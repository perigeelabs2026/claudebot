/**
 * Silent-idle watch (Fable audit 2026-10-14): paths where a failure left the team idle with nothing in the group chat. One tick a
 * minute from the supervisor; each finding is one line in the team group (cos/alerts.ts), posted once; owner-relevant lines also go
 * to Telegram, held during quiet hours. Deterministic: no model call.
 */
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import { teamLine } from './alerts.ts';
import { REAL_PROJECT } from './report.ts';
import { taskTitle } from '../model/wording.ts';
import { computeGovernor, deferralOf } from '../usage/governor.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const getRs = (db: DB, key: string): unknown => { const r = db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as { value: string } | undefined; try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
const setRs = (db: DB, key: string, value: unknown, why: string) => db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(key, JSON.stringify(value), why, iso(Date.now()));
const names = (db: DB) => new Map((db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name.replace(/\s*\(.*\)$/, '')]));

/** An engine restart cancels or re-queues work on purpose: never counted as a failure. */
const NOT_RESTART = "COALESCE(json_extract(e.detail, '$.reason'), '') NOT LIKE '%engine shutdown or restart%'";
export const STREAK = { failures: 3, tasks: 2, windowMs: 30 * 60_000, pauseMs: 30 * 60_000 };

/** 1. Three failures by one assistant within 30 minutes (since its last successful turn): one owner line, and its queue pauses until a
 *  turn succeeds, its model is changed, or 30 minutes pass (then one task runs as a probe). */
export function failureStreaks(db: DB, store: JobStore, nowMs = Date.now()): string[] {
  const since = iso(nowMs - STREAK.windowMs); const who = names(db); const out: string[] = [];
  const rows = db.prepare(`SELECT j.agent_role AS agent, COUNT(*) AS n, COUNT(DISTINCT j.id) AS tasks, GROUP_CONCAT(COALESCE(json_extract(e.detail, '$.reason'), j.failure_detail), ' | ') AS reasons
    FROM job_events e JOIN jobs j ON j.id = e.job_id
    WHERE e.type = 'job.transition' AND json_extract(e.detail, '$.to') IN ('failed_terminal', 'retry_scheduled') AND e.at > ? AND ${REAL_PROJECT} AND ${NOT_RESTART}
    GROUP BY j.agent_role HAVING n >= ? AND tasks >= ?`).all(since, STREAK.failures, STREAK.tasks) as Array<{ agent: string; n: number; reasons: string | null }>;
  for (const r of rows) {
    const lastOk = String(getRs(db, `agent.last_ok.${r.agent}`) ?? '');
    const c = (db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT e.job_id) AS tasks FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE e.type = 'job.transition' AND json_extract(e.detail, '$.to') IN ('failed_terminal', 'retry_scheduled') AND e.at > ? AND e.at > ? AND j.agent_role = ? AND ${REAL_PROJECT} AND ${NOT_RESTART}`).get(since, lastOk || '0', r.agent) as { n: number; tasks: number });
    const n = c.n; if (n < STREAK.failures || c.tasks < STREAK.tasks) continue;   // one flaky task retrying is not a streak
    const paused = getRs(db, `agent.paused.${r.agent}`) as { until?: string; since?: string } | null;
    if (paused?.since && paused.since > lastOk) continue;   // this streak is already paused and reported
    const t = iso(nowMs); setRs(db, `agent.paused.${r.agent}`, { since: t, until: iso(nowMs + STREAK.pauseMs), failures: n }, 'failure streak');
    store.event(null, 'supervisor', 'agent.paused', { agent: r.agent, failures: n, until: iso(nowMs + STREAK.pauseMs) });
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
    const reason = String(r.reasons ?? '').split(' | ').pop()!.replace(/\s+/g, ' ').slice(0, 160);
    const name = who.get(r.agent) ?? r.agent;
    teamLine(db, store, { key: `streak:${r.agent}:${t}`, owner: true,
      text: `${name} failed ${n} times in the last 30 minutes${reason ? ` (last: ${reason})` : ''}. ${name}'s queue is paused until a turn works, the model is changed, or 30 minutes pass.${waiting ? ` ${waiting} decision${waiting === 1 ? '' : 's'} also wait${waiting === 1 ? 's' : ''} on you.` : ''}` });
    out.push(r.agent);
  }
  return out;
}

/** 2. Routine and scheduled tasks have no conversation: their result or failure goes to the team group. */
export function routineLines(db: DB, store: JobStore, nowMs = Date.now()): number {
  const mark = String(getRs(db, 'watch.routines.since') ?? ''); const t = iso(nowMs);
  if (!mark) { setRs(db, 'watch.routines.since', t, 'first watch tick'); return 0; }
  const who = names(db); let n = 0;
  const rows = db.prepare(`SELECT j.id, j.kind, j.objective, j.agent_role, j.state, j.failure_detail, j.completed_at FROM jobs j
    WHERE j.conversation_id IS NULL AND (j.schedule_id IS NOT NULL OR j.kind = 'monitor.scheduled') AND j.state IN ('completed', 'failed_terminal') AND j.completed_at > ? AND j.completed_at <= ?
      AND NOT (j.state = 'completed' AND (j.kind IN ('browser.login_health', 'priority.rank') OR j.kind LIKE 'system.%')) AND ${REAL_PROJECT} ORDER BY j.completed_at LIMIT 20`).all(mark, t) as Array<{ id: string; kind: string; objective: string; agent_role: string; state: string; failure_detail: string | null }>;
  for (const j of rows) {
    const name = who.get(j.agent_role) ?? j.agent_role; const title = taskTitle(j.objective);
    const text = j.state === 'completed' ? `${name} finished the routine "${title}".` : `${name} could not finish the routine "${title}": ${String(j.failure_detail ?? 'no reason recorded').replace(/\s+/g, ' ').slice(0, 200)}.`;
    if (teamLine(db, store, { key: `routine:${j.id}`, text, jobId: j.id, mirrorOf: j.id })) n++;
  }
  setRs(db, 'watch.routines.since', t, 'watch tick'); return n;
}

/** 4. The governors pause work: one line when a pause starts (how many tasks wait and why) and one when it ends. */
export function governorLine(db: DB, store: JobStore, nowMs = Date.now()): string | null {
  const mem = getRs(db, 'governor') as { paused?: boolean; level_pct?: number; floor_pct?: number } | null;
  const gov = computeGovernor(db, nowMs);
  const queued = db.prepare("SELECT id, kind, state, schedule_id, inputs FROM jobs WHERE state IN ('queued', 'retry_scheduled')").all() as Array<{ id: string; kind: string; state: string; schedule_id: string | null; inputs: string }>;
  const rank = (id: string) => (db.prepare('SELECT rank FROM task_priorities WHERE job_id = ?').get(id) as { rank: number } | undefined)?.rank ?? null;
  const deferred = queued.filter((j) => deferralOf(j, gov, rank(j.id))).length;
  const state = mem?.paused ? 'memory' : deferred ? gov.level : 'running';
  const prev = String(getRs(db, 'watch.governor') ?? 'running'); if (state === prev) return null;
  setRs(db, 'watch.governor', state, 'governor changed');
  const pct = gov.pct === null ? '' : ` (usage ${Math.round(gov.pct)}%)`;
  const text = state === 'memory' ? `New work is paused: this Mac is low on memory (${mem?.level_pct ?? '?'}% free, floor ${mem?.floor_pct ?? '?'}%). ${queued.length} task${queued.length === 1 ? ' waits' : 's wait'}; running work continues.`
    : state === 'stopped' ? `Claude usage is at its limit${pct}: ${deferred} task${deferred === 1 ? ' is' : 's are'} paused until usage allows.`
    : state === 'low_power' ? `Low-power mode${pct}: ${deferred} lower-priority task${deferred === 1 ? ' is' : 's are'} deferred; your messages and top-ranked work still run.`
    : 'Work is running normally again; deferred tasks are starting.';
  teamLine(db, store, { key: `governor:${state}:${iso(nowMs)}`, text });
  return state;
}

/** 5. A queue starved behind long tasks: a task queued for 20 minutes while every worker is busy. */
export function starvation(db: DB, store: JobStore, workerLimit: number, nowMs = Date.now()): string | null {
  const active = db.prepare("SELECT id, objective, agent_role, kind FROM jobs WHERE state IN ('leased', 'running') AND COALESCE(waiting_on, '') NOT LIKE 'children:%' ORDER BY updated_at").all() as Array<{ id: string; objective: string; agent_role: string; kind: string }>;
  if (active.length < workerLimit) {
    // Workers are free, yet a task waits: its assistant or its project is at its own limit (Jude at 1 behind a long browser task).
    const held = db.prepare(`SELECT j.id, j.objective, j.agent_role, j.workspace_id, a.concurrency_limit AS alimit, w.worker_limit AS wlimit, w.name AS wname,
        (SELECT COUNT(*) FROM jobs x WHERE x.agent_role = j.agent_role AND x.state IN ('leased','running') AND COALESCE(x.waiting_on, '') NOT LIKE 'children:%') AS abusy,
        (SELECT COUNT(*) FROM jobs x WHERE x.workspace_id IS j.workspace_id AND x.state IN ('leased','running') AND COALESCE(x.waiting_on, '') NOT LIKE 'children:%') AS wbusy
      FROM jobs j LEFT JOIN agent_definitions a ON a.id = j.agent_role LEFT JOIN workspaces w ON w.id = j.workspace_id
      WHERE j.state = 'queued' AND j.updated_at < ? AND ${REAL_PROJECT} ORDER BY j.updated_at`).all(iso(nowMs - 20 * 60_000)) as Array<{ id: string; objective: string; agent_role: string; alimit: number | null; wlimit: number | null; wname: string | null; abusy: number; wbusy: number }>;
    const h = held.find((x) => (x.alimit !== null && x.abusy >= x.alimit) || (x.wlimit !== null && x.wbusy >= x.wlimit)); if (!h) return null;
    const who = names(db); const name = who.get(h.agent_role) ?? h.agent_role;
    const behind = active.filter((a) => a.agent_role === h.agent_role).map((a) => `"${taskTitle(a.objective)}"`).join('; ');
    const why = h.alimit !== null && h.abusy >= h.alimit ? `${name} runs ${h.alimit} task${h.alimit === 1 ? '' : 's'} at a time${behind ? ` and is busy with ${behind}` : ''}` : `the project "${h.wname ?? 'this project'}" runs ${h.wlimit} task${h.wlimit === 1 ? '' : 's'} at a time`;
    teamLine(db, store, { key: `held:${h.id}`, jobId: h.id, text: `"${taskTitle(h.objective)}" has waited over 20 minutes while workers are free: ${why}. Raise the limit in Edit assistant or let it wait.` });
    return h.id;
  }
  const old = db.prepare(`SELECT j.id, j.objective, j.agent_role, j.created_at FROM jobs j WHERE j.state = 'queued' AND j.updated_at < ? AND ${REAL_PROJECT} ORDER BY j.updated_at LIMIT 1`).get(iso(nowMs - 20 * 60_000)) as { id: string; objective: string; agent_role: string } | undefined;
  if (!old) return null;
  const who = names(db); const waiting = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued' AND updated_at < ?").get(iso(nowMs - 20 * 60_000)) as { n: number }).n;
  teamLine(db, store, { key: `starved:${old.id}`, jobId: old.id,
    text: `${waiting} task${waiting === 1 ? ' has' : 's have'} waited over 20 minutes for a free worker (oldest: ${who.get(old.agent_role) ?? old.agent_role}, "${taskTitle(old.objective)}"). All ${workerLimit} workers are busy with: ${active.map((a) => `${who.get(a.agent_role) ?? a.agent_role}, "${taskTitle(a.objective)}"`).join('; ')}.` });
  return old.id;
}

/** 6. A plan limit with no reset time: after two hours of waiting, one owner line. */
export function resetLapsed(db: DB, store: JobStore, nowMs = Date.now()): number {
  const rows = db.prepare(`SELECT j.id, j.agent_role, (SELECT MAX(e.at) FROM job_events e WHERE e.job_id = j.id AND e.type = 'job.transition' AND json_extract(e.detail, '$.to') = 'waiting_for_reset') AS since
    FROM jobs j WHERE j.state = 'waiting_for_reset' AND ${REAL_PROJECT}`).all() as Array<{ id: string; agent_role: string; since: string | null }>;
  const lapsed = rows.filter((r) => r.since && r.since < iso(nowMs - 2 * 3600_000)); if (!lapsed.length) return 0;
  const first = lapsed.map((r) => r.since!).sort()[0];
  teamLine(db, store, { key: `reset:${first}`, owner: true,
    text: `Claude has been at its plan limit for over two hours with no reset time, and ${lapsed.length} task${lapsed.length === 1 ? ' is' : 's are'} still waiting. Check your Claude plan's usage page; the tasks resume on their own when it resets.` });
  return lapsed.length;
}

/** 7. A decision card unanswered for two hours: re-asked once (Telegram holds it in quiet hours, so it lands in the daytime). */
export function approvalReminders(db: DB, store: JobStore, nowMs = Date.now()): number {
  const who = names(db); let n = 0;
  const rows = db.prepare(`SELECT a.id, a.action_kind, a.target, j.agent_role FROM approvals a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.status = 'pending' AND a.created_at < ? AND (j.id IS NULL OR ${REAL_PROJECT}) ORDER BY a.created_at LIMIT 10`).all(iso(nowMs - 2 * 3600_000)) as Array<{ id: string; action_kind: string; target: string; agent_role: string | null }>;
  for (const a of rows) {
    const name = a.agent_role ? who.get(a.agent_role) ?? a.agent_role : 'An assistant';
    if (teamLine(db, store, { key: `remind:${a.id}`, owner: true, text: `Still waiting on you: ${name} wants to ${a.action_kind === 'send' ? 'send' : a.action_kind === 'purchase' ? 'buy' : a.action_kind === 'publish' ? 'post' : a.action_kind === 'delete' ? 'delete' : a.action_kind} ${String(a.target).replace(/https?:\/\/\S+/g, '').trim().slice(0, 160)}. Open ClaudeBot to allow or deny it.` })) n++;
  }
  return n;
}

export function watchTick(db: DB, store: JobStore, opts: { workerLimit: number; nowMs?: number }): void {
  const t = opts.nowMs ?? Date.now();
  for (const f of [() => failureStreaks(db, store, t), () => routineLines(db, store, t), () => governorLine(db, store, t), () => starvation(db, store, opts.workerLimit, t), () => resetLapsed(db, store, t), () => approvalReminders(db, store, t)]) {
    try { f(); } catch { /* one check failing never stops the others */ }
  }
}
