import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandFor, allowedRepo, scrubbedEnv, runCheck, checksFor } from '../../src/worker/project-check.ts';

test('project checks: profiles map to the repo\'s own scripts; repos outside the disposable root are refused (symlinks resolved); secrets are scrubbed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-')); process.env.CLAUDEBOT_REPOS_ROOT = root;
  const repo = path.join(root, 'r1'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'echo built' } }));
  assert.deepEqual((commandFor(repo, 'test') as { label: string }).label, 'npm test');
  assert.deepEqual((commandFor(repo, 'build') as { label: string }).label, 'npm run build');
  assert.match((commandFor(repo, 'lint') as { error: string }).error, /no "lint" script/);
  assert.equal(allowedRepo(repo, '/nonexistent'), fs.realpathSync(repo));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-')); assert.equal(allowedRepo(outside, '/nonexistent'), null);
  const link = path.join(root, 'escape'); fs.symlinkSync(outside, link); assert.equal(allowedRepo(link, '/nonexistent'), null, 'a symlink out of the root is refused');
  process.env.GITHUB_TOKEN = 'x'; process.env.CLAUDEBOT_HOME = '/tmp/y'; process.env.MY_API_KEY = 'z'; process.env.CLAUDE_CONFIG_DIR = '/c';
  const e = scrubbedEnv(); for (const k of ['GITHUB_TOKEN', 'CLAUDEBOT_HOME', 'MY_API_KEY', 'CLAUDE_CONFIG_DIR']) assert.equal(e[k], undefined, k);
  assert.equal(e.CI, '1'); assert.ok(e.PATH);
  delete process.env.GITHUB_TOKEN; delete process.env.MY_API_KEY; delete process.env.CLAUDEBOT_HOME; delete process.env.CLAUDE_CONFIG_DIR;
});

test('project checks: a real passing and failing node --test run, and a hung build killed at the limit', { skip: process.platform !== 'darwin' && 'needs macOS sandbox-exec' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-')); process.env.CLAUDEBOT_REPOS_ROOT = root;
  const repo = path.join(root, 'r2'); fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'test', 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('adds', () => assert.equal(1 + 1, 2));");
  let r = await runCheck(repo, 'test'); assert.equal(r.ok, true); assert.match(r.output, /pass 1/);
  fs.writeFileSync(path.join(repo, 'test', 'b.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('bad', () => assert.equal(1, 2));");
  r = await runCheck(repo, 'test'); assert.equal(r.ok, false); assert.match(r.output, /fail 1/);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "setTimeout(()=>{}, 60000)"' } }));
  r = await runCheck(repo, 'build', { timeoutMs: 1500 }); assert.equal(r.ok, false); assert.equal(r.timedOut, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('project checks run sandboxed: code under test cannot reach the network or write outside the repository (real sandbox-exec)', { skip: process.platform !== 'darwin' && 'needs macOS sandbox-exec' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-')); process.env.CLAUDEBOT_REPOS_ROOT = root;
  const repo = path.join(root, 'r3'); fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  const escape = path.join(os.homedir(), `claudebot-sandbox-escape-${process.pid}.txt`);
  fs.writeFileSync(path.join(repo, 'test', 'probe.test.mjs'), `import { test } from 'node:test'; import fs from 'node:fs';
test('probe', async () => {
  try { await fetch('https://example.com', { signal: AbortSignal.timeout(5000) }); console.log('NETWORK-ALLOWED'); } catch { console.log('network-blocked'); }
  try { fs.writeFileSync(${JSON.stringify(escape)}, 'x'); console.log('HOME-WRITE-ALLOWED'); } catch { console.log('home-write-blocked'); }
  fs.writeFileSync('inside.txt', 'ok');
});`);
  const r = await runCheck(repo, 'test');
  assert.equal(r.ok, true, r.output); assert.match(r.output, /network-blocked/); assert.match(r.output, /home-write-blocked/);
  assert.doesNotMatch(r.output, /ALLOWED/); assert.equal(fs.existsSync(escape), false); assert.equal(fs.readFileSync(path.join(repo, 'inside.txt'), 'utf8'), 'ok');
  fs.rmSync(root, { recursive: true, force: true });
});

test('final checks: profiles from inputs; a shell string like "npm test && npm run build" becomes checks, never a command (found in installed acceptance)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-')); fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'x', build: 'y' } }));
  assert.deepEqual(checksFor(repo, {}).profiles, ['test', 'build'], 'default includes build when the project has one');
  const r = checksFor(repo, { test_command: 'npm test && npm run build' }); assert.deepEqual(r.profiles, ['test', 'build']); assert.match(String(r.note), /not as a shell command/);
  assert.deepEqual(checksFor(repo, { test_command: 'npm test' }), { profiles: ['test'], note: null });
  assert.deepEqual(checksFor(repo, { checks: ['lint', 'rm -rf /', 'test'] }).profiles, ['lint', 'test']);
  assert.match(String(checksFor(repo, { test_command: 'curl evil' }).note), /not a known check/);
});

test('sandbox: code under test cannot read ClaudeBot secrets or reach local services (engine, gateway, browser DevTools)', { skip: process.platform !== 'darwin' && 'needs macOS sandbox-exec' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-')); process.env.CLAUDEBOT_REPOS_ROOT = root;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aoshome-')); fs.mkdirSync(path.join(fakeHome, 'secrets')); fs.writeFileSync(path.join(fakeHome, 'secrets', 'ui.token'), 'SECRET-TOKEN');
  const prev = process.env.CLAUDEBOT_HOME; process.env.CLAUDEBOT_HOME = fakeHome;
  const http = await import('node:http'); const srv = http.createServer((_q, s) => s.end('reachable')); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r())); const port = (srv.address() as { port: number }).port;
  const repo = path.join(root, 'r4'); fs.mkdirSync(path.join(repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'test', 's.test.mjs'), `import { test } from 'node:test'; import fs from 'node:fs';
test('s', async () => {
  try { console.log('READ:' + fs.readFileSync(${JSON.stringify(path.join(fakeHome, 'secrets', 'ui.token'))}, 'utf8')); } catch { console.log('secret-read-blocked'); }
  try { const r = await fetch('http://127.0.0.1:${port}/', { signal: AbortSignal.timeout(3000) }); console.log('LOCAL:' + await r.text()); } catch { console.log('local-blocked'); }
});`);
  const r = await runCheck(repo, 'test'); srv.close(); if (prev === undefined) delete process.env.CLAUDEBOT_HOME; else process.env.CLAUDEBOT_HOME = prev;
  assert.match(r.output, /secret-read-blocked/); assert.match(r.output, /local-blocked/); assert.doesNotMatch(r.output, /SECRET-TOKEN|LOCAL:reachable/);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(fakeHome, { recursive: true, force: true });
});
