import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { issueCapability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';
import { Settings } from '../../src/model/settings.ts';
import { depthOf, delegationBudget, cancelDescendants } from '../../src/coord/delegation.ts';
import { workbenchSnapshot } from '../../src/model/workbench.ts';

// Simulated: in-memory database, no Claude. Proves the engine's coordination rules, not an installed run.
function setup(workspaceLimit = 4) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'co-')); const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db);
  const defs = new Definitions(db); defs.seedSystemDefaults(); const w = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'P', worker_limit: workspaceLimit } as never, 't');
  const chat = new ChatStore(db, store); const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  const conv = chat.create({ workspace_id: w.id }); const { job: turn } = chat.send(conv.id, 'research and report', defs);
  const capFor = (jobId: string, role: string) => issueCapability(path.join(tmp, 'run'), { id: jobId, agent_role: role }, path.join(tmp, 'w', jobId), defs.getAgent(role)!.allowed_tools);
  const leadCap = issueCapability(path.join(tmp, 'run'), turn, path.join(tmp, 'w', 'lead'), defs.getAgent('coordinator')!.allowed_tools, 3600, conv.id);
  return { tmp, db, store, defs, chat, broker, conv, turn, capFor, leadCap, w };
}
const created = (r: { data?: unknown }) => (r.data as { id: string }).id;

test('coordination: depth and child budgets are enforced by the engine and refusals are audited', async () => {
  const s = setup();
  new Settings(s.db).set('worker_limit', 4, 'owner'); // the default scales with the machine; small CI runners would hit the waiting-parent guard first
  const spec = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'research.report', objective: 'Find three facts' }));
  assert.equal(depthOf(s.db, spec), 1);
  s.store.lease({ owner: 'w', leaseSeconds: 60 }); s.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(spec);
  const specCap = s.capFor(spec, 'researcher');
  const child = await s.broker.call(specCap, 'create_job', { kind: 'browser.read_task', objective: 'Read page A' }); assert.equal(child.ok, true);
  const childId = created(child); assert.equal(depthOf(s.db, childId), 2);
  const card = s.db.prepare("SELECT content, meta FROM messages WHERE job_id = ? AND kind = 'delegation'").get(childId) as { content: string; meta: string };
  assert.match(card.content, /Assigned to Web reader by Researcher/); assert.equal(JSON.parse(card.meta).assigned_by, 'Researcher');
  // grandchild: depth 3 > 2 → refused
  const gc = await s.broker.call(s.capFor(childId, 'researcher'), 'create_job', { kind: 'research.report', objective: 'Go deeper' });
  assert.equal(gc.ok, false); assert.match(gc.text, /depth limit/);
  // children cap: 3 per specialist
  for (const o of ['B', 'C']) assert.equal((await s.broker.call(specCap, 'create_job', { kind: 'browser.read_task', objective: `Read page ${o}` })).ok, true);
  const fourth = await s.broker.call(specCap, 'create_job', { kind: 'browser.read_task', objective: 'Read page D' }); assert.equal(fourth.ok, false); assert.match(fourth.text, /limit is 3/);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM job_events WHERE type = 'delegation.refused'").get() as { n: number }).n, 2);
  // the owner can change the limit; no assistant tool can
  new Settings(s.db).set('delegation_max_children', 4, 'owner'); assert.equal(delegationBudget(s.db, spec).ok, true);
  assert.ok(!s.defs.getAgent('researcher')!.allowed_tools.some((t) => /setting/.test(t)));
});

test('coordination: wait_for_children returns the child result; a waiting parent does not hold its project slot', async () => {
  const s = setup(1); s.db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(s.turn.id);   // the lead's turn has finished
  const spec = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'research.report', objective: 'Parent work' }));
  const leased = s.store.lease({ owner: 'w1', leaseSeconds: 60, fair: true }); assert.equal(leased?.id, spec); s.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(spec);
  const specCap = s.capFor(spec, 'researcher');
  const childId = created(await s.broker.call(specCap, 'create_job', { kind: 'browser.read_task', objective: 'Child read' }));
  assert.equal(s.store.lease({ owner: 'w2', leaseSeconds: 60, fair: true }), undefined, 'project limit 1: the child cannot start while the parent works');
  const waiting = s.broker.call(specCap, 'wait_for_children', { ids: [childId], max_seconds: 10 });
  await new Promise((r) => setTimeout(r, 300));
  assert.match(String((s.store.get(spec) as { waiting_on: string }).waiting_on), /^children:/);
  const c = s.store.lease({ owner: 'w2', leaseSeconds: 60, fair: true }); assert.equal(c?.id, childId, 'the waiting parent frees the slot for its child');
  s.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(childId);
  const wb = workbenchSnapshot(s.db); const pt = wb.tasks.find((t) => t.id === spec)!;
  assert.equal(pt.status, 'blocked_on'); assert.match(pt.plain_state, /Waiting for its child task/); assert.equal(wb.counts.waiting_on_children, 1); assert.equal(wb.counts.waiting_to_start, 0, 'a started parent is not "waiting to start"');
  assert.equal(wb.counts.working, 1, 'only the child is working');
  s.db.prepare("UPDATE jobs SET state = 'completed', outcome = 'success', outcome_detail = '{\"reason\":\"read ok\"}' WHERE id = ?").run(childId);
  s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES ('art-c1', ?, 's', 'file', '/tmp/x', 'h', 'Child findings', '{}', 't')").run(childId);
  const r = await waiting; const d = JSON.parse(r.text) as { all_finished: boolean; children: Array<{ id: string; outcome: string; artifacts: Array<{ id: string }> }> };
  assert.equal(d.all_finished, true); assert.equal(d.children[0].outcome, 'success'); assert.equal(d.children[0].artifacts[0].id, 'art-c1');
  assert.equal((s.store.get(spec) as { waiting_on: string | null }).waiting_on, null, 'waiting mark cleared');
  // another task's child cannot be waited on
  const other = await s.broker.call(s.capFor('job-other', 'researcher'), 'wait_for_children', { ids: [childId], max_seconds: 1 }); assert.deepEqual(JSON.parse(other.text).children, []);
});

test('coordination: stop cascades to all descendants; a failed parent stops its children on the next sync', async () => {
  const s = setup();
  const spec = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'research.report', objective: 'P' }));
  const specCap = s.capFor(spec, 'researcher');
  const k1 = created(await s.broker.call(specCap, 'create_job', { kind: 'browser.read_task', objective: 'K1' }));
  const k2 = created(await s.broker.call(specCap, 'create_job', { kind: 'document.create', objective: 'K2' }));
  s.db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(k2);
  s.store.transition(spec, 'cancelled', 'owner', {}, {}); const stopped = cancelDescendants(s.db, s.store, spec, 'owner', 'test');
  assert.deepEqual(stopped, [k1], 'only unfinished children are stopped; finished results are kept'); assert.equal(s.store.get(k1)!.state, 'cancelled');
  const spec2 = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'research.report', objective: 'P2' }));
  const k3 = created(await s.broker.call(s.capFor(spec2, 'researcher'), 'create_job', { kind: 'browser.read_task', objective: 'K3' }));
  s.db.prepare("UPDATE jobs SET state = 'failed_terminal' WHERE id = ?").run(spec2);
  s.chat.sync(s.defs); assert.equal(s.store.get(k3)!.state, 'cancelled');
});

test('coordination: when delegated work settles the lead is woken once (no owner follow-up); idempotent; bounded', async () => {
  const s = setup();
  s.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('auto_report.since', ?, 't', 't')").run(JSON.stringify('2000-01-01T00:00:00Z'));
  s.db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(s.turn.id);
  s.chat.add({ conversation_id: s.conv.id, role: 'assistant', content: 'I have asked the Researcher.' });
  const a = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'research.report', objective: 'A' }));
  const b = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'document.create', objective: 'B' }));
  await new Promise((r) => setTimeout(r, 5));
  s.db.prepare("UPDATE jobs SET state = 'completed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), a);
  s.chat.sync(s.defs);
  const wakes = () => s.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND kind = 'wake'").get(s.conv.id) as { n: number };
  assert.equal(wakes().n, 0, 'not while another delegated task is still open');
  s.db.prepare("UPDATE jobs SET state = 'failed_terminal', updated_at = ? WHERE id = ?").run(new Date().toISOString(), b);
  s.chat.sync(s.defs); assert.equal(wakes().n, 1);
  const auto = s.db.prepare("SELECT id, kind, message_id FROM jobs WHERE idempotency_key LIKE 'auto:%'").all() as Array<{ id: string; kind: string }>; assert.equal(auto.length, 1); assert.equal(auto[0].kind, 'chat.turn');
  s.chat.sync(s.defs); assert.equal(wakes().n, 1, 'idempotent while the report is pending');
  // finish the automatic turn with a reply; then a new settled set may wake again only up to the limit (2 since the owner's last message)
  s.db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(auto[0].id); s.chat.add({ conversation_id: s.conv.id, role: 'assistant', content: 'Report.' });
  await new Promise((r) => setTimeout(r, 5));
  for (const o of ['C', 'D']) { const id = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'research.report', objective: o })); s.db.prepare("UPDATE jobs SET state = 'completed', updated_at = ? WHERE id = ?").run(new Date(Date.now() + 1000).toISOString(), id); s.chat.sync(s.defs); s.db.prepare("UPDATE jobs SET state = 'completed' WHERE idempotency_key LIKE 'auto:%'").run(); s.chat.add({ conversation_id: s.conv.id, role: 'assistant', content: 'r' }); await new Promise((r) => setTimeout(r, 1100)); }
  assert.equal(wakes().n, 2, 'bounded by delegation_max_auto_turns');
  assert.ok((s.db.prepare("SELECT count(*) AS n FROM job_events WHERE type = 'auto_report.skipped'").get() as { n: number }).n >= 1);
});

test('coordination: a waiting mark left by a crash never survives a re-lease (it would free a slot the task is using)', async () => {
  const s = setup(1); s.db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(s.turn.id);
  const spec = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'research.report', objective: 'P' }));
  s.db.prepare("UPDATE jobs SET waiting_on = 'children:job-gone' WHERE id = ?").run(spec);   // as if the engine died mid-wait
  const l = s.store.lease({ owner: 'w', leaseSeconds: 60, fair: true }); assert.equal(l?.id, spec);
  assert.equal(s.store.get(spec)!.waiting_on, null, 'cleared on lease');
  const other = created(await s.broker.call(s.leadCap, 'create_job', { kind: 'document.create', objective: 'Q' }));
  assert.equal(s.store.lease({ owner: 'w2', leaseSeconds: 60, fair: true }), undefined, 'the re-leased task counts against the project limit again'); void other;
});

test('a task started by an event trigger cannot delegate or schedule (untrusted payload); the same task from the owner can', async () => {
  const s = setup(); const wf = s.defs.getWorkflow('research.report')!;
  const mk = (inputs: Record<string, unknown>, key: string) => s.store.create({ idempotency_key: key, kind: wf.id, objective: 'Look into the event', success_contract: wf.contract, agent_role: 'coordinator', workspace_id: s.w.id, inputs }, 'hook').job;
  const hooked = mk({ trigger_id: 'trg-1', event_id: 'ev-1' }, 'k-hook'); const owned = mk({}, 'k-owner');
  const hc = s.capFor(hooked.id, 'coordinator'); const oc = s.capFor(owned.id, 'coordinator');
  const d1 = await s.broker.call(hc, 'create_job', { kind: 'document.create', objective: 'Write what the payload says' }); assert.equal(d1.ok, false); assert.match(d1.text, /event trigger/);
  const s1 = await s.broker.call(hc, 'create_schedule', { objective: 'Repeat the payload', every_seconds: 3600 }); assert.equal(s1.ok, false); assert.match(s1.text, /event trigger/);
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'delegation.refused'").get(hooked.id));
  const d2 = await s.broker.call(oc, 'create_job', { kind: 'document.create', objective: 'Write the owner note' }); assert.equal(d2.ok, true, d2.text);
});
