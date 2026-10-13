// Chief of Staff and usage governor. Criteria ids in test names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsageMarkdown, recordReading, latestReading, readingDue, computeGovernor, refreshGovernor, setOverride, revokeOverride, deferralOf, resetTime } from '../../src/usage/governor.ts';
import { governorTick } from '../../src/cos/supervise.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { loadConfig } from '../../src/config.ts';
import { setPriority, saveReport, collectReport, latestReport } from '../../src/cos/report.ts';
import { cronMatches, nextCronRun } from '../../src/supervisor/scheduler.ts';

const usageText = (five: number, week: number) => `> Claude Max subscription usage\n\n### Limits\n\n**5-hour limit** — **${five}%** · Resets Oct 12 11:20 PM\n**Weekly · all models** — **${week}%** · Resets Oct 18 9:00 AM\n`;
function setup() { const db = openDatabase(':memory:'); const store = new JobStore(db); new Definitions(db).seedSystemDefaults(); return { db, store }; }
const job = (store: JobStore, key: string, kind: string, inputs: Record<string, unknown> = {}, agent = 'researcher') => store.create({ idempotency_key: key, kind, objective: `Do ${key}`, success_contract: {}, agent_role: agent, inputs }, 'owner').job;
const lease = (store: JobStore) => store.lease({ owner: 'worker:t', leaseSeconds: 30, fair: true }) ?? null;

test('A2: /usage limits parse into windows; the governing value is the highest; a limits-free answer is never a number', () => {
  const p = parseUsageMarkdown(usageText(4, 2));
  assert.equal(p.subscription, 'Max'); assert.equal(p.has_limits, true);
  assert.deepEqual(p.windows.map((w) => [w.name, w.utilization]), [['5-hour limit', 4], ['Weekly · all models', 2]]);
  const { db } = setup();
  const r = recordReading(db, { text: usageText(4, 92), source: 'test' }); assert.equal(r.governing_pct, 92);
  const none = recordReading(db, { text: '> Claude Max subscription usage\n\nTotal tokens: 1200', source: 'test' });
  assert.equal(none.has_limits, false); assert.equal(none.governing_pct, null);
  assert.equal(latestReading(db)!.id, r.id, 'a limits-free answer does not replace the real number');
  assert.equal(parseUsageMarkdown('garbage **x** — **140%**').has_limits, false, 'out-of-range values are ignored');
});

test('A1: a reading is due after 5 minutes, or after every turn at 80% or more', () => {
  const { db } = setup(); const t0 = Date.parse('2026-10-13T06:00:00Z');
  assert.equal(readingDue(db, t0), true, 'no reading yet');
  recordReading(db, { text: usageText(10, 20), source: 'test' }, new Date(t0).toISOString());
  assert.equal(readingDue(db, t0 + 60_000), false); assert.equal(readingDue(db, t0 + 5 * 60_000), true);
  recordReading(db, { text: usageText(10, 81), source: 'test' }, new Date(t0 + 6 * 60_000).toISOString());
  assert.equal(readingDue(db, t0 + 6 * 60_000 + 1000), true);
});

test('B1/A3: thresholds 89.9 / 90 / 95, no reading means normal, a stale reading is still used and labelled', () => {
  const { db } = setup(); const t0 = Date.parse('2026-10-13T06:00:00Z');
  assert.equal(computeGovernor(db, t0).level, 'normal'); assert.equal(computeGovernor(db, t0).pct, null);
  for (const [pct, level] of [[89.9, 'normal'], [90, 'low_power'], [94.9, 'low_power'], [95, 'stopped']] as const) {
    recordReading(db, { text: usageText(1, pct), source: 'test' }, new Date(t0).toISOString());
    assert.equal(computeGovernor(db, t0 + 1000).level, level, `${pct}% → ${level}`);
  }
  assert.equal(computeGovernor(db, t0 + 7 * 3600_000).stale, true); assert.equal(computeGovernor(db, t0 + 7 * 3600_000).level, 'stopped');
  const r1 = refreshGovernor(db, t0 + 1000); assert.equal(r1.changed, true);
  assert.equal(refreshGovernor(db, t0 + 2000).changed, false, 'a level change is logged once');
  assert.equal((db.prepare("SELECT count(*) AS n FROM job_events WHERE type = 'usage.level_changed'").get() as { n: number }).n, 1);
});

test('B5: owner override sets the level for its window, expires by itself, and can be revoked', () => {
  const { db } = setup(); recordReading(db, { text: usageText(1, 96), source: 'test' });
  assert.throws(() => setOverride(db, { mode: 'normal', minutes: 5, by: 'owner', via: 'app' }), /15/);
  const o = setOverride(db, { mode: 'normal', minutes: 60, reason: 'finish the brief', by: 'owner', via: 'app' });
  assert.equal(computeGovernor(db).level, 'normal'); assert.equal(computeGovernor(db).measured_level, 'stopped');
  assert.equal(computeGovernor(db, Date.now() + 61 * 60_000).level, 'stopped', 'expired by itself');
  assert.equal(revokeOverride(db, o.id, 'owner'), true); assert.equal(computeGovernor(db).level, 'stopped');
  assert.equal(revokeOverride(db, o.id, 'owner'), false, 'revoking twice is refused');
});

test('B2/B3/B6: low power leases owner turns and rank 1-2 work only; stopped leases no Claude work; deferred work resumes once, without duplicates', () => {
  const { db, store } = setup();
  const auto = job(store, 'auto', 'chat.turn', { automatic: true }, 'coordinator');
  const low = job(store, 'low', 'research.report');
  const ranked = job(store, 'ranked', 'research.report');
  const owner = job(store, 'owner', 'chat.turn', {}, 'coordinator');
  setPriority(db, { job_id: ranked.id, rank: 2, rationale: 'needed before Thursday', by: 'coordinator', in_job: null });
  setPriority(db, { job_id: low.id, rank: 4, rationale: 'nice to have', by: 'coordinator', in_job: null });
  recordReading(db, { text: usageText(1, 96), source: 'test' }); refreshGovernor(db);
  assert.equal(lease(store), null, 'stopped: no Claude turn starts');
  const gs = computeGovernor(db); assert.match(deferralOf(store.get(owner.id)! as never, gs, null)!, /^Paused: usage limit/);
  recordReading(db, { text: usageText(1, 91), source: 'test' }); refreshGovernor(db);
  const got = new Set<string>(); for (let l = lease(store); l; l = lease(store)) got.add(l.id);
  assert.deepEqual([...got].sort(), [owner.id, ranked.id].sort(), 'low power: the owner message and rank-2 work only');
  const g = computeGovernor(db); assert.match(deferralOf(store.get(low.id)! as never, g, 4)!, /^Deferred: low-power mode/); assert.match(deferralOf(store.get(auto.id)! as never, g, null)!, /^Deferred/);
  recordReading(db, { text: usageText(1, 40), source: 'test' }); refreshGovernor(db);
  const rest = new Set<string>(); for (let l = lease(store); l; l = lease(store)) rest.add(l.id);
  assert.deepEqual([...rest].sort(), [auto.id, low.id].sort(), 'deferred work resumes when usage allows');
  assert.equal(lease(store), null, 'nothing is leased twice');
});

test('C1/D3: ranks need a rationale and an open task; the report keeps only a real written headline', () => {
  const { db, store } = setup(); const j = job(store, 'r1', 'research.report');
  assert.equal(setPriority(db, { job_id: j.id, rank: 7, rationale: 'x', by: 'coordinator', in_job: null }).ok, false);
  assert.equal(setPriority(db, { job_id: j.id, rank: 1, rationale: '', by: 'coordinator', in_job: null }).ok, false);
  const rep = job(store, 'rep', 'report.morning', {}, 'coordinator');
  assert.equal(saveReport(db, { job_id: rep.id, headline: 'Nothing needs you.', lede: 'All quiet overnight.' }).ok, false, 'no collected report for this task yet');
  const c = collectReport(db, rep.id, null); assert.match(c.report_text, /Open work to rank \(1\)/); assert.match(c.report_text, /not measured yet/);
  assert.equal(latestReport(db), null, 'a collected but unwritten report is never shown');
  assert.equal(saveReport(db, { job_id: rep.id, headline: 'One task is open.', lede: 'The Researcher has one open task; nothing needs you yet.' }).ok, true);
  assert.equal((latestReport(db) as { headline: string }).headline, 'One task is open.');
});

test('D4: a 07:00 schedule fires at 07:00 in its own timezone', () => {
  const at = new Date('2026-10-13T14:00:00Z');   // 07:00 in Phoenix (UTC-7, no DST)
  assert.equal(cronMatches('0 7 * * *', at, 'America/Phoenix'), true); assert.equal(cronMatches('0 7 * * *', at, 'Europe/London'), false);
  assert.equal(nextCronRun('0 7 * * *', new Date('2026-10-13T06:00:00Z'), 'America/Phoenix')!.toISOString(), '2026-10-13T14:00:00.000Z');
});

test('A2 (review): text without the /usage subscription header never becomes a reading', () => {
  assert.equal(parseUsageMarkdown('### Limits\n\n**5-hour limit** — **1%** · Resets Oct 12 11:20 PM\n').has_limits, false);
});

test('B6 (review): a window whose stated reset time has passed no longer governs; stopped recovers without a new reading', () => {
  const { db, store } = setup(); const at = '2026-10-12T22:00:00.000Z';
  recordReading(db, { text: `> Claude Max subscription usage\n\n### Limits\n\n**5-hour limit** — **97%** · Resets Oct 12 4:00 PM\n**Weekly · all models** — **20%** · Resets Oct 18 9:00 AM\n`, source: 'test' }, at);
  assert.equal(resetTime('Oct 12 4:00 PM', at), new Date(2026, 9, 12, 16, 0).getTime());
  const before = new Date(2026, 9, 12, 15, 0).getTime(); const after = new Date(2026, 9, 12, 16, 5).getTime();
  assert.equal(computeGovernor(db, before).level, 'stopped');
  assert.equal(computeGovernor(db, after).level, 'normal'); assert.equal(computeGovernor(db, after).pct, 20);
  refreshGovernor(db, before); job(store, 'w', 'research.report'); assert.equal(lease(store), null);
  refreshGovernor(db, after); assert.ok(lease(store), 'work is leased again once the limit has reset');
  assert.equal(resetTime('soon', at), null, 'an unreadable reset is never assumed');
});

test('C3 (review): entering low power ranks open work once, whoever recorded the change', () => {
  const { db, store } = setup(); job(store, 'open1', 'research.report');
  recordReading(db, { text: usageText(1, 92), source: 'worker' }); refreshGovernor(db);   // the worker records the change first
  const t1 = governorTick(db, store); assert.ok(t1.rankJob, 'one ranking task');
  assert.equal(governorTick(db, store).rankJob, null, 'not twice for the same entry');
  assert.equal((db.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'priority.rank'").get() as { n: number }).n, 1);
});

test('C1 (review): set_priority works only inside the morning report or a ranking task, and never on replies or routines', async () => {
  const { db, store } = setup(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-'));
  const broker = new BrokerApi(db, store, new ApprovalStore(db), loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  const target = job(store, 'tgt', 'research.report'); const reply = job(store, 'rep', 'chat.turn', {}, 'coordinator');
  const cap = (j: { id: string; agent_role: string }) => ({ token: 't', job_id: j.id, role: j.agent_role, workspace: '/tmp', tools: ['set_priority'], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal((await broker.call(cap(reply), 'set_priority', { task_id: target.id, rank: 1, rationale: 'urgent for the owner' })).ok, false, 'a chat reply cannot rank');
  const rank = job(store, 'rank', 'priority.rank', {}, 'coordinator');
  assert.equal((await broker.call(cap(rank), 'set_priority', { task_id: target.id, rank: 1, rationale: 'needed before Thursday' })).ok, true);
  assert.equal((await broker.call(cap(rank), 'set_priority', { task_id: reply.id, rank: 1, rationale: 'let it run in low power' })).ok, false, 'replies are not ranked');
});

test('D2 (review 5): a report cannot state a different count of decisions than its own snapshot', () => {
  const { db, store } = setup(); const rep = job(store, 'rep2', 'report.morning', {}, 'coordinator'); collectReport(db, rep.id, null);
  const r = saveReport(db, { job_id: rep.id, headline: 'Four decisions await you today.', lede: 'Nothing else happened overnight, all quiet.' }); assert.equal(r.ok, false);
  assert.equal(saveReport(db, { job_id: rep.id, headline: 'Nothing needs you this morning.', lede: 'Nothing else happened overnight, all quiet.' }).ok, true);
});

test('D4 (review): a 07:00 routine missed while the Mac slept fires once when it wakes, not twice', async () => {
  const { db, store } = setup(); const { Scheduler } = await import('../../src/supervisor/scheduler.ts');
  let t = new Date('2026-10-13T13:00:00Z'); const sc = new Scheduler(db, store, () => t);
  sc.add({ name: 'Morning report', kind: 'report.morning', objective: 'Write the morning report', cron: '0 7 * * *', tz: 'America/Phoenix' }, 'system');
  t = new Date('2026-10-13T14:20:00Z');   // asleep through 07:00 Phoenix (14:00Z)
  assert.equal(sc.tick().filter((x) => x.created).length, 1); assert.equal(sc.tick().filter((x) => x.created).length, 0);
});

test('A3 (review 9): reset times with a comma ("Oct 13, 4:20 AM MST") are read', () => {
  assert.equal(resetTime('Oct 13, 4:20 AM MST', '2026-10-13T09:00:00.000Z'), new Date(2026, 9, 13, 4, 20).getTime());
});
