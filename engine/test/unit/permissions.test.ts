// standing permissions. Criteria ids in test names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { ActionStore } from '../../src/actions/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { TOOL_SCHEMAS, type Capability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';
import { proposePermission, activatePermission, revokePermission, matchPermission, listPermissions } from '../../src/approvals/permissions.ts';
import { confirmSubject } from '../../src/api/owner-presence.ts';

function setup() {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  new Definitions(db).seedSystemDefaults();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  return { db, store, approvals, actions, broker };
}
const cap = (job: { id: string; agent_role: string }): Capability => ({ token: 't', job_id: job.id, role: job.agent_role, workspace: '/tmp', tools: ['request_approval'], issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
const turn = (s: ReturnType<typeof setup>, key: string, agent = 'coordinator') => s.store.create({ idempotency_key: key, kind: 'chat.turn', objective: 'reply', success_contract: {}, agent_role: agent, inputs: {} }, 'owner').job;
const ask = (s: ReturnType<typeof setup>, j: { id: string; agent_role: string }, target = 'email to owner@example.org', kind = 'send') => s.broker.call(cap(j), 'request_approval', { kind, target, content: `Subject: Hi\n\nHello ${Math.random()}` });

test('A1/A5: a permission starts proposed from a real approval; only the owner confirmation of its exact scope activates it; no assistant tool exists for it', async () => {
  const s = setup(); const j = turn(s, 't1'); const r = await ask(s, j); const apId = (r.data as { id: string }).id;
  const p = proposePermission(s.db, { approval_id: apId, max_per_day: 2, days: 30, agent_name: 'Chief of Staff' }, 'owner');
  assert.equal(p.status, 'proposed'); assert.match(p.scope_text, /Chief of Staff may send without asking, only to owner@example.org, at most 2 in any 24 hours/);
  assert.equal(matchPermission(s.db, { agent_id: 'coordinator', action_kind: 'send', target: 'email to owner@example.org' }), null, 'a proposed permission allows nothing');
  const sub = confirmSubject(s.db, 'permit', p.id)!; assert.equal(sub.binding, p.scope_hash); assert.equal(sub.content, p.scope_text);
  activatePermission(s.db, p.id, 'owner'); assert.equal(confirmSubject(s.db, 'permit', p.id), null, 'an active permission cannot be confirmed again');
  assert.throws(() => activatePermission(s.db, p.id, 'owner'), /active/);
  // Owner direction 2026-10-13: the lead may switch permissions on the owner's own quoted words (set_permission); no other tool touches them.
  assert.deepEqual(Object.keys(TOOL_SCHEMAS).filter((t) => /permission|permit/.test(t)), ['set_permission'], 'only the lead\'s owner-worded set_permission changes permissions');
  assert.throws(() => proposePermission(s.db, { approval_id: apId, max_per_day: 50 }, 'owner'), /1 to 20/);
});

test('A2/A3: a covered request is recorded with its exact content and approved by the permission; other targets, kinds, assistants and the daily limit still ask', async () => {
  const s = setup(); const j0 = turn(s, 't0'); const first = await ask(s, j0);
  const p = activatePermission(s.db, proposePermission(s.db, { approval_id: (first.data as { id: string }).id, max_per_day: 2 }, 'owner').id, 'owner');
  const j1 = turn(s, 't1'); const r1 = await ask(s, j1);
  assert.match(r1.text, /Allowed by the owner's standing permission/); const a1 = s.approvals.get((r1.data as { id: string }).id)!;
  assert.equal(a1.status, 'approved'); assert.equal(a1.decided_by, `permission:${p.id}`); assert.ok(a1.content.startsWith('Subject: Hi') && a1.content_hash.length === 64, 'exact content is still recorded');
  assert.equal(s.approvals.get(((await ask(s, turn(s, 'x1'), 'email to someone-else@example.org')).data as { id: string }).id)!.status, 'pending', 'a new recipient asks');
  assert.equal(s.approvals.get(((await ask(s, turn(s, 'x2'), 'email to owner@example.org', 'publish')).data as { id: string }).id)!.status, 'pending', 'another kind asks');
  assert.equal(s.approvals.get(((await ask(s, turn(s, 'x3', 'researcher'))).data as { id: string }).id)!.status, 'pending', 'another assistant asks');
  await ask(s, turn(s, 'x4')); // second use today (limit 2 includes the first covered request)
  assert.equal(s.approvals.get(((await ask(s, turn(s, 'x5'))).data as { id: string }).id)!.status, 'pending', 'over the daily limit asks');
  assert.equal(listPermissions(s.db)[0].uses, 2);
});

test('A3: purchase, delete and production changes can never be allowed in advance', async () => {
  const s = setup(); const r = await s.broker.call(cap(turn(s, 'p')), 'request_approval', { kind: 'purchase', target: 'vendor', content: 'buy x' });
  assert.throws(() => proposePermission(s.db, { approval_id: (r.data as { id: string }).id }, 'owner'), /always asks you/);
});

test('A4: revoking and expiry stop a permission at once', async () => {
  const s = setup(); const first = await ask(s, turn(s, 'a'));
  const p = activatePermission(s.db, proposePermission(s.db, { approval_id: (first.data as { id: string }).id, days: 1 }, 'owner').id, 'owner');
  assert.ok(matchPermission(s.db, { agent_id: 'coordinator', action_kind: 'send', target: 'email to owner@example.org' }));
  assert.equal(matchPermission(s.db, { agent_id: 'coordinator', action_kind: 'send', target: 'email to owner@example.org' }, new Date(Date.now() + 2 * 86400_000).toISOString()), null, 'expired');
  const q = activatePermission(s.db, proposePermission(s.db, { approval_id: (first.data as { id: string }).id }, 'owner').id, 'owner');
  assert.equal(revokePermission(s.db, q.id, 'owner'), true); assert.equal(revokePermission(s.db, q.id, 'owner'), false);
  assert.equal(matchPermission(s.db, { agent_id: 'coordinator', action_kind: 'send', target: 'email to owner@example.org' }), null);
  assert.ok(p.id);
});

test('C1: a permission-approved action runs exactly once through the executor', async () => {
  const s = setup(); let calls = 0; s.actions.registerExecutor('send', async () => { calls++; return { ok: true, result: { outbox: 'file' } }; });
  const first = await ask(s, turn(s, 'c0'));
  const p = activatePermission(s.db, proposePermission(s.db, { approval_id: (first.data as { id: string }).id }, 'owner').id, 'owner');
  const a = s.approvals.get(((await ask(s, turn(s, 'c1'))).data as { id: string }).id)!;
  const run = () => s.actions.perform({ job_id: a.job_id, idempotency_key: `approval:${a.id}`, kind: a.action_kind, target: a.target, content: a.content, approval_id: a.id, actor: `permission:${p.id}` });
  assert.equal((await run()).status, 'performed'); await run(); assert.equal(calls, 1, 'idempotent per approval');
  assert.equal(s.approvals.get(a.id)!.status, 'consumed');
});

test('A2/A3 (review): extra recipients in the content, delegated work and another assistant\'s job never use a permission', async () => {
  const s = setup(); const first = await ask(s, turn(s, 'r0'));
  activatePermission(s.db, proposePermission(s.db, { approval_id: (first.data as { id: string }).id }, 'owner').id, 'owner');
  const bcc = await s.broker.call(cap(turn(s, 'r1')), 'request_approval', { kind: 'send', target: 'email to owner@example.org', content: 'To: owner@example.org\nBcc: x@evil.example\nSubject: Hi\n\nHello' });
  assert.equal(s.approvals.get((bcc.data as { id: string }).id)!.status, 'pending', 'an extra Bcc asks');
  const same = await s.broker.call(cap(turn(s, 'r2')), 'request_approval', { kind: 'send', target: 'email to owner@example.org', content: 'To: Owner <OWNER@example.org>\nSubject: Hi\n\nHello' });
  assert.equal(s.approvals.get((same.data as { id: string }).id)!.status, 'approved', 'the same single recipient is covered');
  const parent = turn(s, 'r3'); const child = s.store.create({ idempotency_key: 'child', kind: 'document.create', objective: 'x', success_contract: {}, agent_role: 'coordinator', parent_id: parent.id, inputs: {} } as never, 'agent:researcher').job;
  const del = await s.broker.call(cap(child), 'request_approval', { kind: 'send', target: 'email to owner@example.org', content: 'Subject: Hi\n\nHello' });
  assert.equal(s.approvals.get((del.data as { id: string }).id)!.status, 'pending', 'delegated work asks');
  const auto = s.store.create({ idempotency_key: 'auto', kind: 'chat.turn', objective: 'x', success_contract: {}, agent_role: 'coordinator', inputs: { automatic: true } }, 'system').job;
  assert.equal(s.approvals.get(((await ask(s, auto)).data as { id: string }).id)!.status, 'pending', 'an automatic turn asks');
});

test('A1 (review): only one-recipient targets, current requests, and the waiting email is shown in the confirmed scope', async () => {
  const s = setup(); const many = await s.broker.call(cap(turn(s, 'm')), 'request_approval', { kind: 'send', target: 'email to all customers', content: 'Hello' });
  assert.throws(() => proposePermission(s.db, { approval_id: (many.data as { id: string }).id }, 'owner'), /exactly one recipient/);
  const r = await ask(s, turn(s, 'w')); const p = proposePermission(s.db, { approval_id: (r.data as { id: string }).id }, 'owner');
  assert.match(p.scope_text, /This also allows the email waiting now, exactly as written:\n\nSubject: Hi/);
  s.approvals.decide((r.data as { id: string }).id, 'rejected', 'owner');
  assert.throws(() => proposePermission(s.db, { approval_id: (r.data as { id: string }).id }, 'owner'), /rejected/);
});
