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

/** Deterministic step: snapshot the ledger into a new report row and render it as plain text for the Chief of Staff. */
export function collectReport(db: DB, jobId: string, workspace: string | null): { report_id: string; report_text: string } {
  const snap = homeSnapshot(db, { workspace }); const open = openWork(db); const reading = latestReading(db); const gov = computeGovernor(db);
  const last = db.prepare("SELECT period_end FROM reports WHERE kind = 'morning' AND status = 'written' ORDER BY created_at DESC LIMIT 1").get() as { period_end: string } | undefined;
  const id = newId('rep'); const t = now();
  const data = { ...snap, open, usage: reading ? { pct: reading.governing_pct, windows: reading.windows, observed_at: reading.observed_at, level: gov.level } : null };
  db.prepare('INSERT INTO reports(id, kind, job_id, workspace_id, period_start, period_end, data, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'morning', jobId, workspace, last?.period_end ?? new Date(Date.now() - 24 * 3600_000).toISOString(), t, JSON.stringify(data), 'collected', t);
  const lines: string[] = [];
  lines.push(`Finished in the last ${snap.window_hours} hours (${snap.finished.length}):`, ...(snap.finished.length ? snap.finished.map((f) => `- ${f.title} (${f.agent}${f.outcome ? `, ${f.outcome}` : ''})`) : ['- nothing']));
  lines.push(`Results saved: ${snap.figures.results}.`, `Running now: ${snap.figures.working}.`);
  lines.push(`Needs the owner (${snap.today.filter((x) => x.kind !== 'routine').length}):`, ...(snap.today.filter((x) => x.kind !== 'routine').map((x) => `- ${x.title}${x.detail ? ` — ${x.detail}` : ''}`)), ...(snap.today.some((x) => x.kind !== 'routine') ? [] : ['- nothing']));
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
