// Builder plan step 5 (code.review) and the fix loop: every committed build gets an independent review on fable; FAIL re-queues the
// build on the same branch and worktree with the gaps; PASS is the deploy gate for that exact commit; five fix rounds, then a blocker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore, newId } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { ActionStore } from '../../src/actions/store.ts';
import { SimulatedRuntime } from '../../src/runtime/simulated.ts';
import { runJob, type RunDeps } from '../../src/worker/run.ts';
import { createLogger } from '../../src/log.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { reviewPassed, requeueBuild, MAX_FIX_ROUNDS } from '../../src/build/pipeline.ts';
import type { TurnRequest } from '../../src/runtime/types.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpipe-')); process.env.CLAUDEBOT_MEMORY_DIR = path.join(tmp, 'vault'); process.env.CLAUDEBOT_BUILD_LOCAL_ROOT = path.join(tmp, 'repos');
  const dir = path.join(tmp, 'origin'); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'greet.js'), "exports.greet = (n) => `Hello, ${n}`;\n");
  fs.writeFileSync(path.join(dir, 'test', 'greet.test.js'), "const { test } = require('node:test'); const assert = require('node:assert');\ntest('greets', () => assert.match(require('../greet.js').greet('Sam'), /Sam/));\n");
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const runtime = new SimulatedRuntime([]); const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const deps: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults(); const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Home' }, 'test');
  new ChatStore(db, store).create({ workspace_id: ws.id, type: 'group', members: ['coordinator', 'reviewer'] });
  db.prepare("INSERT INTO settings(key, value, updated_at, updated_by) VALUES ('build_repo', ?, ?, 'test')").run(JSON.stringify({ app: 'demo', url: dir }), new Date().toISOString());
  const wf = defs.getWorkflow('build.task')!;
  const build = (objective: string) => store.create({ idempotency_key: newId('k'), kind: 'build.task', objective, success_contract: wf.contract, agent_role: 'coordinator', workspace_id: ws.id, inputs: { change: objective } }).job;
  return { tmp, db, store, runtime, deps, defs, build, origin: dir };
}
/** Run queued work until `id` (or the newest job of a kind) is terminal. */
async function drain(s: ReturnType<typeof setup>, max = 30) { for (let i = 0; i < max; i++) { const l = s.store.lease({ owner: 'worker:test', leaseSeconds: 30, fair: true }); if (!l) return; await runJob(s.deps, l.id); } }
/** The simulated assistants: builds write greet.js (round n says "Hi n"), reviews write review.md with the verdict the test chooses. */
function assistants(s: ReturnType<typeof setup>, verdicts: string[]) {
  const seen: TurnRequest[] = [];
  const orig = s.runtime.startTurn.bind(s.runtime);
  s.runtime.startTurn = async (req) => {
    seen.push(req); const job = s.store.get(req.jobId)!;
    if (job.kind === 'build.task') fs.writeFileSync(path.join(req.cwd, 'greet.js'), `exports.greet = (n) => \`Hi ${seen.filter((r) => s.store.get(r.jobId)!.kind === 'build.task').length}, \${n}\`;\n`);
    if (job.kind === 'code.review') {
      const v = verdicts.shift() ?? 'PASS'; const f = path.join(req.cwd, 'review.md');
      fs.writeFileSync(f, v === 'PASS' ? 'Verdict: PASS\nThe greeting changed and the test still covers it.\n' : `Verdict: FAIL\n- Gap: greet.js: ${v}\n`);
      s.db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(newId('art'), job.id, 'review', 'file', f, 'x', 'review.md', '{}', new Date().toISOString());
      s.db.prepare("UPDATE jobs SET outcome = 'complete' WHERE id = ?").run(job.id);
    }
    return orig(req);
  };
  return seen;
}

test('step 5: a committed build gets an independent code review on fable; PASS is recorded for that exact commit (the deploy gate)', async () => {
  const s = setup(); const seen = assistants(s, ['PASS']); const b = s.build('Say Hi instead of Hello');
  await drain(s);
  assert.equal(s.store.get(b.id)!.state, 'completed');
  const rv = s.db.prepare("SELECT * FROM jobs WHERE kind = 'code.review'").get() as { id: string; state: string; inputs: string; depends_on: string; agent_role: string };
  assert.equal(rv.state, 'completed'); assert.deepEqual(JSON.parse(rv.depends_on), [b.id]); assert.equal(rv.agent_role, 'reviewer');
  const inp = JSON.parse(rv.inputs); assert.equal(inp.model, 'fable');
  const reviewTurn = seen.find((r) => r.jobId === rv.id)!; assert.equal(reviewTurn.model, 'fable', 'the review runs on fable'); assert.notEqual(reviewTurn.sessionRef, seen.find((r) => r.jobId === b.id)!.sessionRef, 'its own session');
  const ws = reviewTurn.cwd; assert.match(fs.readFileSync(path.join(ws, 'diff.patch'), 'utf8'), /\+exports\.greet = \(n\) => `Hi 1/); assert.ok(fs.readdirSync(path.join(ws, 'checks')).some((f) => /final-test-output/.test(f)));
  assert.equal(reviewPassed(s.db, inp.commit), true); assert.equal(reviewPassed(s.db, 'f'.repeat(40)), false, 'only that commit');
});

test('step 5: FAIL re-queues the build on the same branch and worktree with the gaps; the fix is reviewed again; PASS only for the fixed commit', async () => {
  const s = setup(); const seen = assistants(s, ['the greeting must keep a comma after the name', 'PASS']); const b = s.build('Say Hi instead of Hello');
  await drain(s);
  const builds = s.db.prepare("SELECT id, state, inputs, objective FROM jobs WHERE kind = 'build.task' ORDER BY created_at").all() as Array<{ id: string; state: string; inputs: string; objective: string }>;
  assert.equal(builds.length, 2); const fix = builds[1]; const fi = JSON.parse(fix.inputs);
  assert.equal(fi.build_root, b.id); assert.equal(fi.fix_round, 1); assert.match(fix.objective, /^Fix \(round 1\): Say Hi/); assert.equal(fix.state, 'completed');
  const fixTurn = seen.find((r) => r.jobId === fix.id)!; assert.match(fixTurn.prompt, /The independent code review FAILED it[\s\S]*the greeting must keep a comma after the name/);
  assert.equal(fi.worktree, JSON.parse((s.store.get(b.id)!).inputs).worktree, 'the same worktree'); assert.equal(fi.branch, `coordinator/${b.id}`, 'the same branch');
  const reviews = s.db.prepare("SELECT inputs FROM jobs WHERE kind = 'code.review' ORDER BY created_at").all() as Array<{ inputs: string }>;
  assert.equal(reviews.length, 2); const [c1, c2] = reviews.map((r) => JSON.parse(r.inputs).commit as string);
  assert.equal(reviewPassed(s.db, c1), false); assert.equal(reviewPassed(s.db, c2), true);
  const clone = path.join(process.env.CLAUDEBOT_BUILD_LOCAL_ROOT!, 'demo'); assert.equal(git(clone, 'rev-list', '--count', `main..coordinator/${b.id}`), '2', 'both commits on the one branch');
  const ws2 = seen.filter((r) => s.store.get(r.jobId)!.kind === 'code.review')[1].cwd;
  assert.notEqual(fs.readFileSync(path.join(ws2, 'review.md'), 'utf8'), fs.readFileSync(path.join(ws2, 'REQUEST.md'), 'utf8'), 'the brief and the verdict are separate files on a case-insensitive disk (macOS)');
  assert.match(fs.readFileSync(path.join(ws2, 'REQUEST.md'), 'utf8'), /Earlier rounds' gaps[\s\S]*comma after the name/);
  assert.match(fs.readFileSync(path.join(seen.filter((r) => s.store.get(r.jobId)!.kind === 'code.review')[1].cwd, 'diff.patch'), 'utf8'), /Hi 2/, 'the second review sees the whole change');
});

test('fix rounds stop at five with one blocker line; a review with no verdict or a FAIL without gaps fails the review itself', async () => {
  const s = setup(); assistants(s, []); const b = s.build('x');
  for (let i = 1; i <= MAX_FIX_ROUNDS; i++) assert.ok(requeueBuild(s.db, s.store, b.id, { source: 'ci', feedback: `red ${i}`, ref: `sha${i}` }), `round ${i}`);
  assert.equal(requeueBuild(s.db, s.store, b.id, { source: 'ci', feedback: 'red again', ref: 'sha6' }), null);
  const line = s.db.prepare("SELECT content FROM messages WHERE json_extract(meta, '$.alert_key') = ?").get(`build-cap:${b.id}`) as { content: string };
  assert.match(line.content, /still fails CI after 5 fix rounds; it stops here\. Last: red again/);
  assert.equal(requeueBuild(s.db, s.store, b.id, { source: 'ci', feedback: 'red', ref: 'sha1' }), null);
  const { DETERMINISTIC } = await import('../../src/worker/deterministic.ts');
  const rv = s.store.create({ idempotency_key: 'rv', kind: 'code.review', objective: 'r', success_contract: {}, agent_role: 'reviewer', inputs: { build_job: b.id, commit: 'a'.repeat(40) } }).job;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-')); const f = path.join(ws, 'review.md');
  const reg = () => s.db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(newId('art'), rv.id, 'review', 'file', f, 'x', 'review.md', '{}', new Date().toISOString());
  const run = () => DETERMINISTIC.verify_code_review({ db: s.db, store: s.store, job: s.store.get(rv.id)!, workspace: ws, previous: {}, actor: 'w' } as never);
  assert.match(((await run()) as { reason: string }).reason, /no review\.md/);
  fs.writeFileSync(f, 'Looks fine to me\n'); reg(); assert.match(((await run()) as { reason: string }).reason, /does not start with "Verdict/);
  fs.writeFileSync(f, 'Verdict: FAIL\nnot great\n'); assert.match(((await run()) as { reason: string }).reason, /names no gap/);
});
