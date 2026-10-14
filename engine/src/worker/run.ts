import { Vault } from '../memory/vault.ts';
import { eligibilityClause, type Level } from '../usage/governor.ts';
import { conversationAttachments } from '../chat/attachments.ts';
import { installSkills } from '../skills/install.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { JobStore, now } from '../jobs/store.ts';
import type { Job } from '../jobs/types.ts';
import { ApprovalStore } from '../approvals/store.ts';
import { ActionStore } from '../actions/store.ts';
import type { ModelRuntime, TurnResult } from '../runtime/types.ts';
import { renderPrompt, type StageDef } from '../workflows/index.ts';
import { Definitions } from '../model/definitions.ts';
import { DETERMINISTIC } from './deterministic.ts';
import { plainForOwner } from '../model/wording.ts';
import type { Logger } from '../log.ts';
import { issueCapability, revokeCapability, mcpJson } from '../broker/capabilities.ts';
import { ChatStore, CHAT_WORKFLOW } from '../chat/store.ts';
import { progressWording } from '../model/wording.ts';
import { releaseTaskTabs } from '../browser/tabs.ts';
import { readingDue, recordReading, refreshGovernor } from '../usage/governor.ts';

export interface RunDeps {
  db: DB; store: JobStore; approvals: ApprovalStore; actions: ActionStore; runtime: ModelRuntime; log: Logger;
  workspacesDir: string; runDir: string; owner: string; leaseSeconds: number; heartbeatSeconds: number;
  browserCheck?: (site: string) => Promise<{ signed_in: boolean; evidence: string }>;
  /** closes one managed-browser tab by DevTools id; true when it was closed */
  closeTab?: (tabId: string) => Promise<boolean>;
  /** returns true when the Claude identity is currently usable (used before starting a claude stage) */
  claudeAvailable?: () => Promise<{ ok: boolean; reason?: 'auth_required' | 'limited' | 'unreachable'; resetAt?: string | null }>;
}

export type RunOutcome = 'completed' | 'paused' | 'retry' | 'failed' | 'released';

/** Execute one leased job from its last verified checkpoint until it completes, pauses, or fails. */
export async function runJob(deps: RunDeps, jobId: string, opts: { signal?: AbortSignal } = {}): Promise<RunOutcome> {
  const { store, log } = deps;
  const actor = deps.owner;
  let job = store.get(jobId)!;
  const defs = new Definitions(deps.db);
  const wf = defs.getWorkflow(job.kind);
  if (!wf) { store.failTerminal(jobId, actor, `unknown workflow ${job.kind}`, 'This task uses a workflow that no longer exists. Cancel it or restore the workflow.', 'WORKFLOW_MISSING'); return 'failed'; }
  const wsRow = job.workspace_id ? (deps.db.prepare('SELECT root_path, status FROM workspaces WHERE id = ?').get(job.workspace_id) as { root_path: string; status: string } | undefined) : undefined;
  if (job.workspace_id && !wsRow) { store.failTerminal(jobId, actor, `workspace ${job.workspace_id} not found`, 'The task belongs to a workspace that no longer exists.', 'WORKSPACE_MISSING'); return 'failed'; }
  // Conversation turns share one folder (and one persistent lead session) per conversation; every other task gets its own.
  // Group chats: one folder (and one session) per member, so concurrent members never share a capability or .mcp.json.
  const convType = wf.id === CHAT_WORKFLOW && job.conversation_id ? ((deps.db.prepare('SELECT type FROM conversations WHERE id = ?').get(job.conversation_id) as { type: string } | undefined)?.type ?? 'direct') : null;
  const workspace = wf.id === CHAT_WORKFLOW && job.conversation_id
    ? path.join(wsRow?.root_path ?? path.join(deps.workspacesDir, '_unscoped'), 'conversations', job.conversation_id, ...(convType === 'group' ? ['members', job.agent_role] : []))
    : path.join(wsRow?.root_path ?? path.join(deps.workspacesDir, '_unscoped'), 'tasks', job.id);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });

  // Resume point: latest verified checkpoint decides the stage index and prior payload.
  const cp = store.latestVerified(jobId);
  let stageIndex = 0; let previous: Record<string, unknown> = {};
  if (cp) {
    const payload = JSON.parse(cp.payload) as Record<string, unknown>;
    if (cp.phase === 'after') { stageIndex = cp.stage_index + 1; previous = (payload.result as Record<string, unknown>) ?? payload; }
    else { stageIndex = cp.stage_index; previous = (payload.previous as Record<string, unknown>) ?? {}; }
    store.event(jobId, actor, 'job.resumed', { from_checkpoint: cp.id, stage_index: stageIndex, phase: cp.phase });
  }
  if (job.state === 'leased') job = store.transition(jobId, 'running', actor);
  // Owner stop: when the task is cancelled while we run it, abort the in-flight Claude turn (chat.abort + /acp cancel) and return.
  const stopper = new AbortController(); let stopped = false;
  const checkStop = () => { const cur = store.get(jobId); if (cur && cur.state === 'cancelled' && !stopped) { stopped = true; log.info('owner stop observed; aborting the running step', { jobId }); stopper.abort('stopped by the owner'); } };
  opts.signal?.addEventListener('abort', () => stopper.abort(typeof opts.signal?.reason === 'string' ? opts.signal.reason : 'interrupted by an engine shutdown or restart'), { once: true });
  const hb = setInterval(() => { checkStop(); if (stopped) return; if (!store.heartbeat(jobId, actor, deps.leaseSeconds)) { log.warn('lost lease', { jobId }); } }, deps.heartbeatSeconds * 1000);
  const stopWatch = setInterval(checkStop, Math.min(2000, deps.heartbeatSeconds * 1000));
  const beat = (note: string) => { if (stopped) return; store.heartbeat(jobId, actor, deps.leaseSeconds); store.patch(jobId, { next_action: progressWording(note) }); };

  try {
    for (; stageIndex < wf.stages.length; stageIndex++) {
      const stage = wf.stages[stageIndex];
      job = store.get(jobId)!;
      if (job.lease_owner !== actor) { log.warn('lease no longer ours; releasing', { jobId }); return 'released'; }
      if (opts.signal?.aborted) { store.transition(jobId, 'queued', actor, { next_action: 'resume from last verified checkpoint' }, { reason: 'shutdown' }); return 'released'; }
      checkStop(); if (stopped) { if (store.get(jobId)?.state === 'cancelled') store.patch(jobId, { lease_owner: null, lease_expires_at: null, lease_heartbeat_at: null, next_action: null }); return 'released'; }
      // The governor is checked again before every Claude step, not only at lease time: a job leased before the level changed waits.
      if ((stage.kind === 'claude' || stage.kind === 'chat') && stageIndex > 0) {
        const gv = (() => { try { const g = deps.db.prepare("SELECT value FROM runtime_state WHERE key = 'usage.governor'").get() as { value: string } | undefined; return g ? JSON.parse(g.value) as { level?: Level; claude_kinds?: string[] } : {}; } catch { return {}; } })();
        const el = eligibilityClause(gv.level ?? 'normal', gv.claude_kinds ?? []);
        if (el.sql && !deps.db.prepare(`SELECT 1 FROM jobs j WHERE j.id = ?${el.sql}`).get(jobId, ...(el.params as never[]))) { store.transition(jobId, 'queued', actor, { next_action: 'resume from last verified checkpoint', lease_owner: null, lease_expires_at: null, lease_heartbeat_at: null } as never, { reason: `usage ${gv.level}: waiting before the next Claude step` }); return 'paused'; }
      }
      const attempt = (job.stage_index === stageIndex ? job.stage_attempt : 0) + 1;
      store.setStage(jobId, stageIndex, stage.name, attempt);
      job = store.get(jobId)!;   // the stage must see the attempt number it is running under
      store.checkpoint(jobId, { stage_index: stageIndex, stage_name: stage.name, attempt, phase: 'before', payload: { previous, started_at: now() }, session_ref: job.session_ref });
      beat(`running stage ${stage.name}`);
      const res = await executeStage(deps, job, stage, { workspace, previous, actor, beat, signal: stopper.signal, defs });
      checkStop();
      if (stopped) { store.event(jobId, actor, 'turn.cancelled', { stage: stage.name, reason: opts.signal?.aborted ? 'shutdown' : 'owner stop' }); if (store.get(jobId)?.state === 'cancelled') store.patch(jobId, { lease_owner: null, lease_expires_at: null, lease_heartbeat_at: null, next_action: null }); if (opts.signal?.aborted && store.get(jobId)?.state === 'running') { store.transition(jobId, 'queued', actor, { next_action: 'resume from last verified checkpoint' }, { reason: 'shutdown' }); } return 'released'; }
      if (res.kind === 'ok') {
        previous = { ...previous, ...res.payload };
        store.checkpoint(jobId, { stage_index: stageIndex, stage_name: stage.name, attempt, phase: 'after', payload: { result: previous, finished_at: now() }, session_ref: store.get(jobId)!.session_ref });
        continue;
      }
      if (res.kind === 'wait_reset') { store.waitForReset(jobId, actor, res.resetAt, { message: res.message, stage: stage.name }, res.probeCount ?? 0); return 'paused'; }
      if (res.kind === 'wait_auth') { store.waitForAuth(jobId, actor, res.identity, res.operatorAction); return 'paused'; }
      if (res.kind === 'wait_approval') { store.transition(jobId, 'waiting_for_approval', actor, { waiting_on: `approval:${res.approvalId ?? 'pending'}`, blocker_code: 'OWNER_APPROVAL_REQUIRED', operator_action: res.operatorAction, next_action: 'owner decision in Approvals' }, { stage: stage.name }); return 'paused'; }
      if (res.kind === 'retry') { store.failRetryable(jobId, actor, res.reason); return 'retry'; }
      store.failTerminal(jobId, actor, res.reason, res.operatorAction, res.code); return 'failed';
    }
    const r = store.complete(jobId, actor, previous);
    if (r.ok) return 'completed';
    store.failTerminal(jobId, actor, `success contract unmet: ${r.reasons.join('; ')}`, `The job finished its stages but did not satisfy its contract (${r.reasons.join('; ')}). Re-queue it after fixing the inputs, or cancel it.`, 'CONTRACT_UNMET');
    return 'failed';
  } finally {
    clearInterval(hb); clearInterval(stopWatch);
    const final = store.get(jobId);
    if (final && wf.id === CHAT_WORKFLOW && final.message_id) settleDelivery(deps, final);
    if (final && ['completed','failed_terminal','cancelled'].includes(final.state)) {
      revokeCapability(deps.runDir, jobId);
      deps.db.prepare("DELETE FROM runtime_state WHERE key = 'browser.in_use' AND json_extract(value, '$.job_id') = ?").run(jobId);
      if (deps.closeTab) { try { const r = await releaseTaskTabs(deps.db, jobId, deps.closeTab); if (r.closed.length || r.kept.length) store.event(jobId, actor, 'browser.tabs_released', r); } catch (e) { log.warn('tab release failed', { jobId, err: (e as Error).message }); } }
      // A finished task's persistent session would otherwise keep an adapter and a Claude process alive; conversations keep theirs.
      if (wf.id !== CHAT_WORKFLOW && final.session_ref && deps.runtime.closeSession) { try { await deps.runtime.closeSession(final.session_ref); store.event(jobId, actor, 'session.closed', { session_ref: final.session_ref }); } catch (e) { log.warn('session close failed', { jobId, err: (e as Error).message }); } }
    }
  }
}

type StageOutcome =
  | { kind: 'ok'; payload: Record<string, unknown> }
  | { kind: 'wait_reset'; resetAt: string | null; message: string; probeCount?: number }
  | { kind: 'wait_auth'; identity: string; operatorAction: string }
  | { kind: 'wait_approval'; approvalId: string | null; operatorAction: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'fail'; reason: string; operatorAction: string; code: string };

async function executeStage(deps: RunDeps, job: Job, stage: StageDef, ctx: { workspace: string; previous: Record<string, unknown>; actor: string; beat: (n: string) => void; signal?: AbortSignal; defs: Definitions }): Promise<StageOutcome> {
  const { store } = deps;
  switch (stage.kind) {
    case 'deterministic': {
      const fn = DETERMINISTIC[stage.fn ?? ''];
      if (!fn) return { kind: 'fail', reason: `unknown deterministic function ${stage.fn}`, operatorAction: 'Fix the workflow definition.', code: 'WORKFLOW_INVALID' };
      try {
        const r = await fn({ db: deps.db, store, job, workspace: ctx.workspace, previous: ctx.previous, actor: ctx.actor, approvals: deps.approvals, actions: deps.actions });
        if (r.ok) return { kind: 'ok', payload: r.payload };
        return r.terminal ? { kind: 'fail', reason: r.reason, operatorAction: r.operatorAction ?? 'See job detail.', code: 'STAGE_FAILED' } : { kind: 'retry', reason: r.reason };
      } catch (e) { return { kind: 'retry', reason: `stage ${stage.name} threw: ${(e as Error).message}` }; }
    }
    case 'browser_check': {
      const site = renderPrompt(stage.site ?? '', { site: String(((JSON.parse(job.inputs || '{}') as { site?: string }).site) ?? (JSON.parse(job.input_refs) as string[])[0] ?? '') });
      if (!deps.browserCheck) return { kind: 'fail', reason: 'browser adapter not configured', operatorAction: 'Enable the managed browser in Connections.', code: 'BROWSER_NOT_CONFIGURED' };
      try {
        const r = await deps.browserCheck(site);
        deps.db.prepare('INSERT INTO browser_sites(site, profile, signed_in, check_method, last_checked_at, evidence) VALUES (?,?,?,?,?,?) ON CONFLICT(site) DO UPDATE SET signed_in=excluded.signed_in, check_method=excluded.check_method, last_checked_at=excluded.last_checked_at, evidence=excluded.evidence')
          .run(site, 'claudebot', r.signed_in ? 1 : 0, 'dom-marker', now(), r.evidence);
        if (!r.signed_in) return { kind: 'wait_auth', identity: `browser:${site}`, operatorAction: `Open the ClaudeBot browser profile and sign in to ${site}. Tasks that depend on it resume automatically.` };
        return { kind: 'ok', payload: { signed_in: true, site, evidence: r.evidence } };
      } catch (e) { return { kind: 'retry', reason: `browser check failed: ${(e as Error).message}` }; }
    }
    case 'approval_gate': {
      const kind = stage.approval_kind ?? 'send';
      const pending = deps.db.prepare("SELECT id FROM approvals WHERE job_id = ? AND action_kind = ? AND status = 'pending' ORDER BY created_at DESC").get(job.id, kind) as { id: string } | undefined;
      const approved = deps.db.prepare("SELECT id FROM approvals WHERE job_id = ? AND action_kind = ? AND status = 'approved'").get(job.id, kind) as { id: string } | undefined;
      if (approved) return { kind: 'ok', payload: { approval_id: approved.id, gate: kind } };
      const rejected = deps.db.prepare("SELECT id, decision_note FROM approvals WHERE job_id = ? AND action_kind = ? AND status = 'rejected'").get(job.id, kind) as { id: string; decision_note: string | null } | undefined;
      if (rejected) return { kind: 'fail', reason: `owner rejected ${kind}: ${rejected.decision_note ?? ''}`, operatorAction: 'The owner rejected this action. Nothing further will happen for this job.', code: 'OWNER_REJECTED' };
      if (!pending) return { kind: 'ok', payload: { gate: kind, note: 'no action requested approval; nothing to execute' } };
      return { kind: 'wait_approval', approvalId: pending.id, operatorAction: `Review approval ${pending.id} (${kind}) in the Approvals screen.` };
    }
    case 'review': {
      // Independent deterministic review: research must have sourced evidence for every claim; other work must have at least one saved file whose hash still matches.
      const ev = deps.db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN source_url LIKE \'http%\' THEN 1 ELSE 0 END) AS sourced FROM memory_evidence WHERE job_id = ?').get(job.id) as { n: number; sourced: number | null };
      const files = deps.db.prepare("SELECT path, sha256 FROM artifacts WHERE job_id = ? AND kind = 'file'").all(job.id) as Array<{ path: string | null; sha256: string | null }>;
      const filesOk = files.length > 0 && files.every((f) => f.path && fs.existsSync(f.path) && crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex') === f.sha256);
      const verdict = ev.n > 0 ? ((ev.sourced ?? 0) === ev.n ? 'pass' : 'fail') : (filesOk ? 'pass' : 'fail');
      deps.db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, title, provenance, created_at) VALUES (?,?,?,?,?,?,?)').run(`art-review-${job.id}-${Date.now()}`, job.id, stage.name, 'note', `Review verdict: ${verdict}`, JSON.stringify({ evidence: ev }), now());
      if (verdict === 'fail') return { kind: 'fail', reason: ev.n > 0 ? `review failed: ${ev.n} evidence rows, ${ev.sourced ?? 0} sourced` : `review failed: ${files.length} saved file(s), hashes verified: ${filesOk}`, operatorAction: ev.n > 0 ? 'The reviewer rejected the output because claims lack sources. Try again with stricter instructions.' : 'The reviewer found no intact saved output. Try again.', code: 'REVIEW_FAILED' };
      return { kind: 'ok', payload: { verdict, summary: String(ctx.previous.summary ?? 'review passed') } };
    }
    case 'chat': {
      const chat = new ChatStore(deps.db, store);
      const conv = job.conversation_id ? chat.get(job.conversation_id) : undefined;
      const msg = job.message_id ? chat.message(job.message_id) : undefined;
      if (!conv || !msg) return { kind: 'fail', reason: 'conversation or message missing', operatorAction: 'This reply belongs to a conversation that no longer exists.', code: 'CHAT_CONTEXT_MISSING' };
      if (deps.claudeAvailable) {
        const a = await deps.claudeAvailable();
        if (!a.ok && a.reason === 'auth_required') return { kind: 'wait_auth', identity: 'claude', operatorAction: 'Sign in to continue: run `CLAUDE_CONFIG_DIR=$HOME/.claudebot/claude claude auth login --claudeai` in Terminal. The reply resumes automatically.' };
        if (!a.ok && a.reason === 'limited') return { kind: 'wait_reset', resetAt: a.resetAt ?? null, message: 'Claude usage limit reached', probeCount: Number((JSON.parse(job.limit_info ?? '{}') as { probe_count?: number }).probe_count ?? 0) };
        if (!a.ok) return { kind: 'retry', reason: 'Claude runtime unreachable' };
      }
      // The turn runs as the assistant it was created for (direct chat: that assistant; group: the addressed member or the router).
      const agentId = job.agent_role || stage.agent || 'coordinator'; const agent = ctx.defs.getAgent(agentId);
      if (!agent) return { kind: 'fail', reason: `agent ${agentId} not found`, operatorAction: 'This assistant no longer exists. Restore it on the Assistants screen.', code: 'AGENT_MISSING' };
      if (!agent.enabled) return { kind: 'retry', reason: `${agent.name} is turned off; the message waits until they are turned back on` };
      const inputs = (() => { try { return JSON.parse(job.inputs || '{}') as Record<string, unknown>; } catch { return {}; } })();
      const isLead = agentId === 'coordinator'; const isGroup = conv.type === 'group'; const router = inputs.router === true;
      const members = chat.members(conv.id).map((m) => ctx.defs.getAgent(m.agent_id)).filter((a): a is NonNullable<typeof a> => !!a);
      const sessKey = chat.sessionKey(conv, agentId); const sessRef = isGroup ? chat.memberSession(conv.id, agentId) : conv.session_ref;
      chat.refreshDelivery(msg.id); if (msg.kind === 'handoff') deps.db.prepare("UPDATE messages SET delivery = 'delivering' WHERE id = ?").run(msg.id);
      const wsName = job.workspace_id ? ((deps.db.prepare('SELECT name FROM workspaces WHERE id = ?').get(job.workspace_id) as { name: string } | undefined)?.name ?? job.workspace_id) : 'General';
      const kinds = ctx.defs.listWorkflows().filter((w) => w.enabled && w.id !== CHAT_WORKFLOW && !w.id.startsWith('system.') && w.id !== 'browser.login_health' && w.id !== 'monitor.scheduled' && !['assistant.draft', 'report.morning', 'priority.rank'].includes(w.id));
      const kindLines = kinds.map((w) => `- kind "${w.id}" → ${ctx.defs.getAgent(w.default_agent)?.name ?? w.default_agent}: ${w.description}${w.inputs.length ? ` (optional inputs: ${w.inputs.map((i) => i.name).join(', ')})` : ''}`).join('\n');
      const resume = !!sessRef;
      const updates = chat.updatesSince(conv.id, ctx.defs);
      const nowLocal = new Date(); const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const clock = `Current time: ${nowLocal.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' })} (${tz}); ISO ${nowLocal.toISOString()}.`;
      const routerOnly = isGroup && router && !chat.member(conv.id, agentId);
      // A router that is not in the group only reads and hands off: it never starts work in a group it is not part of.
      const tools = routerOnly ? [...agent.allowed_tools.filter((t) => ['read_records', 'search_evidence', 'search', 'read_memory_rules', 'list_jobs', 'read_artifact', 'list_my_tools'].includes(t)), 'hand_off'] : [...agent.allowed_tools, 'react', 'ask_owner', 'read_message', 'read_conversation', 'post_update', 'share_file', 'continue_working', ...(agent.allowed_tools.includes('browser_act') ? ['record_application'] : []), ...(isGroup ? ['hand_off'] : []), ...(agentId === 'coordinator' ? ['rename_assistant', 'disable_assistant', 'enable_assistant', 'add_member', 'remove_member', 'propose_assistant', 'forget', 'create_group', 'edit_group', 'set_permission', 'add_dependency'] : [])];
      // The owner's own name (Settings key owner_name), so nobody mistakes the owner for the assistant being addressed ("Chief, …").
      const ownerName = String((deps.db.prepare("SELECT value FROM settings WHERE key = 'owner_name'").get() as { value: string } | undefined)?.value ?? '').replace(/^"|"$/g, '').trim();
      const whoOwner = ownerName ? ` The owner is ${ownerName}; when the owner writes "${agent.name.split(/[\s(]+/)[0]}, …" they are talking to you. Work is done for ${ownerName}, never for an assistant.` : '';
      const leadFrame = `You are ${agent.name}, the lead assistant in ClaudeBot, talking with the owner of the project "${wsName}".${whoOwner} Reply briefly in plain, friendly English.
${clock} You are the owner's single point of contact; the owner never picks workflows, assistants or settings.
Chat style: this is a chat, not a document. Write one to three short sentences (at most about 60 words) in plain prose: no headings, no bullet or numbered lists, no tables, no code blocks. The details live in the saved file or the decision card, which the owner sees as a card under your message; say what it is and the one thing that matters. When you request an approval, do not paste the draft text in your reply: say who it goes to and why in one sentence of at most 25 words, because the owner reads the exact text in the card.
${agent.system_instructions ? 'Your standing instructions: ' + agent.system_instructions + '\n' : ''}
How to work:
- Answer directly when you can (questions, small edits to text in the conversation, summaries of results below).
- For real work (research, documents, reading web pages, code changes) delegate with the tool mcp__claudebot__create_job: kind = one of the types below, objective = exactly what should exist when done, including every detail, URL, format and length the owner gave. One task per distinct piece of work. Never duplicate work that is already assigned (see the updates below, or call list_jobs).
- When the owner names who should do a part ("Roger: make the resume", "Oscar: draft the email"), give that part to exactly that assistant: in a group where they are a member use hand_off to them; otherwise create_job with agent_role set to their name. Never give a named assistant's part to someone else.
- A step that needs another's output waits for ALL of it: applications wait for both the job search and the tailored resumes (depends_on both ids). If you notice a missing wait, fix it with add_dependency instead of asking the owner.
- To chain work (research → draft → review), create the later task with depends_on: [earlier task id]; it waits for the earlier task and receives its saved outputs and evidence automatically. Create the whole chain in one reply when the owner asks for it; never wait for a task to finish before creating the next.
- After delegating, tell the owner who is doing what, which tasks wait on which, and that you will report when each is finished. Delegated work runs in the background; this reply does not wait for it. Never say work is finished unless a tool result or an update below confirms it.
- When an update shows a task finished, say in a sentence or two what it produced and name the file (no lists; the file card shows the rest). The updates show only the start of each file; for any detail, quote or later section, call read_artifact with the artifact id (and offset=next_offset to continue) and answer from the full text. If read_artifact refuses, say so plainly.
- Anything that would send, publish, purchase, delete or change production needs the owner's approval: call request_approval with the exact content and target, then tell the owner it is waiting for their decision. Never perform such actions yourself. In this build an approved send or publish can only be written by the owner to a local outbox on this Mac (nothing is delivered to anyone); purchases, deletions and production changes have no executor at all. Say exactly that only when the owner asks how sending works; otherwise do not mention the outbox.
- If the owner asks for something later or on a repeat ("tomorrow at 9", "every Monday"), use mcp__claudebot__create_schedule with the same kind/objective you would give create_job and one of at / cron / every_seconds; confirm the time back in plain words.
- If the owner asks you to create or approve a new assistant (a teammate with its own job), that request is their confirmation: call propose_assistant with the full draft and owner_words (their exact words asking for it); pick a sensible name if they gave none. For a draft already waiting, pass its draft_id with owner_words. It exists once the tool says it was created; then give it the owner's work right away. Never claim it exists before that.
- Files: when you save a document for the owner, it appears in the chat as a file card; to show an existing result here or in someone's direct chat, use share_file. Never paste whole documents into a message, and never say a file is in the chat unless a tool confirmed it.
- Long work: post short progress lines with post_update (e.g. "3 of 8 saved"); your reply then states what was done, with the evidence (files, pages, confirmations).
- If a message in your context says "[message continues …]", call read_message before relying on it; count files from the [file: …] lines.
- When one path is blocked (a contact's address cannot be verified, a page will not load, a source is missing, a form field fails), try the alternatives yourself before reporting: other people (their manager, the team, the hiring committee, a recruiter), other sources (company site, LinkedIn, press, the signed-in Gmail, the team folder) and other routes. Report "stuck" only after that, and list what you tried. Form questions are answered from the owner's resume, memory and ./shared/profile/application-answers.md; only a CAPTCHA, a sign-in or a fact that is truly in none of those goes to the owner, once, in one batched message.
- Keep improving: whenever the owner corrects you, criticises something or states a preference, call remember in this same reply (section Lessons or Preferences, in one plain sentence); team-wide rules go to scope team. Follow your Memory every time.
- The owner can do everything in the app through you: when they ask you (the lead) to rename, add, remove, switch off or switch on an assistant, create one, or create, rename or describe a group, use the matching tool with owner_words quoted from their message. Never tell the owner you cannot do something they can do in the app; if a tool refuses, say exactly what it said.
- When you genuinely need the owner to choose before you can continue (a wording, an option, a direction), call ask_owner with the question and 2-4 short options instead of listing them in text.
- To acknowledge the owner briefly you may add an emoji reaction to their message with react (one at most, only when it fits).
- Never automate a login, MFA or CAPTCHA. If a page needs sign-in, tell the owner to take over the ClaudeBot browser.
- If something cannot be done, say exactly why.
- Talk only about this owner's request and its work. Never mention connected apps, connectors, plugins, tools or sign-in prompts that are unrelated to the request.
Types of work you can assign:
${kindLines}
Do not end with DONE. Do not mention tool names, task ids (job-…), approval ids (apr-…) or artifact ids (art-…) to the owner; name the assistant, the file name or the decision instead ("I've asked the Researcher to…", "it's waiting for your approval on the order form").`;
      const memberFrame = `You are ${agent.name}${agent.role ? `, ${agent.role},` : ''} an assistant in ClaudeBot, talking with the owner of the project "${wsName}".${ownerName ? ` The owner is ${ownerName}; everything you make is for ${ownerName} (resumes, emails and documents are in ${ownerName}'s name, never an assistant's).` : ''} Reply briefly in plain, friendly English.
${clock}
Chat style: this is a chat, not a document. Write one to three short sentences (at most about 60 words) in plain prose: no headings, no bullet or numbered lists, no tables, no code blocks. The details live in the saved file or the decision card, which the owner sees as a card under your message; say what it is and the one thing that matters. When you request an approval, do not paste the draft text in your reply: say who it goes to and why in one sentence, because the owner reads the exact text in the card.
Your job: ${agent.purpose}${agent.responsibilities.length ? `\nYour responsibilities:\n${agent.responsibilities.map((r) => '- ' + r).join('\n')}` : ''}
${agent.system_instructions ? 'Your standing instructions: ' + agent.system_instructions + '\n' : ''}
How to work:
- Do the work yourself with your own tools. Save text outputs with mcp__claudebot__write_artifact (path, title, kind, complete content) and name the file to the owner.
- Never say work is finished unless a tool result confirms it. If something cannot be done, say exactly why.
- Keep going until it is really done: check your own result (open the file, read the confirmation page, run it in your shell). If the request is not finished and you can still make progress, call continue_working before ending this reply. If something failed, try a different route next (another selector, another tool, another site path) and say what changed; never repeat the same failed attempt. Stop and tell the owner only when it is verified done, or truly blocked on them.
- Job applications: after you submit one, call record_application while the confirmation page shows. Once one goes through, save the way that worked on that site with save_skill (if it is not already a team skill). Only a recorded application is submitted; never say "submitted" or "applied" otherwise.
- Every file you save appears in the chat as a file card under your reply; to show an existing result here or in someone's direct chat use share_file. Never paste whole documents into a message, and never say a file is in the chat unless a tool confirmed it.
- For long work, post short progress lines with post_update (e.g. "3 of 8 saved"), then reply with what was done and the evidence.
- If a message in your context says "[message continues …]", call read_message before relying on it.
- When one path is blocked (a contact's address cannot be verified, a page will not load, a source is missing, a form field fails), try the alternatives yourself before reporting: other people (their manager, the team, the hiring committee, a recruiter), other sources (company site, LinkedIn, press, the signed-in Gmail, the team folder) and other routes. Report "stuck" only after that, and list what you tried. Form questions are answered from the owner's resume, memory and ./shared/profile/application-answers.md; only a CAPTCHA, a sign-in or a fact that is truly in none of those goes to the owner, once, in one batched message.
- Keep improving: whenever the owner corrects you, criticises something or states a preference, call remember in this same reply (section Lessons or Preferences, in one plain sentence). Follow your Memory every time.
- Anything that would send, publish, purchase, delete or change production needs the owner's approval${tools.includes('request_approval') ? ': call request_approval with the exact content and target' : '; you cannot request it yourself, so tell the owner what you would need'}. Never perform such actions yourself.
- Never automate a login, MFA or CAPTCHA. Talk only about this owner's request.
Do not end with DONE. Do not mention tool names or ids (job-…, art-…, apr-…) to the owner.`;
      const parts = [isLead ? leadFrame : memberFrame];
      if (isGroup) { const gp = (deps.db.prepare('SELECT title, purpose FROM conversations WHERE id = ?').get(conv.id) as { title: string; purpose: string } | undefined); if (gp?.purpose) parts.push(`This group ("${gp.title || 'Group'}") exists for: ${gp.purpose}`); }
      { // Standing permissions the owner switched on, so no assistant asks the owner to switch on something that is already on.
        const perms = deps.db.prepare("SELECT action_kind, scope_text, expires_at FROM standing_permissions WHERE status = 'active' AND expires_at > ?").all(new Date().toISOString()) as Array<{ action_kind: string; scope_text: string; expires_at: string }>;
        if (perms.length) parts.push(`The owner's standing permissions (already on; never ask the owner to turn these on):\n${perms.map((p) => `- ${p.scope_text.split(':')[0]}${p.action_kind === 'job_application' ? ' — on job sites, apply/next/submit is done at once and recorded; just do it and post the receipt' : ''} (until ${p.expires_at.slice(0, 10)})`).join('\n')}`);
      }
      if ((deps.runtime as { sharedFolder?: boolean }).sharedFolder) parts.push('Your computer: you work inside the assistants\' private Linux computer. You have a real shell there (your Bash tool): run code (python3, node), process files, and install what you need for yourself (pip install --user, npm install in your folder). Use it to check your own work. It cannot reach the owner\'s Mac; results for the owner still go through write_artifact or render_document.');
      if ((deps.runtime as { sharedFolder?: boolean }).sharedFolder) parts.push('Team folder: ./shared in your working folder is the team\'s shared folder in the assistants\' computer. Every assistant sees the same files there, across chats and tasks. Put things teammates will reuse there (for example resumes/, applications/, notes/); results the owner should see still go through write_artifact or render_document.');
      { let mem = ''; try { mem = new Vault().context(agent); } catch (e) { deps.log.warn('memory vault unreadable', { err: (e as Error).message }); } if (mem) parts.push(mem); }
      if (job.stage_attempt > 1) parts.push('ClaudeBot restarted while you were working on this (the owner did not stop you and nothing changed in what they asked). Carry on from where you were and finish the request; do not stop to ask whether to continue.');
      { const recent = chat.elsewhere(agentId, conv.id); if (recent) parts.push(`What happened recently in your other conversations with the owner and the team (the durable record; use it when the owner refers to earlier work, "last time" or a mistake, and never ask the owner to repeat what is here):\n${recent}`); }
      { // Team skills for the sites or topics in play (from the request and the recent conversation).
        let sk = ''; try { sk = new Vault().skillsFor(`${msg.content}\n${chat.transcript(conv.id, { limit: 12, beforeSeq: msg.seq + 1 })}`); } catch { /* optional */ } if (sk) parts.push(`Team skills for this (methods that worked before; follow them, and improve them with save_skill if you find a better way):\n${sk}`); }
      if (isLead) {   // what is waiting on the owner across every conversation, from the ledger, so the lead never says "nothing" while a decision waits
        const pend = deps.db.prepare("SELECT ap.action_kind, ap.target, ap.created_at, j.agent_role, c.title, c.type FROM approvals ap LEFT JOIN jobs j ON j.id = ap.job_id LEFT JOIN conversations c ON c.id = j.conversation_id WHERE ap.status = 'pending' ORDER BY ap.created_at").all() as Array<{ action_kind: string; target: string; created_at: string; agent_role: string | null; title: string | null; type: string | null }>;
        const qs = deps.db.prepare("SELECT m.sender, m.content, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.kind = 'question' AND json_extract(m.meta, '$.options') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.role = 'owner')").all() as Array<{ sender: string; content: string; title: string | null }>;
        const drafts = (deps.db.prepare("SELECT count(*) AS n FROM assistant_drafts WHERE status = 'pending'").get() as { n: number }).n;
        parts.push(pend.length || qs.length || drafts ? `Waiting on the owner right now (from the work record, every conversation):\n${[...pend.map((p) => `- decision: ${p.action_kind} → ${p.target} (asked by ${p.agent_role ?? 'an assistant'}${p.title ? ` in "${p.title}"` : ''}${p.type === 'group' ? ', private review' : ''})`), ...qs.map((q) => `- question from ${q.sender}${q.title ? ` in "${q.title}"` : ''}: ${q.content}`), ...(drafts ? [`- ${drafts} assistant draft(s) to name and confirm`] : [])].join('\n')}` : 'Waiting on the owner right now: nothing (no pending decisions, questions or drafts in the work record).');
      }
      { const att = conversationAttachments(deps.db, conv.id); if (att.length) parts.push(`Files the owner attached to this conversation (owner uploads, checked text):\n${att.map((x) => `- ${x.title} (result ${x.artifact_id}, from upload task ${x.job_id}, sha256 ${x.sha256.slice(0, 12)})`).join('\n')}\nRead one with read_artifact. To give a file to a specialist, create its task with depends_on: [the upload task id]; it then receives the file automatically.`); }
      if (isGroup) {
        const roster = members.map((m) => `- ${m.name}${m.id === agentId ? ' (you)' : ''}: ${m.role || m.purpose}`).join('\n');
        parts.push(`This is the group chat "${conv.title || 'untitled'}" between the owner and these assistants:\n${roster}${members.some((m) => m.id === agentId) ? '' : `\n(You, ${agent.name}, are not a member; you are only deciding who should answer.)`}\nSpeak only for yourself. You may acknowledge a message with one emoji reaction (react: 👍 🎉 👀 ❤️ ✅, for example 👍 on the owner's request or 🎉 on a teammate's finished work) when it fits; never more than one per reply. To bring in another member, call hand_off with their name and exactly what they should do; they answer in the group. Hand off only when a member genuinely needs to act, and never to acknowledge or repeat.`);
        const waited = (() => { try { return (JSON.parse(job.depends_on || '[]') as string[]).length > 0; } catch { return false; } })(); const others = chat.groupContext(conv.id, agentId, waited ? Number.MAX_SAFE_INTEGER : msg.seq); if (others) parts.push(`Messages in the group since you last spoke:\n${others}`);   /* a turn that waited for another member sees what that member posted meanwhile */
        if (router) parts.push('The owner did not mention anyone. Decide who should answer: reply yourself only if the message is for you or needs no specialist; otherwise call hand_off for the fewest members who need to act (usually one) and tell the owner in one line who is taking it. When one member needs another member\'s result first, hand off to the first member, then hand off to the next with after = the first member\'s name, so it starts when that result is in.');
      }
      const firstTurn = !(deps.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'assistant' LIMIT 1").get(conv.id));
      if (firstTurn && !isGroup) parts.push('This is the first reply in this conversation: start it with one line "Title: <a 3-6 word name for this conversation>", then a blank line, then your reply.');
      if (!resume && !isGroup) { const t = chat.transcript(conv.id, { beforeSeq: msg.seq }); if (t) parts.push(`Conversation so far (your earlier session was closed; this is the durable record):\n${t}`); }
      if (!resume && isGroup && !routerOnly && deps.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'assistant' AND sender = ? AND seq < ? LIMIT 1").get(conv.id, agentId, msg.seq)) { const t = chat.transcript(conv.id, { beforeSeq: msg.seq, names: true }); if (t) parts.push(`The group so far (your earlier session was closed; this is the durable record, including what you said):\n${t}`); }
      if (updates) parts.push(`Updates on delegated work since your last reply:\n${updates}`);
      { // Files the owner attached since this assistant last spoke: images are copied into this turn's folder so Claude can look at them
        // (Read), and documents are named with their text copy's result id.
        const lastMine = (deps.db.prepare("SELECT max(seq) AS s FROM messages WHERE conversation_id = ? AND role = 'assistant' AND sender = ? AND seq < ?").get(conv.id, agentId, msg.seq) as { s: number | null }).s ?? 0;
        const atts = deps.db.prepare("SELECT m.artifact_id, a.path, a.title, a.job_id FROM messages m JOIN artifacts a ON a.id = m.artifact_id WHERE m.conversation_id = ? AND m.kind = 'attachment' AND m.seq > ? AND m.seq <= ? ORDER BY m.seq").all(conv.id, lastMine, msg.seq + 1) as Array<{ artifact_id: string; path: string; title: string; job_id: string }>;
        const lines: string[] = [];
        for (const a of atts) {
          if (/\.(png|jpe?g|gif|webp)$/i.test(a.path) && fs.existsSync(a.path)) { const dir = path.join(ctx.workspace, 'attachments'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const dest = path.join(dir, path.basename(a.path)); if (!fs.existsSync(dest)) fs.copyFileSync(a.path, dest); lines.push(`- image "${a.title}": open attachments/${path.basename(a.path)} with the Read tool to see it`); }
          else { const copy = deps.db.prepare("SELECT id FROM artifacts WHERE job_id = ? AND kind = 'note' LIMIT 1").get(a.job_id) as { id: string } | undefined; lines.push(`- file "${a.title}" (result id ${a.artifact_id}${copy ? `; readable text copy: read_artifact ${copy.id}` : ''})`); }
        }
        if (lines.length) parts.push(`The owner attached:\n${lines.join('\n')}`);
      }
      if (msg.kind === 'handoff') {
        const root = chat.message(String(inputs.chain_root ?? '')); const fromName = String(inputs.handoff_from_name ?? inputs.handoff_from ?? 'Another assistant');
        parts.push(`${root ? `The owner's message: ${root.content}\n` : ''}${fromName} handed this to you: ${String((msg.meta as { request?: string }).request ?? msg.content)}\nDo your part and reply in the group.`);
      } else parts.push(msg.role === 'owner' ? `Owner: ${msg.content}` : `No new message from the owner. (Automatic: ${msg.content}) Report the finished work to the owner now, briefly: what each task produced (name the files), anything partial, blocked or stopped and why, and any decision waiting for them. Do not start new work unless the owner's earlier request clearly needs the next step.`);
      const prompt = parts.join('\n\n');
      issueCapability(deps.runDir, job, ctx.workspace, tools, 6 * 3600, sessKey);
      fs.writeFileSync(path.join(ctx.workspace, '.mcp.json'), mcpJson(path.resolve(import.meta.dirname, '..', '..', '..'), sessKey, path.dirname(deps.runDir)));
      store.patch(job.id, { session_ref: sessRef });
      const bind = (key: string) => { chat.setSession(conv.id, key, agentId); store.patch(job.id, { session_ref: key, runtime_session_id: key }); };
      let r: TurnResult;
      try {
        r = await deps.runtime.startTurn({ jobId: job.id, label: sessKey, sessionRef: sessRef ?? sessKey, role: agentId, cwd: ctx.workspace, prompt, resume, model: agent?.model, timeoutMs: Number(process.env.CLAUDEBOT_STAGE_TIMEOUT_MS ?? (stage.timeoutMs ?? 10 * 60_000)), onHeartbeat: ctx.beat, onSession: (key) => { if (chat.member(conv.id, agentId) && key !== chat.memberSession(conv.id, agentId)) bind(key); else if (!chat.member(conv.id, agentId)) store.patch(job.id, { session_ref: key, runtime_session_id: key }); }, signal: ctx.signal });
      } finally {
        issueCapability(deps.runDir, job, ctx.workspace, [], 6 * 3600, sessKey);   // between turns the session can call nothing
        // A router that is not a member has no membership to keep its session on: close it now (also when the turn threw).
        if (routerOnly) { const ref = store.get(job.id)?.session_ref; if (ref && deps.runtime.closeSession) { try { await deps.runtime.closeSession(ref); store.event(job.id, ctx.actor, 'session.closed', { session_ref: ref, reason: 'router turn (not a member)' }); } catch { /* best effort */ } } store.patch(job.id, { session_ref: null }); }
      }
      if (chat.member(conv.id, agentId) && r.runtimeSessionId && r.runtimeSessionId !== chat.memberSession(conv.id, agentId)) bind(r.runtimeSessionId);
      if (r.ok) {
        deps.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('claude.capacity', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify({ limited: false }), `conversation turn ${job.id} completed`, now());
        let reply = r.text.replace(/\s*DONE\s*$/i, '').trim() || 'I did not produce a reply. Please try again.';
        const titleLine = reply.match(/^\s*Title:\s*(.{3,80}?)\s*(?:\n|$)/i);
        if (titleLine) { reply = reply.slice(titleLine[0].length).trim() || reply; if (!isGroup && (!conv.title || conv.title === chat.defaultTitle(conv.id))) chat.setTitle(conv.id, titleLine[1].replace(/[*_`]/g, '')); }
        // Ask-back guard (owner: "IT NEEDS TO STOP ASKING ME"): a reply that ends by asking whether to do work the team can do itself is sent
        // straight back to do it, and the question is not pushed to Telegram. Real owner matters (messages, money, posts, deletes, passwords,
        // codes, personal answers) may still be asked. One bounce per question: the bounce turn itself is never bounced again.
        const lastSentence = (reply.trim().split(/(?<=[.!?])\s+/).pop() ?? '');
        // A status report that hands the owner work the team can do ("the other eight roles need answers only you can give") is bounced the same way.
        const ownerTodo = /\b(answers? only you can (give|provide)|only you can answer|need(s)? your answers|need(s)? your input|need you to (answer|fill|provide|find|check|look up))\b/i.test(reply);
        const askBack = !String(msg.content ?? '').startsWith('ClaudeBot: do not ask the owner') && (ownerTodo || /\b(should i|shall i|want me to|do you want me to|would you like me to|can i go ahead|ok(ay)? to|or leave (it|them) for later)\b[^?]{0,240}\?\s*$/i.test(lastSentence)
          && !/\b(send|email|e-mail|message|post|publish|pay|buy|purchase|spend|delete|remove)\b/i.test(lastSentence.replace(/\bverify\b[^?]*/i, ''))   // asking to send, spend, post or delete is the owner's call
          && !/\b(password|passcode|verification code|captcha|salary|compensation|pay range|quota|stack rank|essay)\b/i.test(reply.trim().slice(-400)));   // a personal answer may be named in the sentence before the question
        chat.add({ conversation_id: conv.id, role: 'assistant', sender: agentId, content: reply, job_id: job.id, reply_to: msg.kind === 'handoff' ? msg.id : null, meta: { duration_ms: r.durationMs, session_resumed: resume, ...(router ? { router: true } : {}), ...(askBack ? { update: 1, ask_back: true } : {}) } });
        if (askBack) chat.engineTurn(conv.id, agentId, ownerTodo
          ? 'ClaudeBot: do not ask the owner for answers the team can find; the owner asked not to be asked. Answer form questions from their resume, memory and ./shared/profile/application-answers.md, try other people, sources and routes for anything blocked, and finish the work. Only a CAPTCHA, a sign-in or a fact that is truly in none of those goes to the owner, once, in one batched message that lists what you tried.'
          : 'ClaudeBot: do not ask the owner whether to do work you and the team can do yourselves; the owner asked not to be asked. Do what you just offered now, and report the result when it is done.', `askback:${job.id}`, ctx.defs);
        // Honesty guard: a reply that claims an application went in, with no verified confirmation recorded in this turn, gets a plain note under it.
        const claimsSubmission = /\b(i|we|he|she|they)\s+(have\s+|just\s+|successfully\s+)?(submitted|applied|sent in)\b|\bsubmitted\s+(your|the|his|her|their|an?|\d+)\b[^.]{0,30}\bapplications?\b|\bapplications?\s+(was|were|has been|have been|is|are)\s+(submitted|sent|in)\b|\b(is|are)\s+(now\s+)?submitted\b/i.test(reply);
        const negated = /\b(not|n't|never|nothing|no|none|without|couldn't|didn't|isn't|wasn't|haven't|hasn't|won't)\b[^.]{0,40}\b(submitted|applied)\b|\b(submitted|applied)\b[^.]{0,20}\b(none|nothing|no one|zero)\b/i.test(reply);
        // Verified in this turn, or by any task of this conversation in the last 3 hours (the lead reporting a teammate's verified submit is honest).
        const verified = deps.db.prepare("SELECT 1 FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE e.type = 'application.verified' AND (e.job_id = ? OR (j.conversation_id = ? AND e.at > ?)) LIMIT 1").get(job.id, conv.id, new Date(Date.now() - 3 * 3600_000).toISOString());
        if (claimsSubmission && !negated && !verified)
          chat.add({ conversation_id: conv.id, role: 'system', kind: 'activity', content: 'ClaudeBot check: no application confirmation was verified in this reply, so treat any application mentioned above as not yet submitted.', job_id: job.id, meta: { honesty_check: true } });
        // Files this reply saved appear in the chat under it, one file card each (preview, download), so "it's in the chat" is true.
        for (const a of deps.db.prepare("SELECT id, title FROM artifacts WHERE job_id = ? AND kind = 'file' AND id NOT IN (SELECT artifact_id FROM messages WHERE artifact_id IS NOT NULL AND conversation_id = ?) ORDER BY created_at, rowid").all(job.id, conv.id) as Array<{ id: string; title: string }>)
          chat.add({ conversation_id: conv.id, role: 'assistant', kind: 'result', sender: agentId, content: a.title || 'Saved a file', job_id: job.id, artifact_id: a.id, meta: { state: 'completed', file_verified: true, chat_file: true } });
        if (!routerOnly) await readUsageAfterTurn(deps, job, r.runtimeSessionId ?? store.get(job.id)?.session_ref ?? null, ctx.workspace, agentId);   // a router's session is already closed
        return { kind: 'ok', payload: { reply, summary: reply.slice(0, 200), turn_duration_ms: r.durationMs } };
      }
      if (r.category === 'crashed' || r.category === 'hung') chat.setSession(conv.id, null, agentId);   // next turn respawns with the durable transcript
      switch (r.category) {
        case 'quota_exhausted': return { kind: 'wait_reset', resetAt: r.resetAt ?? null, message: r.message, probeCount: Number((JSON.parse(job.limit_info ?? '{}') as { probe_count?: number }).probe_count ?? 0) + (r.resetAt ? 0 : 1) };
        case 'rate_limited': return { kind: 'retry', reason: `rate limited: ${r.message}` };
        case 'auth_required': return { kind: 'wait_auth', identity: 'claude', operatorAction: 'Sign in to continue: run `CLAUDE_CONFIG_DIR=$HOME/.claudebot/claude claude auth login --claudeai` in Terminal. The reply resumes automatically.' };
        case 'access_denied': return { kind: 'fail', reason: r.message, operatorAction: 'Claude reported an access problem that signing in does not fix. Check the Claude account, then send the message again.', code: 'CLAUDE_ACCESS_DENIED' };
        default: return { kind: 'retry', reason: `${r.category}: ${r.message}` };
      }
    }
    case 'claude': {
      if (deps.claudeAvailable) {
        const a = await deps.claudeAvailable();
        if (!a.ok && a.reason === 'auth_required') return { kind: 'wait_auth', identity: 'claude', operatorAction: 'Reconnect Claude: run `CLAUDE_CONFIG_DIR=$HOME/.claudebot/claude claude auth login --claudeai` in Terminal, then this job resumes automatically.' };
        if (!a.ok && a.reason === 'limited') return { kind: 'wait_reset', resetAt: a.resetAt ?? null, message: 'Claude capacity is paused (plan limit)', probeCount: Number((JSON.parse(job.limit_info ?? '{}') as { probe_count?: number }).probe_count ?? 0) };
        if (!a.ok) return { kind: 'retry', reason: `Claude runtime unreachable` };
      }
      const agentId = stage.agent ?? job.agent_role;
      const agent = ctx.defs.getAgent(agentId);
      if (!agent) return { kind: 'fail', reason: `agent ${agentId} not found`, operatorAction: 'The task names an agent that no longer exists. Edit the workflow or restore the agent.', code: 'AGENT_MISSING' };
      if (!agent.enabled) return { kind: 'retry', reason: `${agent.name} is turned off; this task waits until they are turned back on` };
      const inputs = (() => { try { return JSON.parse(job.inputs || '{}') as Record<string, unknown>; } catch { return {}; } })();
      const vars: Record<string, string> = { agent_name: agent.name, role_title: agent.name, job_id: job.id, workspace: ctx.workspace, objective: job.objective, previous: JSON.stringify(ctx.previous).slice(0, 4000) };
      for (const [k, v] of Object.entries(inputs)) vars[k] = typeof v === 'string' ? v : JSON.stringify(v);
      for (const [k, v] of Object.entries(ctx.previous)) vars[`prev_${k}`] = typeof v === 'string' ? v : JSON.stringify(v);   // earlier deterministic steps' output, whole
      const directions = pendingDirections(deps.db, job.id);
      const handover = dependencyInputs(deps.db, job);
      const continuation = job.stage_attempt > 1 && job.session_ref ? `\n\nYour previous attempt at this step was interrupted (time limit, stop, or restart) and this is the same session. Continue from where you stopped. Files already saved with write_artifact are registered; do not re-create or duplicate them.` : '';
      let memory = ''; try { memory = new Vault().context(agent); } catch { /* the vault is optional */ }
      try { const recent = new ChatStore(deps.db, deps.store).elsewhere(agent.id, job.conversation_id ?? '', { limit: 20 }); if (recent) memory = `${memory ? `${memory}\n\n` : ''}What happened recently in your conversations with the owner and the team (use it; never ask the owner to repeat what is here):\n${recent}`; } catch { /* optional context */ }
      { const on = String((deps.db.prepare("SELECT value FROM settings WHERE key = 'owner_name'").get() as { value: string } | undefined)?.value ?? '').replace(/^"|"$/g, '').trim(); if (on) memory = `The owner is ${on}: everything you make is for ${on} (resumes, emails and documents in ${on}'s name, never an assistant's).\n${memory}`; }
      const prompt = renderPrompt((agent.system_instructions ? `Agent instructions: ${agent.system_instructions}\n\n` : '') + (memory ? `${memory}\n\n` : '') + (stage.prompt ?? '') + (handover ? `\n\nInputs from earlier tasks you depend on (their saved outputs and evidence; use them, do not redo them):\n${handover}` : '') + (directions ? `\n\nDirection from the owner, received while this task was in progress (follow it; it takes precedence over earlier wording where they conflict):\n${directions}` : '') + continuation + '\nSave text outputs using mcp__claudebot__write_artifact with path, title, kind, and the complete content. This audited tool creates and registers the file. Native Write/Edit are restricted in the product state directory. Do not return DONE unless the tool confirms the output was saved. If a file already exists, preserve it and use a new filename for changed content.', vars);
      // A coding step runs with the repository as Claude's working directory (its file tools are allowed only under the cwd); outputs still register into the task folder through the broker.
      const turnCwd = stage.cwd === 'repository' && typeof ctx.previous.repository === 'string' && fs.existsSync(String(ctx.previous.repository)) ? String(ctx.previous.repository) : ctx.workspace;
      issueCapability(deps.runDir, job, ctx.workspace, [...agent.allowed_tools, 'read_conversation', ...(agent.allowed_tools.includes('browser_act') ? ['record_application'] : [])]);
      fs.writeFileSync(path.join(turnCwd, '.mcp.json'), mcpJson(path.resolve(import.meta.dirname, '..', '..', '..'), job.id, path.dirname(deps.runDir)));
      if (turnCwd === ctx.workspace) { const sk = installSkills(turnCwd, agentId); if (sk.installed.length || sk.refused.length) store.event(job.id, 'engine', 'skills.prepared', sk); }   // reviewed skills only; never into a selected repository
      if (directions) markDirectionsDelivered(deps, job.id, `step ${stage.name}`);
      const resume = !!job.session_ref;
      const r: TurnResult = await deps.runtime.startTurn({ jobId: job.id, sessionRef: job.session_ref ?? job.id, role: agentId, cwd: turnCwd, prompt, resume, model: agent?.model, timeoutMs: Number(process.env.CLAUDEBOT_STAGE_TIMEOUT_MS ?? (stage.timeoutMs ?? 15 * 60_000)), onHeartbeat: ctx.beat, onSession: (key) => { if (key !== store.get(job.id)?.session_ref) store.patch(job.id, { session_ref: key, runtime_session_id: key }); }, signal: ctx.signal });
      if (r.runtimeSessionId && r.runtimeSessionId !== job.session_ref) store.patch(job.id, { session_ref: r.runtimeSessionId, runtime_session_id: r.runtimeSessionId });
      if (r.ok) {
        // A successful turn proves capacity and login; clear both flags so other workers stop short-circuiting.
        deps.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('claude.capacity', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify({ limited: false }), `job ${job.id} completed a Claude turn`, now());
        const summary = r.text.replace(/\s*DONE\s*$/i, '').trim().split('\n').slice(-3).join(' ').slice(0, 500) || 'turn completed';
        // Truthful completion: a turn that ends normally is not success. The assistant's own outcome report decides.
        const after = store.get(job.id)!; const od = (() => { try { return JSON.parse(after.outcome_detail || '{}') as { reason?: string; remaining?: string; block_kind?: string; site?: string; next_action?: string }; } catch { return {}; } })();
        if (after.outcome === 'blocked') {
          const needsOwner = ['login', 'captcha', 'mfa', 'bot_check'].includes(od.block_kind ?? '') && od.site;
          if (deps.runtime.closeSession && after.session_ref) { try { await deps.runtime.closeSession(after.session_ref); store.event(job.id, ctx.actor, 'session.closed', { session_ref: after.session_ref, reason: 'blocked' }); store.patch(job.id, { session_ref: null, runtime_session_id: null }); } catch { /* best effort */ } }
          if (needsOwner) return { kind: 'wait_auth', identity: `browser:${od.site}`, operatorAction: `${od.site} ${od.block_kind === 'captcha' ? 'showed a CAPTCHA' : od.block_kind === 'mfa' ? 'asked for a verification code' : od.block_kind === 'bot_check' ? 'showed a bot check' : 'needs a sign-in'}. Take over the ClaudeBot browser, finish it yourself, then click "I'm done"; the task resumes from its saved progress. ${od.reason ?? ''}`.trim() };
          return { kind: 'fail', reason: `blocked: ${plainForOwner(od.reason ?? 'the source could not be read')}`, operatorAction: od.next_action ?? `The requested work could not be done (${od.block_kind ?? 'blocked'}): ${od.reason ?? ''}. ${od.remaining ? 'Still unavailable: ' + od.remaining + '. ' : ''}Try again later or give direction.`, code: 'BLOCKED' };
        }
        await readUsageAfterTurn(deps, job, r.runtimeSessionId ?? after.session_ref ?? null, turnCwd, agentId);
        return { kind: 'ok', payload: { summary, turn_duration_ms: r.durationMs, outcome: after.outcome ?? null, remaining: od.remaining ?? null } };
      }
      switch (r.category) {
        case 'quota_exhausted': return { kind: 'wait_reset', resetAt: r.resetAt ?? null, message: r.message, probeCount: Number((JSON.parse(job.limit_info ?? '{}') as { probe_count?: number }).probe_count ?? 0) + (r.resetAt ? 0 : 1) };
        case 'rate_limited': return { kind: 'retry', reason: `rate limited: ${r.message}` };
        case 'auth_required': return { kind: 'wait_auth', identity: 'claude', operatorAction: 'Reconnect Claude: run `CLAUDE_CONFIG_DIR=$HOME/.claudebot/claude claude auth login --claudeai` in Terminal, then this job resumes automatically.' };
        case 'access_denied': return { kind: 'fail', reason: r.message, operatorAction: 'Claude reported an access problem that login does not fix (organization verification or provider credential). Check the Claude account, then re-queue.', code: 'CLAUDE_ACCESS_DENIED' };
        case 'cancelled': case 'hung': return { kind: 'retry', reason: `turn ${r.category}: ${r.message}` };
        case 'crashed': case 'transient': case 'internal': default: return { kind: 'retry', reason: `${r.category}: ${r.message}` };
      }
    }
  }
}

/**
 * Real usage measurement: after a successful turn, ask the same session for Claude Code's `/usage` (no model call). The
 * limits only appear in a session that has made a model call, which this one just did. Never fatal; never estimated.
 */
async function readUsageAfterTurn(deps: RunDeps, job: Job, sessionRef: string | null, cwd: string, role: string): Promise<void> {
  if (!sessionRef || (deps.runtime.id === 'simulated' && process.env.CLAUDEBOT_USAGE_PROBE !== 'on') || !readingDue(deps.db)) return;
  try {
    const r = await deps.runtime.startTurn({ jobId: job.id, label: `usage:${job.id}`, sessionRef, role, cwd, prompt: '/usage', resume: true, timeoutMs: 60_000, probeOnly: true });
    if (!r.ok) { deps.store.event(job.id, deps.owner, 'usage.read_failed', { category: r.category, message: r.message.slice(0, 200) }); return; }
    const reading = recordReading(deps.db, { text: r.text, source: 'claude /usage via ACP', session_ref: sessionRef, job_id: job.id });
    deps.store.event(job.id, deps.owner, 'usage.read', { reading: reading.id, has_limits: reading.has_limits, pct: reading.governing_pct });
    refreshGovernor(deps.db);
  } catch (e) { deps.store.event(job.id, deps.owner, 'usage.read_failed', { message: (e as Error).message.slice(0, 200) }); }
}

/** Delivery state of the message a conversation turn answers (owner message or handoff). */
function settleDelivery(deps: RunDeps, job: Job): void {
  const chat = new ChatStore(deps.db, deps.store); const m = chat.message(job.message_id!); if (!m) return;
  if (m.role === 'owner') { chat.refreshDelivery(m.id); return; }
  if (m.kind === 'handoff') { const d = job.state === 'completed' ? 'delivered' : ['failed_terminal', 'cancelled'].includes(job.state) ? 'failed' : ['leased', 'running'].includes(job.state) ? 'delivering' : 'queued'; deps.db.prepare('UPDATE messages SET delivery = ? WHERE id = ?').run(d, m.id); }
}

/** Owner direction notes recorded for this task that have not yet been given to the assistant. */
function pendingDirections(db: DB, jobId: string): string {
  const rows = db.prepare("SELECT seq, at, detail FROM job_events WHERE job_id = ? AND type = 'owner.direction' ORDER BY seq").all(jobId) as Array<{ seq: number; at: string; detail: string }>;
  const delivered = new Set((db.prepare("SELECT detail FROM job_events WHERE job_id = ? AND type = 'owner.direction.delivered'").all(jobId) as Array<{ detail: string }>).flatMap((r) => (JSON.parse(r.detail) as { seqs?: number[] }).seqs ?? []));
  return rows.filter((r) => !delivered.has(r.seq)).map((r) => `- (${r.at}) ${(JSON.parse(r.detail) as { note: string }).note}`).join('\n');
}
function markDirectionsDelivered(deps: RunDeps, jobId: string, how: string): void {
  const rows = deps.db.prepare("SELECT seq FROM job_events WHERE job_id = ? AND type = 'owner.direction' ORDER BY seq").all(jobId) as Array<{ seq: number }>;
  const delivered = new Set((deps.db.prepare("SELECT detail FROM job_events WHERE job_id = ? AND type = 'owner.direction.delivered'").all(jobId) as Array<{ detail: string }>).flatMap((r) => (JSON.parse(r.detail) as { seqs?: number[] }).seqs ?? []));
  const seqs = rows.map((r) => r.seq).filter((q) => !delivered.has(q)); if (!seqs.length) return;
  deps.store.event(jobId, deps.owner, 'owner.direction.delivered', { seqs, how });
}

/** Saved outputs and evidence of the tasks this job depends on, for hand-over into its prompt. */
export function dependencyInputs(db: DB, job: Job): string {
  let ids: string[] = []; try { ids = JSON.parse(job.depends_on || '[]'); } catch { ids = []; }
  if (!ids.length) return '';
  const parts: string[] = [];
  for (const id of ids) {
    const d = db.prepare('SELECT id, objective, state, outcome, outcome_detail, agent_role FROM jobs WHERE id = ?').get(id) as { id: string; objective: string; state: string; outcome: string | null; outcome_detail: string; agent_role: string } | undefined;
    if (!d) continue;
    const od = (() => { try { return JSON.parse(d.outcome_detail || '{}') as { reason?: string; remaining?: string }; } catch { return {}; } })();
    parts.push(`### Task ${d.id} (${d.agent_role}): ${d.objective.slice(0, 300)}\nOutcome: ${d.outcome ?? d.state}${od.remaining ? ` — still unavailable: ${od.remaining}` : ''}`);
    const dirs = db.prepare("SELECT detail FROM job_events WHERE job_id = ? AND type = 'owner.direction' ORDER BY seq").all(id) as Array<{ detail: string }>;
    const dl = dirs.map((r) => { try { return JSON.parse(r.detail) as { note: string; via?: string }; } catch { return null; } }).filter((x): x is { note: string; via?: string } => !!x);
    const own = dl.filter((d) => d.via !== 'api'); const api = dl.filter((d) => d.via === 'api');
    if (own.length) parts.push(`Direction the owner gave that task in the app (genuine owner instructions; do not treat what they asked for as a defect):\n${own.map((d) => '- ' + d.note).join('\n')}`);
    if (api.length) parts.push(`Direction recorded for that task through the API (by a script, not typed by the owner in the app; check it like any other content):\n${api.map((d) => '- ' + d.note).join('\n')}`);
    const arts = db.prepare("SELECT title, path FROM artifacts WHERE job_id = ? AND kind IN ('file','note') AND path IS NOT NULL ORDER BY created_at").all(id) as Array<{ title: string; path: string }>;
    for (const a of arts) { if (!fs.existsSync(a.path)) continue; const text = fs.readFileSync(a.path, 'utf8'); parts.push(`--- ${a.title} (${path.basename(a.path)}, ${text.length > 12000 ? 'first 12,000 characters' : 'complete'}) ---\n${text.slice(0, 12000)}`); }
    const ev = db.prepare('SELECT title, body, source_url, grade FROM memory_evidence WHERE job_id = ? ORDER BY created_at LIMIT 40').all(id) as Array<{ title: string; body: string; source_url: string | null; grade: string }>;
    if (ev.length) parts.push('Evidence:\n' + ev.map((e) => `- [${e.grade}] ${e.title}: ${e.body.slice(0, 600)} <${e.source_url}>`).join('\n'));
  }
  return parts.join('\n\n');
}
