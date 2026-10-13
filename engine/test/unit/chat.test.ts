import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { ActionStore } from '../../src/actions/store.ts';
import { SimulatedRuntime, type SimScript } from '../../src/runtime/simulated.ts';
import { runJob, type RunDeps } from '../../src/worker/run.ts';
import { createLogger } from '../../src/log.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore, CHAT_WORKFLOW } from '../../src/chat/store.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { readCapability, verifyCapability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';

function setup(scripts: SimScript[] = []) {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-'));
  const runtime = new SimulatedRuntime(scripts);
  const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const deps: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test');
  const chat = new ChatStore(db, store);
  const cfg = loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv);
  const broker = new BrokerApi(db, store, approvals, cfg);
  return { db, store, approvals, actions, runtime, deps, defs, ws, chat, tmp, broker };
}
async function turn(s: ReturnType<typeof setup>, convId: string, text: string) {
  const { job } = s.chat.send(convId, text, s.defs);
  const leased = s.store.lease({ owner: 'worker:test', leaseSeconds: 30 })!; assert.equal(leased.id, job.id);
  const out = await runJob(s.deps, job.id);
  return { job: s.store.get(job.id)!, out };
}

test('an owner message creates one durable turn; the reply is posted, the lead session persists and is resumed on the next turn', async () => {
  const s = setup([{ kind: 'ok', text: 'Hello! What would you like done?' }, { kind: 'ok', text: 'As before: the guide is in welcome.md.' }]);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const r1 = await turn(s, c.id, 'hi there');
  assert.equal(r1.out, 'completed'); assert.equal(r1.job.kind, CHAT_WORKFLOW); assert.equal(r1.job.conversation_id, c.id);
  const msgs = s.chat.messages(c.id); assert.deepEqual(msgs.map((m) => m.role), ['owner', 'assistant']); assert.equal(msgs[1].content, 'Hello! What would you like done?'); assert.equal(msgs[1].job_id, r1.job.id);
  const conv = s.chat.get(c.id)!; assert.equal(conv.session_ref, `sim-${c.id}`); assert.equal(conv.title, 'Hi there');
  // capability is keyed by the conversation, names the turn job while it runs, and is emptied between turns
  const cap = readCapability(s.deps.runDir, c.id)!; assert.equal(cap.job_id, r1.job.id); assert.deepEqual(cap.tools, []); assert.equal(cap.key, c.id);
  const mcp = JSON.parse(fs.readFileSync(path.join(s.deps.workspacesDir, s.ws.id, 'conversations', c.id, '.mcp.json'), 'utf8')); assert.deepEqual(mcp.mcpServers.claudebot.args, ['--job', c.id]);
  const first = s.runtime.history[0]; assert.equal(first.resume, false); assert.equal(first.label, c.id); assert.match(first.prompt, /Owner: hi there$/); assert.ok(!/Conversation so far/.test(first.prompt), 'a fresh session needs no transcript');
  const r2 = await turn(s, c.id, 'what was that file again?');
  assert.equal(r2.out, 'completed');
  const second = s.runtime.history[1]; assert.equal(second.resume, true); assert.equal(second.sessionRef, `sim-${c.id}`); assert.ok(!/Conversation so far/.test(second.prompt), 'a live session already has the context');
  assert.equal(s.chat.get(c.id)!.session_ref, `sim-${c.id}`, 'the same session stays bound');
  assert.equal(s.chat.messages(c.id).length, 4);
  assert.equal(readCapability(s.deps.runDir, c.id)!.token, cap.token, 'the broker token survives between turns');
});

test('a closed session is replaced and the durable transcript is replayed into the new one', async () => {
  const s = setup([{ kind: 'ok', text: 'first reply' }, { kind: 'ok', text: 'second reply' }]);
  const c = s.chat.create({ workspace_id: s.ws.id });
  await turn(s, c.id, 'remember the word marigold');
  s.chat.setSession(c.id, null);   // idle close / gateway restart
  await turn(s, c.id, 'what word did I ask you to remember?');
  const second = s.runtime.history[1]; assert.equal(second.resume, false); assert.match(second.prompt, /Conversation so far[\s\S]*Owner: remember the word marigold[\s\S]*You: first reply/);
});

test('delegation through the broker links the child to the conversation; sync posts one delegation and one verified result, never duplicates, never for unrelated jobs', async () => {
  const s = setup([{ kind: 'ok', text: 'I have asked the Researcher.' }]);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const { job: turnJob } = s.chat.send(c.id, 'find three facts about tide pools', s.defs);
  s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  // While the turn runs, the lead calls create_job with the conversation-keyed capability.
  const convDir = path.join(s.deps.workspacesDir, s.ws.id, 'conversations', c.id);
  const lead = s.defs.getAgent('coordinator')!;
  const { issueCapability } = await import('../../src/broker/capabilities.ts');
  const cap = issueCapability(s.deps.runDir, turnJob, convDir, lead.allowed_tools, 3600, c.id);
  assert.ok(verifyCapability(s.deps.runDir, c.id, cap.token));
  const r = await s.broker.call(cap, 'create_job', { kind: 'research.report', objective: 'Three sourced facts about tide pools', inputs: { question: 'tide pools' } });
  assert.equal(r.ok, true); const childId = (r.data as { id: string }).id;
  const child = s.store.get(childId)!; assert.equal(child.conversation_id, c.id); assert.equal(child.parent_id, turnJob.id); assert.equal(child.agent_role, 'researcher'); assert.equal(JSON.parse(child.inputs).question, 'tide pools');
  assert.match(r.text, /runs in the background/);
  const dup = await s.broker.call(cap, 'create_job', { kind: 'research.report', objective: 'Three sourced facts about tide pools', inputs: { question: 'tide pools' } }); assert.equal((dup.data as { created: boolean }).created, false, 'identical delegation is not duplicated');
  assert.equal(await runJob(s.deps, turnJob.id), 'completed');
  // Unrelated job (no conversation) must never surface in a conversation.
  s.store.create({ idempotency_key: 'unrelated', kind: 'system.workspace_summary', objective: 'unrelated', success_contract: {}, agent_role: 'coordinator', workspace_id: s.ws.id });
  let msgs = s.chat.messages(c.id); let del = msgs.filter((m) => m.kind === 'delegation'); assert.equal(del.length, 1, 'the Assigned card is posted when the task is created, in conversation order');
  let touched = s.chat.sync(s.defs); assert.deepEqual(touched, [], 'sync does not duplicate the card');
  touched = s.chat.sync(s.defs); assert.deepEqual(touched, []);
  msgs = s.chat.messages(c.id); del = msgs.filter((m) => m.kind === 'delegation'); assert.equal(del.length, 1); assert.equal(del[0].job_id, childId); assert.match(del[0].content, /Assigned to Researcher/);
  assert.equal(msgs.filter((m) => m.kind === 'result').length, 0, 'no result before the work finished');
  // The child finishes with a real file artifact → one result message, file verified by hash.
  const file = path.join(s.tmp, 'report.md'); fs.writeFileSync(file, '# Tide pools\n\nThree facts.');
  const sha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, created_at) VALUES ('art-1', ?, 'research', 'file', ?, ?, 'report.md', ?)").run(childId, file, sha, new Date().toISOString());
  s.store.lease({ owner: 'worker:x', leaseSeconds: 30 }); s.store.transition(childId, 'running', 'worker:x'); s.store.transition(childId, 'completed', 'worker:x');
  assert.deepEqual(s.chat.sync(s.defs), [c.id]); assert.deepEqual(s.chat.sync(s.defs), []);
  msgs = s.chat.messages(c.id); const results = msgs.filter((m) => m.kind === 'result'); assert.equal(results.length, 1); assert.equal(results[0].artifact_id, 'art-1'); assert.equal(results[0].meta.file_verified, true); assert.match(results[0].content, /Researcher finished.*report\.md \(file verified\)/);
  assert.match(String(results[0].meta.preview), /Three facts/);
  // The next turn's prompt carries the finished work so the lead can answer a follow-up about it.
  const upd = s.chat.updatesSince(c.id, s.defs); assert.match(upd, /Finished/); assert.match(upd, /Three facts/);
});

test('a consequential request from the lead becomes a decision card once; approving does not execute anything (no executor)', async () => {
  const s = setup([{ kind: 'ok', text: 'Waiting for your decision.' }]);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const { job: turnJob } = s.chat.send(c.id, 'email the guide to bob@example.com', s.defs);
  s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  const { issueCapability } = await import('../../src/broker/capabilities.ts');
  const cap = issueCapability(s.deps.runDir, turnJob, s.tmp, s.defs.getAgent('coordinator')!.allowed_tools, 3600, c.id);
  const r = await s.broker.call(cap, 'request_approval', { kind: 'send', target: 'bob@example.com', content: 'Hi Bob, here is the guide.' }); assert.equal(r.ok, true);
  assert.equal(await runJob(s.deps, turnJob.id), 'completed');
  s.chat.sync(s.defs); s.chat.sync(s.defs);
  const decisions = s.chat.messages(c.id).filter((m) => m.kind === 'decision'); assert.equal(decisions.length, 1); assert.match(decisions[0].content, /before anything is sent/); assert.equal(decisions[0].approval_id, (r.data as { id: string }).id);
  const ap = s.approvals.decide(decisions[0].approval_id!, 'approved', 'owner');
  const perf = await s.actions.perform({ job_id: turnJob.id, idempotency_key: 'k1', kind: 'send', target: 'bob@example.com', content: 'Hi Bob, here is the guide.', approval_id: ap.id, actor: 'test' });
  assert.equal(perf.status, 'refused'); assert.match((perf as { reason: string }).reason, /no enabled executor/);
  assert.equal(s.chat.sync(s.defs).length, 0, 'no duplicate decision card after the decision');
});

test('a turn that needs sign-in pauses honestly and is explained in the conversation; a crashed session is replaced', async () => {
  const s = setup([{ kind: 'auth' }, { kind: 'crash' }]);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const r1 = await turn(s, c.id, 'hello'); assert.equal(r1.out, 'paused'); assert.equal(r1.job.state, 'waiting_for_auth'); assert.equal(r1.job.waiting_on, 'claude');
  s.chat.sync(s.defs); s.chat.sync(s.defs);
  const st = s.chat.messages(c.id).filter((m) => m.kind === 'status'); assert.equal(st.length, 1); assert.match(st[0].content, /Sign in to continue/);
  assert.ok(s.chat.activeTurn(c.id) === undefined, 'a paused turn does not block the owner');
  const c2 = s.chat.create({ workspace_id: s.ws.id }); s.chat.setSession(c2.id, 'sim-old');
  const r2 = await turn(s, c2.id, 'hello'); assert.equal(r2.out, 'retry'); assert.equal(s.chat.get(c2.id)!.session_ref, null, 'crashed session is dropped so the next attempt respawns');
});

test('a finished specialist task closes its model session; a conversation turn keeps the lead session open', async () => {
  const s = setup([{ kind: 'ok', text: 'done\nDONE' }, { kind: 'ok', text: 'reply' }]);
  const closed: string[] = []; (s.runtime as unknown as { closeSession: (r: string) => Promise<void> }).closeSession = async (r) => { closed.push(r); };
  const wf = s.defs.getWorkflow('document.create')!;
  const { job } = s.store.create({ idempotency_key: 'doc', kind: 'document.create', objective: 'write', success_contract: wf.contract, agent_role: 'builder', workspace_id: s.ws.id });
  s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  const file = path.join(s.deps.workspacesDir, s.ws.id, 'tasks', job.id, 'out.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x');
  s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, created_at) VALUES ('a', ?, 'write', 'file', ?, ?, 'out.md', ?)").run(job.id, file, (await import('node:crypto')).createHash('sha256').update('x').digest('hex'), new Date().toISOString()); s.db.prepare("UPDATE jobs SET outcome = 'success' WHERE id = ?").run(job.id);
  assert.equal(await runJob(s.deps, job.id), 'completed'); assert.deepEqual(closed, [`sim-${job.id}`]);
  const c = s.chat.create({ workspace_id: s.ws.id }); await turn(s, c.id, 'hi'); assert.equal(closed.length, 1, 'lead session not closed by a turn');
});

test('delegation deduplicates on the whole task: two tasks that share a long prefix are both created (verifier finding)', async () => {
  const s = setup();
  const c = s.chat.create({ workspace_id: s.ws.id }); const { job: turnJob } = s.chat.send(c.id, 'read two pages', s.defs);
  const { issueCapability } = await import('../../src/broker/capabilities.ts');
  const cap = issueCapability(s.deps.runDir, turnJob, path.join(s.deps.workspacesDir, s.ws.id, 'conversations', c.id), s.defs.getAgent('coordinator')!.allowed_tools, 3600, c.id);
  // Changed 7 Oct (verifier finding): deduplication is on the whole task, so tasks that only share a long prefix are both created.
  const prefix = 'Read the following page and record what it says about the reserved example domains, with quotes: ';
  const a1 = await s.broker.call(cap, 'create_job', { kind: 'browser.read_task', objective: prefix + 'https://www.iana.org/domains/reserved' });
  const a2 = await s.broker.call(cap, 'create_job', { kind: 'browser.read_task', objective: prefix + 'https://www.iana.org/help/example-domains' });
  assert.equal((a2.data as { created: boolean }).created, true); assert.notEqual((a1.data as { id: string }).id, (a2.data as { id: string }).id);
  for (const x of [a1, a2]) s.store.transition((x.data as { id: string }).id, 'cancelled', 'test', {}, {});
});
