/** Supervisor duties for the Chief of Staff and the usage governor: keep the governor state current, rank work once when low
 *  power begins, and seed the daily morning-report routine (once; the owner can turn it off or remove it). */
import type { DB } from '../db/open.ts';
import { JobStore, now } from '../jobs/store.ts';
import { Definitions } from '../model/definitions.ts';
import { Scheduler } from '../supervisor/scheduler.ts';
import { refreshGovernor } from '../usage/governor.ts';
import { openWork } from './report.ts';

export function governorTick(db: DB, store: JobStore): { level: string; changed: boolean; rankJob: string | null } {
  const { state, changed } = refreshGovernor(db); let rankJob: string | null = null;
  // Once per entry into low power, whoever recorded the change (worker reading, override, this tick): the latest change into low
  // power that has no ranking job created after it gets one, when there is unranked open work.
  const entered = db.prepare("SELECT at FROM job_events WHERE type = 'usage.level_changed' AND json_extract(detail, '$.to') = 'low_power' ORDER BY at DESC LIMIT 1").get() as { at: string } | undefined;
  const ranked = entered ? db.prepare("SELECT 1 FROM jobs WHERE kind = 'priority.rank' AND created_at >= ?").get(entered.at) : null;
  if (state.level === 'low_power' && entered && !ranked && openWork(db).some((o) => o.rank === null)) {
    const busy = db.prepare("SELECT 1 FROM jobs WHERE kind = 'priority.rank' AND state IN ('queued','leased','running')").get();
    const wf = new Definitions(db).getWorkflow('priority.rank');
    if (!busy && wf) { const r = store.create({ idempotency_key: `rank:low_power:${entered.at}`, kind: wf.id, objective: 'Rank open work for low-power mode', success_contract: wf.contract, agent_role: wf.default_agent, priority: 1, inputs: { reason: 'low_power' } }, 'governor'); rankJob = r.job.id; }
  }
  return { level: state.level, changed, rankJob };
}

export function seedMorningRoutine(db: DB, scheduler: Scheduler, tz = Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  if (db.prepare("SELECT 1 FROM runtime_state WHERE key = 'morning_report.seeded'").get()) return null;
  const s = scheduler.add({ name: 'Morning report', kind: 'report.morning', objective: 'Write the morning report', cron: '0 7 * * *', tz }, 'system');
  db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('morning_report.seeded', ?, 'daily routine created once; the owner may remove it', ?)").run(JSON.stringify({ schedule: s.id, tz }), now());
  return s.id;
}
