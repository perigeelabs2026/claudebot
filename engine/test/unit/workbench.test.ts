import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { ActionStore } from '../../src/actions/store.ts';
import { SimulatedRuntime } from '../../src/runtime/simulated.ts';
import { runJob, type RunDeps } from '../../src/worker/run.ts';
import { createLogger } from '../../src/log.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { workbenchSnapshot } from '../../src/model/workbench.ts';
import { taskTitle, conversationTitle, progressWording, eventWording } from '../../src/model/wording.ts';
import { CAPABILITIES, CAPABILITY_STATES } from '../../src/model/capabilities.ts';

function setup(scripts: ConstructorParameters<typeof SimulatedRuntime>[0] = []) {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-')); const runtime = new SimulatedRuntime(scripts);
  const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const deps: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults(); const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'P' }, 'test');
  return { db, store, deps, defs, ws, runtime };
}

test('wording: titles strip implementation clauses; progress notes read as plain English', () => {
  assert.equal(taskTitle('Please write a short customer welcome note (about 120 words) for a dog-walking service and save it as welcome-note.md, registered as an artifact. Use [business name].'), 'Write a short customer welcome note for a dog-walking service');
  assert.equal(taskTitle('Open https://example.com and record the main heading. Read only: do not sign in.'), 'Open https://example.com and record the main heading');
  assert.ok(taskTitle('x'.repeat(200)).length <= 90);
  assert.equal(conversationTitle('Please write a short customer welcome note, about 120 words, for a fictional dog-walking service, and save it as welcome-note.md.'), 'Write a short customer welcome note, about…');
  assert.equal(progressWording('agent acp'), 'Claude is working on this step'); assert.equal(progressWording('agent tool'), 'Claude is using a tool'); assert.equal(progressWording('assistant text'), 'Claude is writing'); assert.equal(progressWording('running stage write'), 'Starting step "write"');
  assert.equal(eventWording('tool.called', { tool: 'write_artifact' }), 'Saving a result'); assert.equal(eventWording('lease.acquired', {}), 'Picked up by a worker'); assert.equal(eventWording('checkpoint.written', { stage: 'write', phase: 'before' }), 'Started step "write"');
});

test('workbench: "working" requires a leased task with a fresh, unexpired heartbeat; stale leases read as checking; engine vs Claude step is labelled', () => {
  const s = setup(); const wf = s.defs.getWorkflow('document.create')!;
  const { job } = s.store.create({ idempotency_key: 'a', kind: 'document.create', objective: 'Write a note and save it as note.md, registered as an artifact.', success_contract: wf.contract, agent_role: 'builder', workspace_id: s.ws.id });
  let snap = workbenchSnapshot(s.db); let t = snap.tasks.find((x) => x.id === job.id)!;
  assert.equal(t.status, 'queued'); assert.equal(t.turn, null); assert.equal(t.title, 'Write a note'); assert.equal(t.assigned_by, 'you');
  s.store.lease({ owner: 'worker:9', leaseSeconds: 30 }); s.store.setStage(job.id, 0, 'prepare', 1);
  snap = workbenchSnapshot(s.db); t = snap.tasks.find((x) => x.id === job.id)!; assert.equal(t.status, 'working'); assert.equal(t.turn, 'engine', 'prepare is a deterministic engine step');
  s.store.setStage(job.id, 1, 'write', 1); snap = workbenchSnapshot(s.db); t = snap.tasks.find((x) => x.id === job.id)!; assert.equal(t.turn, 'claude');
  assert.equal(snap.assistants.find((a) => a.id === 'builder')!.status, 'working');
  // Heartbeat older than the freshness window → checking, never "working"; an expired lease also never "working".
  snap = workbenchSnapshot(s.db, { now: Date.now() + 50_000 }); t = snap.tasks.find((x) => x.id === job.id)!; assert.equal(t.status, 'checking'); assert.equal(t.heartbeat_at, null);
  assert.equal(workbenchSnapshot(s.db, { now: Date.now() + 50_000 }).assistants.find((a) => a.id === 'builder')!.status, 'checking');
  // Phantom control: an assistant with no task is idle even if another assistant works.
  assert.equal(snap.assistants.find((a) => a.id === 'researcher')!.status, 'idle');
});

test('stop: cancelling a task while its Claude turn hangs aborts the turn within a heartbeat; the task stays cancelled (no retry) and its save points remain', async () => {
  const s = setup([{ kind: 'hang' }]); const wf = s.defs.getWorkflow('document.create')!;
  const { job } = s.store.create({ idempotency_key: 'h', kind: 'document.create', objective: 'long', success_contract: wf.contract, agent_role: 'builder', workspace_id: s.ws.id });
  s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  const run = runJob(s.deps, job.id);
  await new Promise((r) => setTimeout(r, 1500));   // prepare done, write stage hanging
  assert.equal(s.store.get(job.id)!.state, 'running');
  s.store.transition(job.id, 'cancelled', 'owner', { next_action: null }, { by: 'owner' });   // what POST /cancel does
  const started = Date.now(); const out = await run;
  assert.equal(out, 'released'); assert.ok(Date.now() - started < 5000, 'abort observed within a couple of heartbeats');
  const j = s.store.get(job.id)!; assert.equal(j.state, 'cancelled'); assert.equal(j.retry_count, 0); assert.equal(j.lease_owner, null, 'a stopped task releases its lease');
  assert.ok(s.store.events(job.id).some((e) => e.type === 'turn.cancelled'));
  assert.ok((s.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE job_id = ?').get(job.id) as { n: number }).n >= 2, 'save points kept');
  assert.equal(s.runtime.history.length, 1);
});

test('direction: a note saved while a task runs is given to the assistant at its next Claude step and marked delivered once', async () => {
  const s = setup([{ kind: 'ok', text: 'done\nDONE' }]); const wf = s.defs.getWorkflow('document.create')!;
  const { job } = s.store.create({ idempotency_key: 'd', kind: 'document.create', objective: 'Write a note', success_contract: wf.contract, agent_role: 'builder', workspace_id: s.ws.id });
  s.store.event(job.id, 'owner', 'owner.direction', { note: 'Make it two paragraphs, not three.' });
  s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  const file = path.join(s.deps.workspacesDir, s.ws.id, 'tasks', job.id, 'note.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x');
  s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, created_at) VALUES ('a', ?, 'write', 'file', ?, ?, 'note.md', ?)").run(job.id, file, (await import('node:crypto')).createHash('sha256').update('x').digest('hex'), new Date().toISOString()); s.db.prepare("UPDATE jobs SET outcome = 'success' WHERE id = ?").run(job.id);
  assert.equal(await runJob(s.deps, job.id), 'completed');
  assert.match(s.runtime.history[0].prompt, /Direction from the owner[\s\S]*two paragraphs/);
  const delivered = s.store.events(job.id).filter((e) => e.type === 'owner.direction.delivered'); assert.equal(delivered.length, 1); assert.match(String(delivered[0].detail.how), /step write/);
  const snap = workbenchSnapshot(s.db); assert.equal(snap.tasks.find((t) => t.id === job.id)!.directions.length, 1);
});

test('capabilities checklist: every item has one of the four honest states and the required areas are covered', () => {
  const states = Object.keys(CAPABILITY_STATES); for (const c of CAPABILITIES) assert.ok(states.includes(c.state), c.item);
  const areas = new Set(CAPABILITIES.map((c) => c.area));
  for (const a of ['Chat and persistent sessions', 'Assistant discovery and delegation', 'Parent/child, results, completion', 'Status, cancellation, steering, recovery', 'Tools, skills, plugins, MCP', 'Browser', 'Coding, builds, project tests', 'Memory and retrieval', 'Schedules and event-driven work', 'Connections and approved external actions']) assert.ok(areas.has(a), a);
  assert.ok(CAPABILITIES.some((c) => c.state === 'intentionally_restricted' && /Send, publish/.test(c.item)));
});
