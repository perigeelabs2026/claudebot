/**
 * Assistants created from the owner's plain words. The Chief of Staff drafts (a real Claude turn calling propose_assistant).
 * The owner confirms either in the app or by asking for it in chat/Telegram: an owner message that asks for the assistant is
 * the owner's confirmation (ownerAsked checks the quoted words against the owner's own message that started this turn).
 * Creating a teammate is internal; a draft can only grant tools from the fixed capability groups below (never delegation,
 * scheduling or approval-free consequential actions), so sends, publishing, purchases and deletions stay approval-bound.
 */
import type { DB } from '../db/open.ts';
import { newId, now } from '../jobs/store.ts';
import { Definitions, type AgentDef } from '../model/definitions.ts';
import { ChatRuleError } from './store.ts';

/** Plain capability words a draft may ask for, and the catalogue tools each grants. */
export const CAPABILITY_GROUPS: Record<string, string[]> = {
  read: ['read_records', 'search_evidence', 'read_memory_rules', 'list_jobs', 'read_artifact', 'list_my_tools'],
  search: ['search'],
  write: ['write_artifact', 'report_progress', 'report_outcome', 'propose_memory_change'],
  evidence: ['add_evidence'],
  records: ['upsert_record'],
  browser: ['browser_read', 'browser_act'],
  approvals: ['request_approval'],
};
const BASE = ['read', 'search', 'write'];

export interface DraftFields { name: string; role: string; purpose: string; responsibilities: string[]; instructions: string; tools: string[] }
export interface AssistantDraft { id: string; job_id: string | null; conversation_id: string | null; description: string; draft: DraftFields; status: 'pending' | 'confirmed' | 'discarded'; agent_id: string | null; created_at: string; decided_at: string | null }

const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validate and normalise a draft from the model; throws a ChatRuleError naming what is wrong. */
export function normaliseDraft(a: Record<string, unknown>): DraftFields {
  const name = clean(a.name, 40); const role = clean(a.role, 60); const purpose = clean(a.purpose, 300);
  const responsibilities = (Array.isArray(a.responsibilities) ? a.responsibilities : []).map((x) => clean(x, 160)).filter(Boolean).slice(0, 8);
  const instructions = String(a.instructions ?? '').trim().slice(0, 2000);
  const wanted = (Array.isArray(a.tools) ? a.tools : []).map((x) => String(x).toLowerCase().trim());
  const groups = [...new Set([...BASE, ...wanted.map((w) => Object.keys(CAPABILITY_GROUPS).find((g) => g === w || w.startsWith(g)) ?? '').filter(Boolean)])];
  const missing = [!name && 'name', !role && 'role', !purpose && 'purpose', !responsibilities.length && 'responsibilities', !instructions && 'instructions'].filter(Boolean);
  if (missing.length) throw new ChatRuleError('draft_incomplete', `the draft is missing: ${missing.join(', ')}`);
  return { name, role, purpose, responsibilities, instructions, tools: groups };
}

const norm = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();
/** Most assistants the owner can have created from chat in one day (runaway guard; the app's Create screen is not limited). */
export const CHAT_CREATE_DAILY_LIMIT = 5;

/**
 * Did the owner ask for this in the message that started the turn? The turn must be a chat reply to an owner message (not a
 * handoff from another assistant, a routine or a wake), and owner_words must be quoted from that message (at least 3 words).
 */
export function ownerAsked(db: DB, jobId: string, ownerWords: unknown): { ok: true; message_id: string; source: string } | { ok: false; reason: string } {
  const w = norm(String(ownerWords ?? '')); if (w.split(' ').filter(Boolean).length < 3) return { ok: false, reason: 'owner_words must quote at least three words of the owner\'s request' };
  const j = db.prepare('SELECT kind, message_id FROM jobs WHERE id = ?').get(jobId) as { kind: string; message_id: string | null } | undefined;
  if (!j || j.kind !== 'chat.turn' || !j.message_id) return { ok: false, reason: 'only a chat reply to the owner can act on the owner\'s request' };
  const m = db.prepare('SELECT role, content, meta FROM messages WHERE id = ?').get(j.message_id) as { role: string; content: string; meta: string | null } | undefined;
  if (!m || m.role !== 'owner') return { ok: false, reason: 'this turn was not started by the owner' };
  if (!norm(m.content).includes(w)) return { ok: false, reason: 'owner_words are not in the owner\'s message; quote the owner exactly' };
  let source = 'app'; try { source = String((JSON.parse(m.meta || '{}') as { source?: string }).source ?? 'app'); } catch { /* */ }
  return { ok: true, message_id: j.message_id, source };
}

export class Assistants {
  private db: DB; private defs: Definitions;
  constructor(db: DB) { this.db = db; this.defs = new Definitions(db); }

  saveDraft(input: { job_id?: string | null; conversation_id?: string | null; description: string; fields: Record<string, unknown> }): AssistantDraft {
    const draft = normaliseDraft(input.fields); const id = newId('draft');
    this.db.prepare('INSERT INTO assistant_drafts(id, job_id, conversation_id, description, draft, status, created_at) VALUES (?,?,?,?,?,?,?)').run(id, input.job_id ?? null, input.conversation_id ?? null, clean(input.description, 2000), JSON.stringify(draft), 'pending', now());
    return this.get(id)!;
  }
  get(id: string): AssistantDraft | undefined { const r = this.db.prepare('SELECT * FROM assistant_drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? { ...(r as unknown as AssistantDraft), draft: JSON.parse(String(r.draft)) as DraftFields } : undefined; }
  byJob(jobId: string): AssistantDraft | undefined { const r = this.db.prepare('SELECT id FROM assistant_drafts WHERE job_id = ? ORDER BY created_at DESC LIMIT 1').get(jobId) as { id: string } | undefined; return r ? this.get(r.id) : undefined; }

  /** The owner names and confirms a draft: the assistant is created (enabled) with the draft's role, duties and tool groups. */
  confirm(id: string, input: { name?: string; role?: string; purpose?: string; responsibilities?: string[]; instructions?: string }, actor = 'owner', opts: { autoName?: boolean; via?: Record<string, unknown> } = {}): AgentDef {
    const d = this.get(id); if (!d) throw new ChatRuleError('not_found', 'draft not found');
    if (d.status !== 'pending') throw new ChatRuleError('draft_decided', `this draft was already ${d.status}`);
    const f = normaliseDraft({ ...d.draft, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')) });
    if (opts.autoName) {   // asked for in chat: a taken or reserved name gets a free variant (the owner can rename it later)
      const taken = (n: string) => /^everyone$/i.test(n) || !!this.db.prepare('SELECT 1 FROM agent_definitions WHERE lower(name) = lower(?) OR lower(id) = lower(?) OR lower(id) = lower(replace(?, \' \', \'-\'))').get(n, n, n);
      const base = taken(f.name) && !/^everyone$/i.test(f.name) ? f.name : /^everyone$/i.test(f.name) ? f.role : f.name; let n = base; for (let i = 2; taken(n); i++) n = `${base} ${i}`; f.name = n;
    }
    if (/^everyone$/i.test(f.name)) throw new ChatRuleError('bad_name', '"everyone" is reserved for mentioning the whole group');
    // A name may not equal another assistant's name or id: mentions resolve both, so either would be ambiguous.
    const clash = this.db.prepare('SELECT name FROM agent_definitions WHERE lower(name) = lower(?) OR lower(id) = lower(?) OR lower(id) = lower(replace(?, \' \', \'-\'))').get(f.name, f.name, f.name) as { name: string } | undefined;
    if (clash) throw new ChatRuleError('name_taken', `There is already an assistant called ${clash.name}. Pick another name.`);
    const base = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'assistant';
    let agentId = base; for (let i = 2; this.defs.getAgent(agentId); i++) agentId = `${base}-${i}`;
    const tools = [...new Set(f.tools.flatMap((g) => CAPABILITY_GROUPS[g] ?? []))];
    const proposer = d.job_id ? (this.db.prepare('SELECT agent_role, kind FROM jobs WHERE id = ?').get(d.job_id) as { agent_role: string; kind: string } | undefined) : undefined;
    const createdBy = proposer?.kind === 'chat.turn' ? `assistant:${proposer.agent_role}` : 'owner';
    const agent = this.defs.upsertAgent({ id: agentId, name: f.name, purpose: f.purpose, role: f.role, responsibilities: f.responsibilities, system_instructions: f.instructions, allowed_tools: tools, data_scopes: ['workspace'], prohibited_actions: ['send, publish, purchase or delete anything without the owner\'s approval', 'fabricate sources, results or evidence', 'automate around login, MFA, CAPTCHA or anti-bot controls'], approval_rules: ['any consequential action → owner'], measurable_outputs: [], acceptance_tests: [], concurrency_limit: 1, memory_scope: [], created_by: createdBy }, actor);
    this.db.prepare("UPDATE assistant_drafts SET status = 'confirmed', agent_id = ?, decided_at = ? WHERE id = ?").run(agent.id, now(), id);
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)').run(d.job_id, now(), actor, 'assistant.confirmed', JSON.stringify({ draft_id: id, agent_id: agent.id, name: agent.name, created_by: createdBy, tools: f.tools, ...(opts.via ?? {}) }));
    return agent;
  }
  /** Assistants created from chat requests in the last 24 hours. */
  createdFromChatToday(): number { return (this.db.prepare("SELECT count(*) AS n FROM job_events WHERE type = 'assistant.confirmed' AND actor = 'owner:chat' AND at > ?").get(new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n; }
  discard(id: string, actor = 'owner'): void {
    const d = this.get(id); if (!d) throw new ChatRuleError('not_found', 'draft not found'); if (d.status !== 'pending') return;
    this.db.prepare("UPDATE assistant_drafts SET status = 'discarded', decided_at = ? WHERE id = ?").run(now(), id);
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)').run(d.job_id, now(), actor, 'assistant.draft_discarded', JSON.stringify({ draft_id: id }));
  }
}
