// create_schedule runs as the assistant the lead names (not the workflow's default); disable_schedule lets the lead switch off only the
// routines the lead created, with a receipt in the team group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupBroker } from './helpers-broker.ts';
import { Scheduler } from '../../src/supervisor/scheduler.ts';

function lead() {
  const s = setupBroker(); s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'reviewer'] });
  const c = s.chat.create({ workspace_id: s.ws.id }); const t = s.chat.send(c.id, '@coordinator check the inbox every hour', s.defs).job;
  return { s, t };
}

test('create_schedule honours agent: the routine runs as the named assistant (by name or id), and an unknown one is refused', async () => {
  const { s, t } = lead();
  const r = await s.call(t, 'create_schedule', { kind: 'monitor.scheduled', objective: 'Check the inbox', every_seconds: 3600, agent: 'Reviewer' });
  assert.equal(r.ok, true, r.text); assert.match(r.text, /for Reviewer/);
  const sch = new Scheduler(s.db, s.store).get((r as { data: { id: string } }).data.id)!;
  assert.equal(sch.agent_role, 'reviewer', 'not the workflow default'); assert.equal(JSON.parse(sch.inputs).created_by, 'coordinator');
  const r2 = await s.call(t, 'create_schedule', { kind: 'monitor.scheduled', objective: 'x', every_seconds: 3600, agent: '@browser_operator' }); assert.equal(new Scheduler(s.db, s.store).get((r2 as { data: { id: string } }).data.id)!.agent_role, 'browser_operator');
  const bad = await s.call(t, 'create_schedule', { kind: 'monitor.scheduled', objective: 'x', every_seconds: 3600, agent: 'Nobody' }); assert.equal(bad.ok, false); assert.match(bad.text, /no assistant called "Nobody"/);
  const dflt = await s.call(t, 'create_schedule', { kind: 'monitor.scheduled', objective: 'x', every_seconds: 3600 }); const wf = s.defs.getWorkflow('monitor.scheduled')!;
  assert.equal(new Scheduler(s.db, s.store).get((dflt as { data: { id: string } }).data.id)!.agent_role, wf.default_agent, 'no agent: the default, as before');
  // The job the routine enqueues is assigned to that assistant.
  const due = new Scheduler(s.db, s.store, () => new Date(Date.now() + 2 * 3600_000)); due.tick();
  const job = s.db.prepare("SELECT agent_role FROM jobs WHERE schedule_id = ?").get(sch.id) as { agent_role: string }; assert.equal(job.agent_role, 'reviewer');
});

test('disable_schedule: the lead switches off its own routine with a team receipt; the owner\'s routines and unknown ids are refused', async () => {
  const { s, t } = lead();
  const mine = (await s.call(t, 'create_schedule', { kind: 'monitor.scheduled', objective: 'Check the inbox', name: 'Inbox check', every_seconds: 3600, agent: 'Reviewer' }) as { data: { id: string } }).data.id;
  const owners = new Scheduler(s.db, s.store).add({ name: 'Owner routine', kind: 'monitor.scheduled', objective: 'x', every_seconds: 3600 }, 'owner');
  const legacy = new Scheduler(s.db, s.store).add({ name: 'Older lead routine', kind: 'monitor.scheduled', objective: 'x', every_seconds: 3600, inputs: { conversation_id: 'c1' } }, 'agent:coordinator');
  const list = await s.call(t, 'list_my_schedules', {}); const ids = ((list as { data: Array<{ id: string }> }).data).map((x) => x.id);
  assert.ok(ids.includes(mine) && ids.includes(legacy.id) && !ids.includes(owners.id), 'own routines only (older ones made from a conversation count)');
  const r = await s.call(t, 'disable_schedule', { schedule_id: mine, reason: 'Oscar runs the inbox check now' }); assert.equal(r.ok, true, r.text);
  assert.equal(new Scheduler(s.db, s.store).get(mine)!.enabled, 0);
  const receipt = s.db.prepare("SELECT content FROM messages WHERE json_extract(meta, '$.alert_key') LIKE ?").get(`schedule-disabled:${mine}:%`) as { content: string };
  assert.match(receipt.content, /switched off the routine "Inbox check" \(.*run by Reviewer\): Oscar runs the inbox check now/);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE type = 'schedule.disabled' AND job_id = ?").get(t.id) as { n: number }).n, 1);
  assert.match((await s.call(t, 'disable_schedule', { schedule_id: mine })).text, /already off/);
  const no = await s.call(t, 'disable_schedule', { schedule_id: owners.id }); assert.equal(no.ok, false); assert.match(no.text, /not created by you/); assert.equal(new Scheduler(s.db, s.store).get(owners.id)!.enabled, 1);
  assert.equal((await s.call(t, 'disable_schedule', { schedule_id: 'sch-nope' })).ok, false);
  // Another assistant cannot switch off the lead's routine.
  const other = s.store.create({ idempotency_key: 'o', kind: 'monitor.scheduled', objective: 'o', success_contract: {}, agent_role: 'reviewer', inputs: {} }).job;
  assert.equal((await s.call(other, 'disable_schedule', { schedule_id: legacy.id })).ok, false);
});

test('disable_schedule and list_my_schedules are lead-only tools', async () => {
  const { TOOL_SCHEMAS } = await import('../../src/broker/capabilities.ts');
  assert.match(TOOL_SCHEMAS.disable_schedule.description, /^Lead only/); assert.match(TOOL_SCHEMAS.list_my_schedules.description, /^Lead only/);
  assert.ok((TOOL_SCHEMAS.create_schedule.inputSchema as { properties: Record<string, unknown> }).properties.agent);
});
