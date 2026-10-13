/**
 * Conversations with the lead assistant. Every message is durable; every delegation, result and decision message is
 * derived from a real job/approval row (never invented) and posted exactly once per (job, state) or approval.
 */
import { plainForOwner } from '../model/wording.ts';
import { cancelDescendants } from '../coord/delegation.ts';
import { Settings } from '../model/settings.ts';
import { ApprovalStore } from '../approvals/store.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { JobStore, newId, now } from '../jobs/store.ts';
import type { Job } from '../jobs/types.ts';
import { Definitions } from '../model/definitions.ts';
import { conversationTitle, taskTitle } from '../model/wording.ts';

export const CHAT_WORKFLOW = 'chat.turn';
export interface Conversation { id: string; workspace_id: string | null; title: string; session_ref: string | null; session_closed_at: string | null; status: 'active' | 'archived'; created_at: string; updated_at: string; last_message_at: string | null; type: 'direct' | 'group'; owner: string }
export interface Member { conversation_id: string; agent_id: string; session_ref: string | null; session_closed_at: string | null; joined_at: string; added_by: string }
export type MessageKind = 'text' | 'delegation' | 'handoff' | 'activity' | 'result' | 'question' | 'blocker' | 'decision' | 'status' | 'wake' | 'attachment';
export type Delivery = 'queued' | 'delivering' | 'delivered' | 'failed';
export interface Message { seq: number; id: string; conversation_id: string; role: 'owner' | 'assistant' | 'system'; kind: string; content: string; job_id: string | null; artifact_id: string | null; approval_id: string | null; meta: Record<string, unknown>; created_at: string; sender: string; reply_to: string | null; mentions: string[]; delivery: Delivery }

/** A group has 2-6 assistants; a direct chat exactly one. */
export const GROUP_MIN = 2, GROUP_MAX = 6;
/** Owner-facing refusal (bad membership, unknown mention, limits): the API returns it as a 400 with this text. */
export class ChatRuleError extends Error { readonly code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } }

const P = <T>(s: unknown, f: T): T => { try { return JSON.parse(String(s)) as T; } catch { return f; } };
const rowM = (r: Record<string, unknown>): Message => ({ ...(r as unknown as Message), meta: P(r.meta, {}), mentions: P(r.mentions, [] as string[]) });
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Plain-English state wording shared by the API and the prompt builder. */
export function plainState(j: Pick<Job, 'state' | 'blocker_code' | 'waiting_on' | 'reset_at' | 'retry_at'> & { outcome?: Job['outcome']; kind?: string }): string {
  if (j.state === 'completed' && j.outcome === 'partial') return 'Partial result';
  if (j.state === 'completed' && j.outcome === null && j.kind !== CHAT_WORKFLOW) return 'Finished (outcome not recorded)';
  if (j.state === 'failed_terminal' && j.blocker_code === 'BLOCKED') return 'Blocked';
  switch (j.state) {
    case 'queued': return 'Waiting to start';
    case 'leased': case 'running': return 'In progress';
    case 'waiting_for_auth': return j.waiting_on?.startsWith('browser:') ? `Sign in to continue (${j.waiting_on.slice(8)})` : 'Sign in to continue (Claude)';
    case 'waiting_for_reset': return j.reset_at ? `Claude usage limit reached; resumes at ${j.reset_at}` : 'Claude usage limit reached; checking again shortly';
    case 'waiting_for_approval': return 'Needs your decision';
    case 'retry_scheduled': return j.retry_at ? `Trying again at ${j.retry_at}` : 'Trying again shortly';
    case 'completed': return 'Finished';
    case 'failed_terminal': return 'Could not finish';
    case 'cancelled': return 'Cancelled';
    default: return String(j.state);
  }
}

/**
 * Honest state of a job for the UI: "working" only with a live lease and a fresh heartbeat; otherwise "checking" (stale).
 * An automatic report that is running is "delivering" (results being brought back to the chat).
 */
export type TurnState = 'queued' | 'working' | 'checking' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'delivering';
export function turnState(j: Pick<Job, 'state' | 'blocker_code' | 'lease_heartbeat_at' | 'lease_expires_at' | 'inputs'>, heartbeatSeconds: number, nowMs = Date.now()): TurnState {
  switch (j.state) {
    case 'queued': case 'retry_scheduled': return 'queued';
    case 'leased': case 'running': {
      const fresh = !!j.lease_heartbeat_at && nowMs - Date.parse(j.lease_heartbeat_at) < heartbeatSeconds * 2 * 1000 && !!j.lease_expires_at && Date.parse(j.lease_expires_at) > nowMs;
      if (!fresh) return 'checking';
      return P<{ automatic?: boolean }>(j.inputs, {}).automatic ? 'delivering' : 'working';
    }
    case 'waiting_for_auth': case 'waiting_for_reset': case 'waiting_for_approval': return 'waiting';
    case 'failed_terminal': return j.blocker_code === 'BLOCKED' ? 'blocked' : 'failed';
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    default: return 'checking';
  }
}

export class ChatStore {
  readonly db: DB; private store: JobStore;
  constructor(db: DB, store: JobStore) { this.db = db; this.store = store; }

  /** A direct chat with one assistant (default: the Chief of Staff) or a group of 2-6 assistants. */
  create(input: { workspace_id: string; title?: string; type?: 'direct' | 'group'; members?: string[] }, actor = 'owner'): Conversation {
    const type = input.type ?? 'direct';
    const members = [...new Set((input.members?.length ? input.members : type === 'direct' ? ['coordinator'] : []).map(String))];
    if (type === 'direct' && members.length !== 1) throw new ChatRuleError('direct_members', 'A direct chat has exactly one assistant.');
    if (type === 'group' && (members.length < GROUP_MIN || members.length > GROUP_MAX)) throw new ChatRuleError('group_size', `A group has ${GROUP_MIN} to ${GROUP_MAX} assistants (you picked ${members.length}).`);
    for (const m of members) { const a = this.db.prepare('SELECT enabled, name FROM agent_definitions WHERE id = ?').get(m) as { enabled: number; name: string } | undefined; if (!a) throw new ChatRuleError('unknown_assistant', `There is no assistant "${m}".`); if (!a.enabled) throw new ChatRuleError('disabled_assistant', `${a.name} is turned off; turn it on first.`); }
    const id = `conv-${crypto.randomBytes(5).toString('hex')}`; const t = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO conversations(id, workspace_id, title, status, created_at, updated_at, type, owner) VALUES (?,?,?,?,?,?,?,?)').run(id, input.workspace_id, (input.title ?? '').slice(0, 120), 'active', t, t, type, 'owner');
      for (const m of members) this.db.prepare('INSERT INTO conversation_members(conversation_id, agent_id, joined_at, added_by) VALUES (?,?,?,?)').run(id, m, t, actor);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.store.event(null, actor, 'conversation.created', { id, workspace_id: input.workspace_id, type, members });
    return this.get(id)!;
  }
  members(conversationId: string): Member[] { return this.db.prepare('SELECT * FROM conversation_members WHERE conversation_id = ? ORDER BY joined_at, rowid').all(conversationId) as unknown as Member[]; }
  member(conversationId: string, agentId: string): Member | undefined { return this.db.prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND agent_id = ?').get(conversationId, agentId) as Member | undefined; }
  /** The assistant a direct chat talks to (groups: the first member). */
  primaryAgent(conversationId: string): string { return this.members(conversationId)[0]?.agent_id ?? 'coordinator'; }
  /** Add an assistant to a group (the DB also refuses a 7th member and any second member of a direct chat). */
  addMember(conversationId: string, agentId: string, actor = 'owner'): Member {
    const c = this.get(conversationId); if (!c) throw new ChatRuleError('not_found', 'conversation not found');
    if (c.type !== 'group') throw new ChatRuleError('direct_members', 'A direct chat has exactly one assistant; start a group instead.');
    if (this.members(conversationId).length >= GROUP_MAX) throw new ChatRuleError('group_size', `A group has at most ${GROUP_MAX} assistants.`);
    const a = this.db.prepare('SELECT enabled, name FROM agent_definitions WHERE id = ?').get(agentId) as { enabled: number; name: string } | undefined; if (!a) throw new ChatRuleError('unknown_assistant', `There is no assistant "${agentId}".`);
    if (this.member(conversationId, agentId)) return this.member(conversationId, agentId)!;
    this.db.prepare('INSERT INTO conversation_members(conversation_id, agent_id, joined_at, added_by) VALUES (?,?,?,?)').run(conversationId, agentId, now(), actor);
    this.store.event(null, actor, 'conversation.member_added', { conversation_id: conversationId, agent_id: agentId });
    return this.member(conversationId, agentId)!;
  }
  /** Session / capability / folder key of one assistant in a conversation. Direct chats keep the conversation id (unchanged from before groups). */
  sessionKey(conv: Pick<Conversation, 'id' | 'type'>, agentId: string): string { return conv.type === 'group' ? `${conv.id}.${agentId}` : conv.id; }
  get(id: string): Conversation | undefined { return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined; }
  list(opts: { workspace?: string; includeArchived?: boolean } = {}): Array<Conversation & { open_work: number; last_preview: string; members: string[] }> {
    const where: string[] = []; const args: unknown[] = [];
    if (opts.workspace) { where.push('c.workspace_id = ?'); args.push(opts.workspace); }
    if (!opts.includeArchived) where.push("c.status = 'active'");
    const rows = this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM jobs j WHERE j.conversation_id = c.id AND j.kind NOT IN ('${CHAT_WORKFLOW}','owner.upload') AND j.state NOT IN ('completed','failed_terminal','cancelled')) AS open_work,
      COALESCE((SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('owner','assistant') ORDER BY m.seq DESC LIMIT 1), '') AS last_preview
      FROM conversations c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`).all(...(args as never[])) as unknown as Array<Conversation & { open_work: number; last_preview: string }>;
    return rows.map((r) => ({ ...r, last_preview: r.last_preview.slice(0, 140), members: this.members(r.id).map((m) => m.agent_id) }));
  }
  archive(id: string, actor = 'owner'): void { this.db.prepare("UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), id); this.store.event(null, actor, 'conversation.archived', { id }); }
  setTitle(id: string, title: string): void { this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title.slice(0, 120), now(), id); }
  /** The heuristic title derived from the first owner message (so a better model-provided title may replace it, but never an owner-edited one). */
  defaultTitle(id: string): string { const first = this.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'owner' ORDER BY seq LIMIT 1").get(id) as { content: string } | undefined; return first ? conversationTitle(first.content) : ''; }
  /** Bind (or clear) an assistant's persistent session in a conversation. Direct chats also mirror it on the conversation row. */
  setSession(id: string, sessionRef: string | null, agentId?: string): void {
    const c = this.get(id); if (!c) return; const agent = agentId ?? this.primaryAgent(id); const t = now();
    this.db.prepare('UPDATE conversation_members SET session_ref = ?, session_closed_at = ? WHERE conversation_id = ? AND agent_id = ?').run(sessionRef, sessionRef ? null : t, id, agent);
    if (c.type === 'direct') this.db.prepare('UPDATE conversations SET session_ref = ?, session_closed_at = ?, updated_at = ? WHERE id = ?').run(sessionRef, sessionRef ? null : t, t, id);
    else this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, id);
  }
  memberSession(id: string, agentId: string): string | null { return this.member(id, agentId)?.session_ref ?? null; }

  // ---- messages ----
  add(m: { conversation_id: string; role: Message['role']; kind?: string; content: string; job_id?: string | null; artifact_id?: string | null; approval_id?: string | null; meta?: Record<string, unknown>; sender?: string; reply_to?: string | null; mentions?: string[]; delivery?: Delivery }): Message {
    const id = newId('msg'); const t = now();
    const sender = m.sender ?? (m.role === 'owner' ? 'owner' : m.role === 'system' ? 'system' : this.primaryAgent(m.conversation_id));
    this.db.prepare('INSERT INTO messages(id, conversation_id, role, kind, content, job_id, artifact_id, approval_id, meta, created_at, sender, reply_to, mentions, delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, m.conversation_id, m.role, m.kind ?? 'text', m.content, m.job_id ?? null, m.artifact_id ?? null, m.approval_id ?? null, JSON.stringify(m.meta ?? {}), t, sender, m.reply_to ?? null, JSON.stringify(m.mentions ?? []), m.delivery ?? 'delivered');
    this.db.prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?').run(t, t, m.conversation_id);
    return this.message(id)!;
  }
  message(id: string): Message | undefined { const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? rowM(r) : undefined; }
  messages(conversationId: string, opts: { afterSeq?: number; limit?: number } = {}): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(conversationId, opts.afterSeq ?? 0, opts.limit ?? 500) as Record<string, unknown>[]).map(rowM);
  }

  /** A turn in flight for this conversation (optionally: for one assistant), if any. */
  activeTurn(conversationId: string, agentId?: string): Job | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE conversation_id = ? AND kind = '${CHAT_WORKFLOW}' AND state IN ('queued','leased','running','retry_scheduled') ${agentId ? 'AND agent_role = ?' : ''} ORDER BY created_at DESC LIMIT 1`).get(...([conversationId, ...(agentId ? [agentId] : [])] as never[])) as Job | undefined;
  }

  /**
   * Who an owner message is for. Direct chat: its assistant. Group: explicit mentions (ids from the composer, or @Name in the
   * text) and the author of a replied-to assistant message; @everyone = every member. A mention of an assistant who is not a
   * member is refused. No addressee in a group: one routing turn by the Chief of Staff, who answers or hands off.
   */
  resolveTargets(conv: Conversation, content: string, opts: { mentions?: string[]; reply_to?: string | null } = {}): { targets: string[]; mentions: string[]; everyone: boolean; routed: boolean } {
    const members = this.members(conv.id).map((m) => m.agent_id);
    if (opts.reply_to) { const r = this.message(opts.reply_to); if (!r || r.conversation_id !== conv.id) throw new ChatRuleError('bad_reply', 'The message you replied to is not in this conversation.'); }
    if (conv.type === 'direct') return { targets: [members[0] ?? 'coordinator'], mentions: [], everyone: false, routed: false };
    const agents = this.db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>;
    const byKey = new Map<string, string>(); for (const a of agents) { byKey.set(a.id.toLowerCase(), a.id); byKey.set(a.name.toLowerCase(), a.id); }
    const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
    const mentioned = new Set<string>(); let everyone = /(^|[^\w@])@everyone(?![\w])/i.test(content);
    const ids = new Set(agents.map((a) => a.id));
    for (const raw of opts.mentions ?? []) { const k = String(raw).toLowerCase(); if (k === 'everyone') { everyone = true; continue; } const id = ids.has(String(raw)) ? String(raw) : byKey.get(k); if (!id) throw new ChatRuleError('unknown_mention', `There is no assistant called "${raw}".`); mentioned.add(id); }
    // @Name in the text: longest names first so "@Chief of Staff" is not read as "@Chief".
    const sorted = [...agents].sort((a, b) => b.name.length - a.name.length);
    let rest = content;
    for (const a of sorted) for (const key of [a.name, a.id]) { const re = new RegExp(`(^|[^\\w@])@${escapeRe(key)}(?![\\w])`, 'gi'); if (re.test(rest)) { mentioned.add(a.id); rest = rest.replace(re, '$1'); } }
    const outsiders = [...mentioned].filter((id) => !members.includes(id));
    if (outsiders.length) throw new ChatRuleError('not_a_member', `${outsiders.map(nameOf).join(', ')} ${outsiders.length > 1 ? 'are' : 'is'} not in this group. Add ${outsiders.length > 1 ? 'them' : 'them'} first, or ask someone who is.`);
    const targets = new Set<string>(everyone ? members : [...mentioned]);
    if (opts.reply_to) { const r = this.message(opts.reply_to); if (!r || r.conversation_id !== conv.id) throw new ChatRuleError('bad_reply', 'The message you replied to is not in this conversation.'); if (r.role === 'assistant' && members.includes(r.sender)) targets.add(r.sender); }
    if (targets.size) return { targets: members.filter((m) => targets.has(m)), mentions: everyone ? ['everyone', ...mentioned] : [...mentioned], everyone, routed: false };
    return { targets: ['coordinator'], mentions: [], everyone: false, routed: true };
  }

  /**
   * Owner sends a message: one durable message row and one chat.turn job per addressed assistant (idempotent per message and
   * assistant). The owner can keep sending while turns run; turns of one assistant in one chat run strictly one after another.
   */
  send(conversationId: string, content: string, defs: Definitions, actor = 'owner', meta: Record<string, unknown> = {}, opts: { mentions?: string[]; reply_to?: string | null } = {}): { message: Message; job: Job; jobs: Job[]; routed: boolean } {
    const conv = this.get(conversationId); if (!conv) throw new Error('conversation not found');
    if (conv.status !== 'active') throw new Error('conversation is archived');
    const wf = defs.getWorkflow(CHAT_WORKFLOW); if (!wf) throw new Error('chat workflow missing');
    const route = this.resolveTargets(conv, content, opts);
    for (const t of route.targets) { const a = defs.getAgent(t); if (!a) throw new ChatRuleError('unknown_assistant', `There is no assistant "${t}".`); if (!a.enabled) throw new ChatRuleError('disabled_assistant', `${a.name} is turned off; turn it on first.`); }
    const message = this.add({ conversation_id: conversationId, role: 'owner', content, meta: { ...meta, ...(route.routed ? { routed_by: 'coordinator' } : {}) }, mentions: route.mentions, reply_to: opts.reply_to ?? null, delivery: 'queued' });
    if (!conv.title) this.setTitle(conversationId, conversationTitle(content));
    const jobs: Job[] = [];
    for (const agent of route.targets) {
      const key = conv.type === 'direct' ? `chat:${message.id}` : `chat:${message.id}:${agent}`;
      const r = this.createTurn({ idempotency_key: key, kind: CHAT_WORKFLOW, objective: content.slice(0, 2000), success_contract: wf.contract, agent_role: agent, workspace_id: conv.workspace_id, priority: 3, inputs: { conversation_id: conversationId, message_id: message.id, chain_root: message.id, ...(route.routed ? { router: true } : {}) } }, actor, conversationId, message.id);
      jobs.push(this.store.get(r.job.id)!);
    }
    this.db.prepare('UPDATE messages SET job_id = ? WHERE id = ?').run(jobs[0].id, message.id);   // the owner's message shows the live state of its (first) reply
    if (route.routed) this.add({ conversation_id: conversationId, role: 'system', kind: 'activity', content: 'No one was mentioned, so the Chief of Staff is deciding who should answer.', job_id: jobs[0].id, meta: { routing: true, chain_root: message.id } });
    else if (conv.type === 'group') this.store.event(jobs[0].id, actor, 'chat.routed', { conversation_id: conversationId, message_id: message.id, targets: route.targets, everyone: route.everyone });
    return { message: this.message(message.id)!, job: jobs[0], jobs, routed: route.routed };
  }

  /** Create a chat turn and bind it to its conversation and message atomically, so no worker can lease it half-bound. */
  private createTurn(input: Parameters<JobStore['create']>[0], actor: string, conversationId: string, messageId: string): { job: Job; created: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = this.store.create(input, actor); if (r.created) this.db.prepare('UPDATE jobs SET conversation_id = ?, message_id = ? WHERE id = ?').run(conversationId, messageId, r.job.id); this.db.exec('COMMIT'); return { job: this.store.get(r.job.id)!, created: r.created }; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** The owner's message is delivered once every turn it caused has replied (or failed). */
  refreshDelivery(messageId: string): void {
    const states = (this.db.prepare(`SELECT state FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND message_id = ?`).all(messageId) as Array<{ state: string }>).map((r) => r.state);
    if (!states.length) return;
    const d: Delivery = states.some((s) => ['leased', 'running'].includes(s)) ? 'delivering' : states.every((s) => s === 'completed') ? 'delivered' : states.some((s) => ['queued', 'retry_scheduled', 'waiting_for_auth', 'waiting_for_reset'].includes(s)) ? 'queued' : states.some((s) => s === 'completed') ? 'delivered' : 'failed';
    this.db.prepare("UPDATE messages SET delivery = ? WHERE id = ? AND role = 'owner'").run(d, messageId);
  }

  /** Toggle one reaction (owner or an assistant) on a message. */
  react(messageId: string, reactor: string, emoji: string, on = true): Array<{ emoji: string; reactor: string }> {
    const m = this.message(messageId); if (!m) throw new ChatRuleError('not_found', 'message not found');
    const e = String(emoji).trim(); if (!e || e.length > 16) throw new ChatRuleError('bad_emoji', 'pick one emoji');
    if (on) this.db.prepare('INSERT OR IGNORE INTO message_reactions(message_id, reactor, emoji, created_at) VALUES (?,?,?,?)').run(messageId, reactor, e, now());
    else this.db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND reactor = ? AND emoji = ?').run(messageId, reactor, e);
    return this.reactions(messageId);
  }
  reactions(messageId: string): Array<{ emoji: string; reactor: string }> { return this.db.prepare('SELECT emoji, reactor FROM message_reactions WHERE message_id = ? ORDER BY created_at, rowid').all(messageId) as Array<{ emoji: string; reactor: string }>; }

  /**
   * One assistant hands part of the owner's request to another member of the same group. Limits (engine-enforced, owner
   * settings): members only, never to yourself, never twice to the same assistant for one owner message (loop/duplicate
   * guard), delegation depth, and an automatic-turn budget per owner message. Creates one visible handoff message and one turn.
   */
  handOff(fromJobId: string, to: string, request: string, defs: Definitions, actor: string, after?: string): { ok: true; job: Job; message: Message } | { ok: false; reason: string } {
    const from = this.store.get(fromJobId); const refuse = (reason: string, extra: Record<string, unknown> = {}) => { this.store.event(fromJobId, actor, 'handoff.refused', { to, reason, ...extra }); return { ok: false as const, reason }; };
    if (!from || from.kind !== CHAT_WORKFLOW || !from.conversation_id) return refuse('hand_off is only available in a conversation reply');
    const conv = this.get(from.conversation_id)!; if (conv.type !== 'group') return refuse('hand_off is only for group chats');
    const text = String(request ?? '').trim(); if (!text) return refuse('request is required');
    const agents = this.db.prepare('SELECT id, name, enabled FROM agent_definitions').all() as Array<{ id: string; name: string; enabled: number }>;
    const want = String(to).trim().toLowerCase().replace(/^@/, ''); const target = agents.find((a) => a.id.toLowerCase() === want) ?? agents.find((a) => a.name.toLowerCase() === want);
    if (!target) return refuse(`there is no assistant called "${to}"`);
    if (!this.member(conv.id, target.id)) return refuse(`${target.name} is not in this group`);
    if (!target.enabled) return refuse(`${target.name} is turned off`);
    if (target.id === from.agent_role) return refuse('you cannot hand off to yourself');
    const inputs = P<Record<string, unknown>>(from.inputs, {}); const root = String(inputs.chain_root ?? from.message_id ?? '');
    if (!root) return refuse('this reply is not linked to an owner message');
    const chain = this.db.prepare(`SELECT id, agent_role, state, inputs FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND conversation_id = ? AND json_extract(inputs, '$.chain_root') = ?`).all(conv.id, root) as Array<{ id: string; agent_role: string; state: string; inputs: string }>;
    // A loop is handing work to a member who is still on it, or the same sender handing the same member work twice. A finished
    // member may be asked again (a reviewer sending fixes back to the writer); the per-message turn budget bounds the rest.
    if (chain.some((j) => j.agent_role === target.id && !['completed', 'failed_terminal', 'cancelled'].includes(j.state))) return refuse(`${target.name} is already working on this request`, { loop: true });
    // Review loop: a member answering the one who sent it this work (a writer returning a revision, a reviewer sending fixes back)
    // is bounded by review_max_rounds instead of the twice and depth rules; the turn budget below still applies.
    const loopBack = P<Record<string, unknown>>(from.inputs, {}).handoff_from === target.id;
    const rounds = chain.filter((j) => P<Record<string, unknown>>(j.inputs, {}).review_round !== undefined).length;
    const maxRounds = Number(new Settings(this.db).get('review_max_rounds')) * 2;   // each round is a revision and a re-review
    if (loopBack && rounds >= maxRounds) {
      // Stop with a blocker the owner sees (once per request): what is unresolved, and the owner's choice.
      if (!this.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND kind = 'blocker' AND json_extract(meta, '$.chain_root') = ?").get(conv.id, root)) {
        const fromName = defs.getAgent(from.agent_role)?.name ?? from.agent_role;
        this.add({ conversation_id: conv.id, role: 'system', kind: 'blocker', content: actor === 'engine' ? `Review stopped after ${maxRounds / 2} rounds: ${fromName}'s latest version has not been re-reviewed. You can accept it as it is, or ask ${target.name} to look again.` : `Review stopped after ${maxRounds / 2} rounds: ${fromName} still found problems in ${target.name}'s latest version. You can accept it as it is, or ask for another round.`, job_id: from.id, meta: { chain_root: root, review_cap: maxRounds / 2, from: from.agent_role, to: target.id } });
      }
      return refuse(`the review limit of ${maxRounds / 2} rounds for this request is reached; answer with what you have`, { review_cap: true, limit: maxRounds / 2 });
    }
    if (!loopBack && (this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND conversation_id = ? AND json_extract(inputs, '$.chain_root') = ? AND agent_role = ? AND json_extract(inputs, '$.handoff_from') = ?`).get(conv.id, root, target.id, from.agent_role) as { n: number }).n >= 1 && (this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND conversation_id = ? AND json_extract(inputs, '$.chain_root') = ? AND agent_role = ?`).get(conv.id, root, target.id) as { n: number }).n >= 2) return refuse(`${target.name} already took this request twice from ${defs.getAgent(from.agent_role)?.name ?? from.agent_role}; answer with what you have`, { loop: true });
    const st = new Settings(this.db); const maxTurns = Number(st.get('chat_max_turns_per_message')); const maxDepth = Number(st.get('delegation_max_depth'));
    const autos = chain.filter((j) => P<Record<string, unknown>>(j.inputs, {}).handoff_from).length;
    if (autos >= maxTurns) return refuse(`the limit of ${maxTurns} handoffs for one owner message is reached; answer with what you have`, { budget: true, limit: maxTurns });
    const depth = Number(inputs.handoff_depth ?? 0) + 1;
    if (depth > maxDepth && !loopBack) return refuse(`handoff depth limit reached (${maxDepth}); answer with what you have`, { depth, limit: maxDepth });
    // "after": this member starts only when the named member's turn for the same request has finished (a real dependency, so it waits instead of answering at once).
    let dependsOn: string[] = [];
    if (after && String(after).trim()) { const w = String(after).trim().toLowerCase().replace(/^@/, ''); const dep = agents.find((x) => x.id.toLowerCase() === w) ?? agents.find((x) => x.name.toLowerCase() === w); if (!dep) return refuse(`there is no assistant called "${after}" to wait for`); const dj = this.db.prepare(`SELECT id FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND conversation_id = ? AND json_extract(inputs, '$.chain_root') = ? AND agent_role = ? ORDER BY created_at DESC LIMIT 1`).get(conv.id, root, dep.id) as { id: string } | undefined; if (!dj) return refuse(`${dep.name} has not been handed this request yet; hand it to them first`); dependsOn = [dj.id]; }
    const wf = defs.getWorkflow(CHAT_WORKFLOW)!; const fromName = defs.getAgent(from.agent_role)?.name ?? from.agent_role;
    // An engine-made hand-off (the automatic re-review) is a ledger event from ClaudeBot, never a message from the member it concerns.
    const auto = actor === 'engine';
    const msg = auto
      ? this.add({ conversation_id: conv.id, role: 'system', kind: 'handoff', content: `ClaudeBot sent ${fromName}'s revision to ${target.name} for re-review (automatic).`, mentions: [target.id], delivery: 'queued', meta: { from: 'engine', automatic: true, revised_by: from.agent_role, to: target.id, request: text.slice(0, 4000), chain_root: root } })
      : this.add({ conversation_id: conv.id, role: 'assistant', kind: 'handoff', sender: from.agent_role, content: `Handing to ${target.name}: ${text.slice(0, 600)}`, mentions: [target.id], delivery: 'queued', meta: { from: from.agent_role, to: target.id, request: text.slice(0, 4000), chain_root: root } });
    // Linked through inputs, not parent_id: a handoff is its own request, so stopping or failing the sender must not cancel it.
    const r = this.createTurn({ idempotency_key: `chat:${root}:${target.id}:${chain.filter((j) => j.agent_role === target.id).length}`, kind: CHAT_WORKFLOW, objective: text.slice(0, 2000), success_contract: wf.contract, agent_role: target.id, workspace_id: conv.workspace_id, priority: 3, depends_on: dependsOn, inputs: { ...(loopBack ? { review_round: rounds + 1 } : {}), conversation_id: conv.id, message_id: msg.id, chain_root: root, handoff_from: from.agent_role, handoff_from_name: auto ? `ClaudeBot (automatically, because ${fromName} saved a revision after your review)` : fromName, handoff_depth: depth, handoff_parent: from.id } }, actor, conv.id, msg.id);
    if (!r.created) { this.db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id); return refuse(`${target.name} already has this request`, { duplicate: true }); }
    this.db.prepare('UPDATE messages SET job_id = ? WHERE id = ?').run(r.job.id, msg.id);
    this.store.event(r.job.id, actor, 'handoff.created', { conversation_id: conv.id, from: from.agent_role, to: target.id, chain_root: root, depth });
    return { ok: true, job: this.store.get(r.job.id)!, message: this.message(msg.id)! };
  }

  /** What other members said in a group since this assistant last spoke (each member's session sees only its own turns). */
  groupContext(conversationId: string, agentId: string, beforeSeq: number): string {
    const last = this.db.prepare("SELECT max(seq) AS s FROM messages WHERE conversation_id = ? AND role = 'assistant' AND sender = ? AND seq < ?").get(conversationId, agentId, beforeSeq) as { s: number | null };
    const rows = this.db.prepare("SELECT role, sender, kind, content FROM messages WHERE conversation_id = ? AND seq > ? AND seq < ? AND (role IN ('owner','assistant') OR kind IN ('result','delegation')) ORDER BY seq DESC LIMIT 40").all(conversationId, last.s ?? 0, beforeSeq) as Array<{ role: string; sender: string; kind: string; content: string }>;
    const names = new Map((this.db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    return rows.reverse().filter((r) => !(r.role === 'assistant' && r.sender === agentId)).map((r) => `${r.role === 'owner' ? 'Owner' : r.role === 'assistant' ? (names.get(r.sender) ?? r.sender) : 'System'}: ${r.content.slice(0, 1500)}`).join('\n');
  }

  autoReport(defs: Definitions, touched: Set<string>): void {
    const since = (() => { const r = this.db.prepare("SELECT value FROM runtime_state WHERE key = 'auto_report.since'").get() as { value: string } | undefined; if (r) return JSON.parse(r.value) as string; const t = new Date().toISOString(); this.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('auto_report.since', ?, 'first sync with completion delivery', ?) ON CONFLICT(key) DO NOTHING").run(JSON.stringify(t), t); return t; })();
    const maxAuto = Number(new Settings(this.db).get('delegation_max_auto_turns'));
    const convs = this.db.prepare(`SELECT DISTINCT conversation_id AS id FROM jobs WHERE conversation_id IS NOT NULL AND kind NOT IN ('${CHAT_WORKFLOW}','owner.upload') AND created_at >= ? AND state IN ('completed','failed_terminal','cancelled','waiting_for_auth','waiting_for_reset')`).all(since) as Array<{ id: string }>;
    for (const { id: conv } of convs) {
      const c = this.get(conv); if (!c || c.status !== 'active' || this.activeTurn(conv)) continue;
      // Groups: another member's reply must not hide this member's finished work, so compare against each delegator's own last reply.
      const isGroup = c.type === 'group';
      const lastReply = isGroup ? '' : (this.db.prepare("SELECT max(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(conv) as { t: string | null }).t ?? '';
      const open = (this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE conversation_id = ? AND kind NOT IN ('${CHAT_WORKFLOW}','owner.upload') AND state IN ('queued','leased','running','retry_scheduled')`).get(conv) as { n: number }).n;
      if (open) continue;
      const settled = (this.db.prepare(`SELECT c.id, c.state, c.updated_at, p.agent_role AS delegator FROM jobs c LEFT JOIN jobs p ON p.id = c.parent_id WHERE c.conversation_id = ? AND c.kind NOT IN ('${CHAT_WORKFLOW}','owner.upload') AND c.created_at >= ? AND c.updated_at > ? AND c.state IN ('completed','failed_terminal','cancelled','waiting_for_auth','waiting_for_reset') ORDER BY c.id`).all(conv, since, lastReply) as Array<{ id: string; state: string; updated_at: string; delegator: string | null }>)
        .filter((x) => !isGroup || x.updated_at > ((this.db.prepare("SELECT max(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'assistant' AND sender = ?").get(conv, x.delegator ?? '') as { t: string | null }).t ?? ''))
        .map((x) => ({ id: x.id, state: x.state }));
      if (!settled.length) continue;
      const lastOwner = (this.db.prepare("SELECT max(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'owner'").get(conv) as { t: string | null }).t ?? '';
      const autos = (this.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND kind = 'wake' AND created_at > ?").get(conv, lastOwner) as { n: number }).n;
      const key = `auto:${conv}:${crypto.createHash('sha256').update(settled.map((x) => `${x.id}=${x.state}`).join(',')).digest('hex').slice(0, 24)}`;
      if (this.db.prepare('SELECT 1 FROM jobs WHERE idempotency_key = ?').get(key)) continue;
      if (autos >= maxAuto) { if (!this.db.prepare("SELECT 1 FROM job_events WHERE type = 'auto_report.skipped' AND json_extract(detail, '$.key') = ?").get(key)) this.store.event(null, 'engine', 'auto_report.skipped', { key, conversation_id: conv, reason: `limit of ${maxAuto} automatic reports since the owner's last message` }); continue; }
      const wf = defs.getWorkflow(CHAT_WORKFLOW); if (!wf) continue;
      // The report comes from the assistant whose turn delegated the work (if still a member), so results return to who asked.
      const delegator = (this.db.prepare(`SELECT p.agent_role FROM jobs c JOIN jobs p ON p.id = c.parent_id WHERE c.id IN (${settled.map(() => '?').join(',')}) AND p.kind = '${CHAT_WORKFLOW}' ORDER BY c.updated_at DESC LIMIT 1`).get(...(settled.map((x) => x.id) as never[])) as { agent_role: string } | undefined)?.agent_role;
      const reporter = delegator && this.member(conv, delegator) ? delegator : this.primaryAgent(conv);
      const reporterName = (this.db.prepare('SELECT name FROM agent_definitions WHERE id = ?').get(reporter) as { name: string } | undefined)?.name ?? reporter;
      const msg = this.add({ conversation_id: conv, role: 'system', kind: 'wake', content: `Delegated work finished (${settled.length} task${settled.length > 1 ? 's' : ''}); ${reporterName} is reporting back.`, meta: { settled: settled.map((x) => x.id), automatic: true, reporter } });
      const r = this.createTurn({ idempotency_key: key, kind: CHAT_WORKFLOW, objective: 'Automatic report: delegated work finished', success_contract: wf.contract, agent_role: reporter, workspace_id: c.workspace_id, priority: 3, inputs: { conversation_id: conv, message_id: msg.id, chain_root: msg.id, automatic: true } }, 'engine', conv, msg.id);
      this.db.prepare('UPDATE messages SET job_id = ? WHERE id = ?').run(r.job.id, msg.id);
      this.store.event(r.job.id, 'engine', 'auto_report.started', { conversation_id: conv, settled: settled.map((x) => x.id) });
      touched.add(conv);
    }
  }

  /** The owner message submitted with this client id, if any (idempotent submission). */
  byClientId(conversationId: string, clientId: string): Message | null { const r = this.db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'owner' AND json_extract(meta, '$.client_id') = ? ORDER BY seq LIMIT 1").get(conversationId, clientId) as { id: string } | undefined; return r ? (this.message(r.id) ?? null) : null; }

  /** Delegated (non-turn) jobs of a conversation. */
  delegations(conversationId: string): Job[] { return this.db.prepare(`SELECT * FROM jobs WHERE conversation_id = ? AND kind NOT IN ('${CHAT_WORKFLOW}','owner.upload') ORDER BY created_at`).all(conversationId) as unknown as Job[]; }

  /** Transcript for a lead-assistant session that has to be (re)started: the recent owner/assistant exchange. */
  transcript(conversationId: string, opts: { limit?: number; beforeSeq?: number; names?: boolean } = {}): string {
    const rows = (this.db.prepare("SELECT role, kind, content, sender FROM messages WHERE conversation_id = ? AND seq < ? AND (role IN ('owner','assistant') OR kind IN ('result','delegation')) ORDER BY seq DESC LIMIT ?").all(conversationId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 30) as Array<{ role: string; kind: string; content: string; sender: string }>).reverse();
    const names = opts.names ? new Map((this.db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])) : null;
    return rows.map((r) => `${r.role === 'owner' ? 'Owner' : r.role === 'assistant' ? (names ? (names.get(r.sender) ?? r.sender) : 'You') : 'System'}: ${r.content.slice(0, 1500)}`).join('\n');
  }

  /** What happened to delegated work since the assistant last replied (fed into the next turn so results are usable). */
  updatesSince(conversationId: string, defs: Definitions): string {
    const last = this.db.prepare("SELECT created_at FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1").get(conversationId) as { created_at: string } | undefined;
    const since = last?.created_at ?? '1970-01-01T00:00:00Z';
    const jobs = this.delegations(conversationId).filter((j) => j.updated_at >= since || j.state === 'completed');
    // Decisions and their execution are part of the state the lead must know (found: the lead said an executed approval was still pending).
    const decisions = this.db.prepare(`SELECT a.action_kind, a.target, a.status, a.decided_at, x.status AS run_status, x.performed_at, x.receipt FROM approvals a JOIN jobs j ON j.id = a.job_id LEFT JOIN actions x ON x.approval_id = a.id WHERE j.conversation_id = ? ORDER BY a.created_at`).all(conversationId) as Array<{ action_kind: string; target: string; status: string; decided_at: string | null; run_status: string | null; performed_at: string | null; receipt: string | null }>;
    const decisionLines = decisions.map((d) => { const run = d.run_status === 'performed' ? (/local_outbox/.test(d.receipt ?? '') ? '; run once into the local outbox on this Mac (nothing was delivered to anyone)' : '; performed once') : d.run_status === 'uncertain' ? '; outcome UNKNOWN — waiting for the owner to say whether it happened' : d.run_status === 'refused' ? '; not run (refused)' : ''; return `- Decision on ${d.action_kind} → ${d.target}: ${d.status === 'pending' ? 'still waiting for the owner' : d.status === 'consumed' ? 'approved by the owner and used' : d.status}${run}.`; });
    if (!jobs.length && !decisionLines.length) return '';
    if (!jobs.length) return `Owner decisions in this conversation (current state):\n${decisionLines.join('\n')}`;
    return jobs.map((j) => {
      const who = defs.getAgent(j.agent_role)?.name ?? j.agent_role;
      let line = `- Task ${j.id} (${who}): "${j.objective.slice(0, 200)}" — ${plainState(j)}.`;
      const dirs = this.db.prepare("SELECT detail FROM job_events WHERE job_id = ? AND type = 'owner.direction' ORDER BY seq").all(j.id) as Array<{ detail: string }>;
      if (dirs.length) { const ds = dirs.map((d) => JSON.parse(d.detail) as { note: string; via?: string }); const own = ds.filter((d) => d.via !== 'api'); const api = ds.filter((d) => d.via === 'api'); if (own.length) line += `\n  Direction the owner gave this task themselves, in the office panel (genuine owner direction; honour it): ${own.map((d) => d.note).join(' | ')}`; if (api.length) line += `\n  Direction recorded for this task through the API (by a script, not typed in the app): ${api.map((d) => d.note).join(' | ')}`; }
      if (j.state === 'completed') {
        const arts = this.db.prepare("SELECT id, title, path, kind, sha256 FROM artifacts WHERE job_id = ? AND kind IN ('file','note') ORDER BY created_at").all(j.id) as Array<{ id: string; title: string; path: string | null; kind: string; sha256: string | null }>;
        for (const a of arts) { const full = a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path, 'utf8') : ''; const excerpt = full.slice(0, 2500); line += `\n  Output "${a.title}" (${a.path ? path.basename(a.path) : 'no file'}, artifact ${a.id}, ${full.length} characters${full.length > 2500 ? '; only the first 2,500 are shown here — use read_artifact for the rest' : ''})${excerpt ? ':\n  ' + excerpt.replace(/\n/g, '\n  ') : ''}`; }
        const ev = this.db.prepare('SELECT title, source_url FROM memory_evidence WHERE job_id = ? LIMIT 12').all(j.id) as Array<{ title: string; source_url: string | null }>;
        if (ev.length) line += `\n  Evidence: ${ev.map((e) => `${e.title} <${e.source_url}>`).join('; ')}`;
      } else if (j.failure_detail) line += ` Reason: ${j.failure_detail.slice(0, 300)}`;
      return line;
    }).join('\n') + (decisionLines.length ? `\nOwner decisions in this conversation (current state):\n${decisionLines.join('\n')}` : '');
  }

  /**
   * Post delegation / result / decision / status messages for real state changes, exactly once each.
   * Returns the ids of conversations that received a message (for live broadcast).
   */
  sync(defs: Definitions): string[] {
    const touched = new Set<string>();
    const has = (jobId: string, kind: string, state?: string) => !!this.db.prepare(`SELECT 1 FROM messages WHERE job_id = ? AND kind = ? ${state ? "AND json_extract(meta, '$.state') = ?" : ''}`).get(...([jobId, kind, ...(state ? [state] : [])] as never[]));
    const who = (j: Job) => defs.getAgent(j.agent_role)?.name ?? j.agent_role;
    // 0. Approvals whose time ran out expire (nothing was done); their cards in the conversation show it.
    for (const a of new ApprovalStore(this.db).expireDue()) { const c = a.job_id ? (this.db.prepare('SELECT conversation_id FROM jobs WHERE id = ?').get(a.job_id) as { conversation_id: string | null } | undefined)?.conversation_id : null; if (c) touched.add(c); }
    // 1. Delegations: a real child job created from a turn (or any non-turn job bound to the conversation).
    for (const j of this.db.prepare(`SELECT * FROM jobs WHERE conversation_id IS NOT NULL AND kind NOT IN ('${CHAT_WORKFLOW}','owner.upload')`).all() as unknown as Job[]) {
      const conv = j.conversation_id!;
      if (!has(j.id, 'delegation')) { this.add({ conversation_id: conv, role: 'system', kind: 'delegation', content: `Assigned to ${who(j)}: ${taskTitle(j.objective)}`, job_id: j.id, meta: { agent: j.agent_role, kind: j.kind, parent_id: j.parent_id } }); touched.add(conv); }
      if (['completed', 'failed_terminal', 'cancelled', 'waiting_for_auth', 'waiting_for_reset'].includes(j.state) && !has(j.id, 'result', j.state)) {
        let content: string; let artifact_id: string | null = null; const meta: Record<string, unknown> = { state: j.state, agent: j.agent_role };
        if (j.state === 'completed') {
          const arts = this.db.prepare("SELECT id, title, path, kind, sha256 FROM artifacts WHERE job_id = ? ORDER BY CASE kind WHEN 'file' THEN 0 ELSE 1 END, created_at").all(j.id) as Array<{ id: string; title: string; path: string | null; kind: string; sha256: string | null }>;
          const main = arts[0];
          if (main) {
            artifact_id = main.id;
            const exists = !!main.path && fs.existsSync(main.path);
            const verified = exists && !!main.sha256 && crypto.createHash('sha256').update(fs.readFileSync(main.path!)).digest('hex') === main.sha256;
            meta.file_verified = verified; meta.path = main.path; meta.preview = exists ? fs.readFileSync(main.path!, 'utf8').slice(0, 1200) : '';
            const od = (() => { try { return JSON.parse(j.outcome_detail || '{}') as { remaining?: string; reason?: string }; } catch { return {}; } })(); meta.outcome = j.outcome;
            content = j.outcome === 'partial' ? `${who(j)} finished part of: ${taskTitle(j.objective)}. Partial result to review: ${main.title}${verified ? ' (file verified)' : ''}. Still unavailable: ${od.remaining ?? od.reason ?? 'see the file'}.` : `${who(j)} finished: ${taskTitle(j.objective)}. Ready to review: ${main.title}${verified ? ' (file verified)' : exists ? ' (file changed since it was saved)' : ''}.`;
          } else content = `${who(j)} finished: ${taskTitle(j.objective)}.`;
        } else if (j.state === 'failed_terminal' && j.blocker_code === 'BLOCKED') { meta.outcome = 'blocked'; content = `${who(j)} was blocked on: ${taskTitle(j.objective)}. ${j.failure_detail ? plainForOwner(j.failure_detail.replace(/^blocked: /, '')) : ''} ${j.operator_action ?? ''}`.trim(); }
        else if (j.state === 'failed_terminal') content = `${who(j)} could not finish: ${taskTitle(j.objective)}. ${j.failure_detail ? 'Reason: ' + j.failure_detail.slice(0, 300) + '.' : ''} ${j.operator_action ?? ''}`.trim();
        else if (j.state === 'cancelled') content = `Stopped: ${taskTitle(j.objective)}. Saved progress and any files are kept.`;
        else content = `${who(j)} is paused on "${taskTitle(j.objective)}": ${plainState(j)}. ${j.operator_action ?? ''}`.trim();
        this.add({ conversation_id: conv, role: 'system', kind: 'result', content, job_id: j.id, artifact_id, meta }); touched.add(conv);
      }
    }
    // 2. Turn jobs that stalled: tell the owner why, once per state.
    for (const j of this.db.prepare(`SELECT * FROM jobs WHERE conversation_id IS NOT NULL AND kind = '${CHAT_WORKFLOW}' AND state IN ('waiting_for_auth','waiting_for_reset','failed_terminal','cancelled')`).all() as unknown as Job[]) {
      if (has(j.id, 'status', j.state)) continue;
      const name = (this.db.prepare('SELECT name FROM agent_definitions WHERE id = ?').get(j.agent_role) as { name: string } | undefined)?.name ?? 'The assistant';
      const content = j.state === 'failed_terminal' ? `${name} could not reply. ${j.failure_detail ? 'Reason: ' + j.failure_detail.slice(0, 300) + '.' : ''} ${j.operator_action ?? ''}`.trim() : j.state === 'cancelled' ? 'This request was cancelled.' : `${plainState(j)}. ${j.operator_action ?? ''}`.trim();
      this.add({ conversation_id: j.conversation_id!, role: 'system', kind: 'status', content, job_id: j.id, meta: { state: j.state } }); touched.add(j.conversation_id!);
    }
    // 2b. Stop/failure cascade: children of a stopped or failed task cannot report to anyone; stop them too.
    for (const j of this.db.prepare(`SELECT p.id FROM jobs p WHERE p.state IN ('cancelled','failed_terminal') AND EXISTS (SELECT 1 FROM jobs c WHERE c.parent_id = p.id AND c.state NOT IN ('completed','failed_terminal','cancelled'))`).all() as Array<{ id: string }>) {
      cancelDescendants(this.db, this.store, j.id, 'engine', 'parent task stopped or failed');
    }
    // 2c. A handoff that waits on a member whose turn failed or was stopped can never start: stop it, and say so.
    for (const j of this.db.prepare(`SELECT w.id, w.conversation_id FROM jobs w WHERE w.kind = '${CHAT_WORKFLOW}' AND w.state = 'queued' AND EXISTS (SELECT 1 FROM json_each(w.depends_on) d JOIN jobs p ON p.id = d.value WHERE p.state IN ('failed_terminal','cancelled'))`).all() as Array<{ id: string; conversation_id: string }>) {
      this.store.transition(j.id, 'cancelled', 'engine', { next_action: null }, { reason: 'the turn it waited for did not finish' }); touched.add(j.conversation_id);
    }
    // 2d. Review loop: a member who was sent fixes and saved a new version without handing it back gets it re-reviewed
    //     automatically by the member who sent the fixes. Bounded by review_max_rounds and the turn budget; at the limit a blocker says so.
    for (const f of this.db.prepare(`SELECT f.* FROM jobs f JOIN conversations c ON c.id = f.conversation_id AND c.type = 'group' AND c.status = 'active' WHERE f.kind = '${CHAT_WORKFLOW}' AND f.state = 'completed' AND json_extract(f.inputs, '$.handoff_from') IS NOT NULL AND EXISTS (SELECT 1 FROM artifacts a WHERE a.job_id = f.id)`).all() as unknown as Job[]) {
      const fi = P<Record<string, unknown>>(f.inputs, {}); const rev = String(fi.handoff_from); const root = String(fi.chain_root ?? '');
      const sent = this.db.prepare(`SELECT 1 FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND conversation_id = ? AND json_extract(inputs, '$.chain_root') = ? AND agent_role = ? AND json_extract(inputs, '$.handoff_from') = ?`).get(f.conversation_id, root, rev, f.agent_role);
      if (!sent) continue;   // only fixes sent back by a reviewer of this member's work
      if (this.db.prepare(`SELECT 1 FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND conversation_id = ? AND json_extract(inputs, '$.chain_root') = ? AND agent_role = ? AND rowid > (SELECT rowid FROM jobs WHERE id = ?)`).get(f.conversation_id, root, rev, f.id)) continue;   // already handed back
      if (has(f.id, 'blocker')) continue;
      const r = this.handOff(f.id, rev, `Automatic re-review: ${who(f)} saved a revised version after your review. Check whether your required fixes are in, then pass it, or send it back with exactly what is still wrong.`, defs, 'engine');
      if (!r.ok && /limit/.test(r.reason) && !this.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND kind = 'blocker' AND json_extract(meta, '$.chain_root') = ?").get(f.conversation_id, root)) { this.add({ conversation_id: f.conversation_id!, role: 'system', kind: 'blocker', content: `Review stopped: ${who(f)}'s latest version has not been re-reviewed (${r.reason.replace(/; answer with what you have$/, '')}). You can accept it as it is, or ask ${defs.getAgent(rev)?.name ?? rev} to look again.`, job_id: f.id, meta: { reason: r.reason, reviewer: rev, chain_root: root } }); }
      touched.add(f.conversation_id!);
    }
    // 4. Completion delivery: when every delegated task of a conversation has settled after the lead's last reply, wake the
    //    lead once (no owner follow-up needed). Idempotent per settled set; bounded by the owner's delegation_max_auto_turns.
    this.autoReport(defs, touched);
    // Delivery state follows the turns, also when they end outside a worker (stopped while queued, cascades, reclaimed leases).
    for (const m of this.db.prepare(`SELECT DISTINCT m.id, m.role, m.kind, m.delivery, m.conversation_id FROM messages m JOIN jobs j ON j.message_id = m.id AND j.kind = '${CHAT_WORKFLOW}' WHERE m.delivery IN ('queued','delivering')`).all() as Array<{ id: string; role: string; kind: string; delivery: string; conversation_id: string }>) {
      if (m.role === 'owner') this.refreshDelivery(m.id);
      else if (m.kind === 'handoff') { const st = (this.db.prepare(`SELECT state FROM jobs WHERE message_id = ? AND kind = '${CHAT_WORKFLOW}' ORDER BY created_at LIMIT 1`).get(m.id) as { state: string } | undefined)?.state; const d = st === 'completed' ? 'delivered' : st && ['failed_terminal', 'cancelled'].includes(st) ? 'failed' : st && ['leased', 'running'].includes(st) ? 'delivering' : 'queued'; this.db.prepare('UPDATE messages SET delivery = ? WHERE id = ?').run(d, m.id); }
      const now2 = this.message(m.id)?.delivery; if (now2 !== m.delivery) touched.add(m.conversation_id);
    }
    // 3. Decisions: every approval raised by a job of the conversation gets one decision card.
    for (const a of this.db.prepare(`SELECT a.id, a.job_id, a.action_kind, a.target, a.content AS body, a.status, j.conversation_id FROM approvals a JOIN jobs j ON j.id = a.job_id WHERE j.conversation_id IS NOT NULL`).all() as Array<{ id: string; job_id: string; action_kind: string; target: string; body: string; status: string; conversation_id: string }>) {
      if (this.db.prepare('SELECT 1 FROM messages WHERE approval_id = ? AND kind = ?').get(a.id, 'decision')) continue;
      this.add({ conversation_id: a.conversation_id, role: 'system', kind: 'decision', content: `Your decision is needed before anything is ${a.action_kind === 'send' ? 'sent' : a.action_kind === 'publish' ? 'published' : a.action_kind === 'purchase' ? 'purchased' : a.action_kind === 'delete' ? 'deleted' : 'done'}: ${a.action_kind} → ${a.target}`, job_id: a.job_id, approval_id: a.id, meta: { action_kind: a.action_kind, target: a.target, preview: a.body.slice(0, 1200) } }); touched.add(a.conversation_id);
    }
    return [...touched];
  }

  /** Assistant sessions (any conversation, any member) idle longer than `idleMs`: candidates for closing to free memory. */
  idleSessions(idleMs: number): Array<{ conversation_id: string; agent_id: string; session_ref: string }> {
    const cutoff = new Date(Date.now() - idleMs).toISOString();
    return this.db.prepare(`SELECT m.conversation_id, m.agent_id, m.session_ref FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE m.session_ref IS NOT NULL AND COALESCE(c.last_message_at, c.updated_at) < ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.conversation_id = m.conversation_id AND j.agent_role = m.agent_id AND j.kind = '${CHAT_WORKFLOW}' AND j.state IN ('queued','leased','running'))`).all(cutoff) as Array<{ conversation_id: string; agent_id: string; session_ref: string }>;
  }

}
