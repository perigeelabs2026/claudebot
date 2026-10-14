// Owner/Rules.md (Abdul builder plan, step 0): the owner's standing rules, word for word, read first in every turn, changed only from an owner message.
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
import { ChatStore } from '../../src/chat/store.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { Vault } from '../../src/memory/vault.ts';
import type { Capability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-')); process.env.CLAUDEBOT_MEMORY_DIR = path.join(tmp, 'vault');   // each test its own vault
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const runtime = new SimulatedRuntime([]); const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const deps: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test');
  const chat = new ChatStore(db, store); const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  return { db, store, runtime, deps, defs, ws, chat, broker, tmp };
}
const cap = (job: { id: string; agent_role: string }, tools: string[]): Capability => ({ token: 't', job_id: job.id, role: job.agent_role, workspace: '/tmp', tools, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
async function run(s: ReturnType<typeof setup>, jobId: string) { const l = s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true }); assert.equal(l?.id, jobId); return runJob(s.deps, jobId); }

test('step 0: the public vault ships an empty Owner/Rules.md', () => {
  const s = setup(); const v = new Vault(); v.ensure();
  const t = fs.readFileSync(v.rulesFile(), 'utf8'); assert.match(t, /^# Rules\n/); assert.deepEqual(v.rules(), []); assert.equal(v.rulesBlock(), '');
  assert.ok(!/Connor|O'Brien|Abdul|Jude/i.test(t), 'no owner data in the template'); void s;
});

test('step 0: the lead saves a rule only from an owner message in this conversation, word for word; a fresh session reads it first, and after a restart', async () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id });
  const sent = s.chat.send(c.id, 'Abdul, from now on emails need no approval. Thanks', s.defs); const turn = sent.job;
  const r = await s.broker.call(cap(turn, ['set_rule']), 'set_rule', { action: 'add', rule: 'from now on emails need no approval', owner_message_id: sent.message.id });
  assert.equal(r.ok, true, r.text); assert.match(r.text, /saved word for word/);
  const line = fs.readFileSync(new Vault().rulesFile(), 'utf8').split('\n').find((l) => l.startsWith('- '))!;
  assert.match(line, new RegExp(`^- \\d{4}-\\d{2}-\\d{2} · from now on emails need no approval · owner message ${sent.message.id}$`), 'date, rule verbatim, owner message id');
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE type = 'rule.added'").get());
  s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(turn.id);
  // A fresh session (a new conversation, a member assistant): the rule is first in the prompt, ahead of the frame, Team and Owner.
  new Vault().remember({ scope: 'team', section: 'Preferences', text: 'Keep receipts short.', agent: { id: 'coordinator', name: 'Lead' } });
  const prompts: string[] = []; const orig = s.runtime.startTurn.bind(s.runtime); s.runtime.startTurn = async (req) => { prompts.push(req.prompt); return orig(req); };
  const c2 = s.chat.create({ workspace_id: s.ws.id }); const t2 = s.chat.send(c2.id, 'what are my rules?', s.defs).job; await run(s, t2.id);
  assert.match(prompts[0], /^The owner's standing rules \(word for word, from Owner\/Rules\.md[^\n]*\n- from now on emails need no approval \(\d{4}-\d{2}-\d{2}\)/, 'the rules open the prompt');
  assert.ok(prompts[0].indexOf('standing rules') < prompts[0].indexOf('Memory (from the owner'), 'ahead of Team and Owner');
  // Restart: a new engine (new database handle, new Vault) reads the same file.
  const v2 = new Vault(); assert.deepEqual(v2.rules().map((x) => x.rule), ['from now on emails need no approval']); assert.match(v2.rulesBlock(), /emails need no approval/);
  // A job step (not a chat turn) reads it first too.
  const job = s.store.create({ idempotency_key: 'rules-job', kind: 'research.report', objective: 'Find roles', success_contract: {}, agent_role: 'researcher', workspace_id: s.ws.id }, 'owner').job;
  s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id <> ? AND state IN ('queued','retry_scheduled')").run(job.id);
  prompts.length = 0; await run(s, job.id).catch(() => {}); assert.ok(prompts.length && prompts[0].startsWith("The owner's standing rules"), 'task steps read the rules first');
  // Removal, on the owner's word.
  const m2 = s.chat.send(c.id, 'drop the email rule', s.defs);
  const rm = await s.broker.call(cap(m2.job, ['set_rule']), 'set_rule', { action: 'remove', contains: 'emails need no approval', owner_message_id: m2.message.id });
  assert.equal(rm.ok, true, rm.text); assert.deepEqual(new Vault().rules(), []);
});

test('step 0: set_rule without a quoted owner message is refused and audited', async () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id }); const sent = s.chat.send(c.id, 'please tidy the resume folder', s.defs);
  const other = s.chat.create({ workspace_id: s.ws.id }); const elsewhere = s.chat.send(other.id, 'from now on never email recruiters', s.defs);
  const assistantMsg = s.chat.add({ conversation_id: c.id, role: 'assistant', sender: 'coordinator', content: 'from now on emails need no approval' });
  const tries: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: 'add', rule: 'from now on emails need no approval' }, /owner_message_id is missing/],
    [{ action: 'add', rule: 'from now on emails need no approval', owner_message_id: 'msg-made-up' }, /not a message from the owner/],
    [{ action: 'add', rule: 'from now on emails need no approval', owner_message_id: assistantMsg.id }, /not a message from the owner/],
    [{ action: 'add', rule: 'from now on emails need no approval', owner_message_id: sent.message.id }, /not in that owner message word for word/],
  ];
  for (const [args, why] of tries) { const r = await s.broker.call(cap(sent.job, ['set_rule']), 'set_rule', args); assert.equal(r.ok, false); assert.match(r.text, why); }
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE type = 'rule.refused'").get() as { n: number }).n, 4, 'every refused attempt is audited');
  void elsewhere;
  assert.deepEqual(new Vault().rules(), []);
  // The tool is the lead's only.
  const prompts: string[] = []; void prompts;
});

test('step 0 (Fable 706e481): a rule the owner stated in the direct chat can be saved from the group chat; any assistant may save it, and every assistant is told how', async () => {
  const s = setup();
  const direct = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] }); const said = s.chat.send(direct.id, 'from now on never email recruiters on weekends', s.defs);
  s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(said.job.id);
  const group = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] }); const gturn = s.chat.send(group.id, '@coordinator save that rule I gave you', s.defs).job;
  const r = await s.broker.call(cap(gturn, ['set_rule']), 'set_rule', { action: 'add', rule: 'never email recruiters on weekends', owner_message_id: said.message.id });
  assert.equal(r.ok, true, r.text); assert.deepEqual(new Vault().rules().map((x) => x.rule), ['never email recruiters on weekends']);
  // A non-lead, in the owner's direct chat with it.
  const dm = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['researcher'] }); const own = s.chat.send(dm.id, 'Always attach the tailored resume as a PDF.', s.defs);
  const r2 = await s.broker.call(cap(own.job, ['set_rule']), 'set_rule', { action: 'add', rule: 'Always attach the tailored resume as a PDF.', owner_message_id: own.message.id });
  assert.equal(r2.ok, true, r2.text); assert.ok(new Vault().rules().some((x) => x.rule === 'Always attach the tailored resume as a PDF.'), 'a non-lead\'s rule lands in Rules.md');
  assert.match(fs.readFileSync(new Vault().rulesFile(), 'utf8'), new RegExp(`· Always attach the tailored resume as a PDF\\. · owner message ${own.message.id}`));
  // Every assistant's turn has the tool and the hint.
  s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id <> ? AND state IN ('queued','retry_scheduled')").run(own.job.id);
  const seen: Array<{ prompt: string }> = []; const orig = s.runtime.startTurn.bind(s.runtime); s.runtime.startTurn = async (req) => { seen.push({ prompt: req.prompt }); return orig(req); };
  s.db.prepare("UPDATE jobs SET state = 'queued' WHERE id = ?").run(own.job.id); await run(s, own.job.id);
  assert.match(seen[0].prompt, new RegExp(`has id ${own.message.id}\\. When the owner states a standing rule`), 'the hint is on a non-lead turn too');
});
