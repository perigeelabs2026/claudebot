import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedRuntime } from '../../src/runtime/simulated.ts';
import { anthropicApiStub, bedrockStub, vertexStub, claudeWorkStub } from '../../src/runtime/stubs.ts';

const req = (over = {}) => ({ jobId: 'j', sessionRef: 's', role: 'r', cwd: '/tmp', prompt: 'p', resume: false, timeoutMs: 50, ...over });

test('simulated runtime follows its script then succeeds', async () => {
  const rt = new SimulatedRuntime([{ kind: 'limit', resetAt: '2026-10-06T12:00:00Z' }, { kind: 'auth' }]);
  const a = await rt.startTurn(req()); const b = await rt.startTurn(req()); const c = await rt.startTurn(req());
  assert.equal(a.ok, false); assert.equal((a as { category: string }).category, 'quota_exhausted'); assert.equal((a as { resetAt: string }).resetAt, '2026-10-06T12:00:00Z');
  assert.equal((b as { category: string }).category, 'auth_required');
  assert.equal(c.ok, true);
});

test('simulated hang is cancellable via cancel()', async () => {
  const rt = new SimulatedRuntime([{ kind: 'hang' }]);
  const p = rt.startTurn(req()); setTimeout(() => rt.cancel('s'), 20);
  const r = await p; assert.equal((r as { category: string }).category, 'cancelled');
});

test('other runtime adapters report not_configured and never pretend to work', async () => {
  for (const s of [anthropicApiStub, bedrockStub, vertexStub, claudeWorkStub]) {
    const h = await s.health(); assert.equal(h.state, 'not_configured'); assert.equal(h.ok, false);
    const t = await s.startTurn(req()); assert.equal(t.ok, false);
  }
});
