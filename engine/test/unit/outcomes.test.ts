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
import { BrokerApi } from '../../src/broker/api.ts';
import { issueCapability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';
import { workbenchSnapshot } from '../../src/model/workbench.ts';
import { ChatStore } from '../../src/chat/store.ts';

function setup(scripts: ConstructorParameters<typeof SimulatedRuntime>[0] = []) {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-')); const runtime = new SimulatedRuntime(scripts);
  const closed: string[] = []; (runtime as unknown as { closeSession: (r: string) => Promise<void> }).closeSession = async (r) => { closed.push(r); };
  const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const deps: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults(); const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'P' }, 'test');
  const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  return { db, store, deps, defs, ws, runtime, broker, tmp, closed };
}
function task(s: ReturnType<typeof setup>, kind: string, objective = 'o', extra: Record<string, unknown> = {}) { const wf = s.defs.getWorkflow(kind)!; const { job } = s.store.create({ idempotency_key: `k-${kind}-${Math.random()}`, kind, objective, success_contract: wf.contract, agent_role: wf.default_agent, workspace_id: s.ws.id, ...extra }); return job; }
function fileArtifact(s: ReturnType<typeof setup>, jobId: string, name: string, text: string) { const file = path.join(s.deps.workspacesDir, s.ws.id, 'tasks', jobId, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, created_at) VALUES (?, ?, 'x', 'file', ?, ?, ?, ?)").run('a-' + Math.random(), jobId, file, require_sha(text), name, new Date().toISOString()); s.db.prepare("UPDATE jobs SET outcome = COALESCE(outcome, 'success') WHERE id = ?").run(jobId); return file; }
function require_sha(t: string) { return (globalThis as unknown as { __crypto?: typeof import('node:crypto') }).__crypto?.createHash('sha256').update(t).digest('hex') ?? ''; }
const crypto = await import('node:crypto'); (globalThis as unknown as { __crypto: typeof crypto }).__crypto = crypto;
function evidence(s: ReturnType<typeof setup>, jobId: string) { s.db.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES (?, ?, 't', 'b', 'https://example.com/', 'B', ?)").run('ev-' + Math.random(), jobId, new Date().toISOString()); }

test('a read blocked by a sign-in wall pauses for owner takeover (browser:<site>), closes its session and keeps progress; a blocked read for another reason ends as Blocked with the reason', async () => {
  const s = setup([{ kind: 'ok', text: 'DONE' }, { kind: 'ok', text: 'DONE' }]);
  const j1 = task(s, 'browser.read_task', 'Read https://www.linkedin.com/feed/'); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  const cap1 = issueCapability(s.deps.runDir, j1, path.join(s.tmp, 'w1'), s.defs.getAgent('browser_operator')!.allowed_tools);
  await s.broker.call(cap1, 'report_outcome', { status: 'blocked', reason: 'LinkedIn redirected to its sign-in page.', block_kind: 'login', site: 'www.linkedin.com' });
  assert.equal(await runJob(s.deps, j1.id), 'paused');
  const a = s.store.get(j1.id)!; assert.equal(a.state, 'waiting_for_auth'); assert.equal(a.waiting_on, 'browser:linkedin.com'); assert.match(String(a.operator_action), /Take over the ClaudeBot browser/); assert.equal(a.outcome, 'blocked');
  assert.equal(a.session_ref, null, 'session released while waiting'); assert.equal(s.closed.length, 1);
  assert.ok(s.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE job_id = ?').get(j1.id)!.n as number >= 2);
  const j2 = task(s, 'browser.read_task', 'Read https://slow.example/'); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  const cap2 = issueCapability(s.deps.runDir, j2, path.join(s.tmp, 'w2'), s.defs.getAgent('browser_operator')!.allowed_tools);
  await s.broker.call(cap2, 'report_outcome', { status: 'blocked', reason: 'The page never finished loading.', block_kind: 'timeout', remaining: 'everything', alternatives_tried: [{ route: 'reloaded the page', result: 'timed out again' }, { route: 'the cached copy and the company press page', result: 'not available' }] });
  assert.equal(await runJob(s.deps, j2.id), 'failed');
  const b = s.store.get(j2.id)!; assert.equal(b.state, 'failed_terminal'); assert.equal(b.blocker_code, 'BLOCKED'); assert.match(String(b.operator_action), /could not be done.*timeout/);
});

test('a findings file alone is not success: the contract fails when no outcome was reported; partial completes as Partial result with what remains', async () => {
  const s = setup([{ kind: 'ok', text: 'DONE' }, { kind: 'ok', text: 'DONE' }]);
  const j1 = task(s, 'browser.read_task', 'Read https://example.com/'); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  fileArtifact(s, j1.id, 'findings.md', 'Status: BLOCKED'); evidence(s, j1.id); s.db.prepare('UPDATE jobs SET outcome = NULL WHERE id = ?').run(j1.id);   // the assistant never reported
  assert.equal(await runJob(s.deps, j1.id), 'failed'); const a = s.store.get(j1.id)!; assert.equal(a.blocker_code, 'CONTRACT_UNMET'); assert.match(String(a.failure_detail), /did not report whether/);
  const j2 = task(s, 'browser.read_task', 'Read two pages'); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  fileArtifact(s, j2.id, 'findings.md', 'Page 1 read; page 2 unavailable'); evidence(s, j2.id);
  const cap = issueCapability(s.deps.runDir, j2, path.join(s.tmp, 'w'), s.defs.getAgent('browser_operator')!.allowed_tools);
  await s.broker.call(cap, 'report_outcome', { status: 'partial', reason: 'One of two pages read.', remaining: 'page 2 returned 503' });
  assert.equal(await runJob(s.deps, j2.id), 'completed'); const b = s.store.get(j2.id)!; assert.equal(b.outcome, 'partial');
  const chat = new ChatStore(s.db, s.store); const conv = chat.create({ workspace_id: s.ws.id }); s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conv.id, j2.id);
  chat.sync(s.defs); const card = chat.messages(conv.id).find((m) => m.kind === 'result')!; assert.match(card.content, /finished part of/); assert.match(card.content, /Still unavailable: page 2 returned 503/); assert.equal(card.meta.outcome, 'partial');
  assert.equal(workbenchSnapshot(s.db).tasks.find((t) => t.id === j2.id)!.plain_state, 'Partial result');
});

test('dependencies: the lead chains tasks with depends_on; the later task waits ("waiting on another assistant") and receives the earlier outputs and evidence in its prompt', async () => {
  const s = setup([{ kind: 'ok', text: 'DONE' }, { kind: 'ok', text: 'DONE' }]);
  const chat = new ChatStore(s.db, s.store); const conv = chat.create({ workspace_id: s.ws.id }); const { job: turn } = chat.send(conv.id, 'research then draft', s.defs);
  const lead = issueCapability(s.deps.runDir, turn, s.tmp, s.defs.getAgent('coordinator')!.allowed_tools, 3600, conv.id);
  const r1 = await s.broker.call(lead, 'create_job', { kind: 'research.report', objective: 'Find facts' }); const researchId = (r1.data as { id: string }).id;
  const r2 = await s.broker.call(lead, 'create_job', { kind: 'document.create', objective: 'Draft the offer from the research', depends_on: [researchId] }); const draftId = (r2.data as { id: string }).id;
  assert.match(r2.text, /waiting for/); assert.deepEqual(JSON.parse(s.store.get(draftId)!.depends_on), [researchId]);
  const bad = await s.broker.call(lead, 'create_job', { kind: 'document.create', objective: 'x', depends_on: ['job-nope'] }); assert.equal(bad.ok, false);
  const snap = workbenchSnapshot(s.db); const d = snap.tasks.find((t) => t.id === draftId)!; assert.equal(d.status, 'blocked_on'); assert.equal(d.waiting_on_tasks[0].id, researchId); assert.equal(d.waiting_on_tasks[0].assistant, 'Researcher');
  assert.equal(s.store.lease({ owner: 'worker:test', leaseSeconds: 30, respectGovernor: false })?.id, turn.id, 'the chat turn leases first'); s.store.transition(turn.id, 'cancelled', 'test');
  assert.equal(s.store.lease({ owner: 'worker:test', leaseSeconds: 30 })?.id, researchId, 'the dependent task is not leased before its dependency');
  fileArtifact(s, researchId, 'report.md', '# Findings\n\nTide pools host anemones.'); evidence(s, researchId);
  const cap = issueCapability(s.deps.runDir, s.store.get(researchId)!, s.tmp, s.defs.getAgent('researcher')!.allowed_tools); await s.broker.call(cap, 'report_outcome', { status: 'complete', reason: 'done' });
  assert.equal(await runJob(s.deps, researchId), 'completed');
  assert.equal(s.store.lease({ owner: 'worker:test', leaseSeconds: 30 })?.id, draftId);
  fileArtifact(s, draftId, 'offer.md', 'offer');
  assert.equal(await runJob(s.deps, draftId), 'completed');
  const prompt = s.runtime.history.find((h) => h.jobId === draftId)!.prompt;
  assert.match(prompt, /Inputs from earlier tasks you depend on/); assert.match(prompt, /Tide pools host anemones/); assert.match(prompt, /Evidence:/); assert.match(prompt, /Outcome: success/);
});

test('bounded code task: the engine runs node --test in the repository, saves the output as a file, and reports pass/fail without giving Claude a shell', { skip: process.platform !== 'darwin' && 'needs macOS sandbox-exec' }, async () => {
  const s = setup([{ kind: 'ok', text: 'DONE' }]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-')); fs.writeFileSync(path.join(repo, 'sum.test.js'), "const t=require('node:test');const a=require('node:assert');t('adds',()=>a.equal(1+1,2));");
  const j = task(s, 'code.task', 'Add a sum function', { inputs: { repository: repo, change: 'add' } }); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  fileArtifact(s, j.id, 'CHANGES.md', 'changed');
  assert.equal(await runJob(s.deps, j.id), 'completed');
  const d = s.store.get(j.id)!; assert.equal(d.outcome, 'success');
  const out = s.db.prepare("SELECT title, path FROM artifacts WHERE job_id = ? AND title LIKE 'Final %'").get(j.id) as { title: string; path: string }; assert.match(out.title, /passed/); assert.match(fs.readFileSync(out.path, "utf8"), /pass 1/);
  const last = s.db.prepare('SELECT payload FROM checkpoints WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(j.id) as { payload: string }; assert.match(last.payload, /"test_result":"pass"/);
  // failing tests → partial, not success
  fs.writeFileSync(path.join(repo, 'sum.test.js'), "const t=require('node:test');const a=require('node:assert');t('adds',()=>a.equal(1+1,3));");
  s.runtime.push({ kind: 'ok', text: 'DONE' }); const j2 = task(s, 'code.task', 'Break it', { inputs: { repository: repo, change: 'x' } }); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 }); fileArtifact(s, j2.id, 'CHANGES.md', 'c');
  assert.equal(await runJob(s.deps, j2.id), 'completed'); assert.equal(s.store.get(j2.id)!.outcome, 'partial');
  const disallowed = task(s, 'code.task', 'x', { inputs: { repository: repo, change: 'x', test_command: 'rm -rf /' } }); s.runtime.push({ kind: 'ok', text: 'DONE' }); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 }); fileArtifact(s, disallowed.id, 'CHANGES.md', 'c');
  // Changed 7 Oct (installed finding): an unknown test_command is never executed and no longer fails the finished work; the default checks run and the note says so.
  assert.equal(await runJob(s.deps, disallowed.id), 'completed'); const dd = s.store.get(disallowed.id)!; assert.match(String(dd.outcome_detail), /not a known check; ran the default/); assert.ok(fs.existsSync(repo), 'the repository is untouched by the rejected string');
});

test('cut-off continuation: a second attempt on a bound session tells the assistant to continue without duplicating saved files', async () => {
  const s = setup([{ kind: 'hang' }, { kind: 'ok', text: 'DONE' }]);
  const j = task(s, 'document.create', 'Long doc'); s.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  const p1 = runJob({ ...s.deps }, j.id); await new Promise((r) => setTimeout(r, 1200)); s.store.transition(j.id, 'cancelled', 'owner'); await p1;
  s.db.prepare("UPDATE jobs SET state = 'queued', lease_owner = NULL, stage_attempt = 1 WHERE id = ?").run(j.id);   // simulate a retry after a cut-off with the session kept
  s.db.prepare('UPDATE jobs SET session_ref = ? WHERE id = ?').run('sim-' + j.id, j.id);
  s.store.lease({ owner: 'worker:test', leaseSeconds: 30 }); fileArtifact(s, j.id, 'doc.md', 'x');
  assert.equal(await runJob(s.deps, j.id), 'completed');
  assert.match(s.runtime.history[1].prompt, /previous attempt at this step was interrupted/);
});
