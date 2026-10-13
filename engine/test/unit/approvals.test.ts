import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { ActionStore } from '../../src/actions/store.ts';

function setup(clock?: () => string) { const db = openDatabase(':memory:'); const ap = new ApprovalStore(db, clock); const ac = new ActionStore(db, ap, clock); return { db, ap, ac }; }
const send = { kind: 'send', target: 'mailto:someone@example.com', content: 'Hello' };

test('unapproved consequential action is refused and audited', async () => {
  const { db, ac } = setup();
  const r = await ac.perform({ idempotency_key: 'k1', ...send, actor: 'agent:sales' });
  assert.equal(r.status, 'refused'); assert.match((r as { reason: string }).reason, /approval missing/);
  const ev = db.prepare("SELECT * FROM job_events WHERE type='action.refused'").all();
  assert.equal(ev.length, 1);
});

test('approved action with no enabled executor is still refused (executors disabled in this build)', async () => {
  const { ap, ac } = setup();
  const a = ap.request({ action_kind: 'send', target: send.target, content: send.content });
  ap.decide(a.id, 'approved', 'owner');
  const r = await ac.perform({ idempotency_key: 'k2', ...send, approval_id: a.id, actor: 'agent:sales' });
  assert.equal(r.status, 'refused'); assert.match((r as { reason: string }).reason, /no enabled executor/);
});

test('approved action with an executor performs once; content change makes approval stale', async () => {
  const { ap, ac } = setup();
  let calls = 0; ac.registerExecutor('send', async () => { calls++; return { ok: true, result: { id: 'm1' } }; });
  const a = ap.request({ action_kind: 'send', target: send.target, content: send.content });
  ap.decide(a.id, 'approved', 'owner');
  const bad = await ac.perform({ idempotency_key: 'k3', ...send, content: 'Hello!!', approval_id: a.id, actor: 'x' });
  assert.equal(bad.status, 'refused'); assert.match((bad as { reason: string }).reason, /stale/); assert.equal(calls, 0);
  assert.equal(ap.get(a.id)!.status, 'stale');
  const b = ap.request({ action_kind: 'send', target: send.target, content: send.content }); ap.decide(b.id, 'approved', 'owner');
  const ok = await ac.perform({ idempotency_key: 'k4', ...send, approval_id: b.id, actor: 'x' });
  assert.equal(ok.status, 'performed'); assert.equal(calls, 1); assert.equal(ap.get(b.id)!.status, 'consumed');
  const again = await ac.perform({ idempotency_key: 'k4', ...send, approval_id: b.id, actor: 'x' });
  assert.equal(again.status, 'already_performed'); assert.equal(calls, 1);
});

test('expired approval is rejected; pending and rejected are reported distinctly', async () => {
  let t = Date.parse('2026-10-06T10:00:00Z'); const { ap } = setup(() => new Date(t).toISOString());
  const a = ap.request({ action_kind: 'publish', target: 'x', content: 'c', ttlSeconds: 60 });
  assert.equal(ap.verify(a.id, { kind: 'publish', target: 'x', content: 'c' }).ok, false);
  assert.equal((ap.verify(a.id, { kind: 'publish', target: 'x', content: 'c' }) as { reason: string }).reason, 'pending');
  ap.decide(a.id, 'approved', 'owner');
  assert.equal(ap.verify(a.id, { kind: 'publish', target: 'x', content: 'c' }).ok, true);   // control
  assert.equal((ap.verify(a.id, { kind: 'publish', target: 'y', content: 'c' }) as { reason: string }).reason, 'target_mismatch');
  t += 61_000;
  assert.equal((ap.verify(a.id, { kind: 'publish', target: 'x', content: 'c' }) as { reason: string }).reason, 'expired');
  const b = ap.request({ action_kind: 'publish', target: 'x', content: 'c' }); ap.decide(b.id, 'rejected', 'owner', 'no');
  assert.equal((ap.verify(b.id, { kind: 'publish', target: 'x', content: 'c' }) as { reason: string }).reason, 'rejected');
});

test('non-consequential action runs without approval but still once per key', async () => {
  const { ac } = setup(); let calls = 0; ac.registerExecutor('record_update', async () => { calls++; return { ok: true }; });
  const a = await ac.perform({ idempotency_key: 'r1', kind: 'record_update', target: 'rec-1', content: '{}', actor: 'x' });
  const b = await ac.perform({ idempotency_key: 'r1', kind: 'record_update', target: 'rec-1', content: '{}', actor: 'x' });
  assert.equal(a.status, 'performed'); assert.equal(b.status, 'already_performed'); assert.equal(calls, 1);
});
