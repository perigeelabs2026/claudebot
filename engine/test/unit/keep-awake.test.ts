import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { KeepAwake, CAFFEINATE, CAFFEINATE_ARGS } from '../../src/power/awake.ts';
import type { AwakeChild } from '../../src/power/awake.ts';

class FakeChild implements AwakeChild {
  static next = 1000;
  pid = FakeChild.next++; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; killed: NodeJS.Signals[] = [];
  private exitFns: Array<() => void> = [];
  kill(sig: NodeJS.Signals = 'SIGTERM') { this.killed.push(sig); this.signalCode = sig; for (const f of this.exitFns) f(); return true; }
  on(ev: 'exit' | 'error', fn: (...a: never[]) => void) { if (ev === 'exit') this.exitFns.push(fn as () => void); return this; }
  exitOnItsOwn() { this.exitCode = 0; for (const f of this.exitFns) f(); }
}

function setup(opts: { platform?: string; now?: () => number } = {}) {
  const db = openDatabase(':memory:'); const store = new JobStore(db);
  const spawned: Array<{ cmd: string; args: string[]; child: FakeChild }> = [];
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push('WARN ' + m) };
  const ka = new KeepAwake(db, log as never, { platform: opts.platform ?? 'darwin', now: opts.now, spawn: (cmd, args) => { const child = new FakeChild(); spawned.push({ cmd, args, child }); return child; } });
  return { db, store, ka, spawned, logs };
}
const newJob = (key = 'k1') => ({ idempotency_key: key, kind: 'research.scan', objective: 'o', success_contract: {}, agent_role: 'market_research' });
const alive = (s: Array<{ child: FakeChild }>) => s.filter((x) => x.child.exitCode === null && x.child.signalCode === null);

test('keep-awake: no child while idle (queued work alone does not hold the Mac awake)', () => {
  const { store, ka, spawned } = setup();
  assert.equal(ka.tick(), 0); assert.equal(spawned.length, 0);
  store.create(newJob());
  assert.equal(ka.tick(), 0); assert.equal(spawned.length, 0); assert.equal(ka.holding, false);
});

test('keep-awake: exactly one caffeinate child while a job runs, not duplicated across ticks', () => {
  const { store, ka, spawned, logs } = setup();
  store.create(newJob()); const j = store.lease({ owner: 'w', leaseSeconds: 60 })!;
  assert.equal(ka.tick(), 1); assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, CAFFEINATE); assert.deepEqual(spawned[0].args, CAFFEINATE_ARGS); assert.deepEqual(CAFFEINATE_ARGS, ['-i', '-t', '600']);
  store.transition(j.id, 'running', 'w');
  for (let i = 0; i < 5; i++) ka.tick();
  assert.equal(spawned.length, 1); assert.equal(alive(spawned).length, 1); assert.equal(ka.holding, true);
  assert.equal(logs.filter((l) => /keeping the Mac awake/.test(l)).length, 1);
});

test('keep-awake: respawns when caffeinate exits while work remains, and refreshes after ~5 min', () => {
  let t = 0; const { store, ka, spawned, logs } = setup({ now: () => t });
  store.create(newJob()); store.lease({ owner: 'w', leaseSeconds: 60 });
  ka.tick(); spawned[0].child.exitOnItsOwn(); assert.equal(ka.holding, false);
  ka.tick(); assert.equal(spawned.length, 2); assert.equal(alive(spawned).length, 1);
  t += 5 * 60_000; ka.tick();
  assert.equal(spawned.length, 3); assert.deepEqual(spawned[1].child.killed, ['SIGTERM']); assert.equal(alive(spawned).length, 1);
  assert.equal(logs.filter((l) => /keeping the Mac awake/.test(l)).length, 1);   // one start line for the whole stretch of work
});

test('keep-awake: child killed when work ends', () => {
  const { store, ka, spawned, logs } = setup();
  store.create(newJob()); const j = store.lease({ owner: 'w', leaseSeconds: 60 })!; store.transition(j.id, 'running', 'w');
  ka.tick(); assert.equal(alive(spawned).length, 1);
  store.transition(j.id, 'completed', 'w');
  assert.equal(ka.tick(), 0); assert.equal(alive(spawned).length, 0); assert.deepEqual(spawned[0].child.killed, ['SIGTERM']); assert.equal(ka.holding, false);
  ka.tick(); assert.equal(spawned.length, 1);
  assert.ok(logs.some((l) => /may sleep again/.test(l)));
});

test('keep-awake: stop() kills the child and later ticks do nothing', () => {
  const { store, ka, spawned } = setup();
  store.create(newJob()); store.lease({ owner: 'w', leaseSeconds: 60 });
  ka.tick(); assert.equal(alive(spawned).length, 1);
  ka.stop(); assert.equal(alive(spawned).length, 0); assert.equal(ka.holding, false);
  ka.tick(); assert.equal(spawned.length, 1);
});

test('keep-awake: no-op off macOS', () => {
  for (const platform of ['linux', 'win32']) {
    const { store, ka, spawned } = setup({ platform });
    store.create(newJob()); store.lease({ owner: 'w', leaseSeconds: 60 });
    assert.equal(ka.enabled, false); assert.equal(ka.tick(), 0); ka.stop(); assert.equal(spawned.length, 0);
  }
});
