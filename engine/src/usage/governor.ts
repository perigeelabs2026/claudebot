/**
 * Usage governor. The only measurement is Claude Code's own `/usage` answer read through the installed route (it reports the
 * subscription's 5-hour and weekly utilization, account-wide). Nothing here estimates a percentage: no reading → no number.
 * Levels: normal < low power (default 90%) < stopped (default 95%). The dispatcher enforces the level in the lease query.
 */
import type { DB } from '../db/open.ts';
import { newId, now } from '../jobs/store.ts';
import { Settings } from '../model/settings.ts';

export interface UsageWindow { name: string; utilization: number; resets_at: string | null }
export interface ParsedUsage { subscription: string | null; has_limits: boolean; windows: UsageWindow[] }
export interface UsageReading { id: string; observed_at: string; source: string; session_ref: string | null; job_id: string | null; subscription: string | null; has_limits: boolean; governing_pct: number | null; windows: UsageWindow[] }
export type Level = 'normal' | 'low_power' | 'stopped';
export interface GovernorState { level: Level; measured_level: Level; pct: number | null; reading: UsageReading | null; stale: boolean; override: Override | null; low_power_pct: number; stop_pct: number; claude_kinds: string[]; observed_at: string }
export interface Override { id: string; mode: 'normal' | 'low_power'; reason: string; created_by: string; via: string; created_at: string; expires_at: string; revoked_at: string | null }

export const STALE_MS = 6 * 3600_000;
export const READ_EVERY_MS = 5 * 60_000;

/** Parse the Markdown that claude-agent-acp renders for `/usage`. Only lines of the form `**<label>** — **<n>%**` count. */
export function parseUsageMarkdown(text: string): ParsedUsage {
  const sub = text.match(/>\s*Claude\s+(.+?)\s+subscription usage/i);
  const windows: UsageWindow[] = [];
  const limits = text.split(/^###\s+/m).find((s) => /^Limits\b/.test(s)) ?? '';
  for (const m of limits.matchAll(/\*\*([^*\n]+?)\*\*\s*[—–-]\s*\*\*(\d{1,3}(?:\.\d+)?)%\*\*(?:\s*·\s*Resets\s+([^\n`]+))?/g)) {
    const u = Number(m[2]); if (!Number.isFinite(u) || u < 0 || u > 100) continue;
    windows.push({ name: m[1].replace(/\\(.)/g, '$1').trim(), utilization: u, resets_at: m[3] ? m[3].trim() : null });
  }
  // Only Claude Code's own /usage answer counts: it starts with the subscription header. Model-written text with a Limits section does not.
  return { subscription: sub ? sub[1].trim() : null, has_limits: !!sub && windows.length > 0, windows: sub ? windows : [] };
}

const rowR = (r: Record<string, unknown>): UsageReading => ({ ...(r as unknown as UsageReading), has_limits: !!r.has_limits, windows: JSON.parse(String(r.windows || '[]')) as UsageWindow[] });

export function recordReading(db: DB, input: { text: string; source: string; session_ref?: string | null; job_id?: string | null }, at = now()): UsageReading {
  const p = parseUsageMarkdown(input.text);
  const id = newId('use'); const pct = p.has_limits ? Math.max(...p.windows.map((w) => w.utilization)) : null;
  db.prepare('INSERT INTO usage_readings(id, observed_at, source, session_ref, job_id, subscription, has_limits, governing_pct, windows) VALUES (?,?,?,?,?,?,?,?,?)').run(id, at, input.source, input.session_ref ?? null, input.job_id ?? null, p.subscription, p.has_limits ? 1 : 0, pct, JSON.stringify(p.windows));
  return rowR(db.prepare('SELECT * FROM usage_readings WHERE id = ?').get(id) as Record<string, unknown>);
}
/** The most recent reading that carried limits (a limits-free answer never replaces a real number). */
export function latestReading(db: DB): UsageReading | null { const r = db.prepare('SELECT * FROM usage_readings WHERE has_limits = 1 ORDER BY observed_at DESC LIMIT 1').get() as Record<string, unknown> | undefined; return r ? rowR(r) : null; }
/** Is a new reading due? Every 5 minutes, or after every turn once usage is at or above 80%. */
export function readingDue(db: DB, nowMs = Date.now()): boolean {
  const last = db.prepare('SELECT observed_at, governing_pct FROM usage_readings ORDER BY observed_at DESC LIMIT 1').get() as { observed_at: string; governing_pct: number | null } | undefined;
  if (!last) return true; if ((last.governing_pct ?? 0) >= 80) return true;
  return nowMs - Date.parse(last.observed_at) >= READ_EVERY_MS;
}

export function activeOverride(db: DB, at = now()): Override | null { return (db.prepare('SELECT * FROM usage_overrides WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(at) as unknown as Override | undefined) ?? null; }
export function setOverride(db: DB, input: { mode: 'normal' | 'low_power'; minutes: number; reason?: string; by: string; via: 'app' | 'telegram' | 'api' }): Override {
  if (!['normal', 'low_power'].includes(input.mode)) throw new Error('mode must be normal or low_power');
  const minutes = Math.round(Number(input.minutes)); if (!Number.isFinite(minutes) || minutes < 15 || minutes > 24 * 60) throw new Error('an override lasts 15 minutes to 24 hours');
  const id = newId('ovr'); const t = now(); const exp = new Date(Date.now() + minutes * 60_000).toISOString();
  db.prepare('UPDATE usage_overrides SET revoked_at = ?, revoked_by = ? WHERE revoked_at IS NULL AND expires_at > ?').run(t, `${input.by} (replaced)`, t);
  db.prepare('INSERT INTO usage_overrides(id, mode, reason, created_by, via, created_at, expires_at) VALUES (?,?,?,?,?,?,?)').run(id, input.mode, String(input.reason ?? '').slice(0, 300), input.by, input.via, t, exp);
  db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(t, input.by, 'usage.override_set', JSON.stringify({ id, mode: input.mode, minutes, via: input.via, reason: input.reason ?? '' }));
  return db.prepare('SELECT * FROM usage_overrides WHERE id = ?').get(id) as unknown as Override;
}
export function revokeOverride(db: DB, id: string, by: string): boolean {
  const t = now(); const r = db.prepare('UPDATE usage_overrides SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(t, by, id);
  if (Number(r.changes)) db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(t, by, 'usage.override_revoked', JSON.stringify({ id }));
  return Number(r.changes) > 0;
}

/** Workflows that start Claude turns (chat or claude stages): the only work the governor holds back. */
export function claudeKinds(db: DB): string[] {
  return (db.prepare('SELECT id, stages FROM workflow_definitions').all() as Array<{ id: string; stages: string }>).filter((w) => { try { return (JSON.parse(w.stages) as Array<{ kind: string }>).some((s) => s.kind === 'claude' || s.kind === 'chat'); } catch { return false; } }).map((w) => w.id);
}

export function computeGovernor(db: DB, nowMs = Date.now()): GovernorState {
  const st = new Settings(db); const low = Number(st.get('usage_low_power_pct')); const stop = Number(st.get('usage_stop_pct'));
  const reading = latestReading(db);
  // A window whose stated reset time has passed is known to have reset: govern only on the windows that are still current.
  const live = reading ? reading.windows.filter((w) => { const r = resetTime(w.resets_at, reading.observed_at); return r === null || r > nowMs; }) : [];
  const pct = reading ? (live.length ? Math.max(...live.map((w) => w.utilization)) : (reading.windows.length ? 0 : reading.governing_pct)) : null;
  const measured: Level = pct === null ? 'normal' : pct >= stop ? 'stopped' : pct >= low ? 'low_power' : 'normal';
  const ovr = activeOverride(db, new Date(nowMs).toISOString());
  const level: Level = ovr ? ovr.mode : measured;
  return { level, measured_level: measured, pct, reading, stale: !!reading && nowMs - Date.parse(reading.observed_at) > STALE_MS, override: ovr, low_power_pct: low, stop_pct: stop, claude_kinds: claudeKinds(db), observed_at: new Date(nowMs).toISOString() };
}

/** Recompute and store the governor state (read by the lease query); records a level change as an event. Returns the state and whether the level changed. */
export function refreshGovernor(db: DB, nowMs = Date.now()): { state: GovernorState; changed: boolean; previous: Level } {
  const state = computeGovernor(db, nowMs);
  const prev = db.prepare("SELECT value FROM runtime_state WHERE key = 'usage.governor'").get() as { value: string } | undefined;
  const previous: Level = prev ? ((JSON.parse(prev.value) as { level?: Level }).level ?? 'normal') : 'normal';
  const value = JSON.stringify({ level: state.level, measured_level: state.measured_level, pct: state.pct, reading_at: state.reading?.observed_at ?? null, override: state.override?.id ?? null, override_expires_at: state.override?.expires_at ?? null, claude_kinds: state.claude_kinds });
  db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('usage.governor', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(value, state.reading ? `claude /usage ${state.reading.observed_at}` : 'no usage reading yet', state.observed_at);
  const changed = previous !== state.level;
  if (changed) db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(state.observed_at, 'governor', 'usage.level_changed', JSON.stringify({ from: previous, to: state.level, pct: state.pct, override: state.override?.id ?? null }));
  return { state, changed, previous };
}

/**
 * SQL (for the lease query, alias j) admitting only jobs the current level allows. normal: all. low power: non-Claude work,
 * the owner's own messages (and their routing), owner-started drafts, the morning report and ranking, and work ranked 1-2 by
 * the Chief of Staff. stopped: non-Claude work only.
 */
export function eligibilityClause(level: Level, kinds: string[]): { sql: string; params: string[] } {
  if (level === 'normal' || !kinds.length) return { sql: '', params: [] };
  const inKinds = `j.kind IN (${kinds.map(() => '?').join(',')})`;
  if (level === 'stopped') return { sql: ` AND NOT (${inKinds})`, params: kinds };
  const owner = "(j.kind = 'chat.turn' AND j.schedule_id IS NULL AND json_extract(j.inputs, '$.automatic') IS NULL AND json_extract(j.inputs, '$.handoff_from') IS NULL AND json_extract(j.inputs, '$.trigger_id') IS NULL)";
  return { sql: ` AND (NOT (${inKinds}) OR ${owner} OR j.kind IN ('report.morning','priority.rank') OR (j.kind = 'assistant.draft' AND j.schedule_id IS NULL) OR EXISTS (SELECT 1 FROM task_priorities tp WHERE tp.job_id = j.id AND tp.rank <= 2))`, params: kinds };
}

/** Same rule in JS, for labelling queued work in the UI ("Deferred: low-power mode" / "Paused: usage at N%"). */
export function deferralOf(job: { id: string; kind: string; state: string; schedule_id: string | null; inputs: string }, gov: Pick<GovernorState, 'level' | 'pct' | 'claude_kinds'>, rank: number | null): string | null {
  if (!['queued', 'retry_scheduled'].includes(job.state) || gov.level === 'normal' || !gov.claude_kinds.includes(job.kind)) return null;
  const pctText = gov.pct === null ? '' : ` (usage ${Math.round(gov.pct)}%)`;
  if (gov.level === 'stopped') return `Paused: usage limit reached${pctText}; starts when usage allows or you override`;
  let i: Record<string, unknown> = {}; try { i = JSON.parse(job.inputs || '{}'); } catch { /* */ }
  const owner = job.kind === 'chat.turn' && !job.schedule_id && !i.automatic && !i.handoff_from && !i.trigger_id;
  if (owner || ['report.morning', 'priority.rank'].includes(job.kind) || (job.kind === 'assistant.draft' && !job.schedule_id) || (rank !== null && rank <= 2)) return null;
  return `Deferred: low-power mode${pctText}; runs when usage allows`;
}

/** Measured cost of one Claude task or turn, in points of the weekly limit: the weekly reading's rise over the last day divided by
 *  the Claude jobs that finished in between. Null until there is a real rise to measure. Used for "About x% of your weekly usage". */
export function perTurnWeeklyCost(db: DB, nowMs = Date.now()): { pct: number; turns: number; since: string; upper: boolean } | null {
  const since = new Date(nowMs - 24 * 3600_000).toISOString();
  const rows = (db.prepare('SELECT observed_at, windows FROM usage_readings WHERE has_limits = 1 AND observed_at >= ? ORDER BY observed_at').all(since) as Array<{ observed_at: string; windows: string }>)
    .map((r) => ({ at: r.observed_at, week: (JSON.parse(r.windows) as UsageWindow[]).find((w) => /week/i.test(w.name) && /all models/i.test(w.name))?.utilization ?? null })).filter((r) => r.week !== null) as Array<{ at: string; week: number }>;
  if (rows.length < 2) return null;
  const first = rows[0]; const last = rows[rows.length - 1]; const rise = last.week - first.week; if (rise < 0) return null;   // a weekly reset in between
  const kinds = claudeKinds(db); if (!kinds.length) return null;
  const turns = (db.prepare(`SELECT count(*) AS n FROM jobs WHERE state = 'completed' AND completed_at > ? AND completed_at <= ? AND kind IN (${kinds.map(() => '?').join(',')})`).get(first.at, last.at, ...kinds) as { n: number }).n;
  if (!turns) return null;
  // Readings are whole points: no visible rise over N turns means each cost less than 1/N of a point (an upper bound, said as such).
  return rise > 0 ? { pct: rise / turns, turns, since: first.at, upper: false } : { pct: 1 / turns, turns, since: first.at, upper: true };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Parse Claude's reset text ("Oct 18 9:00 AM", optionally "(America/Phoenix)") as local time in the reading's year (next year if it
 *  would fall well before the reading). Returns ms, or null when the text cannot be read; an unreadable reset is never assumed. */
export function resetTime(text: string | null, observedAt: string): number | null {
  if (!text) return null;
  const m = text.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i); if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase()); if (mon < 0) return null;
  let h = Number(m[4]) % 12; if (m[6].toLowerCase() === 'pm') h += 12;
  const obs = new Date(observedAt); const year = m[3] ? Number(m[3]) : obs.getFullYear();
  let d = new Date(year, mon, Number(m[2]), h, Number(m[5] ?? 0));
  if (!m[3] && d.getTime() < obs.getTime() - 40 * 86400_000) d = new Date(year + 1, mon, Number(m[2]), h, Number(m[5] ?? 0));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
