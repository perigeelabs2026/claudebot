import type { DB } from '../db/open.ts';
import { JobStore, newId, now } from '../jobs/store.ts';
import { Definitions } from '../model/definitions.ts';

export interface ScheduleRow { id: string; name: string; kind: string; agent_role: string; objective: string; success_contract: string; cron: string | null; every_seconds: number | null; once?: number; enabled: number; last_enqueued_at: string | null; next_run_at: string | null; created_at: string; workspace_id: string | null; inputs: string; tz?: string | null }

/** Minimal 5-field cron matcher (minute hour dom month dow), supports *, lists, ranges, steps. */
export function cronMatches(expr: string, d: Date, tz?: string | null): boolean {
  const parts = expr.trim().split(/\s+/); if (parts.length !== 5) return false;
  const vals = tz ? zonedFields(d, tz) : [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  return parts.every((p, i) => fieldMatches(p, vals[i], i));
}
/** minute, hour, day of month, month, weekday of an instant in an IANA timezone. */
export function zonedFields(d: Date, tz: string): number[] {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday));
  return [Number(p.minute), Number(p.hour) % 24, Number(p.day), Number(p.month), wd];
}
/** Next minute (within `horizonMin`) at which a cron expression fires, or null. */
export function nextCronRun(expr: string, from: Date, tz?: string | null, horizonMin = 2 * 24 * 60): Date | null {
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i <= horizonMin; i++) { const d = new Date(start.getTime() + i * 60_000); if (cronMatches(expr, d, tz)) return d; }
  return null;
}
export function validTimezone(tz: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
function fieldMatches(field: string, v: number, idx: number): boolean {
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return field.split(',').some((part) => {
    const [base, stepS] = part.split('/'); const step = stepS ? Number(stepS) : 1;
    let lo: number, hi: number;
    if (base === '*') { [lo, hi] = ranges[idx]; } else if (base.includes('-')) { [lo, hi] = base.split('-').map(Number) as [number, number]; } else { lo = hi = Number(base); if (stepS) hi = ranges[idx][1]; }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
    if (v < lo || v > hi) return false; return (v - lo) % step === 0;
  });
}

export class Scheduler {
  private db: DB; private store: JobStore; private clock: () => Date;
  constructor(db: DB, store: JobStore, clock: () => Date = () => new Date()) { this.db = db; this.store = store; this.clock = clock; }

  add(s: { name: string; kind: string; agent_role?: string; objective: string; cron?: string | null; every_seconds?: number | null; at?: string | null; enabled?: boolean; workspace_id?: string | null; inputs?: Record<string, unknown>; tz?: string | null }, actor = 'owner'): ScheduleRow {
    if (s.tz && !validTimezone(s.tz)) throw new Error(`unknown timezone ${s.tz}`);
    if (s.cron && !s.tz) s = { ...s, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };   // a routine's time is the owner's local time, recorded explicitly
    const wf = new Definitions(this.db).getWorkflow(s.kind); if (!wf || !wf.enabled) throw new Error(`unknown or disabled workflow ${s.kind}`);
    if (s.at) {
      const when = Date.parse(s.at); if (Number.isNaN(when)) throw new Error('at must be an ISO date-time');
      if (when < this.clock().getTime() - 60_000) throw new Error('at is in the past');
      const id = newId('sch');
      this.db.prepare('INSERT INTO schedules(id, name, kind, agent_role, objective, success_contract, cron, every_seconds, enabled, created_at, workspace_id, inputs, next_run_at, once) VALUES (?,?,?,?,?,?,NULL,NULL,1,?,?,?,?,1)')
        .run(id, s.name, s.kind, s.agent_role ?? wf.default_agent, s.objective, JSON.stringify(wf.contract), this.clock().toISOString(), s.workspace_id ?? null, JSON.stringify(s.inputs ?? {}), new Date(when).toISOString());
      this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(now(), actor, 'schedule.created', JSON.stringify({ id, kind: s.kind, at: new Date(when).toISOString(), once: true, workspace_id: s.workspace_id ?? null }));
      return this.get(id)!;
    }
    if (!s.cron && !s.every_seconds) throw new Error('a schedule needs a time (at), a cron expression or an interval');
    if (s.cron && s.cron.trim().split(/\s+/).length !== 5) throw new Error('cron needs 5 fields');
    const id = newId('sch');
    this.db.prepare('INSERT INTO schedules(id, name, kind, agent_role, objective, success_contract, cron, every_seconds, enabled, created_at, workspace_id, inputs, tz) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, s.name, s.kind, s.agent_role ?? wf.default_agent, s.objective, JSON.stringify(wf.contract), s.cron ?? null, s.every_seconds ?? null, s.enabled === false ? 0 : 1, this.clock().toISOString(), s.workspace_id ?? null, JSON.stringify(s.inputs ?? {}), s.tz ?? null);   /* the scheduler's own clock, so catch-up is measured on one timeline */
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(now(), 'owner', 'schedule.created', JSON.stringify({ id, kind: s.kind, workspace_id: s.workspace_id ?? null }));
    return this.get(id)!;
  }
  remove(id: string): void { this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id); this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(now(), 'owner', 'schedule.removed', JSON.stringify({ id })); }
  get(id: string): ScheduleRow | undefined { return this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined; }
  list(): ScheduleRow[] { return this.db.prepare('SELECT * FROM schedules ORDER BY created_at').all() as unknown as ScheduleRow[]; }
  setEnabled(id: string, enabled: boolean) { this.db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id); }

  /** A schedule made from a conversation posts its results there (cards, and the lead's automatic report). */
  private bindConversation(s: ScheduleRow, jobId: string): void { try { const conv = (JSON.parse(s.inputs || '{}') as { conversation_id?: string }).conversation_id; if (conv) this.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL').run(conv, jobId); } catch { /* */ } }

  /** Called every minute. Enqueues due schedules with a per-minute idempotency key so a restart cannot double-enqueue. */
  tick(): Array<{ schedule: string; job: string; created: boolean }> {
    const d = this.clock(); const minute = d.toISOString().slice(0, 16);
    const out: Array<{ schedule: string; job: string; created: boolean }> = [];
    for (const s of this.list()) {
      if (!s.enabled) continue;
      let due = false;
      if (s.once) {
        // One-shot: due once at next_run_at (catches up after a restart or sleep), then disabled. Keyed per schedule: never twice.
        if (!s.next_run_at || Date.parse(s.next_run_at) > d.getTime()) continue;
        const r = this.store.create({ idempotency_key: `schedule:${s.id}:once`, kind: s.kind, objective: s.objective, success_contract: JSON.parse(s.success_contract), agent_role: s.agent_role, schedule_id: s.id, workspace_id: s.workspace_id, inputs: JSON.parse(s.inputs || '{}') }, 'scheduler');
        this.db.prepare('UPDATE schedules SET last_enqueued_at = ?, enabled = 0 WHERE id = ?').run(now(), s.id);
        this.bindConversation(s, r.job.id);
        out.push({ schedule: s.id, job: r.job.id, created: r.created }); continue;
      }
      let catchUpAt: Date | null = null;
      if (s.cron) { due = cronMatches(s.cron, d, s.tz);
        // Catch up once if the Mac slept or a tick was late: the last matching minute within 6 hours, after the last run, fires now.
        if (!due) { const since = Math.max(s.last_enqueued_at ? Date.parse(s.last_enqueued_at) : 0, Date.parse(s.created_at), d.getTime() - 6 * 3600_000); const nx = nextCronRun(s.cron, new Date(since + 60_000), s.tz, 6 * 60); if (nx && nx.getTime() <= d.getTime() - 60_000) { due = true; catchUpAt = nx; } } }
      else if (s.every_seconds) { const last = s.last_enqueued_at ? Date.parse(s.last_enqueued_at) : 0; due = d.getTime() - last >= s.every_seconds * 1000; }
      if (!due) continue;
      const key = `schedule:${s.id}:${s.cron ? (catchUpAt ? catchUpAt.toISOString().slice(0, 16) : minute) : Math.floor(d.getTime() / (s.every_seconds! * 1000))}`;
      const r = this.store.create({ idempotency_key: key, kind: s.kind, objective: s.objective, success_contract: JSON.parse(s.success_contract), agent_role: s.agent_role, schedule_id: s.id, workspace_id: s.workspace_id, inputs: JSON.parse(s.inputs || '{}') }, 'scheduler');
      if (r.created) { this.db.prepare('UPDATE schedules SET last_enqueued_at = ? WHERE id = ?').run(now(), s.id); this.bindConversation(s, r.job.id); }
      out.push({ schedule: s.id, job: r.job.id, created: r.created });
    }
    return out;
  }
}
