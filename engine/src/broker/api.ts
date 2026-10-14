import { safeExtract, sourceAllowed } from './archive.ts';
import { matchPermission, jobApplicationPermission, isJobSite, isApplicationControl, contentRecipients, grantJobApplications, revokePermission, JOB_APPLICATIONS } from '../approvals/permissions.ts';
import fs from 'node:fs';
import path from 'node:path';
import { runProbe } from '../infra/probe.ts';
import { recordTaskTab, taskTab, newTabId } from '../browser/tabs.ts';
import type { DB } from '../db/open.ts';
import { JobStore, newId, now } from '../jobs/store.ts';
import { ApprovalStore, CONSEQUENTIAL_KINDS } from '../approvals/store.ts';
import { Definitions } from '../model/definitions.ts';
import { ChatStore, ChatRuleError } from '../chat/store.ts';
import { Assistants, ownerAsked, CHAT_CREATE_DAILY_LIMIT } from '../chat/assistants.ts';
import { setPriority, saveReport } from '../cos/report.ts';
import { readArtifact, artifactFile } from './artifact-access.ts';
import { toComputer, fromComputer, computerTmpRoot } from '../runtime/computer.ts';
import { searchScoped } from '../search/index.ts';
import { delegationBudget, waitForChildren, childStatus } from '../coord/delegation.ts';
import { runCheck, allowedRepo, type CheckProfile } from '../worker/project-check.ts';
import { TOOL_SCHEMAS } from './capabilities.ts';
import { parseSnapshot, decide, approvalContent, type ActRequest, type SnapshotElement } from '../browser/act-policy.ts';
import crypto from 'node:crypto';
import { markdownToHtml, renderDocument } from '../documents/render.ts';
import { Vault } from '../memory/vault.ts';
import { taskTitle } from '../model/wording.ts';
import type { Capability } from './capabilities.ts';
import type { EngineConfig } from '../config.ts';

export const COMMAND_ALLOWLIST: RegExp[] = [/^ls( -la?)?( [\w./-]+)?$/, /^wc -l [\w./-]+$/, /^head -n \d{1,3} [\w./-]+$/, /^cat [\w./-]+\.(md|txt|json|csv)$/];

export interface ToolResult { ok: boolean; text: string; data?: unknown }

/** Engine-side implementation of broker tools. Every call is audited in job_events with the capability's job id. */
export class BrokerApi {
  private db: DB; private store: JobStore; private approvals: ApprovalStore; private cfg: EngineConfig;
  constructor(db: DB, store: JobStore, approvals: ApprovalStore, cfg: EngineConfig) { this.db = db; this.store = store; this.approvals = approvals; this.cfg = cfg; }

  async call(cap: Capability, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const actor = `agent:${cap.role}`;
    if (!cap.tools.includes(tool)) { this.store.event(cap.job_id, actor, 'tool.refused', { tool, reason: 'not in capability' }); return { ok: false, text: `Tool ${tool} is not available to the ${cap.role} role.` }; }
    this.store.event(cap.job_id, actor, 'tool.called', { tool, args: summarize(args) });
    try {
      const r = await this.dispatch(cap, tool, args, actor);
      this.store.heartbeat(cap.job_id, this.store.get(cap.job_id)?.lease_owner ?? '', this.cfg.leaseSeconds);
      return r;
    } catch (e) { this.store.event(cap.job_id, actor, 'tool.failed', { tool, error: (e as Error).message }); return { ok: false, text: `Tool failed: ${(e as Error).message}` }; }
  }

  private inWorkspace(cap: Capability, rel: string): string {
    const abs = path.resolve(cap.workspace, rel);
    if (!abs.startsWith(path.resolve(cap.workspace) + path.sep) && abs !== path.resolve(cap.workspace)) throw new Error('path escapes the job workspace');
    return abs;
  }

  private async dispatch(cap: Capability, tool: string, a: Record<string, unknown>, actor: string): Promise<ToolResult> {
    const db = this.db; const t = now();
    switch (tool) {
      case 'read_records': { const rows = db.prepare('SELECT id, type, data, updated_at FROM records WHERE type = ? AND (? IS NULL OR data LIKE ?) ORDER BY updated_at DESC LIMIT ?').all(String(a.type), a.query ? String(a.query) : null, a.query ? `%${a.query}%` : null, Number(a.limit ?? 50)); return { ok: true, text: JSON.stringify(rows), data: rows }; }
      case 'search': { const r = searchScoped(db, cap.job_id, String(a.query ?? ''), { kinds: Array.isArray(a.kinds) ? a.kinds.map(String) : undefined, limit: Number(a.limit ?? 10) }); this.store.event(cap.job_id, actor, 'search.run', { query: String(a.query ?? '').slice(0, 200), hits: r.hits.length, scope: r.scope }); return { ok: true, text: JSON.stringify({ scope: r.scope, hits: r.hits }, null, 1), data: r }; }
      case 'list_my_tools': { const approval = ['request_approval', 'browser_act']; return { ok: true, text: JSON.stringify(cap.tools.map((t) => ({ tool: t, what: (TOOL_SCHEMAS[t]?.description ?? '').split('. ')[0], approval: approval.includes(t) ? 'consequential uses wait for the owner\'s approval' : 'no approval needed' })), null, 1) }; }
      case 'search_evidence': { const rows = db.prepare('SELECT id, title, body, source_url, grade, created_at FROM memory_evidence WHERE title LIKE ? OR body LIKE ? ORDER BY created_at DESC LIMIT ?').all(`%${a.query}%`, `%${a.query}%`, Number(a.limit ?? 20)); return { ok: true, text: JSON.stringify(rows), data: rows }; }
      case 'read_memory_rules': { const rows = db.prepare('SELECT id, title, body, source FROM memory_rules ORDER BY updated_at DESC').all(); return { ok: true, text: JSON.stringify(rows), data: rows }; }
      case 'list_jobs': { const me = this.store.get(cap.job_id); const rows = this.store.list({ state: a.state ? String(a.state) as never : undefined, limit: Number(a.limit ?? 50), workspace: me?.workspace_id ?? undefined }).map((j) => ({ id: j.id, kind: j.kind, agent: j.agent_role, state: j.state, stage: j.stage_name, blocker: j.blocker_code })); return { ok: true, text: JSON.stringify(rows), data: rows }; }
      case 'read_artifact': {
        const r = readArtifact(db, cap.job_id, String(a.id ?? ''), { offset: a.offset === undefined ? undefined : Number(a.offset), maxChars: a.max_chars === undefined ? undefined : Number(a.max_chars) });
        if (!r.ok) { this.store.event(cap.job_id, actor, 'artifact.read_refused', { id: String(a.id ?? ''), reason: r.reason }); return { ok: false, text: r.reason }; }
        this.store.event(cap.job_id, actor, 'artifact.read', { id: String(a.id), job_id: r.job_id, offset: r.offset, chars: r.content.length, total: r.total_chars });
        return { ok: true, text: JSON.stringify({ id: String(a.id), title: r.title, file: r.file, from_task: r.job_id, sha256: r.sha256, total_chars: r.total_chars, offset: r.offset, next_offset: r.next_offset, content: r.content }), data: { total_chars: r.total_chars, next_offset: r.next_offset } };
      }
      case 'write_artifact': {
        const rel = String(a.path); const abs = this.inWorkspace(cap, rel);
        if (!rel || path.isAbsolute(rel) || abs === path.resolve(cap.workspace)) throw new Error('provide a relative file path inside the task workspace');
        // Never follow a symlink into another workspace or the host's private files.
        const parts = path.relative(path.resolve(cap.workspace), abs).split(path.sep);
        let current = path.resolve(cap.workspace);
        for (const part of parts) { current = path.join(current, part); try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlinks are not allowed for output files'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
        if (a.content !== undefined) {
          if (typeof a.content !== 'string' || Buffer.byteLength(a.content) > 1024 * 1024) throw new Error('content must be text no larger than 1 MB');
          if (fs.existsSync(abs)) { if (fs.readFileSync(abs, 'utf8') !== a.content) return { ok: false, text: 'This file already exists with different content. Save a new version under a different name.' }; }
          else { fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 }); fs.writeFileSync(abs, a.content, { flag: 'wx', mode: 0o600 }); }
        }
        if (!fs.existsSync(abs)) return { ok: false, text: `file ${a.path} does not exist; supply content to save it` };
        const sha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        const existing = db.prepare('SELECT id FROM artifacts WHERE job_id = ? AND path = ? AND sha256 = ?').get(cap.job_id, abs, sha) as { id: string } | undefined;
        if (existing) return { ok: true, text: `artifact ${existing.id} already recorded`, data: { id: existing.id } };
        const id = newId('art'); db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, cap.job_id, this.store.get(cap.job_id)?.stage_name ?? 'claude', String(a.kind ?? 'file'), abs, sha, String(a.title), JSON.stringify({ actor, saved_by_broker: a.content !== undefined }), t);
        this.store.event(cap.job_id, actor, 'artifact.saved', { id, path: rel, sha256: sha });
        return { ok: true, text: `artifact ${id} saved and recorded`, data: { id } };
      }
      case 'add_evidence': { const url = String(a.source_url ?? ''); if (!/^https?:\/\/\S+$/.test(url)) return { ok: false, text: 'source_url must be an http(s) URL; evidence without a source is not accepted' }; const id = newId('ev'); db.prepare('INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES (?,?,?,?,?,?,?)').run(id, cap.job_id, String(a.title), String(a.body), url, String(a.grade ?? 'C'), t); return { ok: true, text: `evidence ${id} recorded`, data: { id } }; }
      case 'upsert_record': { const id = String(a.id ?? newId('rec')); const type = String(a.type); const existing = db.prepare('SELECT id FROM records WHERE id = ?').get(id); if (existing) db.prepare('UPDATE records SET data = ?, job_id = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(a.data ?? {}), cap.job_id, t, id); else db.prepare('INSERT INTO records(id, type, data, job_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, type, JSON.stringify(a.data ?? {}), cap.job_id, t, t); this.store.event(cap.job_id, actor, 'record.upserted', { id, type }); return { ok: true, text: `record ${id} ${existing ? 'updated' : 'created'}`, data: { id } }; }
      case 'propose_memory_change': { const id = newId('prop'); db.prepare('INSERT INTO memory_proposals(id, job_id, title, body, rationale, status, created_at) VALUES (?,?,?,?,?,?,?)').run(id, cap.job_id, String(a.title), String(a.body), String(a.rationale), 'proposed', t); return { ok: true, text: `proposal ${id} recorded for owner review`, data: { id } }; }
      case 'report_progress': { this.store.patch(cap.job_id, { next_action: String(a.note).slice(0, 200) }); this.store.event(cap.job_id, actor, 'agent.progress', { note: String(a.note).slice(0, 500) }); return { ok: true, text: 'noted' }; }
      case 'create_job': {
        const defs = new Definitions(db); const wf = defs.getWorkflow(String(a.kind)); if (!wf || !wf.enabled) return { ok: false, text: `unknown workflow ${a.kind}; available: ${defs.listWorkflows().filter((w) => w.id !== 'chat.turn').map((w) => w.id).join(', ')}` };
        if (['chat.turn', 'assistant.draft', 'report.morning', 'priority.rank'].includes(wf.id)) return { ok: false, text: wf.id === 'chat.turn' ? 'chat turns cannot be delegated' : 'new assistants are drafted with propose_assistant, not delegated' };
        const parent = this.store.get(cap.job_id);
        // Who does it: the assistant the lead names (by id, name or first name), never silently someone else.
        const want = a.agent_role ? String(a.agent_role).trim().toLowerCase().replace(/^@/, '') : '';
        const named = want ? defs.listAgents({ includeDisabled: true }).find((x) => x.id.toLowerCase() === want || x.name.toLowerCase() === want || x.name.toLowerCase().split(/[\s(]+/)[0] === want) : undefined;
        if (want && !named) return { ok: false, text: `There is no assistant called "${a.agent_role}". Use one of: ${defs.listAgents().map((x) => x.name).join(', ')}.` };
        const agent = named ? named.id : wf.default_agent;
        const assignee = defs.getAgent(agent); if (!assignee || !assignee.enabled) return { ok: false, text: `${assignee?.name ?? agent} is switched off, so the task was not created. Give it to an assistant who is on (agent_role), or ask the owner to switch ${assignee?.name ?? agent} on.` };
        const objective = String(a.objective ?? '').trim(); if (!objective) return { ok: false, text: 'objective is required' };
        const inputs = (a.inputs && typeof a.inputs === 'object' ? a.inputs : {}) as Record<string, unknown>;
        const wanted = Array.isArray(a.depends_on) ? (a.depends_on as unknown[]).map(String) : [];
        const depends = wanted.filter((id) => { const d = this.store.get(id); return d && (d.workspace_id ?? null) === (parent?.workspace_id ?? null) && (!parent?.conversation_id || d.conversation_id === parent.conversation_id); });   // dependencies stay inside the same conversation
        if (wanted.length && depends.length !== wanted.length) return { ok: false, text: `dependency task id(s) not found in this conversation: ${wanted.filter((x) => !depends.includes(x)).join(', ')}` };
        // Budgets (owner settings, enforced here; no tool can change them): depth, children per task, and a free worker for children.
        { const why = notOwnerInitiated(parent?.inputs); if (why) { this.store.event(cap.job_id, actor, 'delegation.refused', { kind: wf.id, reason: why }); return { ok: false, text: `Not delegated: this is ${why}, not an owner request. Report what you found and ask the owner before starting new work.` }; } }
        const budget = delegationBudget(db, cap.job_id);
        if (!budget.ok) { this.store.event(cap.job_id, actor, 'delegation.refused', { kind: wf.id, reason: budget.reason, depth: budget.depth, children: budget.children }); return { ok: false, text: `Not delegated: ${budget.reason}.` }; }
        const lead = parent?.kind === 'chat.turn';
        // Deduplicate on the whole task (objective, kind, inputs, dependencies), not a prefix: different tasks must never collapse.
        const taskHash = crypto.createHash('sha256').update(JSON.stringify([wf.id, objective, inputs, depends])).digest('hex').slice(0, 32);
        const r = this.store.create({ idempotency_key: lead ? `child:${parent?.conversation_id ?? cap.job_id}:${taskHash}` : `child:${cap.job_id}:${taskHash}`, kind: wf.id, objective, success_contract: wf.contract, agent_role: agent, parent_id: cap.job_id, workspace_id: parent?.workspace_id ?? null, objective_id: parent?.objective_id ?? null, inputs, depends_on: depends }, actor);
        const who = defs.getAgent(agent)?.name ?? agent;
        if (r.created && parent?.conversation_id) {
          db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(parent.conversation_id, r.job.id);
          // Post the "Assigned" card now, in order with the conversation, rather than on the next sync tick (sync skips it if present).
          const by = lead ? null : (defs.getAgent(parent!.agent_role)?.name ?? parent!.agent_role);
          new ChatStore(db, this.store).add({ conversation_id: parent.conversation_id, role: 'system', kind: 'delegation', content: `Assigned to ${who}${by ? ` by ${by}` : ''}: ${taskTitle(objective)}`, job_id: r.job.id, meta: { agent, kind: wf.id, parent_id: cap.job_id, ...(by ? { assigned_by: by } : {}) } });
        }
        return { ok: true, text: r.created ? `Task ${r.job.id} assigned to ${who} (${wf.name})${depends.length ? `, waiting for ${depends.join(', ')} first` : ''}. It runs in the background; do not claim it is finished.${lead ? ' Its result will be posted into the conversation when it completes.' : ' Call wait_for_children with its id to receive its result, then read its files with read_artifact.'}` : `An identical task already exists: ${r.job.id} (${r.job.state}). Not duplicated.`, data: { id: r.job.id, created: r.created, agent, state: r.job.state, depends_on: depends } };
      }
      case 'set_priority': {
        const me = this.store.get(cap.job_id); if (me?.agent_role !== 'coordinator' || !['report.morning', 'priority.rank'].includes(me.kind)) return { ok: false, text: 'Work is ranked only in the morning report or a ranking task.' };
        { const t = this.store.get(String(a.task_id ?? '')); let ti: Record<string, unknown> = {}; try { ti = JSON.parse(t?.inputs || '{}'); } catch { /* */ } if (t && (['chat.turn', 'report.morning', 'priority.rank', 'assistant.draft'].includes(t.kind) || t.schedule_id || ti.trigger_id)) return { ok: false, text: 'That kind of work is not ranked (replies, routines and triggered work keep their own rules).' }; }
        const r = setPriority(db, { job_id: String(a.task_id ?? ''), rank: Number(a.rank), rationale: String(a.rationale ?? ''), by: 'coordinator', in_job: cap.job_id });
        return r.ok ? { ok: true, text: `Ranked ${a.task_id} at ${Math.round(Number(a.rank))}.` } : { ok: false, text: `Not ranked: ${r.reason}.` };
      }
      case 'save_report': { const r = saveReport(db, { job_id: cap.job_id, headline: String(a.headline ?? ''), lede: String(a.lede ?? '') }); return r.ok ? { ok: true, text: 'Report saved.' } : { ok: false, text: `Not saved: ${r.reason}.` }; }
      case 'ask_owner': {
        const me = this.store.get(cap.job_id); if (!me || me.kind !== 'chat.turn' || !me.conversation_id) return { ok: false, text: 'ask_owner is only available in a conversation reply' };
        const question = String(a.question ?? '').replace(/\s+/g, ' ').trim(); const options = (Array.isArray(a.options) ? a.options : []).map((o) => String(o).replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (question.length < 5 || question.length > 200) return { ok: false, text: 'question must be 5-200 characters' };
        if (options.length < 2 || options.length > 4 || options.some((o) => o.length > 120)) return { ok: false, text: 'give 2-4 options of at most 120 characters' };
        const chat = new ChatStore(this.db, this.store);
        if (this.db.prepare("SELECT 1 FROM messages WHERE job_id = ? AND kind = 'question' AND json_extract(meta, '$.options') IS NOT NULL").get(cap.job_id)) return { ok: false, text: 'one question per reply' };
        const msg = chat.add({ conversation_id: me.conversation_id, role: 'assistant', kind: 'question', sender: me.agent_role, content: question, job_id: cap.job_id, meta: { options, action: String(a.action ?? '').trim().slice(0, 40) || null } });
        this.store.event(cap.job_id, actor, 'question.asked', { message_id: msg.id, options: options.length });
        return { ok: true, text: 'Question shown to the owner as a card with the options; their answer arrives as their next message.' };
      }
      case 'react': {
        const me = this.store.get(cap.job_id); if (!me || me.kind !== 'chat.turn' || !me.conversation_id) return { ok: false, text: 'react is only available in a conversation reply' };
        const emoji = String(a.emoji ?? '').trim(); if (!['👍', '🎉', '👀', '❤️', '✅'].includes(emoji)) return { ok: false, text: 'emoji must be one of 👍 🎉 👀 ❤️ ✅' };
        const chat = new ChatStore(db, this.store); const mid = String(a.message_id ?? me.message_id ?? ''); const msg = chat.message(mid);
        if (!msg || msg.conversation_id !== me.conversation_id) return { ok: false, text: 'that message is not in this conversation' };
        chat.react(mid, me.agent_role, emoji, true); this.store.event(cap.job_id, actor, 'reaction.added', { message_id: mid, emoji });
        return { ok: true, text: `Reacted ${emoji}.` };
      }
      case 'hand_off': {
        { const why = notOwnerInitiated(this.store.get(cap.job_id)?.inputs); if (why) { this.store.event(cap.job_id, actor, 'handoff.refused', { reason: why }); return { ok: false, text: `Not handed off: this is ${why}, not an owner request.` }; } }
        const r = new ChatStore(db, this.store).handOff(cap.job_id, String(a.to ?? ''), String(a.request ?? ''), new Definitions(db), actor, a.after ? String(a.after) : undefined);
        if (!r.ok) return { ok: false, text: `Not handed off: ${r.reason}.` };
        const who = new Definitions(db).getAgent(r.job.agent_role)?.name ?? r.job.agent_role;
        return { ok: true, text: `Handed to ${who}. They will answer in the group; do not claim their part is done.`, data: { to: r.job.agent_role, message_id: r.message.id } };
      }
      case 'propose_assistant': {
        // The owner asking for an assistant in chat (or Telegram) is the owner's confirmation: with owner_words quoted from the
        // owner's message that started this turn, the assistant is created now. Without it, a draft waits for the owner in the app.
        const me = this.store.get(cap.job_id); const conv = me?.conversation_id ?? null; const as = new Assistants(db);
        const asked = a.owner_words !== undefined ? ownerAsked(db, cap.job_id, a.owner_words) : null;
        const create = (draftId: string) => {
          if (!asked || !asked.ok) return null;
          if (db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'assistant.confirmed'").get(cap.job_id)) return { ok: false, text: 'One new assistant per reply. Tell the owner the first one exists and ask about the next.' };
          if (as.createdFromChatToday() >= CHAT_CREATE_DAILY_LIMIT) return { ok: false, text: `Not created: ${CHAT_CREATE_DAILY_LIMIT} assistants were already created from chat today. The owner can create more on the Create assistant screen.` };
          const agent = as.confirm(draftId, { name: a.name ? String(a.name) : undefined }, 'owner:chat', { autoName: true, via: { confirmed_via: 'owner_message', message_id: asked.message_id, source: asked.source, by_assistant: me?.agent_role } });
          if (conv) new ChatStore(db, this.store).add({ conversation_id: conv, role: 'system', kind: 'activity', content: `${agent.name} joined the team, as you asked. You can rename or edit them any time.`, job_id: cap.job_id, meta: { assistant_created: agent.id, draft_id: draftId } });
          return { ok: true, text: `Created "${agent.name}" (id ${agent.id}) because the owner asked for it. It exists now. Give it the owner's work right away (hand_off in a group, or create_job with agent "${agent.id}"); tell the owner its name in one sentence.`, data: { agent_id: agent.id, name: agent.name, draft_id: draftId } };
        };
        try {
          if (a.draft_id) {   // confirm a draft that is already waiting
            const d = as.get(String(a.draft_id)); if (!d) return { ok: false, text: 'no such draft' }; if (d.status !== 'pending') return { ok: false, text: `that draft was already ${d.status}` + (d.agent_id ? ` (assistant ${d.agent_id})` : '') };
            if (!asked || !asked.ok) return { ok: false, text: `Not confirmed: ${asked ? asked.reason : 'pass owner_words quoting the owner asking for it'}.` };
            return create(d.id)!;
          }
          const d = as.saveDraft({ job_id: cap.job_id, conversation_id: conv, description: String(a.description ?? ''), fields: a });
          this.store.event(cap.job_id, actor, 'assistant.drafted', { draft_id: d.id, role: d.draft.role, tools: d.draft.tools });
          const made = create(d.id); if (made) return made;
          if (conv) new ChatStore(db, this.store).add({ conversation_id: conv, role: 'assistant', kind: 'question', sender: me!.agent_role, content: `Draft assistant ready for you to name and confirm: ${d.draft.role}.`, job_id: cap.job_id, meta: { draft_id: d.id, draft: d.draft } });
          return { ok: true, text: `Draft saved and shown to the owner (suggested name "${d.draft.name}").${asked && !asked.ok ? ` Not created yet: ${asked.reason}.` : ''} It does not exist until the owner confirms it, in the app or by asking you for it in chat; say so.`, data: { draft_id: d.id } };
        } catch (e) { return { ok: false, text: `Not saved: ${e instanceof ChatRuleError ? e.message : (e as Error).message}` }; }
      }
      case 'render_document': {   // a real .docx / .pdf from Markdown (or a saved text result), saved as results with their own cards
        let md = typeof a.markdown === 'string' ? a.markdown : ''; let from: string | null = null;
        if (!md && a.source_artifact_id) { const f = artifactFile(db, cap.job_id, String(a.source_artifact_id)); if (!f.ok) return { ok: false, text: `Not rendered: ${f.reason}.` }; md = f.buf.toString('utf8'); from = String(a.source_artifact_id); }
        if (!md.trim()) return { ok: false, text: 'give markdown or source_artifact_id' }; if (Buffer.byteLength(md) > 512 * 1024) return { ok: false, text: 'the text is larger than 512 KB' };
        const title = String(a.title ?? 'Document').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Document';
        const formats = (Array.isArray(a.formats) && a.formats.length ? a.formats : ['docx', 'pdf']).map(String).filter((x): x is 'docx' | 'pdf' => x === 'docx' || x === 'pdf'); if (!formats.length) return { ok: false, text: 'formats: docx and/or pdf' };
        const base = title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'document';
        let made; try { made = renderDocument(markdownToHtml(md, title), path.join(path.resolve(cap.workspace), 'documents'), base, [...new Set(formats)]); } catch (e) { return { ok: false, text: `Not rendered: ${(e as Error).message}` }; }
        const ids: Array<{ id: string; format: string }> = [];
        for (const r of made) { const sha = crypto.createHash('sha256').update(fs.readFileSync(r.path)).digest('hex'); const id = newId('art'); db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, cap.job_id, this.store.get(cap.job_id)?.stage_name ?? 'claude', 'file', r.path, sha, `${title} (${r.format.toUpperCase()})`, JSON.stringify({ actor, rendered_from: from ?? 'markdown', format: r.format }), now()); ids.push({ id, format: r.format }); }
        this.store.event(cap.job_id, actor, 'document.rendered', { title, files: ids, from });
        return { ok: true, text: `Saved ${ids.map((x) => `${x.format.toUpperCase()} ${x.id}`).join(' and ')} for "${title}". They appear as file cards under your reply.`, data: { files: ids } };
      }
      case 'save_skill': {   // a method that worked, saved for the whole team and shown to whoever works on that site or topic next
        const r = new Vault().saveSkill({ topic: String(a.topic ?? ''), title: String(a.title ?? ''), steps: String(a.steps ?? ''), by: cap.role });
        if (!r.ok) return { ok: false, text: r.reason }; this.store.event(cap.job_id, actor, 'skill.saved', { topic: a.topic, file: path.basename(r.file) });
        return { ok: true, text: `Saved as a team skill (${path.basename(r.file)}). Whoever works on ${a.topic} next gets these steps.` };
      }
      case 'remember': case 'forget': {   // the memory vault (Team / Owner / own note); see memory/vault.ts
        const defs = new Definitions(db); const me = defs.getAgent(cap.role); if (!me) return { ok: false, text: 'unknown assistant' };
        const scope = (['team', 'owner', 'self'].includes(String(a.scope)) ? String(a.scope) : 'self') as 'team' | 'owner' | 'self';
        let target = me;
        if (a.assistant && cap.role === 'coordinator') { const k = String(a.assistant).toLowerCase(); const t2 = defs.listAgents({ includeDisabled: true }).find((x) => x.id.toLowerCase() === k || x.name.toLowerCase() === k || x.name.toLowerCase().split(/[\s(]+/)[0] === k); if (!t2) return { ok: false, text: `no assistant "${a.assistant}"` }; target = t2; }
        if ((scope === 'team' || target.id !== me.id) && cap.role !== 'coordinator') return { ok: false, text: 'only the lead writes team rules or another assistant\'s memory' };
        const vault = new Vault();
        if (tool === 'forget') { const asked = ownerAsked(db, cap.job_id, a.owner_words); if (!asked.ok) return { ok: false, text: `Not removed: ${asked.reason}.` }; const n = vault.forget({ scope, agent: target, contains: String(a.contains ?? '') }); return { ok: true, text: n ? `removed ${n} line(s)` : 'nothing matched' }; }
        const src = a.source_message_id ? `from message ${String(a.source_message_id).slice(0, 40)}` : undefined;
        const r = vault.remember({ scope, section: a.section as never, text: String(a.text ?? ''), agent: target, source: src });
        if (!r.ok) return { ok: false, text: r.reason }; this.store.event(cap.job_id, actor, 'memory.saved', { scope, assistant: target.id, added: r.added });
        return { ok: true, text: r.added ? `remembered in ${path.basename(r.file)}` : 'already remembered' };
      }
      case 'continue_working': {
        // The goal loop: an assistant whose work is not finished schedules its own next turn (plan, act, check, again) until the goal is
        // verified. Capped per request; after a failed round it must say what it will do differently, and it may not repeat itself.
        const me = this.store.get(cap.job_id); if (!me || me.kind !== 'chat.turn' || !me.conversation_id) return { ok: false, text: 'continue_working is for conversation work' };
        let inp: Record<string, unknown> = {}; try { inp = JSON.parse(me.inputs || '{}'); } catch { /* */ }
        const root = String(inp.chain_root ?? me.message_id ?? me.id); const round = Number(inp.continue_round ?? 0) + 1; const MAX = 6;
        if (round > MAX) return { ok: false, text: `Stop here: this request has had ${MAX} rounds. Tell the owner exactly what is done (with proof), what is not, and what you need.` };
        const next = String(a.next_step ?? '').trim().slice(0, 600); const changed = String(a.what_changed ?? '').trim().slice(0, 600); const failed = a.last_attempt_failed === true;
        if (!next) return { ok: false, text: 'next_step is required: the concrete next thing you will do' };
        if (failed && !changed) return { ok: false, text: 'Your last attempt failed: say in what_changed what you will do differently this time (another route, another tool, another selector). Repeating the same attempt is not allowed.' };
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const prior = db.prepare("SELECT detail FROM job_events WHERE type = 'goal.continue' AND json_extract(detail, '$.root') = ?").all(root) as Array<{ detail: string }>;
        if (changed && prior.some((p) => { try { return norm(String(JSON.parse(p.detail).what_changed ?? '')) === norm(changed); } catch { return false; } })) return { ok: false, text: 'You already tried exactly that. Pick a genuinely different approach, or stop and tell the owner what is blocking you.' };
        const goalMsg = new ChatStore(db, this.store).message(String(inp.chain_root ?? '')); const goal = goalMsg ? goalMsg.content.slice(0, 1500) : me.objective.slice(0, 1500);
        const content = `Continuing (round ${round} of ${MAX}) for ${new Definitions(db).getAgent(me.agent_role)?.name ?? me.agent_role}.\nGoal: ${goal}\nNext step: ${next}${changed ? `\nWhat is different this time: ${changed}` : ''}\nWork until the goal is verified (proof: confirmation pages, files that exist, tool results). If it is done, say so with the proof; if not and you can still make progress, call continue_working again.`;
        const j = new ChatStore(db, this.store).engineTurn(me.conversation_id, me.agent_role, content, `continue:${root}:${round}`, new Definitions(db));
        if (!j) return { ok: false, text: 'could not schedule the next round (are you still a member of this chat?)' };
        db.prepare('UPDATE jobs SET inputs = json_set(inputs, \'$.chain_root\', ?, \'$.continue_round\', ?) WHERE id = ?').run(root, round, j.id);
        this.store.event(cap.job_id, actor, 'goal.continue', { root, round, next_step: next, what_changed: changed || null, failed, next_job: j.id });
        return { ok: true, text: `Round ${round} scheduled; it starts right after this reply. End this reply with a one-line status for the owner (no claim of done).`, data: { job_id: j.id, round } };
      }
      case 'record_application': {
        // An application counts as submitted only with proof: the task's own browser tab must be showing the site's confirmation.
        // The page text is checked, a screenshot is saved as a receipt (a file card), and the record is written. No proof, no record.
        const tab = taskTab(db, cap.job_id) ?? this.resumedTab(cap.job_id);
        if (!tab) return { ok: false, text: 'Not recorded: this task has no browser tab. Submit in your tab first, then record it while the confirmation is showing.' };
        const company = String(a.company ?? '').trim().slice(0, 120); const role = String(a.role ?? '').trim().slice(0, 160); if (!company || !role) return { ok: false, text: 'company and role are required' };
        const ev = await this.browserRunner(['evaluate', '--fn', '() => (document.title + "\\n" + location.href + "\\n" + document.body.innerText).slice(0, 20000)', '--target-id', tab], 'browser.evaluate', 30_000);
        const pageText = ev.stdout ?? ''; const urlNow = await this.tabUrl(tab);
        const CONFIRM = /(thank(s| you)[^.\n]{0,40}(for )?(apply|application|your interest|submitting))|(application (has been |was )?(submitted|received|sent|complete))|(we('| ha)ve received your application)|(successfully (submitted|applied))|(your application is (in|complete))|(applied\s*[✓✔]?\s*$)/im;
        const ERROR = /(is required|please (fix|correct|complete)|there (was|were) (an )?(error|problem)s?|invalid|captcha|verify you are human)/i;
        if (!ev.ok || !CONFIRM.test(pageText) || (ERROR.test(pageText) && !/thank/i.test(pageText))) return { ok: false, text: `Not recorded: the page in your tab (${urlNow}) does not show an application confirmation${ERROR.test(pageText) ? ' and shows an error or required field' : ''}. It is NOT submitted. Read the page, fix what it asks for (or try another way to attach the file), submit again, then record it. Never tell the owner it was submitted until this succeeds.` };
        const conf = (pageText.split('\n').find((l) => CONFIRM.test(l)) ?? '').trim().slice(0, 300);
        let shotArt: string | null = null;
        try {
          const sh = await this.browserRunner(['screenshot', '--target-id', tab], 'browser.screenshot', 60_000); const where = (sh.stdout.match(/(\/[^\s]+\.(png|jpe?g))/) ?? [])[1];
          if (sh.ok && where) { const dir = path.join(path.resolve(cap.workspace), 'receipts'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const dest = path.join(dir, `${company.replace(/[^A-Za-z0-9]+/g, '-')}-${Date.now()}.png`);
            const got = (this.cfg as { browserInComputer?: boolean }).browserInComputer ? await fromComputer(where, dest) : (fs.copyFileSync(where, dest), { ok: true });
            if (got.ok && fs.existsSync(dest)) { const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'); shotArt = newId('art'); db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(shotArt, cap.job_id, this.store.get(cap.job_id)?.stage_name ?? 'claude', 'file', dest, sha, `Receipt: ${company} – ${role}`, JSON.stringify({ actor, receipt: true, url: urlNow }), now()); } }
        } catch { /* the record stands on the page text; the screenshot is a bonus */ }
        const recId = newId('rec'); const rt = now();
        db.prepare('INSERT INTO records(id, type, data, job_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(recId, 'application', JSON.stringify({ title: `${company} – ${role}`, company, role, url: urlNow, submitted_at: rt, confirmation: conf, receipt_artifact: shotArt, verified: true }), cap.job_id, rt, rt);
        this.store.event(cap.job_id, actor, 'application.verified', { record: recId, company, role, url: urlNow, confirmation: conf, receipt: shotArt });
        return { ok: true, text: `Recorded and verified: ${company} – ${role}. Confirmation on the page: "${conf}". ${shotArt ? 'The receipt screenshot shows as a file card under your reply.' : ''} You may now tell the owner it was submitted.`, data: { record_id: recId, receipt: shotArt } };
      }
      // ---- conversation tools (chat replies) ----
      case 'read_message': {   // the full text of a long message in this conversation (context lines never cut silently)
        const me = this.store.get(cap.job_id); const msg = new ChatStore(db, this.store).message(String(a.id ?? ''));
        if (!me?.conversation_id || !msg || msg.conversation_id !== me.conversation_id) return { ok: false, text: 'that message is not in this conversation' };
        const off = Math.max(0, Math.floor(Number(a.offset ?? 0))); const part = msg.content.slice(off, off + 8000); const next = off + part.length < msg.content.length ? off + part.length : null;
        return { ok: true, text: part + (next !== null ? `\n[continues: read_message ${msg.id} offset ${next}]` : ''), data: { total_chars: msg.content.length, next_offset: next } };
      }
      case 'post_update': {   // a short live progress line in the conversation while the work runs (the final answer is still the reply)
        const me = this.store.get(cap.job_id); if (!me?.conversation_id) return { ok: false, text: 'post_update is only for conversation replies' };
        const text = String(a.text ?? '').trim().slice(0, 600); if (!text) return { ok: false, text: 'text is required' };
        const n = (db.prepare("SELECT count(*) AS n FROM messages WHERE job_id = ? AND json_extract(meta, '$.update') = 1").get(cap.job_id) as { n: number }).n; if (n >= 10) return { ok: false, text: 'at most 10 updates per reply; put the rest in your reply' };
        const m = new ChatStore(db, this.store).add({ conversation_id: me.conversation_id, role: 'assistant', sender: me.agent_role, content: text, job_id: cap.job_id, meta: { update: true } });
        return { ok: true, text: 'posted', data: { message_id: m.id } };
      }
      case 'share_file': {   // put a saved result in this conversation, or in the owner's direct chat with an assistant
        const me = this.store.get(cap.job_id); const f = artifactFile(db, cap.job_id, String(a.artifact_id ?? '')); if (!f.ok) return { ok: false, text: `Not shared: ${f.reason}.` };
        const to = String(a.to ?? 'current'); let conv: string | null = null;
        if (to === 'current') conv = me?.conversation_id ?? null;
        else if (to.startsWith('direct:')) { const ag = to.slice(7).trim().toLowerCase(); const agent = (db.prepare('SELECT id FROM agent_definitions WHERE lower(id) = ? OR lower(name) = ?').get(ag, ag) as { id: string } | undefined)?.id; conv = agent ? (db.prepare("SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.type = 'direct' AND c.status = 'active' AND m.agent_id = ? ORDER BY c.updated_at DESC LIMIT 1").get(agent) as { id: string } | undefined)?.id ?? null : null; }
        if (!conv) return { ok: false, text: `Not shared: no ${to === 'current' ? 'current conversation' : `open direct chat for ${to.slice(7)}`}.` };
        if (db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND artifact_id = ?').get(conv, String(a.artifact_id))) return { ok: true, text: 'already in that chat' };
        new ChatStore(db, this.store).add({ conversation_id: conv, role: 'assistant', kind: 'result', sender: me?.agent_role ?? cap.role, content: f.title, job_id: f.job_id, artifact_id: String(a.artifact_id), meta: { state: 'completed', file_verified: true, chat_file: true, shared_by: cap.role } });
        return { ok: true, text: `shared "${f.title}"` };
      }
      // ---- the lead's team tools: each acts only on the owner's own words in the message being answered ----
      case 'set_permission': {   // the lead switches a standing permission on or off because the owner said so in the message being answered
        const asked = ownerAsked(db, cap.job_id, a.owner_words); if (!asked.ok) return { ok: false, text: `Not changed: ${asked.reason}.` };
        const which = String(a.permission ?? ''); const on = a.on !== false;
        if (which === 'job_applications') {
          if (on) { const p2 = grantJobApplications(db, 'owner:chat', { reason: `owner asked in chat (${asked.source})` }); return { ok: true, text: `"Submit job applications without asking" is on (until ${p2.expires_at.slice(0, 10)}). Applications on job sites go ahead without a card; each is recorded.` }; }
          const live = db.prepare("SELECT id FROM standing_permissions WHERE status = 'active' AND action_kind = ?").all(JOB_APPLICATIONS) as Array<{ id: string }>; for (const x of live) revokePermission(db, x.id, 'owner:chat'); return { ok: true, text: live.length ? 'Switched off: every application asks the owner again.' : 'It was already off.' };
        }
        if (!on && a.id) { return revokePermission(db, String(a.id), 'owner:chat') ? { ok: true, text: 'permission revoked' } : { ok: false, text: 'no active permission with that id' }; }
        return { ok: false, text: 'permission must be "job_applications" (or give id with on=false to revoke another one); email permissions are created from the email\'s own card in the app' };
      }
      case 'add_dependency': {   // the lead makes a waiting task also wait for another one (e.g. applications wait for the tailored resumes)
        const me = this.store.get(cap.job_id); const target = this.store.get(String(a.task_id ?? ''));
        if (!me || !target || target.conversation_id !== me.conversation_id) return { ok: false, text: 'that task is not part of this conversation' };
        if (!['queued', 'retry_scheduled', 'drafted'].includes(target.state)) return { ok: false, text: `that task has already ${target.state === 'completed' ? 'finished' : 'started'}; create a new one that waits instead` };
        const add = (Array.isArray(a.depends_on) ? a.depends_on : [a.depends_on]).map(String).filter(Boolean);
        for (const d of add) { const dj = this.store.get(d); if (!dj || dj.conversation_id !== me.conversation_id) return { ok: false, text: `task ${d} is not part of this conversation` }; if (d === target.id || (JSON.parse(dj.depends_on || '[]') as string[]).includes(target.id)) return { ok: false, text: 'that would make the tasks wait for each other' }; }
        const cur = JSON.parse(target.depends_on || '[]') as string[]; const next = [...new Set([...cur, ...add])];
        db.prepare('UPDATE jobs SET depends_on = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), now(), target.id); this.store.event(target.id, actor, 'job.dependency_added', { added: add, by: cap.job_id });
        return { ok: true, text: `Done: that task now also waits for ${add.length} more task(s) and gets their results.` };
      }
      case 'create_group': case 'edit_group': {   // the lead, on the owner's own words
        const asked = ownerAsked(db, cap.job_id, a.owner_words); if (!asked.ok) return { ok: false, text: `Not done: ${asked.reason}.` };
        const defs = new Definitions(db); const chat = new ChatStore(db, this.store); const me = this.store.get(cap.job_id)!;
        const ids = (Array.isArray(a.members) ? a.members : []).map((x) => { const k = String(x).toLowerCase().replace(/^@/, ''); return defs.listAgents().find((ag) => ag.id.toLowerCase() === k || ag.name.toLowerCase() === k || ag.name.toLowerCase().split(/[\s(]+/)[0] === k)?.id; });
        if (ids.some((x) => !x)) return { ok: false, text: 'one of those assistants does not exist or is switched off' };
        try {
          if (tool === 'create_group') { const members = [...new Set(['coordinator', ...ids as string[]])]; const g = chat.create({ workspace_id: me.workspace_id ?? (db.prepare('SELECT workspace_id FROM conversations WHERE id = ?').get(me.conversation_id) as { workspace_id: string }).workspace_id, type: 'group', title: String(a.name ?? '').trim().slice(0, 120) || 'New group', members }, 'owner:chat'); if (a.purpose) db.prepare('UPDATE conversations SET purpose = ? WHERE id = ?').run(String(a.purpose).slice(0, 1000), g.id); return { ok: true, text: `Created the group "${g.title}" with ${members.length} assistants. It is in the owner's rail.`, data: { conversation_id: g.id } }; }
          const gid = String(a.conversation ?? me.conversation_id ?? ''); const g = chat.get(gid); if (!g || g.type !== 'group') return { ok: false, text: 'that is not a group' };
          if (a.name) chat.setTitle(gid, String(a.name).trim()); if (a.purpose !== undefined) db.prepare('UPDATE conversations SET purpose = ? WHERE id = ?').run(String(a.purpose).slice(0, 1000), gid);
          return { ok: true, text: 'group updated' };
        } catch (e) { return { ok: false, text: e instanceof ChatRuleError ? e.message : (e as Error).message }; }
      }
      case 'rename_assistant': case 'disable_assistant': case 'enable_assistant': case 'add_member': case 'remove_member': {
        const asked = ownerAsked(db, cap.job_id, a.owner_words); if (!asked.ok) return { ok: false, text: `Not done: ${asked.reason}.` };
        const defs = new Definitions(db); const key = String(a.assistant ?? a.id ?? '').trim().toLowerCase().replace(/^@/, '');
        const ag = defs.listAgents({ includeDisabled: true }).find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key || x.name.toLowerCase().split(/[\s(]+/)[0] === key); if (!ag) return { ok: false, text: `there is no assistant "${key}"` };
        const me = this.store.get(cap.job_id)!; const chat = new ChatStore(db, this.store);
        try {
          if (tool === 'rename_assistant') { const nn = String(a.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40); if (!nn || /^everyone$/i.test(nn)) return { ok: false, text: 'give a name' }; if (defs.listAgents({ includeDisabled: true }).some((x) => x.id !== ag.id && x.name.toLowerCase() === nn.toLowerCase())) return { ok: false, text: `another assistant is already called ${nn}` }; defs.upsertAgent({ ...ag, name: nn }, 'owner:chat'); return { ok: true, text: `${ag.name} is now ${nn}` }; }
          if (tool === 'enable_assistant') { defs.setAgentEnabled(ag.id, true, 'owner:chat'); return { ok: true, text: `${ag.name} is switched on` }; }
          if (tool === 'disable_assistant') { if (ag.id === 'coordinator') return { ok: false, text: 'the lead cannot switch itself off' }; defs.setAgentEnabled(ag.id, false, 'owner:chat'); return { ok: true, text: `${ag.name} is switched off` }; }
          const conv = String(a.conversation ?? me.conversation_id ?? '');
          if (tool === 'add_member') { chat.addMember(conv, ag.id, 'owner:chat'); return { ok: true, text: `${ag.name} added` }; }
          chat.removeMember(conv, ag.id, 'owner:chat'); return { ok: true, text: `${ag.name} removed` };
        } catch (e) { return { ok: false, text: e instanceof ChatRuleError ? e.message : (e as Error).message }; }
      }
      case 'create_experiment': { const id = newId('exp'); db.prepare('INSERT INTO experiments(id, opportunity_id, hypothesis, metric, status, result, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, a.opportunity_id ? String(a.opportunity_id) : null, String(a.hypothesis), `${a.metric} | stop: ${a.stop_rule}`, 'designed', null, t, t); return { ok: true, text: `experiment ${id} recorded (designed, not active)`, data: { id } }; }
      case 'request_approval': { const kind = String(a.kind); if (!(CONSEQUENTIAL_KINDS as readonly string[]).includes(kind)) return { ok: false, text: `kind must be one of ${CONSEQUENTIAL_KINDS.join(', ')}` }; const ttlMin = Number((this.db.prepare("SELECT value FROM settings WHERE key = 'approval_ttl_minutes'").get() as { value: string } | undefined)?.value ?? 720); const ap = this.approvals.request({ job_id: cap.job_id, action_kind: kind, target: String(a.target), content: String(a.content), evidence: Array.isArray(a.evidence_ids) ? a.evidence_ids : [], budget: (a.budget as Record<string, unknown>) ?? null, ttlSeconds: ttlMin * 60 });
        // A live standing permission the owner created for exactly this assistant, kind and target approves it; it still runs once, through the executor.
        // Only the assistant's own reply to the owner can use its permission: not delegated or automatic work, not another assistant's job.
        const me = this.store.get(cap.job_id); let mi: Record<string, unknown> = {}; try { mi = JSON.parse(me?.inputs || '{}'); } catch { /* */ }
        const ownerReply = !!me && me.kind === 'chat.turn' && !me.parent_id && me.agent_role === cap.role && !mi.automatic && !mi.handoff_from && !mi.trigger_id && !me.schedule_id;
        const perm = ownerReply ? matchPermission(this.db, { agent_id: cap.role, action_kind: kind, target: String(a.target), content: String(a.content) }) : null;
        // A request to submit job applications (no email recipients in it) is covered by "Submit job applications without asking".
        if (!perm && kind === 'send' && /\bapplication/i.test(`${a.target} ${String(a.content).slice(0, 400)}`) && !/@/.test(String(a.target)) && (contentRecipients(String(a.content)) ?? ['x']).length === 0) { const jp = jobApplicationPermission(this.db); if (jp) { this.approvals.decide(ap.id, 'approved', `permission:${jp.id}`, 'covered by "Submit job applications without asking"'); this.store.event(cap.job_id, actor, 'permission.used', { permission: jp.id, approval: ap.id, kind: 'job_application' }); return { ok: true, text: `Allowed by the owner's standing permission "Submit job applications without asking" (${ap.id}). Go ahead and submit the applications in your browser tab; each submit is recorded. Post a receipt for each.`, data: { id: ap.id } }; } }
        if (perm) { this.approvals.decide(ap.id, 'approved', `permission:${perm.id}`, 'covered by the owner\'s standing permission'); this.store.event(cap.job_id, actor, 'permission.used', { permission: perm.id, approval: ap.id }); return { ok: true, text: `Allowed by the owner's standing permission (${perm.scope_text}). It will be ${kind === 'send' ? 'sent' : 'done'} once; tell the owner it was covered by their standing permission.`, data: { id: ap.id, permission: perm.id } }; }
        return { ok: true, text: `approval ${ap.id} requested; the owner must approve before anything is ${kind === 'send' ? 'sent' : 'done'}. Content hash ${ap.content_hash.slice(0, 12)}…`, data: { id: ap.id } }; }
      case 'report_outcome': {
        const status = String(a.status); if (!['complete', 'partial', 'blocked'].includes(status)) return { ok: false, text: 'status must be complete, partial or blocked' };
        const outcome = status === 'complete' ? 'success' : status;
        const detail = { reason: String(a.reason ?? '').slice(0, 1000), remaining: a.remaining ? String(a.remaining).slice(0, 1000) : null, block_kind: a.block_kind ? String(a.block_kind) : null, site: a.site ? String(a.site).toLowerCase().replace(/^www\./, '') : null, next_action: a.next_action ? String(a.next_action).slice(0, 500) : null, reported_by: cap.role, at: t };
        db.prepare('UPDATE jobs SET outcome = ?, outcome_detail = ?, updated_at = ? WHERE id = ?').run(outcome, JSON.stringify(detail), t, cap.job_id);
        this.store.event(cap.job_id, actor, 'outcome.reported', { outcome, ...detail });
        return { ok: true, text: `outcome recorded: ${status}${status !== 'complete' ? ' — the owner will see exactly what remains unavailable' : ''}` };
      }
      case 'browser_read': {
        const url = String(a.url); if (!/^https?:\/\//.test(url)) return { ok: false, text: 'url must be http(s)' };
        const takeover = db.prepare("SELECT value FROM runtime_state WHERE key = 'browser.takeover'").get() as { value: string } | undefined;
        if (takeover && (JSON.parse(takeover.value) as { active?: boolean }).active) return { ok: false, text: 'The owner has taken over the browser (sign-in or verification in progress). Do not retry now; say that you are waiting for the owner to finish.' };
        const args = ['--profile', this.cfg.openclawProfile, 'browser', '--browser-profile', 'claudebot', '--json'];
        const mark = (phase: string) => db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('browser.in_use', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify({ job_id: cap.job_id, role: cap.role, url, phase, at: now() }), 'browser_read tool', now());
        mark('opening');
        const env = { ...process.env, OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' };
        // Bounded tabs: a task reuses the tab it already opened (navigate) instead of opening another; the tab is recorded so it can be closed when the task ends.
        const cdp = `http://127.0.0.1:${this.cfg.browserCdpPort}`;
        const targets = async () => { try { const r = await fetch(`${cdp}/json`, { signal: AbortSignal.timeout(1500) }); return ((await r.json()) as Array<{ id: string; type: string }>).filter((t) => t.type === 'page'); } catch { return [] as Array<{ id: string; type: string }>; } };
        const existing = taskTab(db, cap.job_id) ?? this.resumedTab(cap.job_id); const before = await targets(); const reuse = !!existing && before.some((t) => t.id === existing);
        if (reuse) { const focus = await runProbe(this.cfg.openclawBin, [...args, 'focus', existing!], { timeoutMs: 20_000, label: 'browser.focus', env, registryDir: path.join(this.cfg.runDir, 'probes') }); if (!focus.ok) this.store.event(cap.job_id, actor, 'browser.tab', { note: 'could not focus the task tab; opening a new one', detail: (focus.stderr || focus.stdout).slice(0, 120) }); }
        const opened = await runProbe(this.cfg.openclawBin, [...args, reuse ? 'navigate' : 'open', url], { timeoutMs: 60_000, label: reuse ? 'browser.navigate' : 'browser.open', env, registryDir: path.join(this.cfg.runDir, 'probes') });
        if (!opened.ok) { mark('failed'); return { ok: false, text: `could not open the page: ${(opened.stderr || opened.stdout).replace(/\s+/g, ' ').slice(0, 200)}` }; }
        if (!reuse) {
          // The tab OpenClaw opened (its --json answer names it; it may reuse a blank tab, so a before/after diff can miss it).
          let id: string | null = null; try { const j = JSON.parse(opened.stdout) as { targetId?: string; id?: string }; id = j.targetId ?? j.id ?? null; } catch { /* older output */ }
          if (!id) { const after = await targets(); id = newTabId(before, after); }
          if (id) { recordTaskTab(db, cap.job_id, id); this.store.event(cap.job_id, actor, 'browser.tab', { opened: id, url }); }
          else this.store.event(cap.job_id, actor, 'browser.tab', { note: 'could not tell which tab was opened', url });
        }
        await new Promise((r) => setTimeout(r, Number(process.env.CLAUDEBOT_BROWSER_SETTLE_MS ?? 2500)));
        mark('reading');
        const snap = await runProbe(this.cfg.openclawBin, [...args, 'snapshot', '--format', 'aria'], { timeoutMs: 60_000, label: 'browser.snapshot', env, maxBuffer: 8 * 1024 * 1024, registryDir: path.join(this.cfg.runDir, 'probes') });
        mark('done');
        if (!snap.ok) return { ok: false, text: `could not read the page: ${(snap.stderr || snap.stdout).replace(/\s+/g, ' ').slice(0, 200)}` };
        this.store.event(cap.job_id, actor, 'browser.read', { url });
        return { ok: true, text: snap.stdout.slice(0, 60_000) };
      }
      case 'create_schedule': {
        // The owner asked for something later or repeatedly ("tomorrow at 9", "every Monday"). Bounded: ≥ 15-minute intervals, ≤ 10 active per project.
        const parent = this.store.get(cap.job_id); const ws = parent?.workspace_id ?? null;
        { const why = notOwnerInitiated(parent?.inputs); if (why) return { ok: false, text: `Not scheduled: this is ${why}, not an owner request.` }; }
        const active = (db.prepare('SELECT count(*) AS n FROM schedules WHERE enabled = 1 AND workspace_id IS ?').get(ws) as { n: number }).n;
        if (active >= 10) return { ok: false, text: 'This project already has 10 active schedules (the limit); ask the owner which to remove.' };
        const every = a.every_seconds !== undefined ? Number(a.every_seconds) : null; if (every !== null && (!Number.isFinite(every) || every < 900)) return { ok: false, text: 'every_seconds must be at least 900 (15 minutes)' };
        const kind = String(a.kind ?? ''); if (['chat.turn', 'assistant.draft', 'priority.rank'].includes(kind) || kind.startsWith('system.')) return { ok: false, text: 'that kind of work cannot be scheduled' };
        try {
          const { Scheduler } = await import('../supervisor/scheduler.ts');
          const sch = new Scheduler(db, this.store).add({ name: String(a.name ?? taskTitle(String(a.objective ?? ''))).slice(0, 120), kind, objective: String(a.objective ?? ''), at: a.in_minutes !== undefined ? new Date(Date.now() + Math.max(1, Number(a.in_minutes)) * 60_000).toISOString() : a.at ? String(a.at) : null, cron: a.cron ? String(a.cron) : null, every_seconds: every, workspace_id: ws, inputs: { ...(parent?.conversation_id ? { conversation_id: parent.conversation_id } : {}) } }, actor);
          if (parent?.conversation_id) new ChatStore(db, this.store).add({ conversation_id: parent.conversation_id, role: 'system', kind: 'status', content: `Scheduled by the lead assistant: "${sch.name}" — ${sch.once ? `once at ${new Date(sch.next_run_at!).toLocaleString('en-US')}` : sch.cron ? `cron ${sch.cron}` : `every ${Math.round(sch.every_seconds! / 60)} minutes`}. Remove it under Automations if you did not want this.`, job_id: null, meta: { schedule_id: sch.id } });
          return { ok: true, text: `Scheduled ${sch.id}: ${sch.once ? `once at ${sch.next_run_at}` : sch.cron ? `cron "${sch.cron}"` : `every ${sch.every_seconds} s`}. Its results will be posted in this conversation. The owner can remove it on the Automations screen.`, data: { id: sch.id } };
        } catch (e) { return { ok: false, text: `not scheduled: ${(e as Error).message}` }; }
      }
      case 'browser_act': return this.browserAct(cap, a, actor);
      case 'wait_for_children': {
        const ids = Array.isArray(a.ids) ? a.ids.map(String) : (db.prepare("SELECT id FROM jobs WHERE parent_id = ?").all(cap.job_id) as Array<{ id: string }>).map((r) => r.id);
        const r = await waitForChildren(db, this.store, cap.job_id, ids, Number(a.max_seconds ?? 50) * 1000);
        this.store.event(cap.job_id, actor, 'children.result', { done: r.done, children: r.children.map((c) => ({ id: c.id, state: c.state, outcome: c.outcome })) });
        return { ok: true, text: JSON.stringify({ all_finished: r.done, children: r.children, note: r.done ? 'Read each child\'s files with read_artifact and use them. A child that is blocked, partial, failed or cancelled did not deliver everything: say so in your own result.' : 'Not finished yet; call wait_for_children again.' }, null, 1), data: r };
      }
      case 'run_project_check': {
        const profile = String(a.profile) as CheckProfile; if (!['test', 'build', 'typecheck', 'lint'].includes(profile)) return { ok: false, text: 'profile must be test, build, typecheck or lint' };
        const job = this.store.get(cap.job_id); const inputs = JSON.parse(job?.inputs || '{}') as { repository?: string };
        const repo = inputs.repository ? allowedRepo(inputs.repository, cap.workspace) : null;
        if (!repo) { this.store.event(cap.job_id, actor, 'command.refused', { profile, repository: inputs.repository ?? null, reason: 'repository outside the disposable repos folder or task workspace' }); return { ok: false, text: 'This task has no repository inside the disposable repositories folder (~/ClaudeBot-Repos) or its workspace; refused and recorded.' }; }
        const runs = db.prepare("SELECT count(*) AS n FROM job_events WHERE job_id = ? AND type = 'command.ran'").get(cap.job_id) as { n: number };
        if (runs.n >= 20) return { ok: false, text: 'this task already ran 20 checks; report what remains instead of retrying' };
        const r = await runCheck(repo, profile, { registryDir: path.join(this.cfg.runDir, 'probes') });
        if (r.notRun) return { ok: false, text: `not run: ${r.output}` };
        const dir = path.resolve(cap.workspace); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `check-${profile}-${runs.n + 1}.txt`); fs.writeFileSync(file, r.output, { mode: 0o600 });
        const sha = crypto.createHash('sha256').update(r.output).digest('hex'); const id = newId('art');
        db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, cap.job_id, job?.stage_name ?? 'claude', 'file', file, sha, `${r.label} (${r.ok ? 'passed' : 'failed'})`, JSON.stringify({ actor, command: r.label, exit: r.exit, timed_out: r.timedOut }), now());
        this.store.event(cap.job_id, actor, 'command.ran', { command: r.label, cwd: repo, exit: r.exit, timed_out: r.timedOut, artifact_id: id });
        return { ok: true, text: `${r.label}: ${r.ok ? 'passed' : `FAILED (exit ${r.exit ?? 'timeout'})`}. Output saved as ${id}.\n\n${r.output.slice(-6000)}`, data: { passed: r.ok, artifact_id: id } };
      }
      case 'extract_archive': {
        const job = this.store.get(cap.job_id); const src = String(a.path ?? '').trim(); if (!src) return { ok: false, text: 'path is required' };
        const conv = job?.conversation_id ?? null;
        const ownerText = [job?.objective ?? '', job?.inputs ?? '', ...(conv ? (this.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'owner'").all(conv) as Array<{ content: string }>).map((m) => m.content) : [])].join('\n');
        const abs = path.isAbsolute(src) ? src : path.resolve(cap.workspace, src);
        if (!sourceAllowed(abs, cap.workspace, ownerText) && !sourceAllowed(src, cap.workspace, ownerText)) return { ok: false, text: 'Only archives the owner gave you can be opened: a path they named in this request, or a file in the task folder.' };
        try { const r = safeExtract(abs, cap.workspace); this.store.event(cap.job_id, actor, 'archive.extracted', { source: path.basename(abs), folder: r.folder, files: r.files.length, skipped: r.skipped.length });
          return { ok: true, text: `Extracted ${r.files.length} file(s) into ${r.folder}.${r.skipped.length ? ` Skipped ${r.skipped.length} link(s).` : ''}\n${r.files.slice(0, 400).map((f) => `- ${f.path} (${f.bytes} bytes)${f.text_copy ? ` · text: ${f.text_copy}` : ''}`).join('\n')}`, data: r };
        } catch (e) { return { ok: false, text: `The archive could not be opened safely: ${(e as Error).message}.` }; }
      }
      case 'run_allowlisted': { const cmd = String(a.command).trim(); if (!COMMAND_ALLOWLIST.some((re) => re.test(cmd))) { this.store.event(cap.job_id, actor, 'command.refused', { command: cmd.slice(0, 200) }); return { ok: false, text: 'command is not on the allowlist (ls, wc -l, head -n N, cat *.md|txt|json|csv); refused and audited' }; } const [bin, ...rest] = cmd.split(/\s+/); const r = await runProbe(bin, rest, { cwd: cap.workspace, timeoutMs: 20_000, label: 'run_allowlisted', maxBuffer: 1024 * 1024, registryDir: path.join(this.cfg.runDir, 'probes') }); this.store.event(cap.job_id, actor, 'command.ran', { command: cmd, exit: r.code }); return { ok: r.ok, text: (r.stdout + r.stderr).slice(0, 20_000) }; }
      default: return { ok: false, text: `unknown tool ${tool}` };
    }
  }
  /** A turn started to carry out an approval works in the tab of the task that asked for it (same page, same filled form). */
  private resumedTab(jobId: string): string | null {
    try { const inp = JSON.parse(this.store.get(jobId)?.inputs || '{}') as { resume_approval?: string }; if (!inp.resume_approval) return null;
      const origin = (this.db.prepare('SELECT job_id FROM approvals WHERE id = ?').get(inp.resume_approval) as { job_id: string | null } | undefined)?.job_id; return origin ? taskTab(this.db, origin) : null; } catch { return null; }
  }
  /** Runs `openclaw browser …` (replaceable in tests). */
  browserRunner = (args: string[], label: string, timeoutMs = 60_000) => runProbe(this.cfg.openclawBin, ['--profile', this.cfg.openclawProfile, 'browser', '--browser-profile', 'claudebot', ...args], { timeoutMs, label, env: { ...process.env, OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' }, maxBuffer: 8 * 1024 * 1024, registryDir: path.join(this.cfg.runDir, 'probes') });

  /**
   * Act in the task's own browser tab (opened by browser_read): click, type, press, select, scroll, fill, download.
   * Every element is resolved against a fresh snapshot of that tab; the policy in browser/act-policy.ts decides. Consequential
   * actions run only with an approval bound to the exact page, control and typed content, once (actions table).
   */
  private async browserAct(cap: Capability, a: Record<string, unknown>, actor: string): Promise<{ ok: boolean; text: string; data?: unknown }> {
    const db = this.db;
    const takeover = db.prepare("SELECT value FROM runtime_state WHERE key = 'browser.takeover'").get() as { value: string } | undefined;
    if (takeover && (JSON.parse(takeover.value) as { active?: boolean }).active) return { ok: false, text: 'The owner has taken over the browser. Do not act now; say that you are waiting for the owner.' };
    const tab = taskTab(db, cap.job_id) ?? this.resumedTab(cap.job_id);
    if (!tab) return { ok: false, text: 'This task has no browser tab yet. Open the page with browser_read first; browser_act works only in that tab.' };
    const req: ActRequest = { action: String(a.action) as ActRequest['action'], ref: a.ref ? String(a.ref) : undefined, text: a.text !== undefined ? String(a.text) : undefined, key: a.key ? String(a.key) : undefined, values: Array.isArray(a.values) ? a.values.map(String) : undefined, submit: a.submit === true, fields: Array.isArray(a.fields) ? (a.fields as Array<{ ref: string; value: string }>).map((f) => ({ ref: String(f.ref), value: String(f.value) })) : undefined };
    const tgt = ['--target-id', tab];
    let snap = await this.browserRunner(['snapshot', '--format', 'ai', ...tgt], 'browser.snapshot');
    if (!snap.ok && /timeout/i.test(snap.stderr + snap.stdout)) snap = await this.browserRunner(['snapshot', '--format', 'aria', ...tgt], 'browser.snapshot');   // some pages time out the AI snapshot; the accessibility tree still works
    if (!snap.ok) return { ok: false, text: `could not read the task tab: ${(snap.stderr || snap.stdout).replace(/\s+/g, ' ').slice(0, 200)}` };
    if (req.action === 'snapshot') { this.store.event(cap.job_id, actor, 'browser.act', { action: 'snapshot' }); return { ok: true, text: snap.stdout.slice(0, 60_000) }; }
    const els = parseSnapshot(snap.stdout); const byRef = (r?: string) => els.find((e) => e.ref === r);
    const el = byRef(req.ref);
    const lastTyped = db.prepare("SELECT detail FROM job_events WHERE job_id = ? AND type = 'browser.act' ORDER BY seq DESC LIMIT 1").get(cap.job_id) as { detail: string } | undefined;
    const focused = req.action === 'press' ? (() => { try { const d = JSON.parse(lastTyped?.detail ?? '{}') as { ref?: string }; return byRef(d.ref); } catch { return undefined; } })() : undefined;
    const verdict = decide(req, el, focused);
    const urlNow = await this.tabUrl(tab);
    const typed: string[] = (db.prepare("SELECT detail FROM job_events WHERE job_id = ? AND type = 'browser.act' ORDER BY seq").all(cap.job_id) as Array<{ detail: string }>).map((r) => { try { const d = JSON.parse(r.detail) as { url?: string; value?: string; values?: string[] }; return d.url === urlNow ? [d.value, ...(d.values ?? [])].filter((x): x is string => typeof x === 'string') : []; } catch { return []; } }).flat();
    const elementLog = el ? { ref: el.ref, role: el.role, name: el.name.slice(0, 200) } : { ref: req.ref ?? null };
    if (verdict.verdict === 'refuse') { this.store.event(cap.job_id, actor, 'browser.act_refused', { action: req.action, ...elementLog, reason: verdict.reason, url: urlNow }); return { ok: false, text: `Refused and recorded: ${verdict.reason}.` }; }
    if (verdict.verdict === 'needs_approval' && req.action === 'type' && req.submit && !a.approval_id) {
      // Typing is preparation: do it now; only the Enter that would submit waits for the owner.
      const tr = await this.browserRunner(['type', req.ref!, req.text ?? '', ...tgt], 'browser.type');
      if (!tr.ok) return { ok: false, text: `the browser could not type: ${(tr.stderr || tr.stdout).replace(/\s+/g, ' ').slice(0, 200)}` };
      this.store.event(cap.job_id, actor, 'browser.act', { action: 'type', ...elementLog, url: urlNow, why: 'preparation (the submit is held for approval)', value: req.text ?? '' });
      typed.push(req.text ?? '');
    }
    if (verdict.verdict === 'needs_approval') {
      // Dry-run projects (workspace policies.dry_run): everything up to the final submit, never the submit itself, whatever permission is on.
      try { const pol = JSON.parse((db.prepare('SELECT w.policies FROM jobs j JOIN workspaces w ON w.id = j.workspace_id WHERE j.id = ?').get(cap.job_id) as { policies: string } | undefined)?.policies || '{}') as { dry_run?: boolean }; if (pol.dry_run) { this.store.event(cap.job_id, actor, 'browser.dry_run_stop', { url: urlNow, control: el?.name ?? null }); return { ok: false, text: `Dry run: stopped before "${el?.name ?? 'submit'}". Nothing was submitted. The form stays filled; report what is filled and attached.` }; } } catch { /* no policy */ }
      const target = `${urlNow} — ${el ? `${el.role} "${el.name}"` : `key ${req.key}`}`;
      const content = approvalContent({ url: urlNow, element: el ?? focused, action: req.action === 'type' ? 'press' : req.action, key: req.key ?? (req.submit ? 'Enter' : undefined), typed });
      const shown = JSON.stringify({ page: urlNow, control: el ? `${el.role} "${el.name}"` : `Enter${focused ? ` in ${focused.role} "${focused.name}"` : ''}`, values_entered_in_this_tab: typed }, null, 1);
      let approvalId = a.approval_id ? String(a.approval_id) : null;
      // The owner's "Submit job applications without asking": a submit/next/apply control on a job site is allowed by it, recorded
      // exactly like an approval (page, control, values hash), and performed once below. Anything else still asks.
      const ctl = el?.name ?? focused?.name ?? '';
      if (!approvalId && verdict.action_kind === 'send' && isJobSite(urlNow) && isApplicationControl(ctl)) {
        const perm = jobApplicationPermission(db);
        if (perm) { const ap = this.approvals.request({ job_id: cap.job_id, action_kind: verdict.action_kind, target, content, evidence: [{ shown_to_owner: shown }] }); this.approvals.decide(ap.id, 'approved', `permission:${perm.id}`, 'covered by "Submit job applications without asking"'); this.store.event(cap.job_id, actor, 'permission.used', { permission: perm.id, approval: ap.id, kind: 'job_application', url: urlNow, control: ctl }); approvalId = ap.id; }
      }
      const v = approvalId ? this.approvals.verify(approvalId, { kind: verdict.action_kind, target, content }) : null;
      if (!v || !v.ok) {
        // An identical pending request is reused instead of piling up duplicates.
        const pending = db.prepare("SELECT id FROM approvals WHERE job_id = ? AND status = 'pending' AND action_kind = ? AND target = ? AND content_hash = ?").get(cap.job_id, verdict.action_kind, target, crypto.createHash('sha256').update(content).digest('hex')) as { id: string } | undefined;
        const apr = pending ? { id: pending.id } : this.approvals.request({ job_id: cap.job_id, action_kind: verdict.action_kind, target, content, evidence: [{ shown_to_owner: shown }] });
        this.store.event(cap.job_id, actor, 'browser.act_refused', { action: req.action, ...elementLog, reason: v ? `approval ${v.reason}` : 'needs the owner\'s approval', approval_id: apr.id, url: urlNow });
        return { ok: false, text: `Not done: ${verdict.reason}. This needs the owner's approval of exactly this page, control and the values entered (${apr.id}${v ? `; the approval given was ${v.reason}` : ''}). Nothing was submitted. Report that it is waiting for the owner's decision; do not try another way to submit.`, data: { approval_id: apr.id } };
      }
      // Approved for exactly this content: perform once.
      const key = `browser:${approvalId}`;
      if (db.prepare("SELECT 1 FROM actions WHERE idempotency_key = ? AND status = 'performed'").get(key)) return { ok: false, text: `approval ${approvalId} was already used; nothing was done again` };
      const actId = newId('act'); const t0 = now();
      db.prepare("INSERT INTO actions(id, job_id, idempotency_key, kind, consequential, target, content_hash, approval_id, status, created_at) VALUES (?,?,?,?,1,?,?,?,'pending',?)").run(actId, cap.job_id, key, verdict.action_kind, target, crypto.createHash('sha256').update(content).digest('hex'), approvalId, t0);
      this.approvals.consume(approvalId!);
      const r = req.action === 'click' ? await this.browserRunner(['click', req.ref!, ...tgt], 'browser.click') : await this.browserRunner(['press', 'Enter', ...tgt], 'browser.press');
      // A browser submission has no receipt: success of the click is not proof the site accepted it.
      db.prepare('UPDATE actions SET status = ?, performed_at = ?, result = ? WHERE id = ?').run(r.ok ? 'performed' : 'failed', now(), JSON.stringify({ clicked: r.ok, outcome: r.ok ? 'uncertain: the site response must be read from the page' : (r.stderr || r.stdout).slice(0, 200) }), actId);
      this.store.event(cap.job_id, actor, r.ok ? 'action.performed' : 'action.failed', { action_id: actId, approval_id: approvalId, kind: verdict.action_kind, via: 'browser_act', ...elementLog });
      return { ok: r.ok, text: r.ok ? 'Submitted once under the owner\'s approval. Read the page to see what the site did; the result is uncertain until you do.' : 'The approved action failed to run; it was not retried.' };
    }
    // Allowed preparation / navigation.
    let r: { ok: boolean; stdout: string; stderr: string };
    let extra: Record<string, unknown> = {};
    switch (req.action) {
      case 'click': r = await this.browserRunner(['click', req.ref!, ...tgt], 'browser.click'); break;
      case 'type': r = await this.browserRunner(['type', req.ref!, req.text ?? '', ...(req.submit ? ['--submit'] : []), ...tgt], 'browser.type'); extra = { value: req.text ?? '' }; break;
      case 'press': r = await this.browserRunner(['press', req.key ?? '', ...tgt], 'browser.press'); break;
      case 'select': r = await this.browserRunner(['select', req.ref!, ...(req.values ?? []), ...tgt], 'browser.select'); extra = { values: req.values ?? [] }; break;
      case 'scroll': r = await this.browserRunner(['scrollintoview', req.ref!, ...tgt], 'browser.scroll'); break;
      case 'fill': r = await this.browserRunner(['fill', '--fields', JSON.stringify((req.fields ?? []).map((f) => ({ ref: f.ref, value: f.value }))), ...tgt], 'browser.fill'); extra = { values: (req.fields ?? []).map((f) => f.value) }; break;
      case 'wait': r = { ok: true, stdout: '', stderr: '' }; await new Promise((res) => setTimeout(res, Math.min(Number(a.ms ?? 1500), 10_000))); break;
      case 'upload': {
        // Only a saved result this task may read (same scope and hash checks as read_artifact) is attached. It is staged in OpenClaw's
        // uploads folder (the only place its browser accepts files from), per task, then attached to the file field or chooser at ref.
        const f = artifactFile(db, cap.job_id, String(a.artifact_id ?? ''));
        if (!f.ok) return { ok: false, text: `Not attached: ${f.reason}.` };
        const inVmU = (this.cfg as { browserInComputer?: boolean }).browserInComputer; const jobDir = cap.job_id.replace(/[^a-z0-9-]/gi, '');
        let staged: string;
        if (inVmU) { staged = path.posix.join(await computerTmpRoot(), 'uploads', jobDir, path.basename(f.path)); const cp = await toComputer(staged, f.buf); if (!cp.ok) return { ok: false, text: `Not attached: could not hand the file to the assistants' computer (${cp.error}).` }; }
        else { const stage = path.join('/tmp/openclaw/uploads', jobDir); fs.mkdirSync(stage, { recursive: true, mode: 0o700 }); staged = path.join(stage, path.basename(f.path)); fs.writeFileSync(staged, f.buf, { mode: 0o600 }); }
        // Set the file input directly first (works for hidden inputs behind "Attach" buttons); fall back to clicking the chooser.
        // Then check the page really holds the file (in a file field, or shown by name after the form re-renders, as Greenhouse does), so "attached" is never claimed for a stuck upload.
        const fname = path.basename(staged);
        const holds = async () => { const ev = await this.browserRunner(['evaluate', '--fn', `() => [...document.querySelectorAll('input[type=file]')].some((i) => [...(i.files || [])].some((f) => f.name === ${JSON.stringify(fname)})) || (document.body.innerText || '').includes(${JSON.stringify(fname)})`, ...tgt], 'browser.evaluate', 20_000); return ev.ok && /true/.test(ev.stdout); };
        const tries: string[][] = a.file_input === false ? [['--ref', req.ref!], ['--input-ref', req.ref!]] : [['--input-ref', req.ref!], ['--ref', req.ref!]];
        r = { ok: false, stdout: '', stderr: 'not attempted' };
        for (const how of tries) { r = await this.browserRunner(['upload', staged, ...how, '--timeout-ms', '20000', ...tgt], 'browser.upload', 45_000); if (r.ok && await holds()) break; r = { ...r, ok: false, stderr: r.stderr || 'the page does not hold the file after this attempt' }; }
        if (!r.ok) return { ok: false, text: `Not attached: the page does not show ${fname} in any file field after trying the file input directly and the chooser. Take a fresh snapshot, find the real file field (often an input next to "Attach"/"Choose File"), and try that ref; or use another route the site offers (paste the resume text, a "Upload resume" link).` };
        extra = { artifact_id: String(a.artifact_id), file: path.basename(f.path), sha256: f.sha256 }; break;
      }
      case 'download': {
        const name = (String(a.filename ?? 'download.bin').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'download.bin').slice(0, 120);
        const dir = path.join(path.resolve(cap.workspace), 'downloads'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const dest = path.join(dir, name); if (fs.existsSync(dest)) return { ok: false, text: `downloads/${name} already exists; choose another filename` };
        const inVm = (this.cfg as { browserInComputer?: boolean }).browserInComputer; const vmDest = inVm ? path.posix.join(await computerTmpRoot(), 'downloads', cap.job_id.replace(/[^a-z0-9-]/gi, ''), name) : '';
        r = await this.browserRunner(['download', req.ref!, inVm ? vmDest : dest, ...tgt, '--timeout-ms', '60000'], 'browser.download', 90_000);
        if (inVm && r.ok) { const back = await fromComputer(vmDest, dest); if (!back.ok) return { ok: false, text: `the download finished in the assistants' computer but could not be copied back (${back.error})` }; }
        if (r.ok && fs.existsSync(dest)) {
          const size = fs.statSync(dest).size; if (size > 50 * 1024 * 1024) { fs.rmSync(dest); return { ok: false, text: 'the download was larger than 50 MB and was removed' }; }
          const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex'); const id = newId('art');
          db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, cap.job_id, this.store.get(cap.job_id)?.stage_name ?? 'claude', 'file', dest, sha, `Downloaded: ${name}`, JSON.stringify({ actor, downloaded_from: urlNow, element: elementLog, bytes: size }), now());
          this.store.event(cap.job_id, actor, 'artifact.saved', { id, path: `downloads/${name}`, sha256: sha, downloaded: true });
          extra = { artifact_id: id, bytes: size };
        }
        break;
      }
      default: return { ok: false, text: 'unknown action' };
    }
    this.store.event(cap.job_id, actor, r.ok ? 'browser.act' : 'browser.act_failed', { action: req.action, ...elementLog, url: urlNow, why: verdict.reason, ...extra });
    if (!r.ok) return { ok: false, text: `the browser could not ${req.action}: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').slice(0, 200)}` };
    return { ok: true, text: `${req.action} done (${verdict.reason}).${req.action === 'download' && extra.artifact_id ? ` Saved as artifact ${extra.artifact_id} (${extra.bytes} bytes).` : ''}${req.action === 'upload' ? ` The page now holds ${String(extra.file)}; click the form's own submit/upload button next.` : ''} Take a snapshot to see the page now.`, data: extra };
  }

  private async tabUrl(tab: string): Promise<string> { try { const r = await fetch(`http://127.0.0.1:${this.cfg.browserCdpPort}/json`, { signal: AbortSignal.timeout(1500) }); const t = ((await r.json()) as Array<{ id: string; url: string }>).find((x) => x.id === tab); return t?.url ?? 'unknown page'; } catch { return 'unknown page'; } }
}

function summarize(args: Record<string, unknown>): Record<string, unknown> { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(args)) o[k] = typeof v === 'string' ? v.slice(0, 120) : v; return o; }

/** Turns that must not start new work: automatic report turns, and tasks started by an event trigger (their payload is untrusted
 *  outside data and could otherwise turn into delegated tasks or schedules). */
export function notOwnerInitiated(inputs: string | null | undefined): string | null {
  let i: { automatic?: boolean; trigger_id?: string } = {}; try { i = JSON.parse(inputs || '{}'); } catch { /* treat as owner input */ }
  if (i.automatic) return 'an automatic report';
  if (i.trigger_id) return 'a task started by an event trigger';
  return null;
}
