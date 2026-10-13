/**
 * Workbench snapshot: real assistants and their real work. "Working" is never inferred: it requires a leased task whose
 * worker heartbeat is fresh and whose lease has not expired. A local engine step is reported separately from a Claude turn.
 */
// The morning report the owner reads, ranking and owner uploads are records, not assistant work: they never show as an assistant's result.
const NOT_WORK = new Set(['report.morning', 'priority.rank', 'owner.upload']);
import type { DB } from '../db/open.ts';
import { Definitions } from './definitions.ts';
import type { Job } from '../jobs/types.ts';
import { taskTitle, progressWording, eventWording } from './wording.ts';
import { plainState } from '../chat/store.ts';
import { computeGovernor, deferralOf } from '../usage/governor.ts';

export type WorkStatus = 'working' | 'checking' | 'queued' | 'blocked_on' | 'waiting' | 'finished' | 'stopped';

export function workbenchSnapshot(db: DB, opts: { workspace?: string; now?: number; freshSeconds?: number; limit?: number } = {}) {
  const defs = new Definitions(db); const time = opts.now ?? Date.now();
  const freshMs = (opts.freshSeconds ?? 45) * 1000;
  const rows = db.prepare(`SELECT * FROM jobs WHERE kind != 'owner.upload' ${opts.workspace ? 'AND workspace_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...(opts.workspace ? [opts.workspace] : []), opts.limit ?? 200) as unknown as Job[];
  const byId = new Map(rows.map((j) => [j.id, j]));
  const gov = computeGovernor(db, time); const rankOf = (id: string) => (db.prepare('SELECT rank FROM task_priorities WHERE job_id = ?').get(id) as { rank: number } | undefined)?.rank ?? null;
  const tasks = rows.map((j) => {
    const wf = defs.getWorkflow(j.kind); const stage = wf?.stages[j.stage_index];
    const assistantId = stage?.agent ?? j.agent_role;
    const active = ['leased', 'running'].includes(j.state);
    const fresh = active && !!j.lease_owner && !!j.lease_heartbeat_at && !!j.lease_expires_at && Date.parse(j.lease_expires_at) > time && time - Date.parse(j.lease_heartbeat_at) <= freshMs && Date.parse(j.lease_heartbeat_at) <= time;
    const latest = db.prepare("SELECT at, type, detail FROM job_events WHERE job_id = ? AND type IN ('agent.progress','tool.called','artifact.saved','browser.read','job.transition','checkpoint.written','owner.direction','turn.cancelled','session.closed') ORDER BY seq DESC LIMIT 1").get(j.id) as { at: string; type: string; detail: string } | undefined;
    let dependsOn: string[] = []; try { dependsOn = JSON.parse(j.depends_on || '[]'); } catch { dependsOn = []; }
    const openDeps = dependsOn.map((id) => db.prepare('SELECT id, state, agent_role, objective FROM jobs WHERE id = ?').get(id) as { id: string; state: string; agent_role: string; objective: string } | undefined).filter((d): d is { id: string; state: string; agent_role: string; objective: string } => !!d && d.state !== 'completed');
    // A task that is waiting for its own child tasks (wait_for_children) is not working: show who it waits on.
    const waitingChildren = (j.waiting_on ?? '').startsWith('children:') ? (j.waiting_on as string).slice(9).split(',').map((id) => db.prepare('SELECT id, state, agent_role, objective FROM jobs WHERE id = ?').get(id) as { id: string; state: string; agent_role: string; objective: string } | undefined).filter((d): d is { id: string; state: string; agent_role: string; objective: string } => !!d && !['completed', 'failed_terminal', 'cancelled'].includes(d.state)) : [];
    if (waitingChildren.length) openDeps.push(...waitingChildren);
    const status: WorkStatus = fresh && waitingChildren.length ? 'blocked_on' : fresh ? 'working' : active ? 'checking' : j.state === 'queued' ? (openDeps.length ? 'blocked_on' : 'queued') : j.state === 'completed' ? 'finished' : ['cancelled', 'failed_terminal'].includes(j.state) ? 'stopped' : 'waiting';
    const turn: 'claude' | 'engine' | null = active ? (stage && ['claude', 'chat'].includes(stage.kind) ? 'claude' : 'engine') : null;
    const parent = j.parent_id ? byId.get(j.parent_id) ?? (db.prepare('SELECT id, kind, agent_role, conversation_id FROM jobs WHERE id = ?').get(j.parent_id) as Job | undefined) : undefined;
    const assignedBy = parent ? (defs.getAgent(parent.agent_role)?.name ?? parent.agent_role) : j.schedule_id ? 'a schedule' : j.kind === 'chat.turn' ? 'you (conversation)' : 'you';
    const children = db.prepare('SELECT id, kind, state, agent_role, objective FROM jobs WHERE parent_id = ? ORDER BY created_at').all(j.id) as Array<{ id: string; kind: string; state: string; agent_role: string; objective: string }>;
    const directions = db.prepare("SELECT at, detail FROM job_events WHERE job_id = ? AND type = 'owner.direction' ORDER BY seq").all(j.id) as Array<{ at: string; detail: string }>;
    return {
      id: j.id, parent_id: j.parent_id, conversation_id: j.conversation_id, workspace_id: j.workspace_id,
      title: j.kind === 'chat.turn' ? `Reply: ${taskTitle(j.objective)}` : taskTitle(j.objective), objective: j.objective, kind: j.kind, workflow: wf?.name ?? j.kind, is_reply: j.kind === 'chat.turn',
      state: j.state, plain_state: waitingChildren.length && fresh ? `Waiting for its child task${waitingChildren.length > 1 ? 's' : ''}` : plainState(j), status, started: active, turn, outcome: j.outcome, outcome_detail: (() => { try { return JSON.parse(j.outcome_detail || '{}'); } catch { return {}; } })(), waiting_on_tasks: openDeps.map((d) => ({ id: d.id, assistant: defs.getAgent(d.agent_role)?.name ?? d.agent_role, state: d.state, title: taskTitle(d.objective) })), depends_on: dependsOn, stage: j.stage_name, stage_kind: stage?.kind ?? null, stage_index: j.stage_index, stages: wf?.stages.map((s) => ({ name: s.name, kind: s.kind })) ?? [],
      assistant_id: assistantId, assistant: defs.getAgent(assistantId)?.name ?? assistantId, assigned_by: assignedBy, assigned_by_task: parent?.id ?? null,
      heartbeat_at: fresh ? j.lease_heartbeat_at : null, last_update: j.updated_at, created_at: j.created_at, completed_at: j.completed_at,
      progress: fresh && j.next_action ? progressWording(j.next_action) : null,
      next_action: j.operator_action ?? null, blocker: j.failure_detail ?? j.blocker_code ?? null, retry_at: j.retry_at, reset_at: j.reset_at, waiting_on: j.waiting_on,
      latest: latest ? { at: latest.at, type: latest.type, label: eventWording(latest.type, JSON.parse(latest.detail)) } : null,
      outputs: db.prepare('SELECT id, title, kind, path, review_state, created_at FROM artifacts WHERE job_id = ? ORDER BY created_at').all(j.id) as Array<{ id: string; title: string; kind: string; path: string | null; review_state: string; created_at: string }>,
      children: children.map((c) => ({ id: c.id, state: c.state, plain_state: plainState({ state: c.state as Job['state'], blocker_code: null, waiting_on: null, reset_at: null, retry_at: null }), assistant: defs.getAgent(c.agent_role)?.name ?? c.agent_role, title: taskTitle(c.objective) })),
      directions: directions.map((d) => ({ at: d.at, ...(JSON.parse(d.detail) as { note: string; delivered?: boolean }) })),
      session_ref: j.session_ref, runtime: j.runtime_id, deferred: deferralOf(j, gov, rankOf(j.id)), priority: rankOf(j.id),
    };
  });
  const assistants = defs.listAgents({ includeDisabled: true }).map((a) => {
    const owned = tasks.filter((t) => t.assistant_id === a.id);
    const rank: Record<string, number> = { working: 0, checking: 1, waiting: 2, blocked_on: 3, queued: 4 };   // what the assistant is actually doing comes first
    const current = owned.filter((t) => t.status in rank).sort((x, y) => rank[x.status] - rank[y.status]);
    // A pending approval asked for in one of this assistant's tasks also means it waits on the owner, even after the task itself finished.
    const pendingAsk = (db.prepare("SELECT COUNT(*) AS n FROM approvals ap JOIN jobs j ON j.id = ap.job_id WHERE j.agent_role = ? AND ap.status = 'pending'").get(a.id) as { n: number }).n > 0;
    const paused = current.filter((t) => t.status === 'queued' && t.deferred).length > 0 && !current.some((t) => ['working', 'checking'].includes(t.status));
    const status = !a.enabled ? 'disabled' : paused ? 'paused' : current.some((t) => t.status === 'working') ? 'working' : current.some((t) => t.status === 'checking') ? 'checking' : current.some((t) => t.status === 'waiting') || pendingAsk ? 'waiting' : current.some((t) => t.status === 'blocked_on') ? 'blocked_on' : current.some((t) => t.status === 'queued') ? 'queued' : 'idle';
    const lastActivity = owned.map((t) => t.latest).filter(Boolean).sort((x, y) => (x!.at < y!.at ? 1 : -1))[0] ?? null;
    return { id: a.id, name: a.name, purpose: a.purpose, enabled: a.enabled, is_lead: a.id === 'coordinator', status, tasks: current, last_activity: lastActivity, last_result: owned.find((t) => t.status === 'finished' && !NOT_WORK.has(t.kind)) ?? null, finished_count: owned.filter((t) => t.status === 'finished' && !NOT_WORK.has(t.kind)).length };
  });
  // Real hand-off events of the last 40 s, for restrained movement in the office: a delegation (note from the assigner to the assignee) and a delivery (result card posted to the conversation).
  const since = new Date(time - 40_000).toISOString();
  const delegated = (db.prepare("SELECT e.job_id, e.at, j.agent_role, j.parent_id, p.agent_role AS from_role FROM job_events e JOIN jobs j ON j.id = e.job_id LEFT JOIN jobs p ON p.id = j.parent_id WHERE e.type = 'job.created' AND e.at >= ? AND j.kind != 'chat.turn'").all(since) as Array<{ job_id: string; at: string; agent_role: string; parent_id: string | null; from_role: string | null }>).map((r) => ({ type: 'delegated' as const, job_id: r.job_id, at: r.at, from: r.from_role ? (defs.getAgent(r.from_role)?.name ?? r.from_role) : 'you', to: defs.getAgent(r.agent_role)?.name ?? r.agent_role }));
  const delivered = (db.prepare("SELECT m.job_id, m.created_at AS at, j.agent_role, json_extract(m.meta, '$.state') AS state FROM messages m JOIN jobs j ON j.id = m.job_id WHERE m.kind = 'result' AND m.created_at >= ?").all(since) as Array<{ job_id: string; at: string; agent_role: string; state: string }>).map((r) => ({ type: 'delivered' as const, job_id: r.job_id, at: r.at, from: defs.getAgent(r.agent_role)?.name ?? r.agent_role, to: 'you', state: r.state }));
  return { observed_at: new Date(time).toISOString(), fresh_seconds: freshMs / 1000, recent: [...delegated, ...delivered].sort((x, y) => (x.at < y.at ? -1 : 1)), assistants, tasks, counts: { working: tasks.filter((t) => t.status === 'working').length, checking: tasks.filter((t) => t.status === 'checking').length, waiting: tasks.filter((t) => t.status === 'waiting').length, queued: tasks.filter((t) => t.status === 'queued').length, blocked_on: tasks.filter((t) => t.status === 'blocked_on' && !t.started).length, waiting_to_start: tasks.filter((t) => t.status === 'queued' || (t.status === 'blocked_on' && !t.started)).length, waiting_on_children: tasks.filter((t) => t.status === 'blocked_on' && t.started).length }, semantics: 'Working means a leased task with a worker heartbeat in the last 45 s. Waiting on another assistant means a recorded dependency. Claude turns and local engine steps are labelled separately. Private reasoning is never shown.' };
}
