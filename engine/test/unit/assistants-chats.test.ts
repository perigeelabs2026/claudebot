// assistants and chats. Criteria ids in test names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { ActionStore } from '../../src/actions/store.ts';
import { SimulatedRuntime, type SimScript } from '../../src/runtime/simulated.ts';
import { runJob, type RunDeps } from '../../src/worker/run.ts';
import { createLogger } from '../../src/log.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { Settings } from '../../src/model/settings.ts';
import { ChatStore, ChatRuleError, turnState } from '../../src/chat/store.ts';
import { Assistants } from '../../src/chat/assistants.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { readCapability, type Capability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';

function setup(scripts: SimScript[] = []) {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2g1-'));
  const runtime = new SimulatedRuntime(scripts);
  const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const deps: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test');
  const chat = new ChatStore(db, store);
  const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  return { db, store, runtime, deps, defs, ws, chat, broker, tmp };
}
type S = ReturnType<typeof setup>;
/** Lease exactly this job (fails if the dispatcher would pick something else) and run it. */
async function run(s: S, jobId: string) { const l = s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true }); assert.equal(l?.id, jobId, 'the dispatcher leases the expected turn'); return runJob(s.deps, jobId); }
const cap = (job: { id: string; agent_role: string }, tools: string[]): Capability => ({ token: 't', job_id: job.id, role: job.agent_role, workspace: '/tmp', tools, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
function addAssistant(s: S, id: string, name: string, role = 'Specialist') { return s.defs.upsertAgent({ id, name, purpose: `${name} does ${role.toLowerCase()} work.`, role, system_instructions: 'Be concise.', allowed_tools: ['write_artifact', 'read_artifact'], data_scopes: [], prohibited_actions: [], approval_rules: [], measurable_outputs: [], acceptance_tests: [], concurrency_limit: 2, memory_scope: [] }, 'owner'); }

test('A1/A6: migration 0007 keeps every pre-existing conversation, message, link and session, and adds senders and memberships', () => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(import.meta.dirname, '..', '..', 'src', 'db', 'migrations'); const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files.filter((x) => x < '0007')) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  const t = new Date().toISOString();
  db.prepare("INSERT INTO agent_definitions(id, name, purpose, system_instructions, allowed_tools, data_scopes, prohibited_actions, approval_rules, measurable_outputs, acceptance_tests, concurrency_limit, memory_scope, is_system, enabled, template_pack, created_at, updated_at) VALUES ('coordinator','Lead assistant','p','', '[]','[]','[]','[]','[]','[]',2,'[]',1,1,NULL,?,?)").run(t, t);
  db.prepare("INSERT INTO conversations(id, workspace_id, title, session_ref, status, created_at, updated_at) VALUES ('conv-old', NULL, 'Old chat', 'agent:claude:acp:abc', 'active', ?, ?)").run(t, t);
  db.prepare("INSERT INTO jobs(id, idempotency_key, kind, objective, success_contract, state, agent_role, priority, created_at, updated_at, inputs, depends_on, input_refs) VALUES ('job-old','k','chat.turn','hi','{}','completed','coordinator',3,?,?,'{}','[]','[]')").run(t, t);
  db.prepare("INSERT INTO messages(id, conversation_id, role, kind, content, job_id, meta, created_at) VALUES ('m1','conv-old','owner','text','hello','job-old','{}',?), ('m2','conv-old','assistant','text','hi back','job-old','{}',?), ('m3','conv-old','system','result','done','job-old','{\"state\":\"completed\"}',?)").run(t, t, t);
  const before = db.prepare('SELECT seq, id, conversation_id, role, kind, content, job_id, artifact_id, approval_id, meta, created_at FROM messages ORDER BY seq').all();
  db.exec(fs.readFileSync(path.join(dir, '0007_assistants_chats.sql'), 'utf8'));
  assert.deepEqual(db.prepare('SELECT seq, id, conversation_id, role, kind, content, job_id, artifact_id, approval_id, meta, created_at FROM messages ORDER BY seq').all(), before, 'every message unchanged');
  assert.deepEqual(db.prepare('SELECT id, sender, delivery, mentions, reply_to FROM messages ORDER BY seq').all().map((r) => ({ ...r })), [{ id: 'm1', sender: 'owner', delivery: 'delivered', mentions: '[]', reply_to: null }, { id: 'm2', sender: 'coordinator', delivery: 'delivered', mentions: '[]', reply_to: null }, { id: 'm3', sender: 'system', delivery: 'delivered', mentions: '[]', reply_to: null }]);
  assert.deepEqual({ ...db.prepare("SELECT type, owner, session_ref FROM conversations WHERE id = 'conv-old'").get() }, { type: 'direct', owner: 'owner', session_ref: 'agent:claude:acp:abc' });
  assert.deepEqual({ ...db.prepare('SELECT conversation_id, agent_id, session_ref, added_by FROM conversation_members').get() }, { conversation_id: 'conv-old', agent_id: 'coordinator', session_ref: 'agent:claude:acp:abc', added_by: 'migration' }, 'the lead session is kept on the membership');
  assert.equal((db.prepare("SELECT created_by FROM agent_definitions WHERE id = 'coordinator'").get() as { created_by: string }).created_by, 'system');
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
});

test('A4: a group has 2-6 assistants and a direct chat exactly one; the store and the DB both refuse a 7th member', () => {
  const s = setup(); for (let i = 1; i <= 6; i++) addAssistant(s, `a${i}`, `Helper ${i}`);
  assert.throws(() => s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['a1'] }), (e: unknown) => e instanceof ChatRuleError && e.code === 'group_size');
  assert.throws(() => s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'coordinator'] }), /2 to 6/);
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], title: 'Six' });
  assert.equal(s.chat.members(g.id).length, 6);
  assert.throws(() => s.chat.addMember(g.id, 'coordinator'), /at most 6/);
  assert.throws(() => s.db.prepare('INSERT INTO conversation_members(conversation_id, agent_id, joined_at) VALUES (?,?,?)').run(g.id, 'coordinator', new Date().toISOString()), /at most 6 assistants/, 'the DB trigger refuses a 7th member too');
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['a1'] });
  assert.throws(() => s.db.prepare('INSERT INTO conversation_members(conversation_id, agent_id, joined_at) VALUES (?,?,?)').run(d.id, 'a2', new Date().toISOString()), /exactly one assistant/);
  assert.throws(() => s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['nobody'] }), /no assistant/);
});

test('C1: a direct chat with a specialist runs as that assistant, in its own session, and the reply carries its sender', async () => {
  const s = setup([{ kind: 'ok', text: 'Here is the outline.' }]); addAssistant(s, 'scout', 'Scout', 'Job boards');
  const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['scout'] });
  const { job, message } = s.chat.send(c.id, 'Find three roles', s.defs);
  assert.equal(job.agent_role, 'scout'); assert.equal(message.delivery, 'queued');
  assert.equal(await run(s, job.id), 'completed');
  const msgs = s.chat.messages(c.id); assert.deepEqual(msgs.map((m) => [m.role, m.sender]), [['owner', 'owner'], ['assistant', 'scout']]);
  assert.equal(msgs[0].delivery, 'delivered');
  const prompt = s.runtime.history[0].prompt; assert.match(prompt, /You are Scout, Job boards,/); assert.ok(!/lead assistant in ClaudeBot/.test(prompt), 'not the lead frame');
  assert.equal(s.runtime.history[0].role, 'scout');
  assert.equal(s.chat.memberSession(c.id, 'scout'), `sim-${c.id}`); assert.equal(s.chat.get(c.id)!.session_ref, `sim-${c.id}`, 'direct chats mirror the session on the conversation');
});

test('C2: the owner can keep sending while a turn runs; turns of one assistant in one chat never run at once and keep their order', async () => {
  const s = setup([{ kind: 'ok', text: 'one' }, { kind: 'ok', text: 'two' }]);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const a = s.chat.send(c.id, 'first', s.defs); const b = s.chat.send(c.id, 'second', s.defs);
  assert.notEqual(a.job.id, b.job.id);
  const l1 = s.store.lease({ owner: 'w1', leaseSeconds: 30, fair: true }); assert.equal(l1?.id, a.job.id, 'oldest first');
  assert.equal(s.store.lease({ owner: 'w2', leaseSeconds: 30, fair: true }), undefined, 'the second turn waits while the first is running on the same session');
  s.store.transition(a.job.id, 'queued', 'test', { lease_owner: null, lease_expires_at: null }); // hand it back to the test worker
  assert.equal(await run(s, a.job.id), 'completed'); assert.equal(await run(s, b.job.id), 'completed');
  assert.deepEqual(s.chat.messages(c.id).filter((m) => m.role === 'assistant').map((m) => m.content), ['one', 'two']);
});

test('D1: in a group, @mentions and replies route only to those members; @everyone routes to all; names with spaces work', () => {
  const s = setup(); addAssistant(s, 'gil', 'Gil'); addAssistant(s, 'sam', 'Sam'); addAssistant(s, 'rio', 'Rio');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['gil', 'sam', 'rio', 'coordinator'], title: 'Team' });
  const one = s.chat.send(g.id, '@Rio can you refresh the brief?', s.defs);
  assert.deepEqual(one.jobs.map((j) => j.agent_role), ['rio']); assert.deepEqual(one.message.mentions, ['rio']); assert.equal(one.routed, false);
  const two = s.chat.send(g.id, '@gil and @Chief of Staff please sync', s.defs);
  assert.deepEqual(two.jobs.map((j) => j.agent_role).sort(), ['coordinator', 'gil']);
  const all = s.chat.send(g.id, '@everyone quick check-in', s.defs);
  assert.deepEqual(all.jobs.map((j) => j.agent_role).sort(), ['coordinator', 'gil', 'rio', 'sam']);
  const ids = s.chat.send(g.id, 'from the composer', s.defs, 'owner', {}, { mentions: ['sam'] });
  assert.deepEqual(ids.jobs.map((j) => j.agent_role), ['sam']);
  // reply to an assistant message routes to its author
  const reply = s.chat.add({ conversation_id: g.id, role: 'assistant', sender: 'gil', content: 'Sent the draft.' });
  const r = s.chat.send(g.id, 'Thanks, which version?', s.defs, 'owner', {}, { reply_to: reply.id });
  assert.deepEqual(r.jobs.map((j) => j.agent_role), ['gil']); assert.equal(r.message.reply_to, reply.id);
  assert.ok(!/@/.test('') && s.chat.send(g.id, 'email me at x@example.com', s.defs).routed, 'an email address is not a mention');
});

test('D2: mentioning an assistant who is not a member is refused with a plain error, and no message or turn is created', () => {
  const s = setup(); addAssistant(s, 'gil', 'Gil'); addAssistant(s, 'sam', 'Sam'); addAssistant(s, 'ivy', 'Ivy');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['gil', 'sam'] });
  const before = { m: s.chat.messages(g.id).length, j: (s.db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n };
  assert.throws(() => s.chat.send(g.id, '@Ivy help please', s.defs), (e: unknown) => e instanceof ChatRuleError && e.code === 'not_a_member' && /Ivy is not in this group/.test(e.message));
  assert.throws(() => s.chat.send(g.id, 'hi', s.defs, 'owner', {}, { mentions: ['ivy'] }), /not in this group/);
  assert.deepEqual({ m: s.chat.messages(g.id).length, j: (s.db.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n }, before);
});

test('D3/E1: an unaddressed group message gets one routing turn by the Chief of Staff, who hands off with a visible handoff and one turn per member', async () => {
  const s = setup([{ kind: 'ok', text: 'Rio is taking this.' }, { kind: 'ok', text: 'Brief refreshed.' }]); addAssistant(s, 'gil', 'Gil'); addAssistant(s, 'rio', 'Rio', 'Research');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['gil', 'rio'], title: 'Team' });
  const sent = s.chat.send(g.id, 'Can someone refresh the Ramp brief?', s.defs);
  assert.equal(sent.routed, true); assert.deepEqual(sent.jobs.map((j) => j.agent_role), ['coordinator']);
  assert.ok(s.chat.messages(g.id).some((m) => m.kind === 'activity' && /Chief of Staff is deciding/.test(m.content)), 'the routing is shown as a labelled ledger line');
  const lease = s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true })!; assert.equal(lease.id, sent.job.id);
  // while the router's turn runs it calls hand_off (as the broker would during the turn)
  const ho = await s.broker.call(cap(sent.job, ['hand_off']), 'hand_off', { to: 'Rio', request: 'Refresh the Ramp brief with last week\'s news.' });
  assert.equal(ho.ok, true, ho.text);
  assert.equal((await runJob(s.deps, sent.job.id)), 'completed');
  const routerPrompt = s.runtime.history[0].prompt; assert.match(routerPrompt, /did not mention anyone/); assert.match(routerPrompt, /you are only deciding who should answer/);
  const handoff = s.chat.messages(g.id).find((m) => m.kind === 'handoff')!; assert.equal(handoff.sender, 'coordinator'); assert.deepEqual(handoff.mentions, ['rio']); assert.equal((handoff.meta as { to: string }).to, 'rio');
  const rioTurn = s.store.get(handoff.job_id!)!; assert.equal(rioTurn.agent_role, 'rio'); assert.equal(rioTurn.parent_id, null, 'a handoff is its own request (no parent cascade)'); assert.equal(JSON.parse(rioTurn.inputs).handoff_parent, sent.job.id);
  assert.equal(await run(s, rioTurn.id), 'completed');
  const rexPrompt = s.runtime.history[1].prompt; assert.match(rexPrompt, /The owner's message: Can someone refresh the Ramp brief\?/); assert.match(rexPrompt, /Chief of Staff handed this to you: Refresh the Ramp brief/);
  const last = s.chat.messages(g.id).at(-1)!; assert.equal(last.sender, 'rio'); assert.equal(last.reply_to, handoff.id);
  assert.equal(s.chat.message(handoff.id)!.delivery, 'delivered');
  // each member has its own session and folder in a group
  assert.equal(s.chat.memberSession(g.id, 'rio'), `sim-${g.id}.rio`); assert.ok(readCapability(s.deps.runDir, `${g.id}.rio`), 'capability keyed per member');
  assert.ok(fs.existsSync(path.join(s.deps.workspacesDir, s.ws.id, 'conversations', g.id, 'members', 'rio', '.mcp.json')));
});

test('D4/D5: hand_off refuses non-members, yourself, loops back, duplicates, depth and the per-message budget; every refusal is audited', async () => {
  const s = setup(); for (const [id, n] of [['a', 'Ann'], ['b', 'Ben'], ['c', 'Cat'], ['d', 'Dan'], ['e', 'Eve']]) addAssistant(s, id, n); addAssistant(s, 'out', 'Outsider');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['a', 'b', 'c', 'd', 'e'] });
  const root = s.chat.send(g.id, '@Ann start please', s.defs).job;
  assert.match((s.chat.handOff(root.id, 'Outsider', 'x', s.defs, 'w') as { reason: string }).reason, /not in this group/);
  assert.match((s.chat.handOff(root.id, 'Ann', 'x', s.defs, 'w') as { reason: string }).reason, /yourself/);
  const toBen = s.chat.handOff(root.id, 'Ben', 'part 1', s.defs, 'w'); assert.equal(toBen.ok, true);
  const benJob = (toBen as { job: { id: string } }).job;
  assert.match((s.chat.handOff(benJob.id, 'Ann', 'back to you', s.defs, 'w') as { reason: string }).reason, /already working on this request/, 'no loop back to a sender still on it');
  assert.match((s.chat.handOff(root.id, 'Ben', 'part 1 again', s.defs, 'w') as { reason: string }).reason, /already working on this request/, 'no duplicate turn for the same member');
  // depth: Ann(0) → Ben(1) → Cat(2) → Dan(3) exceeds delegation_max_depth 2
  const toCat = s.chat.handOff(benJob.id, 'Cat', 'part 2', s.defs, 'w'); assert.equal(toCat.ok, true);
  assert.match((s.chat.handOff((toCat as { job: { id: string } }).job.id, 'Dan', 'part 3', s.defs, 'w') as { reason: string }).reason, /depth limit reached \(2\)/);
  // budget: per owner message, 2 handoffs used; lower the limit and the next one is refused
  new Settings(s.db).set('chat_max_turns_per_message', 2, 'owner');
  assert.match((s.chat.handOff(root.id, 'Eve', 'part 4', s.defs, 'w') as { reason: string }).reason, /limit of 2 handoffs for one owner message/);
  const refusals = (s.db.prepare("SELECT json_extract(detail, '$.reason') AS r FROM job_events WHERE type = 'handoff.refused'").all() as Array<{ r: string }>).map((x) => x.r);
  assert.equal(refusals.length, 6, refusals.join(' | '));
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'chat.turn'").get() as { n: number }).n, 3, 'only the owner turn and the two allowed handoffs exist');
  // a member who finished may be asked again once (a reviewer sending fixes back), but not a third time
  // direct chats and automatic reports cannot hand off
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['a'] }); const dj = s.chat.send(d.id, 'hi', s.defs).job;
  assert.match((s.chat.handOff(dj.id, 'Ben', 'x', s.defs, 'w') as { reason: string }).reason, /only for group chats/);
  const auto = s.store.create({ idempotency_key: 'auto-x', kind: 'chat.turn', objective: 'Automatic report', success_contract: {}, agent_role: 'a', workspace_id: s.ws.id, inputs: { conversation_id: g.id, automatic: true } }, 'engine').job;
  s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(g.id, auto.id);
  const r = await s.broker.call(cap(auto, ['hand_off']), 'hand_off', { to: 'Ben', request: 'x' }); assert.equal(r.ok, false); assert.match(r.text, /automatic report/);
});

test('D5: one turn per (message, assistant): a repeated mention or an @everyone that includes an already-addressed member creates no second turn', () => {
  const s = setup(); addAssistant(s, 'gil', 'Gil'); addAssistant(s, 'rio', 'Rio');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['gil', 'rio'] });
  const r = s.chat.send(g.id, '@Rio @rio @everyone go', s.defs);
  assert.deepEqual(r.jobs.map((j) => j.agent_role).sort(), ['gil', 'rio']);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'chat.turn' AND message_id = ?").get(r.message.id) as { n: number }).n, 2);
});

test('B1/B2: the Chief of Staff drafts with propose_assistant; nothing exists until the owner names and confirms; tools come only from fixed groups', async () => {
  const s = setup();
  const c = s.chat.create({ workspace_id: s.ws.id });
  const turn = s.chat.send(c.id, 'Make me an assistant that watches job boards', s.defs).job;
  const before = s.defs.listAgents({ includeDisabled: true }).length;
  const r = await s.broker.call(cap(turn, ['propose_assistant']), 'propose_assistant', { description: 'watches job boards every morning', name: 'Scout', role: 'Job boards', purpose: 'Finds roles that fit.', responsibilities: ['Scan boards daily', 'Shortlist fits'], instructions: 'Never apply without the owner.', tools: ['read', 'browser', 'create_job', 'delete_everything'] });
  assert.equal(r.ok, true, r.text);
  assert.equal(s.defs.listAgents({ includeDisabled: true }).length, before, 'a draft creates no assistant');
  const card = s.chat.messages(c.id).find((m) => m.kind === 'question')!; assert.match(card.content, /name and confirm/); const draftId = (card.meta as { draft_id: string }).draft_id;
  const A = new Assistants(s.db); assert.deepEqual(A.get(draftId)!.draft.tools.sort(), ['browser', 'read', 'search', 'write'], 'unknown or delegation tools are dropped');
  assert.throws(() => A.confirm(draftId, { name: 'Chief of Staff' }), /already an assistant called Chief of Staff/);
  assert.throws(() => A.confirm(draftId, { name: 'everyone' }), /reserved/);
  const agent = A.confirm(draftId, { name: 'Scout' });
  assert.equal(agent.name, 'Scout'); assert.equal(agent.role, 'Job boards'); assert.equal(agent.created_by, 'assistant:coordinator'); assert.equal(agent.model, 'claude-sonnet-5-5', 'new assistants default to Sonnet 5.5'); assert.ok(agent.enabled);
  assert.ok(agent.allowed_tools.includes('browser_read') && agent.allowed_tools.includes('write_artifact')); assert.ok(!agent.allowed_tools.includes('create_job') && !agent.allowed_tools.includes('request_approval'));
  assert.notEqual(agent.color_index, null); assert.ok(agent.station);
  assert.throws(() => A.confirm(draftId, { name: 'Scout 2' }), /already confirmed/);
  // owner flow (B1): a draft from the Create screen task is owner-created
  const job = s.store.create({ idempotency_key: 'd1', kind: 'assistant.draft', objective: 'Draft', success_contract: {}, agent_role: 'coordinator', workspace_id: s.ws.id, inputs: { description: 'tracks interviews' } }, 'owner').job;
  const r2 = await s.broker.call(cap(job, ['propose_assistant']), 'propose_assistant', { description: 'tracks interviews', name: 'Tally', role: 'Interviews', purpose: 'Keeps the interview calendar.', responsibilities: ['Track interviews'], instructions: 'Read only.' });
  assert.equal(r2.ok, true); const d2 = A.byJob(job.id)!; assert.equal(A.confirm(d2.id, { name: 'Tally' }).created_by, 'owner');
  const bad = await s.broker.call(cap(job, ['propose_assistant']), 'propose_assistant', { description: 'x', name: '', role: '', purpose: '', responsibilities: [], instructions: '' });
  assert.equal(bad.ok, false); assert.match(bad.text, /missing: name, role, purpose, responsibilities, instructions/);
  // a draft is never delegated or scheduled
  const cj = await s.broker.call(cap(turn, ['create_job']), 'create_job', { kind: 'assistant.draft', objective: 'x' }); assert.equal(cj.ok, false);
  // an assistant in a conversation cannot be deleted (no dangling members); after its chats go, it can
  const dc = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: [agent.id] });
  assert.match(String(s.defs.deleteAgent(agent.id, 'owner').reason), /part of 1 conversation/); assert.ok(dc);
});

test('B3: the owner asking in chat (or Telegram) is the confirmation: created at once, named if needed; never from a handoff, unquoted words, twice per reply, or past the daily limit', async () => {
  const s = setup(); const A = new Assistants(s.db);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const draft = { description: 'builds resumes', role: 'Resume builder', purpose: 'Tailors resumes per role.', responsibilities: ['Tailor a resume per role'], instructions: 'Use only real history.', tools: ['read', 'write'] };
  // unquoted words: a draft only
  const t0 = s.chat.send(c.id, 'Abdul, spin off a resume building agent', s.defs).job;
  const r0 = await s.broker.call(cap(t0, ['propose_assistant']), 'propose_assistant', { ...draft, name: 'Sailor', owner_words: 'please make a new agent' });
  assert.equal(r0.ok, true); assert.match(r0.text, /not in the owner's message/); assert.equal(s.defs.getAgent('sailor'), undefined);
  const waiting = A.byJob(t0.id)!; assert.equal(waiting.status, 'pending');
  // the owner asks to approve the waiting draft: confirmed now, with the owner's message on record
  const t1 = s.chat.send(c.id, "I'm asking you to approve that agent to build the resumes", s.defs).job;
  const r1 = await s.broker.call(cap(t1, ['propose_assistant']), 'propose_assistant', { draft_id: waiting.id, owner_words: 'approve that agent to build the resumes' });
  assert.equal(r1.ok, true, r1.text); assert.equal(A.get(waiting.id)!.status, 'confirmed'); const sailor = s.defs.getAgent('sailor')!; assert.ok(sailor.enabled);
  const ev = s.db.prepare("SELECT actor, detail FROM job_events WHERE type = 'assistant.confirmed' AND job_id = ?").get(waiting.job_id) as { actor: string; detail: string };
  assert.equal(ev.actor, 'owner:chat'); assert.equal(JSON.parse(ev.detail).message_id, t1.message_id);
  assert.ok(s.chat.messages(c.id).some((m) => m.kind === 'activity' && /Sailor joined the team, as you asked/.test(m.content)));
  assert.ok(!sailor.allowed_tools.includes('create_job') && !sailor.allowed_tools.includes('request_approval'), 'no delegation; consequential actions stay approval-bound');
  // a new one in one step, name taken -> a free variant; a second creation in the same reply is refused
  const t2 = s.chat.send(c.id, 'Create a resume builder for account manager roles too', s.defs).job;
  const r2 = await s.broker.call(cap(t2, ['propose_assistant']), 'propose_assistant', { ...draft, name: 'Sailor', owner_words: 'create a resume builder' });
  assert.equal(r2.ok, true, r2.text); assert.equal((r2.data as { name: string }).name, 'Sailor 2');
  const r2b = await s.broker.call(cap(t2, ['propose_assistant']), 'propose_assistant', { ...draft, name: 'Third', owner_words: 'create a resume builder' });
  assert.equal(r2b.ok, false); assert.match(r2b.text, /One new assistant per reply/);
  // a turn started by another assistant's handoff is not the owner asking
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const gt = s.chat.send(g.id, '@coordinator ask the researcher', s.defs).job;
  const ho = s.chat.handOff(gt.id, 'researcher', 'create a resume builder for me', s.defs, 'agent:coordinator'); assert.equal(ho.ok, true);
  const r3 = await s.broker.call(cap((ho as { job: { id: string; agent_role: string } }).job, ['propose_assistant']), 'propose_assistant', { ...draft, name: 'Sneaky', owner_words: 'create a resume builder' });
  assert.match(r3.text, /not started by the owner/); assert.equal(s.defs.getAgent('sneaky'), undefined);
  // daily limit
  for (let i = 0; i < 5; i++) { const t = s.chat.send(c.id, `Create a helper number ${i} for me now`, s.defs).job; await s.broker.call(cap(t, ['propose_assistant']), 'propose_assistant', { ...draft, name: `Helper ${i}`, owner_words: `create a helper number ${i}` }); }
  assert.equal(A.createdFromChatToday(), 5);
  const tl = s.chat.send(c.id, 'Create one more helper please', s.defs).job;
  const rl = await s.broker.call(cap(tl, ['propose_assistant']), 'propose_assistant', { ...draft, name: 'Overflow', owner_words: 'create one more helper' });
  assert.equal(rl.ok, false); assert.match(rl.text, /already created from chat today/);
  // a message that came in over Telegram counts the same way and is recorded as such
  const s2 = setup(); const c2 = s2.chat.create({ workspace_id: s2.ws.id });
  const tt = s2.chat.send(c2.id, 'Make a new agent for interview prep', s2.defs, 'owner', { source: 'telegram' }).job;
  const rt = await s2.broker.call(cap(tt, ['propose_assistant']), 'propose_assistant', { ...draft, name: 'Prep', owner_words: 'make a new agent for interview prep' });
  assert.equal(rt.ok, true, rt.text); assert.equal(JSON.parse((s2.db.prepare("SELECT detail FROM job_events WHERE type = 'assistant.confirmed'").get() as { detail: string }).detail).source, 'telegram');
});

test('E3: "working" only with a live lease and a fresh heartbeat; stale reads "checking"; a running automatic report is "delivering"', () => {
  const now = Date.parse('2026-10-13T10:00:00Z'); const fresh = '2026-10-13T09:59:50Z'; const stale = '2026-10-13T09:58:00Z'; const exp = '2026-10-13T10:01:00Z';
  const base = { blocker_code: null, inputs: '{}' } as const;
  assert.equal(turnState({ ...base, state: 'running', lease_heartbeat_at: fresh, lease_expires_at: exp }, 15, now), 'working');
  assert.equal(turnState({ ...base, state: 'running', lease_heartbeat_at: stale, lease_expires_at: exp }, 15, now), 'checking');
  assert.equal(turnState({ ...base, state: 'running', lease_heartbeat_at: fresh, lease_expires_at: '2026-10-13T09:59:59Z' }, 15, now), 'checking', 'expired lease');
  assert.equal(turnState({ ...base, state: 'running', lease_heartbeat_at: fresh, lease_expires_at: exp, inputs: '{"automatic":true}' }, 15, now), 'delivering');
  assert.equal(turnState({ ...base, state: 'queued', lease_heartbeat_at: null, lease_expires_at: null }, 15, now), 'queued');
  assert.equal(turnState({ ...base, state: 'waiting_for_auth', lease_heartbeat_at: null, lease_expires_at: null }, 15, now), 'waiting');
  assert.equal(turnState({ state: 'failed_terminal', blocker_code: 'BLOCKED', inputs: '{}', lease_heartbeat_at: null, lease_expires_at: null }, 15, now), 'blocked');
  assert.equal(turnState({ ...base, state: 'failed_terminal', lease_heartbeat_at: null, lease_expires_at: null }, 15, now), 'failed');
});

test('E2: delegated work returns to the chat it came from, reported by the assistant whose turn delegated it', async () => {
  const s = setup([{ kind: 'ok', text: 'On it.' }, { kind: 'ok', text: 'The report is ready.' }]); addAssistant(s, 'gil', 'Gil'); addAssistant(s, 'rio', 'Rio');
  s.db.prepare("UPDATE agent_definitions SET allowed_tools = ? WHERE id = 'rio'").run(JSON.stringify(['create_job', 'write_artifact']));
  s.chat.sync(s.defs);   // completion delivery starts counting from the first sync
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['gil', 'rio'] });
  const t = s.chat.send(g.id, '@Rio research Ramp', s.defs).job;
  s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true });
  const cj = await s.broker.call(cap(t, ['create_job']), 'create_job', { kind: 'research.report', objective: 'Research Ramp' }); assert.equal(cj.ok, true, cj.text);
  await runJob(s.deps, t.id); await new Promise((r) => setTimeout(r, 5));   // timestamps are millisecond-grained
  const child = s.store.get((cj.data as { id: string }).id)!; s.store.transition(child.id, 'cancelled', 'owner');   // any settled state (here: stopped) is reported back
  s.chat.sync(s.defs);
  const wake = s.chat.messages(g.id).find((m) => m.kind === 'wake')!; assert.match(wake.content, /Rio is reporting back/);
  const report = s.store.get(wake.job_id!)!; assert.equal(report.agent_role, 'rio', 'the delegating member reports, not the lead');
  assert.equal(await run(s, report.id), 'completed'); assert.equal(s.chat.messages(g.id).at(-1)!.sender, 'rio');
});

test('F2: reactions toggle per reactor and emoji, and are durable', () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id });
  const m = s.chat.add({ conversation_id: c.id, role: 'assistant', content: 'hello' });
  s.chat.react(m.id, 'owner', '👍'); s.chat.react(m.id, 'owner', '👍'); s.chat.react(m.id, 'owner', '🎉');
  assert.deepEqual(s.chat.reactions(m.id).map((r) => r.emoji), ['👍', '🎉'], 'idempotent per reactor and emoji');
  s.chat.react(m.id, 'owner', '👍', false); assert.deepEqual(s.chat.reactions(m.id).map((r) => r.emoji), ['🎉']);
  assert.throws(() => s.chat.react('msg-nope', 'owner', '👍'), /not found/);
});

test('G3: a router turn by a non-member closes its session (no orphaned adapter); idle member sessions of groups are found for closing', async () => {
  const s = setup([{ kind: 'ok', text: 'Gil will take it.' }]); addAssistant(s, 'gil', 'Gil'); addAssistant(s, 'rio', 'Rio');
  const closed: string[] = []; (s.runtime as unknown as { closeSession: (r: string) => Promise<void> }).closeSession = async (r: string) => { closed.push(r); };
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['gil', 'rio'] });
  const sent = s.chat.send(g.id, 'who can help?', s.defs); assert.equal(sent.routed, true);
  assert.equal(await run(s, sent.job.id), 'completed');
  assert.deepEqual(closed, [`sim-${g.id}.coordinator`], 'the router session is closed right after its turn');
  assert.equal(s.store.get(sent.job.id)!.session_ref, null);
  assert.equal(s.chat.member(g.id, 'coordinator'), undefined, 'the router never becomes a member');
  // member sessions in groups are idle-closable
  s.chat.setSession(g.id, 'sess-gil', 'gil'); s.db.prepare("UPDATE conversations SET last_message_at = '2000-01-01T00:00:00Z', updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(g.id);
  assert.deepEqual(s.chat.idleSessions(60_000).filter((x) => x.conversation_id === g.id).map((x) => ({ ...x })), [{ conversation_id: g.id, agent_id: 'gil', session_ref: 'sess-gil' }]);
});

test('verifier fixes: handoffs survive the sender failing; delivery follows stopped turns; names cannot shadow ids; replies and @everyone edge cases; routers only read and hand off', async () => {
  const s = setup([{ kind: 'ok', text: 'routing' }]); addAssistant(s, 'gil', 'Gil'); addAssistant(s, 'rio', 'Rio');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['gil', 'rio'] });
  // 1) the sender's turn fails after handing off: the target's turn is not cancelled by the stop/failure cascade
  const root = s.chat.send(g.id, '@Gil start', s.defs).job;
  const ho = s.chat.handOff(root.id, 'Rio', 'do part 2', s.defs, 'w') as { ok: true; job: { id: string } }; assert.equal(ho.ok, true);
  s.store.transition(root.id, 'cancelled', 'owner'); s.chat.sync(s.defs);
  assert.equal(s.store.get(ho.job.id)!.state, 'queued', 'the handoff turn still runs');
  // 2) a queued turn stopped by the owner leaves its message failed, not queued forever
  const m2 = s.chat.send(g.id, '@Rio second', s.defs);
  s.store.transition(m2.job.id, 'cancelled', 'owner'); s.chat.sync(s.defs);
  assert.equal(s.chat.message(m2.message.id)!.delivery, 'failed');
  // 3) a new assistant may not be named like another assistant's id; the composer's ids resolve exactly
  const A = new Assistants(s.db); const d = A.saveDraft({ description: 'x', fields: { name: 'builder', role: 'r', purpose: 'p', responsibilities: ['a'], instructions: 'i' } });
  assert.throws(() => A.confirm(d.id, {}), /already an assistant called Writer & builder/);
  const g2 = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['builder', 'rio'] });
  assert.deepEqual(s.chat.send(g2.id, 'hi', s.defs, 'owner', {}, { mentions: ['builder'] }).jobs.map((j) => j.agent_role), ['builder']);
  // 4) reply_to from another conversation is refused in a direct chat too; "(@everyone)" counts
  const dchat = s.chat.create({ workspace_id: s.ws.id }); const other = s.chat.add({ conversation_id: g.id, role: 'assistant', sender: 'gil', content: 'x' });
  assert.throws(() => s.chat.send(dchat.id, 'hi', s.defs, 'owner', {}, { reply_to: other.id }), /not in this conversation/);
  assert.deepEqual(s.chat.send(g2.id, 'status please (@everyone)', s.defs).jobs.map((j) => j.agent_role).sort(), ['builder', 'rio']);
  // 5) a router that is not a member only gets read tools and hand_off
  (s.runtime as unknown as { closeSession: (r: string) => Promise<void> }).closeSession = async () => {};
  let toolsDuringTurn: string[] = []; const orig = s.runtime.startTurn.bind(s.runtime); s.runtime.startTurn = async (req) => { toolsDuringTurn = readCapability(s.deps.runDir, `${g.id}.coordinator`)?.tools ?? []; return orig(req); };
  const r = s.chat.send(g.id, 'who can help?', s.defs); assert.equal(r.routed, true);
  s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE kind = 'chat.turn' AND id != ?").run(r.job.id);
  assert.equal(await run(s, r.job.id), 'completed');
  const cap2 = readCapability(s.deps.runDir, `${g.id}.coordinator`)!; assert.deepEqual(cap2.tools, [], 'emptied after the turn');
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'session.closed'").get(r.job.id), 'router session closed');
  assert.ok(toolsDuringTurn.includes('hand_off') && toolsDuringTurn.includes('read_artifact'), toolsDuringTurn.join(','));
  assert.ok(!toolsDuringTurn.some((t) => ['create_job', 'create_schedule', 'propose_assistant', 'request_approval', 'write_artifact'].includes(t)), 'a non-member router cannot start work');
});

test('P4: a handoff with after waits for that member\'s turn and starts only when it finishes', async () => {
  const s = setup(); addAssistant(s, 'rio', 'Rio', 'Research'); addAssistant(s, 'wes', 'Wes', 'Writing');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['rio', 'wes'], title: 'Team' });
  const sent = s.chat.send(g.id, 'Research then write', s.defs); s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true });
  const a = await s.broker.call(cap(sent.job, ['hand_off']), 'hand_off', { to: 'Rio', request: 'Research it.' }); assert.equal(a.ok, true);
  const b = await s.broker.call(cap(sent.job, ['hand_off']), 'hand_off', { to: 'Wes', request: 'Write it from the research.', after: 'Rio' }); assert.equal(b.ok, true, b.text);
  const rio = s.db.prepare("SELECT id FROM jobs WHERE agent_role = 'rio'").get() as { id: string }; const wes = s.db.prepare("SELECT id, depends_on FROM jobs WHERE agent_role = 'wes'").get() as { id: string; depends_on: string };
  assert.deepEqual(JSON.parse(wes.depends_on), [rio.id]);
  const l1 = s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true }); assert.equal(l1?.id, rio.id, 'the writer is not leased before the research');
  assert.equal(s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true }) ?? null, null);
  s.store.transition(rio.id, 'running', 'worker:test'); s.store.transition(rio.id, 'completed', 'worker:test');
  assert.equal(s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true })?.id, wes.id, 'the writer starts once the research is done');
  const c = await s.broker.call(cap(sent.job, ['hand_off']), 'hand_off', { to: 'Rio', request: 'x', after: 'Nobody' }); assert.equal(c.ok, false);
});

test('P4 (review): a reviewer can send fixes back to a writer who finished; a third round is refused', async () => {
  const s = setup(); addAssistant(s, 'wes', 'Wes'); addAssistant(s, 'rev', 'Rev');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['wes', 'rev'] });
  const root = s.chat.send(g.id, 'Write then review', s.defs).job;
  const w1 = s.chat.handOff(root.id, 'Wes', 'Write it.', s.defs, 'w') as { ok: true; job: { id: string } };
  const r1 = s.chat.handOff(root.id, 'Rev', 'Review it.', s.defs, 'w', 'Wes') as { ok: true; job: { id: string } };
  for (const id of [w1.job.id]) { s.store.transition(id, 'leased', 'w'); s.store.transition(id, 'running', 'w'); s.store.transition(id, 'completed', 'w'); }
  const back = s.chat.handOff(r1.job.id, 'Wes', 'Fix the summary line.', s.defs, 'w'); assert.equal(back.ok, true, (back as { reason?: string }).reason);
  const w2 = (back as { job: { id: string } }).job.id; s.store.transition(w2, 'leased', 'w'); s.store.transition(w2, 'running', 'w'); s.store.transition(w2, 'completed', 'w');
  const again = s.chat.handOff(r1.job.id, 'Wes', 'And again.', s.defs, 'w'); assert.equal(again.ok, false);
});
test('P4 (review loop): a revision after a failed review is re-reviewed automatically; review_max_rounds and the turn budget stop it with a blocker', () => {
  const s = setup(); addAssistant(s, 'wes', 'Wes'); addAssistant(s, 'rev', 'Rev'); new Settings(s.db).set('chat_max_turns_per_message', 12, 'owner');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['wes', 'rev'] });
  const root = s.chat.send(g.id, 'Write then review', s.defs).job;
  const done = (id: string, file = false) => { s.store.transition(id, 'leased', 'w'); s.store.transition(id, 'running', 'w'); if (file) s.db.prepare("INSERT INTO artifacts (id, job_id, stage_name, kind, path, title, created_at) VALUES (?, ?, 'reply', 'file', NULL, 'draft', ?)").run(`art-${id}`, id, new Date().toISOString()); s.store.transition(id, 'completed', 'w'); };
  const w1 = (s.chat.handOff(root.id, 'Wes', 'Write it.', s.defs, 'w') as { job: { id: string } }).job.id; done(w1, true);
  const r1 = (s.chat.handOff(w1, 'Rev', 'Review my draft.', s.defs, 'w') as { job: { id: string } }).job.id; done(r1);
  const turnsFor = (a: string) => s.db.prepare("SELECT id, inputs FROM jobs WHERE kind = 'chat.turn' AND agent_role = ? ORDER BY created_at, rowid").all(a) as Array<{ id: string; inputs: string }>;
  let wesJob = (s.chat.handOff(r1, 'Wes', 'Fails: fix the summary.', s.defs, 'w') as { ok: boolean; job: { id: string } }).job.id;   // fix-back (round 1)
  for (let round = 1; ; round++) {
    done(wesJob, true); s.chat.sync(s.defs);   // the writer saved a revision but did not hand it back
    const revs = turnsFor('rev'); const last = revs[revs.length - 1];
    const blocker = s.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND kind = 'blocker'").get(g.id) as { content: string } | undefined;
    assert.equal(blocker, undefined, 'no blocker while within the cap');
    assert.equal(JSON.parse(last.inputs).handoff_from, 'wes'); assert.ok(JSON.parse(last.inputs).review_round, 'the engine queued a re-review');
    const am = s.db.prepare("SELECT role, sender, content, meta FROM messages WHERE job_id = ? AND kind = 'handoff'").get(last.id) as { role: string; sender: string | null; content: string; meta: string };
    assert.equal(am.role, 'system', 'an engine hand-off is a system ledger event'); assert.equal(am.sender, 'system', 'not sent by the writer');
    assert.match(am.content, /^ClaudeBot sent Wes's revision to Rev for re-review \(automatic\)\.$/); const meta = JSON.parse(am.meta); assert.equal(meta.automatic, true); assert.equal(meta.from, 'engine'); assert.equal(meta.revised_by, 'wes'); assert.match(meta.request, /Automatic re-review/);
    assert.match(String(JSON.parse(last.inputs).handoff_from_name), /^ClaudeBot \(automatically, because Wes saved a revision/);
    s.chat.sync(s.defs); assert.equal(turnsFor('rev').length, revs.length, 'idempotent: one re-review per revision');
    done(last.id); const back = s.chat.handOff(last.id, 'Wes', 'Still fails: one more fix.', s.defs, 'w') as { ok: boolean; job: { id: string }; reason?: string };
    if (!back.ok) { assert.equal(round, 2, 'two review rounds, then the cap'); assert.match(back.reason ?? '', /review limit of 2 rounds/); assert.match((s.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND kind = 'blocker'").get(g.id) as { content: string }).content, /Review stopped after 2 rounds: Rev still found problems in Wes's latest version/); break; }
    wesJob = back.job.id;
  }
  s.chat.sync(s.defs); assert.equal((s.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'blocker'").get() as { n: number }).n, 1, 'one blocker');
  // the turn budget also bounds the loop
  new Settings(s.db).set('chat_max_turns_per_message', 4, 'owner'); new Settings(s.db).set('review_max_rounds', 5, 'owner');
  const g2 = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['wes', 'rev'] }); const root2 = s.chat.send(g2.id, 'Again', s.defs).job;
  const a1 = (s.chat.handOff(root2.id, 'Wes', 'Write.', s.defs, 'w') as { job: { id: string } }).job.id; done(a1, true);
  const b1 = (s.chat.handOff(a1, 'Rev', 'Review.', s.defs, 'w') as { job: { id: string } }).job.id; done(b1);
  const a2 = (s.chat.handOff(b1, 'Wes', 'Fix.', s.defs, 'w') as { job: { id: string } }).job.id; done(a2, true); s.chat.sync(s.defs);
  const b2 = turnsFor('rev').filter((j) => JSON.parse(j.inputs).chain_root === JSON.parse(turnsFor('rev').slice(-1)[0].inputs).chain_root).slice(-1)[0].id; done(b2);
  const a3 = (s.chat.handOff(b2, 'Wes', 'Fix again.', s.defs, 'w') as { ok: boolean; reason: string }); assert.equal(a3.ok, false); assert.match(a3.reason, /limit of 4 handoffs/);
});
test('load test S3.2/S3.3: a turn interrupted by an engine restart (retry_scheduled) keeps its place; the owner\'s later message waits behind it', () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id });
  const a = s.chat.send(c.id, 'write the note', s.defs); const b = s.chat.send(c.id, 'direction: shorter', s.defs);
  const l1 = s.store.lease({ owner: 'w1', leaseSeconds: 30, fair: true }); assert.equal(l1?.id, a.job.id);
  s.store.transition(a.job.id, 'running', 'w1'); s.store.transition(a.job.id, 'retry_scheduled', 'engine', { retry_at: new Date(Date.now() + 30_000).toISOString() }, { reason: 'interrupted by an engine restart' });
  assert.equal(s.store.lease({ owner: 'w2', leaseSeconds: 30, fair: true }), undefined, 'the direction does not jump ahead of the interrupted turn');
  assert.equal(s.store.get(b.job.id)!.state, 'queued');
});
test('owner can rename and re-describe a built-in assistant, and the seed keeps the owner\'s wording', () => {
  const s = setup(); const before = s.defs.getAgent('researcher')!;
  s.defs.upsertAgent({ ...before, name: 'Scout', purpose: 'Finds things.', role: 'Finds sources', color_index: 4, prohibited_actions: ['never guess'] } as never, 'owner');
  let a = s.defs.getAgent('researcher')!; assert.equal(a.name, 'Scout'); assert.equal(a.purpose, 'Finds things.'); assert.equal(a.role, 'Finds sources'); assert.equal(a.color_index, 4); assert.deepEqual(a.prohibited_actions, ['never guess']);
  s.defs.seedSystemDefaults(); a = s.defs.getAgent('researcher')!; assert.equal(a.name, 'Scout', 'the seed does not undo an owner rename'); assert.equal(a.purpose, 'Finds things.');
});

test('files an assistant saves during a chat reply appear in that chat as file cards, once each (owner: "the file is not in the chat")', () => {
  const run = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src/worker/run.ts'), 'utf8');
  assert.match(run, /chat\.add\(\{ conversation_id: conv\.id, role: 'assistant', kind: 'result', sender: agentId, content: a\.title \|\| 'Saved a file', job_id: job\.id, artifact_id: a\.id/);
  assert.match(run, /id NOT IN \(SELECT artifact_id FROM messages WHERE artifact_id IS NOT NULL AND conversation_id = \?\)/, 'never twice');
});

test('browser approvals: the outbox and the permission runner never perform or consume them; allowing one starts exactly one turn that carries it out', async () => {
  const s = setup(); const approvals = new ApprovalStore(s.db); const actions = new ActionStore(s.db, approvals);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const turn = s.chat.send(c.id, 'apply to this posting', s.defs).job;
  const content = JSON.stringify({ url: 'https://boards.example-ats.test/acme/jobs/1', action: 'click', key: null, element: { role: 'button', name: 'Submit application' }, typed_sha256: 'x' });
  const ap = approvals.request({ job_id: turn.id, action_kind: 'send', target: 'https://boards.example-ats.test/acme/jobs/1 — button "Submit application"', content });
  approvals.decide(ap.id, 'approved', 'owner');
  const out = await actions.perform({ job_id: turn.id, idempotency_key: `approval:${ap.id}`, kind: 'send', target: ap.target, content, approval_id: ap.id, actor: 'owner' });
  assert.equal(out.status, 'refused'); assert.match((out as { reason: string }).reason, /browser action/);
  assert.equal(approvals.get(ap.id)!.status, 'approved', 'not consumed'); assert.equal((s.db.prepare('SELECT count(*) AS n FROM actions').get() as { n: number }).n, 0, 'nothing written to the outbox');
  s.store.transition(turn.id, 'leased', 'test'); s.store.transition(turn.id, 'running', 'test'); s.store.transition(turn.id, 'completed', 'test');
  const r1 = s.chat.resumeForApproval(ap.id, s.defs)!; const r2 = s.chat.resumeForApproval(ap.id, s.defs)!;
  assert.ok(r1); assert.equal(r1.id, r2.id, 'one turn per approval'); assert.equal(r1.agent_role, turn.agent_role); assert.equal(r1.conversation_id, c.id);
  assert.match(s.chat.messages(c.id).find((m) => m.kind === 'wake')!.content, new RegExp(`approval_id ${ap.id}`));
  // an email approval is not resumed this way (it runs through the executor)
  const em = approvals.request({ job_id: turn.id, action_kind: 'send', target: 'email to a@example.test', content: 'To: a@example.test\nSubject: x\n\nhi' }); approvals.decide(em.id, 'approved', 'owner');
  assert.equal(s.chat.resumeForApproval(em.id, s.defs), null);
});

test('mentions: first names route ("@Jude", "Jude, …"); long messages are never cut silently; read_message, post_update, share_file and the lead\'s team tools work only within their limits', async () => {
  const s = setup(); const defs = s.defs;
  defs.upsertAgent({ ...defs.getAgent('researcher')!, name: 'Jude (Job Applicator)' }, 'owner');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher', 'reviewer'] });
  assert.deepEqual(s.chat.send(g.id, '@Jude answer me', defs).jobs.map((j) => j.agent_role), ['researcher']);
  assert.deepEqual(s.chat.send(g.id, 'Jude, where are the files?', defs).jobs.map((j) => j.agent_role), ['researcher']);
  assert.deepEqual(s.chat.send(g.id, 'what do we have today', defs).jobs.map((j) => j.agent_role), ['coordinator'], 'no name: the lead routes');
  // truncation is marked, and read_message returns the rest, only for this conversation
  const long = 'x'.repeat(2000) + 'END';
  const lm = s.chat.add({ conversation_id: g.id, role: 'assistant', sender: 'reviewer', content: long });
  const turn = s.chat.send(g.id, '@coordinator summarise', defs).job;
  const ctx = s.chat.groupContext(g.id, 'coordinator', Number.MAX_SAFE_INTEGER); assert.match(ctx, new RegExp(`\\[message continues: 503 more characters; read_message ${lm.id} offset 1500\\]`));
  const rm = await s.broker.call(cap(turn, ['read_message']), 'read_message', { id: lm.id, offset: 1500 }); assert.equal(rm.ok, true); assert.ok(rm.text.endsWith('END'));
  const other = s.chat.create({ workspace_id: s.ws.id }); const om = s.chat.add({ conversation_id: other.id, role: 'assistant', sender: 'coordinator', content: 'private' });
  assert.equal((await s.broker.call(cap(turn, ['read_message']), 'read_message', { id: om.id })).ok, false, 'another conversation is refused');
  // post_update: capped
  for (let i = 0; i < 10; i++) assert.equal((await s.broker.call(cap(turn, ['post_update']), 'post_update', { text: `step ${i}` })).ok, true);
  assert.equal((await s.broker.call(cap(turn, ['post_update']), 'post_update', { text: 'one more' })).ok, false);
  // team tools need the owner's own words
  const rn = s.chat.send(g.id, '@coordinator rename Resume Tailor to Roger please', defs).job;
  assert.equal((await s.broker.call(cap(rn, ['rename_assistant']), 'rename_assistant', { assistant: 'reviewer', name: 'Roger', owner_words: 'make him Bob' })).ok, false);
  const ok = await s.broker.call(cap(rn, ['rename_assistant']), 'rename_assistant', { assistant: 'reviewer', name: 'Roger', owner_words: 'rename Resume Tailor to Roger' }); assert.equal(ok.ok, true, ok.text); assert.equal(defs.getAgent('reviewer')!.name, 'Roger');
  assert.deepEqual(s.chat.send(g.id, 'Roger: check this', defs).jobs.map((j) => j.agent_role), ['reviewer'], 'the new name routes at once');
  const rm2 = s.chat.send(g.id, '@coordinator remove Roger from this group', defs).job;
  assert.equal((await s.broker.call(cap(rm2, ['remove_member']), 'remove_member', { assistant: 'Roger', owner_words: 'remove Roger from this group' })).ok, true); assert.equal(s.chat.member(g.id, 'reviewer'), undefined);
  const rm3 = s.chat.send(g.id, '@coordinator remove Jude from this group', defs).job;
  assert.match((await s.broker.call(cap(rm3, ['remove_member']), 'remove_member', { assistant: 'Jude', owner_words: 'remove Jude from this group' })).text, /at least 2/);
});

test('groups: the lead creates and renames groups on the owner\'s words; purpose reaches members; initials follow the display name', async () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id });
  const t1 = s.chat.send(c.id, 'Abdul, create a group called Job Hunt with Jude and Oscar', s.defs).job;
  assert.equal((await s.broker.call(cap(t1, ['create_group']), 'create_group', { name: 'Job Hunt', members: ['researcher', 'reviewer'], owner_words: 'make a group' })).ok, false);
  const r = await s.broker.call(cap(t1, ['create_group']), 'create_group', { name: 'Job Hunt', members: ['researcher', 'reviewer'], purpose: 'Find and apply to remote roles', owner_words: 'create a group called Job Hunt' });
  assert.equal(r.ok, true, r.text); const gid = (r.data as { conversation_id: string }).conversation_id; const g = s.chat.get(gid)!;
  assert.equal(g.title, 'Job Hunt'); assert.deepEqual(s.chat.members(gid).map((m) => m.agent_id).sort(), ['coordinator', 'researcher', 'reviewer']);
  const t2 = s.chat.send(c.id, 'rename Job Hunt to Applications', s.defs).job;
  assert.equal((await s.broker.call(cap(t2, ['edit_group']), 'edit_group', { conversation: gid, name: 'Applications', owner_words: 'rename Job Hunt to Applications' })).ok, true); assert.equal(s.chat.get(gid)!.title, 'Applications');
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'ui/app.js'), 'utf8');
  const initials = new Function(`${app.match(/const initials = [^\n]+/)![0]}; return initials;`)() as (n: string) => string;
  assert.equal(initials('Abdul El-Sayed'), 'AE'); assert.equal(initials('Jude (Job Applicator)'), 'J'); assert.equal(initials('Roger'), 'R'); assert.ok(!/'CS'/.test(app), 'no hard-coded initials');
});

test('honesty check: a reply that says an application was submitted, without a verified confirmation, gets a plain note under it; "not submitted" does not', async () => {
  const s = setup([{ kind: 'ok', text: 'Done! I submitted the Northwind application.' }, { kind: 'ok', text: 'Northwind is not submitted yet: the upload failed.' }, { kind: 'ok', text: 'Research only: three roles listed, and nothing was applied for.' }, { kind: 'ok', text: 'Three roles found, with links, and applied to none.' }]);
  const c = s.chat.create({ workspace_id: s.ws.id });
  const t1 = s.chat.send(c.id, 'apply to Northwind', s.defs).job; await run(s, t1.id);
  const notes = () => s.chat.messages(c.id).filter((m) => (m.meta as { honesty_check?: boolean }).honesty_check);
  assert.equal(notes().length, 1); assert.match(notes()[0].content, /not yet submitted/);
  const t2 = s.chat.send(c.id, 'status?', s.defs).job; await run(s, t2.id);
  assert.equal(notes().length, 1, 'an honest "not submitted" gets no note');
  const t3 = s.chat.send(c.id, 'and the practice run?', s.defs).job; await run(s, t3.id); assert.equal(notes().length, 1, '"nothing was applied for" is honest too (rehearsal 2 false alarm)');
  const t4 = s.chat.send(c.id, 'and now?', s.defs).job; await run(s, t4.id); assert.equal(notes().length, 1, '"applied to none" is honest (rehearsal 5)');
});

test('the lead switches an assistant off and back on, only on the owner\'s words (morning restart after a pause)', async () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id });
  const t1 = s.chat.send(c.id, 'Abdul, pause Jude for tonight', s.defs).job;
  assert.equal((await s.broker.call(cap(t1, ['disable_assistant']), 'disable_assistant', { assistant: 'researcher', owner_words: 'pause Jude for tonight' })).ok, true); assert.equal(s.defs.getAgent('researcher')!.enabled, false);
  const t2 = s.chat.send(c.id, 'Abdul, turn everyone back on and start the job search', s.defs).job;
  assert.equal((await s.broker.call(cap(t2, ['enable_assistant']), 'enable_assistant', { assistant: 'researcher', owner_words: 'make jude work' })).ok, false);
  assert.equal((await s.broker.call(cap(t2, ['enable_assistant']), 'enable_assistant', { assistant: 'researcher', owner_words: 'turn everyone back on' })).ok, true); assert.equal(s.defs.getAgent('researcher')!.enabled, true);
});

test('delegation goes to the assistant the lead names (by first name), and a switched-off or unknown one is refused, never silently replaced (rehearsal 1 finding)', async () => {
  const s = setup(); addAssistant(s, 'resume-tailor', 'Roger (Resume Tailor)', 'Resumes');
  const c = s.chat.create({ workspace_id: s.ws.id }); const t1 = s.chat.send(c.id, 'Roger: make the resume', s.defs).job;
  const ok = await s.broker.call(cap(t1, ['create_job']), 'create_job', { kind: 'document.create', objective: 'One-page resume', agent_role: 'Roger' });
  assert.equal(ok.ok, true, ok.text); assert.equal(s.store.get((ok.data as { id: string }).id)!.agent_role, 'resume-tailor');
  s.defs.setAgentEnabled('builder', false, 'owner');
  const off = await s.broker.call(cap(t1, ['create_job']), 'create_job', { kind: 'document.create', objective: 'Another doc' }); assert.equal(off.ok, false); assert.match(off.text, /switched off/);
  const nobody = await s.broker.call(cap(t1, ['create_job']), 'create_job', { kind: 'document.create', objective: 'x', agent_role: 'Zed' }); assert.equal(nobody.ok, false); assert.match(nobody.text, /no assistant called "Zed"/);
});

test('every turn knows the owner by name, so "Abdul, make a resume" is for the owner, not for Abdul (rehearsal 4 finding)', async () => {
  const s = setup([{ kind: 'ok', text: 'On it.' }]); new Settings(s.db).set('owner_name', "Sam Rivera", 'test');
  const c = s.chat.create({ workspace_id: s.ws.id }); const t1 = s.chat.send(c.id, 'Abdul, make me a resume', s.defs).job; await run(s, t1.id);
  assert.match(s.runtime.history[0].prompt, /The owner is Sam Rivera; when the owner writes "Chief, …" they are talking to you|The owner is Sam Rivera; when the owner writes "[^"]+, …" they are talking to you/);
});

test('the lead adds a missing wait to a task that has not started (applications wait for the resumes); finished tasks and cycles are refused (launch rehearsal finding)', async () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id }); const lead = s.chat.send(c.id, 'go', s.defs).job;
  const mk = async (o: string) => (await s.broker.call(cap(lead, ['create_job']), 'create_job', { kind: 'document.create', objective: o, agent_role: 'builder' })).data as { id: string };
  const resumes = await mk('resumes'); const apply = await mk('apply');
  const r = await s.broker.call(cap(lead, ['add_dependency']), 'add_dependency', { task_id: apply.id, depends_on: [resumes.id] }); assert.equal(r.ok, true, r.text);
  assert.deepEqual(JSON.parse(s.store.get(apply.id)!.depends_on), [resumes.id]);
  assert.match((await s.broker.call(cap(lead, ['add_dependency']), 'add_dependency', { task_id: resumes.id, depends_on: [apply.id] })).text, /wait for each other/);
});

test('an assistant remembers its other conversations: a direct chat sees what went wrong in the group chat (owner: "it doesn\'t remember")', async () => {
  const s = setup([{ kind: 'ok', text: 'Yes: the Northwind approval went blank and I restarted instead of reopening it.' }]); addAssistant(s, 'scout', 'Scout', 'Job boards');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'scout'] });
  s.chat.add({ conversation_id: g.id, role: 'owner', sender: 'owner', content: 'Scout, the Northwind approval went blank and you started over. Reopen it next time.' });
  s.chat.add({ conversation_id: g.id, role: 'assistant', sender: 'scout', content: 'Understood: I will reopen a blank approval instead of starting over.' });
  const test = new Workspaces(s.db, path.join(s.tmp, 'ws')).create({ name: 'Rehearsal (test)', policies: { telegram: false, dry_run: true } }, 'test');
  const tg = s.chat.create({ workspace_id: test.id, type: 'group', members: ['coordinator', 'scout'] }); s.chat.add({ conversation_id: tg.id, role: 'owner', sender: 'owner', content: 'rehearsal chatter' });
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['scout'] });
  const { job } = s.chat.send(d.id, 'What went wrong last time?', s.defs);
  assert.equal(await run(s, job.id), 'completed');
  const prompt = s.runtime.history[0].prompt;
  assert.match(prompt, /What happened recently in your other conversations/); assert.match(prompt, /Owner: Scout, the Northwind approval went blank/); assert.match(prompt, /You: Understood: I will reopen/);
  assert.ok(!prompt.includes('rehearsal chatter'), 'test projects are not memory');
  assert.equal(s.chat.elsewhere('scout', g.id).includes('you started over'), false, 'a conversation is not repeated as its own "elsewhere"');
});

test('a note sent to an assistant that is turned off waits and is delivered when it is turned back on (never "could not reply", never a raw id)', async () => {
  const s = setup([{ kind: 'ok', text: 'On it: finishing the Priority A applications.' }]); addAssistant(s, 'scout', 'Scout', 'Job boards');
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['scout'] });
  s.defs.setAgentEnabled('scout', false, 'test');
  const job = s.chat.engineTurn(d.id, 'scout', 'ClaudeBot fixed the resume upload. Finish the Priority A applications.', 'note-1', s.defs);
  assert.equal(s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true }), undefined, 'nothing runs while the assistant is off');
  assert.equal(s.store.get(job!.id)!.state, 'queued');
  s.defs.setAgentEnabled('scout', true, 'test');
  assert.equal(await run(s, job!.id), 'completed');
  const texts = s.chat.messages(d.id).map((m) => m.content).join('\n');
  assert.match(texts, /On it: finishing the Priority A applications/); assert.ok(!/could not reply|agent scout/.test(texts));
});

test('read_conversation: an assistant reads the whole record of a chat it belongs to (decisions included) instead of asking the owner to export it; non-members are refused', async () => {
  const s = setup(); addAssistant(s, 'scout', 'Scout', 'Job boards'); addAssistant(s, 'ben', 'Ben', 'Writer');
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', title: 'All right, everybody', members: ['coordinator', 'scout'] });
  const turn = s.chat.send(g.id, '@Scout apply to Northwind', s.defs).job;
  s.chat.add({ conversation_id: g.id, role: 'assistant', sender: 'scout', content: 'Northwind: Submit clicked, checking the confirmation.' });
  const ap = new ApprovalStore(s.db).request({ job_id: turn.id, action_kind: 'submit', target: 'Northwind application', content: 'Submit the Northwind form' });
  s.chat.add({ conversation_id: g.id, role: 'system', kind: 'decision', content: 'decision', approval_id: ap.id, job_id: turn.id });
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['scout'] }); const mine = s.chat.send(d.id, 'Make the Oct 13 transcript', s.defs).job;
  const r = await s.broker.call(cap(mine, ['read_conversation']), 'read_conversation', { conversation: 'All right, everybody' });
  assert.equal(r.ok, true); assert.match(r.text, /Owner: @Scout apply to Northwind/); assert.match(r.text, /Scout: Northwind: Submit clicked/); assert.match(r.text, /decision: submit Northwind application → pending/); assert.match(r.text, /\[end of conversation\]/);
  const dBen = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['ben'] }); const benJob = s.chat.send(dBen.id, 'read it', s.defs).job;
  const no = await s.broker.call(cap(benJob, ['read_conversation']), 'read_conversation', { conversation: g.id }); assert.equal(no.ok, false);
});

test('a ClaudeBot note can start the work it describes (the lead refused a queued handoff as "automatic" and asked the owner again); automatic reports still cannot', async () => {
  const s = setup(); const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const note = s.chat.engineTurn(d.id, 'coordinator', 'ClaudeBot note: start the handoff index now.', 'k-note', s.defs)!;
  const ok = await s.broker.call(cap(note, ['create_job']), 'create_job', { kind: 'document.create', objective: 'Build handoff-index.md from the two zips', agent_role: 'builder' });
  assert.equal(ok.ok, true, ok.text);
  const { notOwnerInitiated } = await import('../../src/broker/api.ts');
  assert.equal(notOwnerInitiated(JSON.stringify({ automatic: true })), 'an automatic report'); assert.equal(notOwnerInitiated(JSON.stringify({ engine: true })), null);
});

test('ask-back guard: a reply that ends by asking whether to do team work is bounced back to do it (not pushed to Telegram); owner matters may still be asked; never bounced twice', async () => {
  const s = setup([{ kind: 'ok', text: 'Both are started. I haven\'t sent anything to the hiring manager; I\'ll only send the follow-up once the address is confirmed. Should I have the researcher try to verify her address now?' }, { kind: 'ok', text: 'Verified and saved.' }, { kind: 'ok', text: 'The form asks your desired salary. Should I enter $120K?' }]);
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const { job } = s.chat.send(d.id, 'Start the handoff index', s.defs); assert.equal(await run(s, job.id), 'completed');
  const ask = s.chat.messages(d.id).find((m) => m.role === 'assistant')!; assert.equal((ask.meta as { ask_back?: boolean }).ask_back, true);
  const bounce = s.db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(`engine:askback:${job.id}`) as { id: string }; assert.ok(bounce, 'bounced back to do the work');
  assert.equal(await run(s, bounce.id), 'completed'); assert.equal((s.db.prepare("SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE 'engine:askback:%'").get() as { n: number }).n, 1, 'the bounce turn is never bounced again');
  const t2 = s.chat.send(d.id, 'Fill the application', s.defs).job; assert.equal(await run(s, t2.id), 'completed');
  assert.ok(!s.db.prepare("SELECT 1 FROM jobs WHERE idempotency_key = ?").get(`engine:askback:${t2.id}`), 'a salary question is the owner\'s to answer');
});

test('a status report that hands the owner answers the team can find is bounced back (alternatives first, memory first); the rule is in every prompt', async () => {
  const s = setup([{ kind: 'ok', text: 'The first role is applied. The second needs you to solve the CAPTCHA, and the other eight roles need answers only you can give.' }, { kind: 'ok', text: 'Answered from the resume and saved answers; 6 submitted.' }]);
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const { job } = s.chat.send(d.id, 'How are the applications going?', s.defs); assert.equal(await run(s, job.id), 'completed');
  assert.match(s.runtime.history[0].prompt, /try the alternatives yourself before reporting/); assert.match(s.runtime.history[0].prompt, /Report "stuck" only after that, and list what you tried/);
  const bounce = s.db.prepare("SELECT id, objective FROM jobs WHERE idempotency_key = ?").get(`engine:askback:${job.id}`) as { id: string; objective: string }; assert.ok(bounce); assert.match(bounce.objective, /application-answers\.md/);
});

test('all work shows in the team group: direct-chat requests, replies, progress and files are recorded there, labelled; approvals and ClaudeBot notes stay private; test projects stay out', async () => {
  const s = setup(); addAssistant(s, 'scout', 'Scout', 'Job boards');
  const team = s.chat.create({ workspace_id: s.ws.id, type: 'group', title: 'Job Hunters', members: ['coordinator', 'scout'] });
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['scout'] });
  s.chat.add({ conversation_id: d.id, role: 'owner', sender: 'owner', content: 'Submit all 9 now.' });
  s.chat.add({ conversation_id: d.id, role: 'assistant', sender: 'scout', content: '2 of 9 done: Northwind submitted and confirmed.', meta: { update: true } });
  s.chat.add({ conversation_id: d.id, role: 'system', kind: 'wake', content: 'ClaudeBot note: carry on.' });
  s.chat.add({ conversation_id: d.id, role: 'system', kind: 'decision', content: 'decision' });
  const test = new Workspaces(s.db, path.join(s.tmp, 'ws')).create({ name: 'Rehearsal (test)', policies: { telegram: false } }, 'test');
  const td = s.chat.create({ workspace_id: test.id, type: 'direct', members: ['scout'] }); s.chat.add({ conversation_id: td.id, role: 'assistant', sender: 'scout', content: 'rehearsal chatter' });
  const lines = s.chat.messages(team.id).map((m) => m.content);
  assert.ok(lines.some((l) => /^From direct chat.* · You: Submit all 9 now\./.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /· Scout: 2 of 9 done: Northwind submitted and confirmed\./.test(l)));
  assert.ok(!lines.some((l) => /ClaudeBot note|decision|rehearsal chatter/.test(l)), 'notes, approvals and test projects stay out');
  assert.equal(s.chat.teamConversation(), team.id);
});

test('an automatic report may start one follow-up when delegated work came back blocked or partial (a follow-up that "stays unsent"); otherwise it may not', async () => {
  const s = setup(); const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const mk = (key: string, inputs: Record<string, unknown>) => { const j = s.store.create({ idempotency_key: key, kind: 'chat.turn', objective: 'Automatic report: delegated work finished', success_contract: {}, agent_role: 'coordinator', workspace_id: s.ws.id, inputs } as never, 'engine').job; s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(d.id, j.id); return s.store.get(j.id)!; };
  const quiet = mk('auto-1', { automatic: true, conversation_id: d.id });
  const no = await s.broker.call(cap(quiet, ['create_job']), 'create_job', { kind: 'document.create', objective: 'x', agent_role: 'builder' }); assert.equal(no.ok, false, 'nothing came back blocked: no new work');
  const blocked = s.store.create({ idempotency_key: 'deleg-1', kind: 'research.report', objective: 'Verify Jean Laurent', success_contract: {}, agent_role: 'builder', workspace_id: s.ws.id } as never, 'owner').job;
  s.db.prepare("UPDATE jobs SET conversation_id = ?, outcome = 'blocked', updated_at = ? WHERE id = ?").run(d.id, new Date().toISOString(), blocked.id);
  const auto = mk('auto-2', { automatic: true, conversation_id: d.id });
  const one = await s.broker.call(cap(auto, ['create_job']), 'create_job', { kind: 'document.create', objective: 'Find another decision-maker and verify their address', agent_role: 'builder' }); assert.equal(one.ok, true, one.text);
  const two = await s.broker.call(cap(auto, ['create_job']), 'create_job', { kind: 'document.create', objective: 'and another', agent_role: 'builder' }); assert.equal(two.ok, false, 'only one follow-up per report');
});

test('one answer store: the team folder answers sync into the vault and "quota attainment" resolves; a stuck report with no alternatives is bounced; assistants see the team record', async () => {
  const { syncAnswerBank } = await import('../../src/memory/answer-sync.ts'); const { lookupAnswer } = await import('../../src/memory/answer-bank.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-'));
  const files: Record<string, string> = { 'application-answers.md': '- Quota attainment: 70% across all quarters\n- Stack rank: top 20% of the team\n' };
  const wrote = await syncAnswerBank(async (f) => files[path.basename(f)] ?? null, dir); assert.deepEqual(wrote, ['Application answers.md']);
  assert.match(lookupAnswer('What was your quota attainment last year?', dir)[0].text, /70% across all quarters/);
  assert.deepEqual(await syncAnswerBank(async (f) => files[path.basename(f)] ?? null, dir), [], 'unchanged files are not rewritten');
  const s = setup([{ kind: 'ok', text: "The hiring manager's address is still not verified, so the Acme follow-up stays unsent." }, { kind: 'ok', text: 'Tried the CEO and the CS team; found and verified one address.' }]); addAssistant(s, 'scout', 'Scout', 'Job boards');
  const team = s.chat.create({ workspace_id: s.ws.id, type: 'group', title: 'Job Hunters', members: ['coordinator', 'scout'] });
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const { job } = s.chat.send(d.id, 'Follow up with Acme', s.defs); assert.equal(await run(s, job.id), 'completed');
  const bounce = s.db.prepare('SELECT objective FROM jobs WHERE idempotency_key = ?').get(`engine:askback:${job.id}`) as { objective: string }; assert.ok(bounce, 'stuck report bounced'); assert.match(bounce.objective, /do not stop at the first blocked path/);
  assert.match(s.chat.groupContext(team.id, 'scout', 1e9), /From direct chat.* · You: Follow up with Acme/, 'the team record is in group context');
});

test('the stuck bounce cannot be slipped past: "no alternatives were found" and a login sentence elsewhere still bounce; naming a route tried passes', async () => {
  const s = setup([
    { kind: 'ok', text: 'No alternatives were found, so the Acme follow-up stays unsent.' }, { kind: 'ok', text: 'ok' },
    { kind: 'ok', text: "I couldn't sign in to the careers site. The hiring manager's address is unverified." }, { kind: 'ok', text: 'ok' },
    { kind: 'ok', text: "I tried the CEO via LinkedIn and the company site; there is still no public email for the hiring manager, so it stays unsent." }]);
  const d = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const bounced = async (text: string) => { const { job } = s.chat.send(d.id, text, s.defs); assert.equal(await run(s, job.id), 'completed'); const b = s.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(`engine:askback:${job.id}`) as { id: string } | undefined; if (b) assert.equal(await run(s, b.id), 'completed'); return !!b; };
  assert.equal(await bounced('Acme?'), true, '"no alternatives were found" is not an alternative');
  assert.equal(await bounced('The careers site and Acme?'), true, 'a login sentence exempts only itself');
  assert.equal(await bounced('Acme again?'), false, 'a reply naming the routes tried passes');
});
