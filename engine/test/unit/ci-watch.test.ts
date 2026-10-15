// Builder plan step 7: CI watch. Red re-queues the change on its branch with the failing log (once per head commit), green posts one
// line, merged/closed ends the watch, five fix rounds then stop. Read-only on GitHub (a fake gh here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { watchPr, ciTick, watches, ghCli, CI_EVERY_MS, type PrStatus, type GhReader } from '../../src/build/ci-watch.ts';

function setup() {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'))).create({ name: 'Home' }, 't');
  const chat = new ChatStore(db, store); const team = chat.create({ workspace_id: ws.id, type: 'group', members: ['coordinator', 'reviewer'] });
  const build = store.create({ idempotency_key: 'b1', kind: 'build.task', objective: 'Rename Work to Tasks', success_contract: {}, agent_role: 'coordinator', workspace_id: ws.id, inputs: { change: 'rename', model: 'fable', branch: 'coordinator/b1' } }).job;
  let status: PrStatus = { state: 'OPEN', head: 'a'.repeat(40), checks: [{ name: 'ubuntu', state: 'pending' }] }; const logsAsked: string[] = [];
  const gh: GhReader = { prStatus: async () => status, failedLog: async (_r, id) => { logsAsked.push(id); return `noise\nnot ok 3 - renames the Work screen\n  expected "Tasks"\n  got "Work"`; } };
  return { db, store, chat, team, build, gh, set: (s: PrStatus) => { status = s; }, logsAsked };
}

test('step 7: pending waits; red re-queues the change with the failing log once per head; green posts one line; merged ends the watch', async () => {
  const s = setup(); let t = Date.now();
  watchPr(s.db, s.store, { repo: 'perigee/app', pr: 12, branch: 'coordinator/b1', build_job: s.build.id });
  assert.deepEqual((await ciTick(s.db, s.store, s.gh, t)).map((r) => r.result), ['pending']);
  assert.deepEqual(await ciTick(s.db, s.store, s.gh, t + 1000), [], 'read at most every 5 minutes');
  s.set({ state: 'OPEN', head: 'b'.repeat(40), checks: [{ name: 'ubuntu', state: 'failure', run_id: '991' }, { name: 'macos', state: 'success' }] });
  t += CI_EVERY_MS; const r = await ciTick(s.db, s.store, s.gh, t); assert.match(r[0].result, /^red: fix job-/);
  const fix = s.db.prepare("SELECT inputs, objective FROM jobs WHERE kind = 'build.task' AND id != ?").get(s.build.id) as { inputs: string; objective: string };
  const fi = JSON.parse(fix.inputs); assert.equal(fi.build_root, s.build.id); assert.equal(fi.fix_source, 'ci'); assert.equal(fi.model, 'fable');
  assert.match(fi.feedback_note, /CI failed on the pushed branch[\s\S]*Failing checks on perigee\/app#12 at bbbbbbb: ubuntu[\s\S]*not ok 3 - renames the Work screen/);
  assert.deepEqual(s.logsAsked, ['991']);
  t += CI_EVERY_MS; assert.deepEqual((await ciTick(s.db, s.store, s.gh, t)).map((x) => x.result), ['unchanged'], 'the same red head is handled once');
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'build.task'").get() as { n: number }).n, 2);
  s.set({ state: 'OPEN', head: 'c'.repeat(40), checks: [{ name: 'ubuntu', state: 'success' }, { name: 'macos', state: 'success' }] });
  t += CI_EVERY_MS; assert.deepEqual((await ciTick(s.db, s.store, s.gh, t)).map((x) => x.result), ['green']);
  t += CI_EVERY_MS; assert.deepEqual((await ciTick(s.db, s.store, s.gh, t)).map((x) => x.result), ['unchanged'], 'one green line per head');
  assert.equal(s.chat.messages(s.team.id).filter((m) => /CI is green on perigee\/app#12 \(coordinator\/b1\) at ccccccc/.test(m.content)).length, 1);
  s.set({ state: 'MERGED', head: 'c'.repeat(40), checks: [] });
  t += CI_EVERY_MS; assert.deepEqual((await ciTick(s.db, s.store, s.gh, t)).map((x) => x.result), ['merged']); assert.equal(watches(s.db)[0].status, 'done');
  t += CI_EVERY_MS; assert.deepEqual(await ciTick(s.db, s.store, s.gh, t), [], 'a finished watch is not read again');
});

test('step 7: red after five fix rounds stops the watch with one blocker line; a bad repo or unknown build is refused; gh output is parsed', async () => {
  const s = setup(); let t = Date.now(); watchPr(s.db, s.store, { repo: 'perigee/app', pr: 3, branch: 'b', build_job: s.build.id });
  for (let i = 0; i < 6; i++) { s.set({ state: 'OPEN', head: String(i).repeat(40), checks: [{ name: 'ubuntu', state: 'failure' }] }); t += CI_EVERY_MS; await ciTick(s.db, s.store, s.gh, t); }
  assert.equal(watches(s.db)[0].status, 'stopped'); assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'build.task'").get() as { n: number }).n, 6);
  assert.equal(s.chat.messages(s.team.id).filter((m) => /still fails CI after 5 fix rounds/.test(m.content)).length, 1);
  assert.throws(() => watchPr(s.db, s.store, { repo: 'not a repo', pr: 1, branch: 'b', build_job: s.build.id }), /owner\/name/);
  assert.throws(() => watchPr(s.db, s.store, { repo: 'a/b', pr: 1, branch: 'b', build_job: 'job-nope' }), /no build task/);
  // The real reader maps gh's statusCheckRollup (fake gh on PATH).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-')); fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '{"state":"OPEN","headRefOid":"${'d'.repeat(40)}","statusCheckRollup":[{"__typename":"CheckRun","name":"ubuntu","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/a/b/actions/runs/123/job/9"},{"__typename":"CheckRun","name":"macos","status":"IN_PROGRESS","conclusion":""},{"__typename":"StatusContext","context":"lint","state":"SUCCESS"}]}'\n`, { mode: 0o755 });
  const old = process.env.PATH; process.env.PATH = `${bin}:${old}`;
  try { const st = await ghCli.prStatus('a/b', 1); assert.deepEqual(st.checks, [{ name: 'ubuntu', state: 'failure', run_id: '123' }, { name: 'macos', state: 'pending', run_id: null }, { name: 'lint', state: 'success', run_id: null }]); }
  finally { process.env.PATH = old; }
});
