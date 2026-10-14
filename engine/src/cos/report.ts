/**
 * Chief of Staff: morning reports and priority ranks. The report's numbers and lists are a snapshot of ledger rows taken by a
 * deterministic step; the Chief of Staff (a real Claude turn) only writes the headline and lede from that snapshot and ranks the
 * open work. Ranks are durable, with the rationale and the turn that set them.
 */
import type { DB } from '../db/open.ts';
import { newId, now } from '../jobs/store.ts';
import { homeSnapshot } from '../model/home.ts';
import { taskTitle } from '../model/wording.ts';
import { latestReading, computeGovernor } from '../usage/governor.ts';

const OPEN = "('queued','leased','running','retry_scheduled','waiting_for_auth','waiting_for_reset','waiting_for_approval')";
const STATE_WORDS: Record<string, string> = { running: 'running', leased: 'starting', queued: 'queued', retry_scheduled: 'will retry', waiting_for_auth: 'waiting for a sign-in', waiting_for_reset: 'waiting for Claude usage to reset', waiting_for_approval: 'waiting for an approval' };
const NOT_RANKABLE = "('chat.turn','report.morning','priority.rank','assistant.draft','system.workspace_summary','browser.login_health','monitor.scheduled')";

export interface OpenItem { id: string; title: string; agent: string; state: string; kind: string; rank: number | null; rationale: string | null; created_at: string }
export function openWork(db: DB, limit = 40): OpenItem[] {
  const names = new Map((db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  return (db.prepare(`SELECT j.id, j.objective, j.agent_role, j.state, j.kind, j.created_at, tp.rank, tp.rationale FROM jobs j LEFT JOIN task_priorities tp ON tp.job_id = j.id WHERE j.state IN ${OPEN} AND j.kind NOT IN ${NOT_RANKABLE} ORDER BY COALESCE(tp.rank, 3), j.created_at LIMIT ?`).all(limit) as Array<{ id: string; objective: string; agent_role: string; state: string; kind: string; created_at: string; rank: number | null; rationale: string | null }>)
    .map((j) => ({ id: j.id, title: taskTitle(j.objective), agent: names.get(j.agent_role) ?? j.agent_role, state: j.state, kind: j.kind, rank: j.rank, rationale: j.rationale, created_at: j.created_at }));
}

export function setPriority(db: DB, input: { job_id: string; rank: number; rationale: string; by: string; in_job: string | null }): { ok: true } | { ok: false; reason: string } {
  const rank = Math.round(Number(input.rank)); const why = String(input.rationale ?? '').trim();
  if (!(rank >= 1 && rank <= 5)) return { ok: false, reason: 'rank must be 1 (most important) to 5' };
  if (why.length < 5) return { ok: false, reason: 'give a short rationale' };
  const j = db.prepare('SELECT state, kind FROM jobs WHERE id = ?').get(input.job_id) as { state: string; kind: string } | undefined;
  if (!j) return { ok: false, reason: `no task ${input.job_id}` };
  if (['completed', 'failed_terminal', 'cancelled'].includes(j.state)) return { ok: false, reason: 'that task is already finished' };
  db.prepare('INSERT INTO task_priorities(job_id, rank, rationale, ranked_by, ranked_in_job, ranked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET rank=excluded.rank, rationale=excluded.rationale, ranked_by=excluded.ranked_by, ranked_in_job=excluded.ranked_in_job, ranked_at=excluded.ranked_at').run(input.job_id, rank, why.slice(0, 400), input.by, input.in_job, now());
  db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?, ?, ?, ?, ?)').run(input.job_id, now(), input.by, 'priority.ranked', JSON.stringify({ rank, rationale: why.slice(0, 400), in_job: input.in_job }));
  return { ok: true };
}
export function priorityOf(db: DB, jobId: string): { rank: number; rationale: string; ranked_by: string; ranked_at: string } | null { return (db.prepare('SELECT rank, rationale, ranked_by, ranked_at FROM task_priorities WHERE job_id = ?').get(jobId) as { rank: number; rationale: string; ranked_by: string; ranked_at: string } | undefined) ?? null; }

/** Kinds that are housekeeping, not the team's work: never listed as live tasks (the report does not list itself). */
const NOT_LIVE = "('report.morning','priority.rank','system.workspace_summary','browser.login_health','monitor.scheduled','owner.upload')";
const LIVE_STATES = "('queued','leased','running','retry_scheduled','waiting_for_auth','waiting_for_reset','waiting_for_approval')";
export interface LiveTask { id: string; title: string; agent: string; state: string; kind: string; updated_at: string }
/** What the team is doing right now, from live task state: every task (chat replies and continuation rounds included) that is
 *  queued, leased, running or waiting, with the assistant and the objective. Continuation rounds are titled by their goal. */
export function liveTasks(db: DB, opts: { workspace?: string | null; limit?: number } = {}): LiveTask[] {
  const names = new Map((db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  const ws = opts.workspace ?? null;
  const rows = db.prepare(`SELECT j.id, j.objective, j.agent_role, j.state, j.kind, j.updated_at FROM jobs j WHERE j.state IN ${LIVE_STATES} AND j.kind NOT IN ${NOT_LIVE}${ws ? ' AND j.workspace_id = ?' : ''} ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'leased' THEN 0 WHEN 'queued' THEN 2 ELSE 1 END, j.updated_at DESC LIMIT ?`).all(...(ws ? [ws] : []), opts.limit ?? 40) as Array<{ id: string; objective: string; agent_role: string; state: string; kind: string; updated_at: string }>;
  return rows.map((j) => { const goal = /^Continuing \(round/i.test(j.objective) ? (j.objective.match(/^Goal:\s*(.+)$/m)?.[1] ?? j.objective) : j.objective; return { id: j.id, title: taskTitle(goal), agent: names.get(j.agent_role) ?? j.agent_role, state: j.state, kind: j.kind, updated_at: j.updated_at }; });
}

export interface SubmittedApplication { record: string; company: string; role: string; verified: boolean; submitted_at: string; agent: string | null }
/** Job applications submitted in the window, from verified application records (record_application) and their
 *  'application.verified' events. Only a verified record counts as submitted. */
export function submittedApplications(db: DB, sinceIso: string): SubmittedApplication[] {
  const names = new Map((db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  const out = new Map<string, SubmittedApplication>();
  for (const r of db.prepare("SELECT r.id, r.data, r.created_at, j.agent_role FROM records r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.type = 'application' AND r.created_at >= ? ORDER BY r.created_at").all(sinceIso) as Array<{ id: string; data: string; created_at: string; agent_role: string | null }>) {
    let d: { company?: string; role?: string; verified?: boolean; submitted_at?: string } = {}; try { d = JSON.parse(r.data); } catch { /* unreadable record: skipped below */ }
    if (!d.company || !d.role) continue;
    out.set(r.id, { record: r.id, company: d.company, role: d.role, verified: d.verified === true, submitted_at: d.submitted_at ?? r.created_at, agent: r.agent_role ? names.get(r.agent_role) ?? r.agent_role : null });
  }
  for (const e of db.prepare("SELECT e.detail, e.at, j.agent_role FROM job_events e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.type = 'application.verified' AND e.at >= ? ORDER BY e.at").all(sinceIso) as Array<{ detail: string; at: string; agent_role: string | null }>) {
    let d: { record?: string; company?: string; role?: string } = {}; try { d = JSON.parse(e.detail); } catch { continue; }
    const key = d.record ?? `${d.company}|${d.role}|${e.at}`; const prev = out.get(key);
    if (prev) { prev.verified = true; continue; }
    if (d.company && d.role) out.set(key, { record: d.record ?? '', company: d.company, role: d.role, verified: true, submitted_at: e.at, agent: e.agent_role ? names.get(e.agent_role) ?? e.agent_role : null });
  }
  return [...out.values()].filter((a) => a.verified).sort((x, y) => x.submitted_at.localeCompare(y.submitted_at));
}

/** Deterministic step: snapshot the ledger into a new report row and render it as plain text for the Chief of Staff. */
export function collectReport(db: DB, jobId: string, workspace: string | null): { report_id: string; report_text: string } {
  const snap = homeSnapshot(db, { workspace }); const open = openWork(db); const reading = latestReading(db); const gov = computeGovernor(db);
  const last = db.prepare("SELECT period_end FROM reports WHERE kind = 'morning' AND status = 'written' ORDER BY created_at DESC LIMIT 1").get() as { period_end: string } | undefined;
  const id = newId('rep'); const t = now();
  const live = liveTasks(db, { workspace }); const since = new Date(Date.now() - snap.window_hours * 3600_000).toISOString(); const applications = submittedApplications(db, since);
  const needs = snap.today.filter((x) => x.kind !== 'routine' && x.kind !== 'done'); const fixing = snap.being_fixed;
  const data = { ...snap, open, live, applications, usage: reading ? { pct: reading.governing_pct, windows: reading.windows, observed_at: reading.observed_at, level: gov.level } : null };
  db.prepare('INSERT INTO reports(id, kind, job_id, workspace_id, period_start, period_end, data, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'morning', jobId, workspace, last?.period_end ?? new Date(Date.now() - 24 * 3600_000).toISOString(), t, JSON.stringify(data), 'collected', t);
  const lines: string[] = [];
  lines.push(`Finished in the last ${snap.window_hours} hours (${snap.finished.length}):`, ...(snap.finished.length ? snap.finished.map((f) => `- ${f.title} (${f.agent}${f.outcome ? `, ${f.outcome}` : ''})`) : ['- nothing']));
  const running = live.filter((t) => t.state === 'leased' || t.state === 'running'); const waiting = live.filter((t) => t.state !== 'leased' && t.state !== 'running');
  lines.push(`Results saved: ${snap.figures.results}.`, `Running now: ${running.length}.`);
  lines.push(`Live tasks (${live.length}: ${running.length} running, ${waiting.length} queued or waiting):`, ...(live.length ? live.map((t) => `- ${t.agent}: ${t.title} (${STATE_WORDS[t.state] ?? t.state})`) : ['- none']));
  lines.push(`Job applications submitted and verified in the last ${snap.window_hours} hours (${applications.length}):`, ...(applications.length ? applications.map((a) => `- ${a.company} — ${a.role} (verified${a.agent ? `, by ${a.agent}` : ''})`) : ['- none']));
  // The owner's list holds only what truly needs him; what an assistant can unblock itself is the team's (see cos/owner-needs.ts).
  lines.push(`Needs the owner (${snap.figures.needs_you}):`, ...(needs.length ? needs.map((x) => `- ${x.title}${x.detail ? ` — ${x.detail}` : ''}`) : ['- nothing']));
  lines.push(`Being fixed by the team (${fixing.length}):`, ...(fixing.length ? fixing.map((x) => `- ${x.title}${x.detail ? ` — ${x.detail}` : ''}`) : ['- nothing']));
  lines.push('Routines due today:', ...(snap.today.filter((x) => x.kind === 'routine').map((x) => `- ${x.title} at ${x.at}`)), ...(snap.today.some((x) => x.kind === 'routine') ? [] : [`- none left today${snap.next_routine ? `; next: ${snap.next_routine.title} at ${new Date(snap.next_routine.at).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}` : ''}`]));
  lines.push(`Open work to rank (${open.length}):`, ...(open.length ? open.map((o) => `- task ${o.id}: ${o.title} (${o.agent}, ${o.state}${o.rank ? `, currently rank ${o.rank}` : ', unranked'})`) : ['- none']));
  lines.push(reading ? `Claude usage (measured ${reading.observed_at}): ${reading.windows.map((w) => `${w.name} ${w.utilization}%`).join(', ')}; governor level ${gov.level}.` : 'Claude usage: not measured yet.');
  return { report_id: id, report_text: lines.join('\n') };
}

/** Tool for the Chief of Staff: store the written headline and lede on the report this task collected. */
export function saveReport(db: DB, input: { job_id: string; headline: string; lede: string }): { ok: true; report_id: string } | { ok: false; reason: string } {
  const rep = db.prepare("SELECT id FROM reports WHERE job_id = ? AND kind = 'morning' ORDER BY created_at DESC LIMIT 1").get(input.job_id) as { id: string } | undefined;
  if (!rep) return { ok: false, reason: 'save_report only works inside a morning report task' };
  const headline = (() => { const h = String(input.headline ?? '').replace(/\s+/g, ' ').trim(); return h && !/[.!?]$/.test(h) ? `${h}.` : h; })(); /* a headline is a sentence: it ends with a full stop */ const lede = String(input.lede ?? '').replace(/\s+/g, ' ').trim();
  if (headline.length < 4 || headline.length > 140) return { ok: false, reason: 'headline must be 4-140 characters' };
  if (lede.length < 10 || lede.length > 180) return { ok: false, reason: 'lede must be 10-180 characters (it is shown as three lines); shorten it and keep complete sentences' };
  // A stated count of things needing the owner must equal the snapshot's own count (the screen shows that number beside it).
  const data = JSON.parse(String((db.prepare('SELECT data FROM reports WHERE id = ?').get(rep.id) as { data: string }).data)) as { figures?: { needs_you?: number } };
  const want = data.figures?.needs_you ?? null; const W: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  for (const m of `${headline} ${lede}`.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:\w+\s+)?(decisions?|items?|things?|requests?)\b/gi)) {
    const n = W[m[1].toLowerCase()] ?? Number(m[1]); if (want !== null && n !== want) return { ok: false, reason: `the snapshot has ${want} thing${want === 1 ? '' : 's'} that need the owner; say ${want} or leave the number out` };
  }
  db.prepare("UPDATE reports SET headline = ?, lede = ?, status = 'written', written_at = ? WHERE id = ?").run(headline, lede, now(), rep.id);
  return { ok: true, report_id: rep.id };
}
export function latestReport(db: DB): Record<string, unknown> | null { const r = db.prepare("SELECT * FROM reports WHERE kind = 'morning' AND status = 'written' ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined; if (!r) return null; const day = String(r.created_at).slice(0, 10); const first = (db.prepare("SELECT min(written_at) AS t FROM reports WHERE kind = 'morning' AND status = 'written' AND substr(created_at, 1, 10) = ?").get(day) as { t: string | null }).t; return { ...r, first_written_at: first, data: JSON.parse(String(r.data)) }; }   /* first_written_at: the day's first report, for an 'Updated … · first written …' stamp */
