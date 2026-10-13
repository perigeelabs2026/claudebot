import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore, sha256 } from '../../src/jobs/store.ts';
import { IllegalTransition } from '../../src/jobs/types.ts';

function store(clock?: () => string) { return new JobStore(openDatabase(':memory:'), clock); }
const newJob = (key = 'k1') => ({ idempotency_key: key, kind: 'research.scan', objective: 'o', success_contract: {}, agent_role: 'market_research' });

test('create is idempotent on idempotency_key', () => {
  const s = store();
  const a = s.create(newJob()); const b = s.create(newJob());
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.job.id, b.job.id);
  assert.equal(s.list({ state: 'queued' }).length, 1);
});

test('lease is exclusive: second lease attempt gets nothing', () => {
  const s = store(); s.create(newJob());
  const a = s.lease({ owner: 'w1', leaseSeconds: 60 }); const b = s.lease({ owner: 'w2', leaseSeconds: 60 });
  assert.ok(a); assert.equal(a!.state, 'leased'); assert.equal(a!.lease_owner, 'w1'); assert.equal(b, undefined);
});

test('heartbeat is compare-and-set on lease owner', () => {
  const s = store(); s.create(newJob()); const j = s.lease({ owner: 'w1', leaseSeconds: 60 })!;
  assert.equal(s.heartbeat(j.id, 'w2', 60), false);  // zombie
  assert.equal(s.heartbeat(j.id, 'w1', 60), true);   // control
});

test('expired lease is reclaimed to queued keeping stage attempt and checkpoint', () => {
  let t = Date.parse('2026-10-06T10:00:00Z');
  const s = store(() => new Date(t).toISOString());
  s.create(newJob()); const j = s.lease({ owner: 'w1', leaseSeconds: 30 })!;
  s.transition(j.id, 'running', 'w1'); s.setStage(j.id, 1, 'analyze', 2);
  const cp = s.checkpoint(j.id, { stage_index: 1, stage_name: 'analyze', attempt: 2, phase: 'before', payload: { x: 1 } });
  assert.deepEqual(s.reclaimExpired(), []);            // control: not yet expired
  t += 31_000;
  const reclaimed = s.reclaimExpired();
  assert.equal(reclaimed.length, 1); assert.equal(reclaimed[0].state, 'queued'); assert.equal(reclaimed[0].lease_owner, null);
  assert.equal(reclaimed[0].stage_attempt, 2); assert.equal(reclaimed[0].last_good_checkpoint_id, cp.id);
  assert.ok(s.events(j.id).some((e) => e.type === 'lease.reclaimed'));
  const again = s.lease({ owner: 'w2', leaseSeconds: 30 }); assert.equal(again!.id, j.id);
});

test('illegal transitions throw', () => {
  const s = store(); const { job } = s.create(newJob());
  assert.throws(() => s.transition(job.id, 'running', 'x'), IllegalTransition);
  const l = s.lease({ owner: 'w', leaseSeconds: 10 })!; s.transition(l.id, 'running', 'w'); s.transition(l.id, 'completed', 'w');
  assert.throws(() => s.transition(l.id, 'running', 'w'), IllegalTransition);
});

test('terminal failure keeps the last good checkpoint and distinguishes failure kinds', () => {
  const s = store(); s.create(newJob()); const j = s.lease({ owner: 'w', leaseSeconds: 10 })!; s.transition(j.id, 'running', 'w');
  const cp = s.checkpoint(j.id, { stage_index: 0, stage_name: 'a', attempt: 1, phase: 'after', payload: { ok: true } });
  const r1 = s.failRetryable(j.id, 'w', 'boom');
  assert.equal(r1.state, 'retry_scheduled'); assert.equal(r1.failure_kind, 'retryable'); assert.ok(r1.retry_at);
  s.transition(j.id, 'queued', 'sup'); s.lease({ owner: 'w', leaseSeconds: 10 }); s.transition(j.id, 'running', 'w');
  const r2 = s.failTerminal(j.id, 'w', 'fatal', 'Fix X then re-queue');
  assert.equal(r2.state, 'failed_terminal'); assert.equal(r2.failure_kind, 'terminal'); assert.equal(r2.last_good_checkpoint_id, cp.id); assert.match(r2.operator_action!, /re-queue/);
});

test('retry budget exhaustion becomes terminal with a plain-English fix', () => {
  const s = store(); s.create(newJob());
  let j = s.lease({ owner: 'w', leaseSeconds: 10 })!;
  for (let i = 0; i < 5; i++) {
    s.transition(j.id, 'running', 'w');
    j = s.failRetryable(j.id, 'w', `fail ${i}`);
    if (j.state === 'failed_terminal') break;
    s.transition(j.id, 'queued', 'sup'); s.lease({ owner: 'w', leaseSeconds: 10 });
  }
  assert.equal(j.state, 'failed_terminal'); assert.equal(j.blocker_code, 'RETRY_BUDGET_EXHAUSTED'); assert.match(j.operator_action!, /failed 5 times/);
});

test('latestVerified skips a tampered checkpoint, records one incident, and uses the previous good one', () => {
  const s = store(); s.create(newJob()); const j = s.lease({ owner: 'w', leaseSeconds: 10 })!; s.transition(j.id, 'running', 'w');
  const good = s.checkpoint(j.id, { stage_index: 0, stage_name: 'a', attempt: 1, phase: 'after', payload: { n: 1 } });
  const bad = s.checkpoint(j.id, { stage_index: 1, stage_name: 'b', attempt: 1, phase: 'before', payload: { n: 2 } });
  assert.equal(s.latestVerified(j.id)!.id, bad.id);   // control: untampered → newest
  s.db.prepare("UPDATE checkpoints SET payload = '{\"n\":999}' WHERE id = ?").run(bad.id);
  assert.equal(s.latestVerified(j.id)!.id, good.id);
  assert.equal(s.latestVerified(j.id)!.id, good.id);
  const incidents = s.db.prepare("SELECT * FROM incidents WHERE code='CHECKPOINT_CORRUPT'").all();
  assert.equal(incidents.length, 1);
  assert.equal(sha256(good.payload), good.sha256);
});

test('complete refuses when the success contract is unmet and succeeds when met', () => {
  const s = store();
  const { job } = s.create({ ...newJob(), success_contract: { requires_keys: ['summary'], requires_artifacts: ['note'] } });
  s.lease({ owner: 'w', leaseSeconds: 10 }); s.transition(job.id, 'running', 'w');
  const r = s.complete(job.id, 'w', { summary: 'x' });
  assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['missing artifact of kind note']); assert.equal(s.get(job.id)!.state, 'running');
  s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('a1', ?, 's', 'note', 't', 'now')").run(job.id);
  const r2 = s.complete(job.id, 'w', { summary: 'x' });
  assert.equal(r2.ok, true); assert.equal(s.get(job.id)!.state, 'completed');
});

test('plan limit becomes waiting_for_reset and is promoted when due; auth pauses only its identity', () => {
  let t = Date.parse('2026-10-06T10:00:00Z');
  const s = store(() => new Date(t).toISOString());
  s.create(newJob('a')); s.create(newJob('b'));
  const a = s.lease({ owner: 'w', leaseSeconds: 10 })!; s.transition(a.id, 'running', 'w');
  const w = s.waitForReset(a.id, 'w', '2026-10-06T10:30:00Z', { message: 'limit' });
  assert.equal(w.state, 'waiting_for_reset'); assert.equal(w.reset_at, '2026-10-06T10:30:00Z');
  const b = s.lease({ owner: 'w', leaseSeconds: 10 })!; s.transition(b.id, 'running', 'w');
  s.waitForAuth(b.id, 'w', 'browser:linkedin.com', 'Sign in to LinkedIn in the ClaudeBot browser profile');
  assert.deepEqual(s.promoteDue().map((j) => j.id), []);           // control
  t = Date.parse('2026-10-06T10:31:00Z');
  assert.deepEqual(s.promoteDue().map((j) => j.id), [a.id]);
  assert.deepEqual(s.resumeWaitingOn('claude').map((j) => j.id), []);   // control: different identity
  assert.deepEqual(s.resumeWaitingOn('browser:linkedin.com').map((j) => j.id), [b.id]);
});

test('waiting_for_reset without reset time uses bounded probing', () => {
  const s = store(); s.create(newJob()); const j = s.lease({ owner: 'w', leaseSeconds: 10 })!; s.transition(j.id, 'running', 'w');
  const w = s.waitForReset(j.id, 'w', null, {}, 3);
  assert.equal(w.reset_at, null); assert.ok(w.retry_at); assert.match(w.next_action!, /probe/);
});
