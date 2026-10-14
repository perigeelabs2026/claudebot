// build.task (Abdul builder plan, step 1): the app's own repository cloned into the assistants' computer (here: a local root, as on
// Linux CI), a worktree per job on <lead>/<job-id>, the engine's test and typecheck checks, a commit on the branch; main never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
import { loadConfig } from '../../src/config.ts';
import type { Capability } from '../../src/broker/capabilities.ts';
import { failingTests, localShell, ensureClone } from '../../src/build/repo.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();

function origin(tmp: string): string {
  const dir = path.join(tmp, 'origin'); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'greet.js'), "exports.greet = (n) => `Hello, ${n}`;\n");
  fs.writeFileSync(path.join(dir, 'test', 'greet.test.js'), "const { test } = require('node:test'); const assert = require('node:assert');\nconst { greet } = require('../greet.js');\ntest('greets by name', () => { assert.match(greet('Sam'), /Sam/); });\ntest('greeting word', () => { assert.match(greet('Sam'), /^Hello/); });\n");
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); process.env.CLAUDEBOT_MEMORY_DIR = path.join(tmp, 'vault'); process.env.CLAUDEBOT_BUILD_LOCAL_ROOT = path.join(tmp, 'repos');
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const runtime = new SimulatedRuntime([]); const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const deps: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test');
  const chat = new ChatStore(db, store); const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  const url = origin(tmp); db.prepare("INSERT INTO settings(key, value, updated_at, updated_by) VALUES ('build_repo', ?, ?, 'test')").run(JSON.stringify({ app: 'demo', url }), new Date().toISOString());
  return { tmp, db, store, runtime, deps, defs, ws, chat, broker, url };
}
const cap = (job: { id: string; agent_role: string }, tools: string[], workspace = '/tmp'): Capability => ({ token: 't', job_id: job.id, role: job.agent_role, workspace, tools, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
async function delegate(s: ReturnType<typeof setup>, objective: string, model?: string) {
  const c = s.chat.create({ workspace_id: s.ws.id }); const turn = s.chat.send(c.id, `Abdul, ${objective}`, s.defs).job;
  const r = await s.broker.call(cap(turn, ['create_job']), 'create_job', { kind: 'build.task', objective, ...(model ? { model } : {}) }); assert.equal(r.ok, true, r.text);
  s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(turn.id);
  return s.db.prepare("SELECT * FROM jobs WHERE kind = 'build.task' ORDER BY created_at DESC LIMIT 1").get() as { id: string; agent_role: string; inputs: string };
}
async function runAll(s: ReturnType<typeof setup>, id: string) { for (let i = 0; i < 6; i++) { const j = s.store.get(id)!; if (['completed', 'failed_terminal', 'cancelled'].includes(j.state)) return j; const l = s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true }); if (!l) return j; assert.equal(l.id, id); await runJob(s.deps, id); } return s.store.get(id)!; }

test('step 1: a build task changes one string on its own branch <lead>/<job-id> in the clone; tests and typecheck run; main is untouched; the task runs on its own model', async () => {
  const s = setup(); const job = await delegate(s, 'change the greeting word to Hi', 'fable');
  assert.equal(job.agent_role, 'coordinator', 'the lead is the default assistant'); assert.equal(JSON.parse(job.inputs).model, 'fable');
  const turns: Array<{ cwd: string; model?: string; prompt: string }> = []; const orig = s.runtime.startTurn.bind(s.runtime);
  s.runtime.startTurn = async (req) => { turns.push({ cwd: req.cwd, model: req.model, prompt: req.prompt });
    fs.writeFileSync(path.join(req.cwd, 'greet.js'), "exports.greet = (n) => `Hi, ${n}`;\n");
    fs.writeFileSync(path.join(req.cwd, 'test', 'greet.test.js'), fs.readFileSync(path.join(req.cwd, 'test', 'greet.test.js'), 'utf8').replace('/^Hello/', '/^Hi/'));
    return orig(req); };
  const done = await runAll(s, job.id);
  assert.equal(done.state, 'completed', JSON.stringify(s.db.prepare('SELECT type, detail FROM job_events WHERE job_id = ? ORDER BY seq').all(job.id)).slice(-1500));
  const clone = path.join(process.env.CLAUDEBOT_BUILD_LOCAL_ROOT!, 'demo'); const wt = path.join(process.env.CLAUDEBOT_BUILD_LOCAL_ROOT!, 'demo-worktrees', job.id);
  assert.equal(turns[0].cwd, wt, 'the turn works in the worktree'); assert.equal(turns[0].model, 'fable', 'on the task\'s own model');
  const branch = `coordinator/${job.id}`;
  assert.equal(git(wt, 'symbolic-ref', '--short', 'HEAD'), branch);
  assert.match(git(clone, 'show', `${branch}:greet.js`), /Hi, /, 'the change is committed on the branch');
  assert.match(git(clone, 'show', 'main:greet.js'), /Hello, /, 'main is untouched'); assert.match(git(s.url, 'show', 'main:greet.js'), /Hello, /, 'origin is untouched (nothing pushed)');
  assert.equal(git(clone, 'rev-parse', 'main'), git(s.url, 'rev-parse', 'main'));
  assert.deepEqual(git(clone, 'diff', '--name-only', 'main', branch).split('\n').sort(), ['greet.js', 'test/greet.test.js']);
  const ev = (t: string) => s.db.prepare('SELECT detail FROM job_events WHERE job_id = ? AND type = ?').all(job.id, t) as Array<{ detail: string }>;
  assert.ok(ev('command.ran').some((e) => /npm test/.test(e.detail)), 'the engine ran the tests'); assert.ok(ev('build.committed').length === 1);
  assert.equal(git(clone, 'remote', 'get-url', '--push', 'origin'), 'no-push-from-build-jobs', 'the clone cannot push');
  // main is never writable: a commit on main in the clone is refused by its hooks, and so is moving refs/heads/main.
  fs.writeFileSync(path.join(clone, 'x.txt'), 'x'); git(clone, 'add', 'x.txt');
  assert.throws(() => git(clone, 'commit', '-q', '-m', 'sneak'), /not allowed/); assert.throws(() => git(clone, 'update-ref', 'refs/heads/main', branch), /read-only/);
  // The lead's own chat stays on its own model.
  assert.notEqual(s.defs.getAgent('coordinator')!.model, 'fable');
});

test('step 1: a failing test fails the build task and names the test; nothing is committed', async () => {
  const s = setup(); const job = await delegate(s, 'make the greeting shout');
  const orig = s.runtime.startTurn.bind(s.runtime);
  s.runtime.startTurn = async (req) => { fs.writeFileSync(path.join(req.cwd, 'greet.js'), "exports.greet = (n) => `HEY ${n}`;\n"); return orig(req); };
  const done = await runAll(s, job.id);
  assert.equal(done.state, 'failed_terminal'); const detail = JSON.stringify(s.store.get(job.id));
  assert.match(detail, /greeting word/, 'the failing test is named'); assert.doesNotMatch(detail, /greets by name"/, 'only the failing test');
  const clone = path.join(process.env.CLAUDEBOT_BUILD_LOCAL_ROOT!, 'demo');
  assert.equal(git(clone, 'rev-parse', `coordinator/${job.id}`), git(clone, 'rev-parse', 'main'), 'nothing committed on the branch');
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'build.checks_failed'").get(job.id));
});

test('step 1: run_project_check runs test and typecheck in the build worktree only; create_job refuses a model that is not an alias; the token never leaves the shell', async () => {
  const s = setup(); const job = await delegate(s, 'check things');
  const c = s.chat.create({ workspace_id: s.ws.id }); const turn = s.chat.send(c.id, 'x', s.defs).job;
  const bad = await s.broker.call(cap(turn, ['create_job']), 'create_job', { kind: 'build.task', objective: 'y', model: 'gpt-5' }); assert.equal(bad.ok, false); assert.match(bad.text, /alias/);
  const none = await s.broker.call(cap(job, ['run_project_check']), 'run_project_check', { profile: 'test' }); assert.equal(none.ok, false, 'no worktree yet');
  const sh = localShell(process.env.CLAUDEBOT_BUILD_LOCAL_ROOT!); fs.mkdirSync(path.dirname(sh.tokenFile), { recursive: true }); fs.writeFileSync(sh.tokenFile, 'ghp_' + 'a'.repeat(36), { mode: 0o600 });
  const cl = await ensureClone(sh, { app: 'demo', url: s.url }); assert.equal(cl.ok, true, JSON.stringify(cl));
  const { prepareWorktree } = await import('../../src/build/repo.ts'); const w = await prepareWorktree(sh, { app: 'demo', url: s.url }, job.id, 'coordinator'); assert.ok(w.ok);
  s.db.prepare('UPDATE jobs SET inputs = ? WHERE id = ?').run(JSON.stringify({ worktree: (w as { dir: string }).dir, repo_where: 'local', branch: (w as { branch: string }).branch }), job.id);
  const ws = path.join(s.tmp, 'turn'); fs.mkdirSync(ws, { recursive: true });
  const t = await s.broker.call(cap(job, ['run_project_check'], ws), 'run_project_check', { profile: 'test' }); assert.equal(t.ok, true, t.text); assert.match(t.text, /npm test: passed/);
  const lint = await s.broker.call(cap(job, ['run_project_check'], ws), 'run_project_check', { profile: 'lint' }); assert.equal(lint.ok, false); assert.match(lint.text, /test and typecheck/);
  const tc = await s.broker.call(cap(job, ['run_project_check'], ws), 'run_project_check', { profile: 'typecheck' }); assert.equal(tc.ok, false); assert.match(tc.text, /not run/);
  const all = JSON.stringify(s.db.prepare('SELECT detail FROM job_events').all()) + fs.readdirSync(ws).map((f) => fs.readFileSync(path.join(ws, f), 'utf8')).join('');
  assert.ok(!all.includes('a'.repeat(36)), 'the token is in no event or output');
});

test('failingTests reads node --test spec and TAP output', () => {
  assert.deepEqual(failingTests('✔ greets by name (0.5ms)\n✖ greeting word (1.2ms)\nℹ fail 1\n✖ failing tests:\n\ntest at test/greet.test.js:4:1\n✖ greeting word (1.2ms)\n'), ['greeting word']);
  assert.deepEqual(failingTests('not ok 2 - greeting word\n  ---\nnot ok 1 - test/greet.test.js\n'), ['greeting word']);
});
