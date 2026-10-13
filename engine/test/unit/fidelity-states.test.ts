// Design fidelity round 2: the real states the approved screens show (expired and retried approvals, edited drafts,
// assistant reactions, needs-you presence, the day line on Home). Every state comes from ledger rows, never seeded display data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore, hashContent } from '../../src/approvals/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import type { Capability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';
import { homeSnapshot } from '../../src/model/home.ts';
import { workbenchSnapshot } from '../../src/model/workbench.ts';

function setup() {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fid-'));
  const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test');
  const chat = new ChatStore(db, store);
  const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  return { db, store, approvals, defs, ws, chat, broker };
}
const cap = (job: { id: string; agent_role: string }, tools: string[]): Capability => ({ token: 't', job_id: job.id, role: job.agent_role, workspace: '/tmp', tools, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });

test('an approval whose time ran out expires (nothing done); Retry asks again with the same exact content', () => {
  let t = '2026-10-12T18:10:00.000Z'; const db = openDatabase(':memory:'); const ap = new ApprovalStore(db, () => t);
  const a = ap.request({ action_kind: 'send', target: 'email to owner@example.org', content: 'Subject: Hi\n\nHello', ttlSeconds: 12 * 3600 });
  assert.equal(ap.expireDue().length, 0, 'not due yet');
  t = '2026-10-13T06:10:00.001Z';
  assert.deepEqual(ap.expireDue().map((x) => x.id), [a.id]); assert.equal(ap.get(a.id)!.status, 'expired');
  assert.equal(ap.expireDue().length, 0, 'expiring is idempotent');
  assert.throws(() => ap.decide(a.id, 'approved', 'owner'), /expired/);
  const n = ap.retry(a.id, 'owner', 12 * 3600);
  assert.equal(n.status, 'pending'); assert.notEqual(n.id, a.id); assert.equal(n.content_hash, a.content_hash); assert.equal(n.target, a.target);
  assert.equal(ap.get(a.id)!.status, 'expired', 'the old request keeps its history');
  assert.throws(() => ap.retry(n.id, 'owner'), /only an expired request/);
  assert.ok(db.prepare("SELECT 1 FROM job_events WHERE type = 'approval.retried'").get());
});

test('Edit draft supersedes the pending request and binds the decision to the edited text', () => {
  const s = setup(); const a = s.approvals.request({ action_kind: 'send', target: 'email to owner@example.org', content: 'Subject: Hi\n\nHello' });
  assert.equal(s.approvals.revise(a.id, 'Subject: Hi\n\nHello', 'owner').id, a.id, 'unchanged text keeps the same request');
  const n = s.approvals.revise(a.id, 'Subject: Hi\n\nHello there', 'owner');
  assert.equal(s.approvals.get(a.id)!.status, 'stale'); assert.equal(n.status, 'pending'); assert.equal(n.content_hash, hashContent('Subject: Hi\n\nHello there'));
  assert.throws(() => s.approvals.revise(a.id, 'again', 'owner'), /not pending/);
  assert.throws(() => s.approvals.revise(n.id, '   ', 'owner'), /cannot be empty/);
});

test('an assistant reacts to a message in its own conversation only, with one of the allowed emoji', async () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const sent = s.chat.send(c.id, 'Please look into this.', s.defs);
  const ok = await s.broker.call(cap(sent.job, ['react']), 'react', { emoji: '👍' });
  assert.equal(ok.ok, true); assert.deepEqual(s.chat.reactions(sent.message.id).map((r) => ({ ...r })).map(({ emoji, reactor }) => ({ emoji, reactor })), [{ emoji: '👍', reactor: 'coordinator' }]);
  assert.equal((await s.broker.call(cap(sent.job, ['react']), 'react', { emoji: '💩' })).ok, false, 'emoji outside the list is refused');
  const other = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['researcher'] }); const o = s.chat.send(other.id, 'Other chat', s.defs);
  const r = await s.broker.call(cap(sent.job, ['react']), 'react', { emoji: '👍', message_id: o.message.id }); assert.equal(r.ok, false); assert.match(r.text, /not in this conversation/);
  const job = s.store.create({ idempotency_key: 'k-doc', kind: 'document.create', objective: 'x', success_contract: {}, agent_role: 'researcher', inputs: {} }, 'owner').job;
  assert.equal((await s.broker.call(cap(job, ['react']), 'react', { emoji: '👍' })).ok, false, 'only conversation replies react');
});

test('a pending approval makes its assistant "needs you" in the office and on Home; finished work today shows on the day line', () => {
  const s = setup(); const t = new Date().toISOString();
  const job = s.store.create({ idempotency_key: 'k-chat', kind: 'document.create', objective: 'Draft the launch note', success_contract: {}, agent_role: 'builder', inputs: {} }, 'owner').job;
  s.db.prepare("UPDATE jobs SET state = 'completed', outcome = 'success', completed_at = ? WHERE id = ?").run(t, job.id);
  s.approvals.request({ job_id: job.id, action_kind: 'send', target: 'email to owner@example.org', content: 'Subject: Launch\n\nHello' });
  const wb = workbenchSnapshot(s.db); assert.equal(wb.assistants.find((a) => a.id === 'builder')!.status, 'waiting');
  const home = homeSnapshot(s.db);
  assert.equal(home.team.find((m) => m.id === 'builder')!.state, 'needs_you');
  assert.deepEqual(home.today.map((x) => x.kind), ['approval', 'done']);
  assert.equal(home.today[1].title, 'Draft the launch note'); assert.equal(home.today[1].at, t);
});
