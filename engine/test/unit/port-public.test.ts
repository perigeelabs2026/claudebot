// Builder plan step 8: port.public. A private range, renamed, applied on port/<job> in the public clone, scrubbed (one hit fails it and
// nothing is committed), tested, committed; never pushed here. The owner data in this test is invented.
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
import { scrubDiff, applyRename, type PortSettings } from '../../src/port/public.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
const S = (over: Partial<PortSettings> = {}): PortSettings => ({ source: '/p', target: '/q', rename: [['Agent OS', 'ClaudeBot'], ['agentos', 'claudebot']], deny: ['Pat Quinlan', 'quinlan-labs'], exclude: ['docs/gates/'], allow_emails: [], ...over });

test('scrub: deny list, personal emails, home paths, tokens, private keys and .local hosts are hits (masked); safe placeholders are not', () => {
  const diff = ['+++ b/src/a.ts', '@@ -0,0 +1,9 @@', '+const owner = "Pat Quinlan";', "+const to = 'pat.q@gmail.com';", '+const cfg = "/Users/patq/Library/x";', '+const t = "ghp_' + 'A'.repeat(36) + '";', '+-----BEGIN OPENSSH PRIVATE KEY-----', '+ssh pats-macbook.local', '+ok("sam@example.com", "noreply@anthropic.com", "/Users/runner/work", "/home/runner", "settings.local.json")', '+const c = "' + 'sk-ant-' + 'b'.repeat(30) + '";', '+// quinlan-labs internal'].join('\n');
  const hits = scrubDiff(diff, S());
  assert.deepEqual(hits.map((h) => `${h.line}:${h.kind}`), ['1:deny list', '2:email', '3:home path', '4:token', '5:private key', '6:.local hostname', '8:token', '9:deny list']);
  for (const h of hits) assert.ok(!/Quinlan|gmail|patq|AAAA|pats-mac/.test(h.masked), `masked: ${h.masked}`);
  assert.deepEqual(scrubDiff('+++ b/Pat Quinlan notes.md\n', S()).map((h) => h.kind), ['deny list'], 'file names are checked too');
  assert.deepEqual(scrubDiff('+++ b/x\n@@ -1 +1 @@\n-removed pat.q@gmail.com\n', S()), [], 'removed lines are not published');
  assert.deepEqual(scrubDiff('+++ b/x\n@@ -0,0 +1 @@\n+mail me: team@claudebot.dev\n', S({ allow_emails: ['team@claudebot.dev'] })), [], 'allow-listed address');
  assert.equal(applyRename('Agent OS uses agentos and AgentOS', S().rename), 'ClaudeBot uses claudebot and AgentOS');
});

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'port-')); process.env.CLAUDEBOT_MEMORY_DIR = path.join(tmp, 'vault');
  const priv = path.join(tmp, 'private'); fs.mkdirSync(path.join(priv, 'test'), { recursive: true }); fs.mkdirSync(path.join(priv, 'docs', 'gates'), { recursive: true });
  fs.writeFileSync(path.join(priv, 'package.json'), JSON.stringify({ name: 'agentos', private: true, scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(priv, 'name.js'), "exports.name = () => 'Agent OS';\n");
  fs.writeFileSync(path.join(priv, 'test', 'name.test.js'), "const { test } = require('node:test'); const assert = require('node:assert');\ntest('name', () => assert.match(require('../name.js').name(), /^(Agent OS|ClaudeBot)$/));\n");
  git(priv, 'init', '-q', '-b', 'main'); git(priv, 'add', '-A'); git(priv, 'commit', '-q', '-m', 'base'); const base = git(priv, 'rev-parse', 'HEAD');
  // The public repo: the same base, renamed.
  const pub = path.join(tmp, 'public'); fs.cpSync(priv, pub, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });
  for (const f of ['package.json', 'name.js']) fs.writeFileSync(path.join(pub, f), applyRename(fs.readFileSync(path.join(pub, f), 'utf8'), S().rename));
  git(pub, 'init', '-q', '-b', 'main'); git(pub, 'add', '-A'); git(pub, 'commit', '-q', '-m', 'public base');
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const deps: RunDeps = { db, store, approvals, actions, runtime: new SimulatedRuntime([]), log: createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream }), workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1 };
  const defs = new Definitions(db); defs.seedSystemDefaults();
  db.prepare("INSERT INTO settings(key, value, updated_at, updated_by) VALUES ('port_public', ?, ?, 'test')").run(JSON.stringify({ ...S(), source: priv, target: pub, last_synced: base }), new Date().toISOString());
  const port = async (key: string) => { const wf = defs.getWorkflow('port.public')!; const j = store.create({ idempotency_key: key, kind: 'port.public', objective: 'Port the latest fixes', success_contract: wf.contract, agent_role: 'coordinator', inputs: {} }).job; for (let i = 0; i < 3; i++) { const l = store.lease({ owner: 'worker:test', leaseSeconds: 30 }); if (!l) break; await runJob(deps, l.id); } return store.get(j.id)!; };
  return { tmp, priv, pub, db, store, port };
}

test('step 8: a private fix lands on port/<job> in the public clone, renamed, scrubbed and tested; excluded paths stay private; nothing pushed', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.priv, 'name.js'), "exports.name = () => 'Agent OS';\nexports.tag = () => 'agentos-1';\n");
  fs.writeFileSync(path.join(s.priv, 'docs', 'gates', 'evidence.md'), 'Pat Quinlan signed off\n');
  git(s.priv, 'add', '-A'); git(s.priv, 'commit', '-q', '-m', 'fix: tag');
  const j = await s.port('p1'); assert.equal(j.state, 'completed', String(j.failure_detail));
  const branch = `port/${j.id}`; assert.match(git(s.pub, 'show', `${branch}:name.js`), /exports\.tag = \(\) => 'claudebot-1'/, 'renamed');
  assert.throws(() => git(s.pub, 'show', `${branch}:docs/gates/evidence.md`), 'excluded path not ported');
  assert.match(git(s.pub, 'log', '-1', '--format=%s', branch), /^Port [0-9a-f]{7}\.\.[0-9a-f]{7} from the private repository$/);
  assert.equal(git(s.pub, 'rev-list', '--count', 'main'), '1', 'public main untouched');
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'port.ready'").get(j.id));
});

test('step 8: one private item in the diff fails the port before anything is committed, and the report masks it', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.priv, 'name.js'), "exports.name = () => 'Agent OS';\nexports.owner = () => 'pat.q@gmail.com';\n");
  git(s.priv, 'add', '-A'); git(s.priv, 'commit', '-q', '-m', 'oops');
  const j = await s.port('p2'); assert.equal(j.state, 'failed_terminal'); assert.match(String(j.failure_detail), /scrub check: 1 private item would be published \(name\.js:2 email\)/);
  assert.ok(!String(j.failure_detail).includes('gmail'));
  assert.equal(git(s.pub, 'rev-list', '--count', `port/${j.id}`), '1', 'nothing committed on the port branch');
  const hits = s.db.prepare("SELECT path FROM artifacts WHERE job_id = ? AND title LIKE 'Scrub check%'").get(j.id) as { path: string };
  assert.match(fs.readFileSync(hits.path, 'utf8'), /^name\.js:2: email pa•+$/m);
  // Without settings the port refuses.
  s.db.prepare("DELETE FROM settings WHERE key = 'port_public'").run(); const k = await s.port('p3'); assert.match(String(k.failure_detail), /needs settings port_public/);
});
