// Build tasks after Fable's step-1 spec review: results leave the VM (bundle + patch), the private repo arrives as a bundle (main and
// tags only), no default repository, npm ci without install scripts, the hand-over helper, the builder egress proxy, and builder turns
// (off by default) wired through their own ACP agent with the token never in argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/db/open.ts';
import { localShell, ensureClone, prepareWorktree, commitBuild, exportBuild, stageBundle, buildRepo, builderTurnsOn, runBuildCheck } from '../../src/build/repo.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
function origin(tmp: string, pkg: Record<string, unknown> = { name: 'demo', private: true, scripts: { test: 'node --test' } }): string {
  const dir = path.join(tmp, 'origin'); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg)); fs.writeFileSync(path.join(dir, 'greet.js'), "exports.greet = (n) => `Hello, ${n}`;\n");
  fs.writeFileSync(path.join(dir, 'test', 'greet.test.js'), "const { test } = require('node:test'); const assert = require('node:assert');\ntest('greets', () => assert.match(require('../greet.js').greet('Sam'), /Sam/));\n");
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init'); git(dir, 'tag', 'v1');
  git(dir, 'checkout', '-q', '-b', 'secret-wip'); fs.writeFileSync(path.join(dir, 'wip.txt'), 'unpushed work'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'wip'); git(dir, 'checkout', '-q', 'main');
  return dir;
}

test('no default repository: with build_repo unset (and no env), build tasks have nothing to edit', () => {
  const db = openDatabase(':memory:');
  assert.equal(buildRepo(db, {} as NodeJS.ProcessEnv), null);
  assert.equal(buildRepo(db, { CLAUDEBOT_BUILD_REPO_URL: 'https://example.test/x.git' } as NodeJS.ProcessEnv)?.app, 'x');
  db.prepare("INSERT INTO settings(key, value, updated_at, updated_by) VALUES ('build_repo', ?, 't', 't')").run(JSON.stringify({ app: 'Mine', bundle_from: '/tmp/mine' }));
  assert.deepEqual(buildRepo(db, {} as NodeJS.ProcessEnv), { app: 'mine', url: '/tmp/mine', bundle_from: '/tmp/mine' });
});

test('bundle source: main and tags only (never other local branches), 0600, verified; clone and fetch from it; the result comes back as a bundle and a patch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsrc-')); const src = origin(tmp); const sh = localShell(path.join(tmp, 'repos'), {} as NodeJS.ProcessEnv);
  const repo = { app: 'demo', url: src, bundle_from: src };
  const b = await stageBundle(sh, repo); assert.equal(b.ok, true, JSON.stringify(b)); const bp = (b as { path: string }).path;
  assert.equal(fs.statSync(bp).mode & 0o777, 0o600); assert.equal(bp, path.join(tmp, 'repos', 'demo.bundle'));
  const heads = git(tmp, 'bundle', 'list-heads', bp); assert.match(heads, /refs\/heads\/main/); assert.match(heads, /refs\/tags\/v1/); assert.doesNotMatch(heads, /secret-wip/, 'unpushed local branches never leave the Mac');
  const c = await ensureClone(sh, repo, bp); assert.equal(c.ok, true, JSON.stringify(c)); const clone = (c as { dir: string }).dir;
  assert.equal(git(clone, 'remote', 'get-url', 'origin'), bp); assert.equal(git(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), 'origin/main');
  assert.throws(() => git(clone, 'rev-parse', '--verify', 'refs/remotes/origin/secret-wip'));
  // A new commit on the Mac arrives with the next prepare (atomic replace, fetch from the new bundle).
  fs.writeFileSync(path.join(src, 'more.txt'), 'x'); git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'more');
  assert.ok((await stageBundle(sh, repo)).ok); assert.ok((await ensureClone(sh, repo, bp)).ok); assert.equal(git(clone, 'rev-parse', 'origin/main'), git(src, 'rev-parse', 'main'));
  // Work on a branch, commit, export: the bundle fetches into the Mac repository and the patch carries the change.
  const w = await prepareWorktree(sh, repo, 'job-x1', 'coordinator'); assert.ok(w.ok); const wt = w as { dir: string; branch: string; base_commit: string };
  assert.match(wt.base_commit, /^[0-9a-f]{40}$/);
  fs.writeFileSync(path.join(wt.dir, 'greet.js'), "exports.greet = (n) => `Hi, ${n}`;\n");
  const cm = await commitBuild(sh, wt.dir, wt.branch, 'say hi'); assert.ok(cm.ok);
  const x = await exportBuild(sh, wt.dir, wt.base_commit, wt.branch); assert.equal(x.ok, true, JSON.stringify(x));
  const out = path.join(tmp, 'job-x1.bundle'); fs.writeFileSync(out, (x as { bundle: Buffer }).bundle);
  git(src, 'fetch', '-q', out, `${wt.branch}:refs/heads/review/x1`); assert.match(git(src, 'show', 'review/x1:greet.js'), /Hi, /);
  assert.match((x as { patch: string }).patch, /^-exports\.greet = \(n\) => `Hello/m); assert.match((x as { patch: string }).patch, /Subject: \[PATCH\] say hi/);
});

test('checks install without install scripts unless the repository opts in', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ign-')); const src = origin(tmp, { name: 'demo', version: '1.0.0', private: true, scripts: { test: 'node --test', preinstall: 'node -e "require(\'fs\').writeFileSync(\'PRE_RAN\', \'1\')"' } });
  fs.writeFileSync(path.join(src, 'package-lock.json'), JSON.stringify({ name: 'demo', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'demo', version: '1.0.0' } } })); git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'lock');
  const sh = localShell(path.join(tmp, 'repos'), {} as NodeJS.ProcessEnv); const repo = { app: 'demo', url: src };
  assert.ok((await ensureClone(sh, repo)).ok); const w = await prepareWorktree(sh, repo, 'job-i1', 'c') as { dir: string };
  const r = await runBuildCheck(sh, w.dir, 'test'); assert.equal(r.ok, true, r.output); assert.ok(!fs.existsSync(path.join(w.dir, 'PRE_RAN')), 'install scripts did not run');
  fs.rmSync(path.join(w.dir, 'node_modules'), { recursive: true, force: true });
  await runBuildCheck(sh, w.dir, 'test', undefined, { installScripts: true }); assert.ok(fs.existsSync(path.join(w.dir, 'PRE_RAN')), 'opted in: they run');
});

test('hand-over helper: only a worktree directly under repos/<app>-worktrees, only to the builder or the engine user; check mode keeps .git and .claudebot', { skip: process.getuid?.() !== 0 && 'needs root (chown)' }, () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-')); const wt = path.join(D, 'repos', 'demo-worktrees', 'job-1'); fs.mkdirSync(path.join(wt, '.claudebot'), { recursive: true }); fs.mkdirSync(path.join(wt, 'src'));
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: x'); fs.writeFileSync(path.join(wt, 'src', 'a.js'), ''); fs.writeFileSync(path.join(wt, '.claudebot', 'capability.json'), '{}');
  const helper = path.join(ROOT, 'computer', 'runtime', 'claudebot-handover'); const env = { ...process.env, CLAUDEBOT_HANDOVER_DATA: D }; delete (env as Record<string, string | undefined>).SUDO_USER;
  const run = (...a: string[]) => execFileSync('bash', [helper, ...a], { env, encoding: 'utf8', stdio: 'pipe' });
  let nobody = 65534; try { nobody = Number(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).trim()); } catch { /* default */ }
  try { execFileSync('id', ['claudebot-builder'], { stdio: 'pipe' }); } catch { /* the builder user only exists in the computer: test the refusals and the engine user */ }
  fs.mkdirSync(path.join(D, 'repos', 'demo'), { recursive: true }); assert.throws(() => run(path.join(D, 'repos', 'demo'), 'root', 'check'), /not a build worktree/);
  assert.throws(() => run('/etc', 'root', 'check'), /not a build worktree/);
  assert.throws(() => run(wt, 'nobody', 'check'), /refused: user nobody/);
  assert.throws(() => run(wt, 'root', 'everything'), /refused: mode/);
  execFileSync('chown', ['-R', String(nobody), wt]);   // as if the builder had it: hand it back to the engine user (owner of repos)
  run(wt, 'root', 'check'); assert.equal(fs.statSync(path.join(wt, 'src', 'a.js')).uid, 0); assert.equal(fs.statSync(path.join(wt, '.claudebot', 'capability.json')).uid, nobody, 'check mode leaves .claudebot alone'); assert.equal(fs.lstatSync(path.join(wt, '.git')).uid, nobody);
  run(wt, 'root', 'turn'); assert.equal(fs.statSync(path.join(wt, '.claudebot', 'capability.json')).uid, 0, 'turn mode includes .claudebot');
});

test('egress proxy: HTTPS tunnels only to Anthropic, GitHub and npm; any other host and plain HTTP are refused and logged', async () => {
  const { allowed, createProxy } = await import(path.join(ROOT, 'computer', 'runtime', 'egress-proxy.mjs'));
  for (const h of ['api.anthropic.com', 'github.com', 'registry.npmjs.org', 'API.ANTHROPIC.COM.']) assert.equal(allowed(h), true, h);
  for (const h of ['example.com', 'anthropic.com.evil.test', 'evil-github.com', 'pastebin.com', '169.254.169.254']) assert.equal(allowed(h), false, h);
  const logs: string[] = []; const up = new net.Server(); await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r())); const upPort = (up.address() as net.AddressInfo).port;
  up.on('connection', (s) => s.end('hello from upstream'));
  const proxy = createProxy({ log: (l: string) => logs.push(l), connect: () => net.connect(upPort, '127.0.0.1') }); await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r())); const port = (proxy.address() as net.AddressInfo).port;
  const tunnel = (host: string) => new Promise<string>((resolve) => { const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`)); let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => resolve(d)); s.on('close', () => resolve(d)); });
  assert.match(await tunnel('example.com:443'), /403/); assert.match(await tunnel('api.anthropic.com:80'), /403/, 'HTTPS only');
  const okRes = await tunnel('api.anthropic.com:443'); assert.match(okRes, /200 Connection Established/); assert.match(okRes, /hello from upstream/);
  const plain = await new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port, path: 'http://example.com/', headers: { host: 'example.com' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
  assert.equal(plain, 403); assert.ok(logs.some((l) => /refused example\.com:443/.test(l)));
  proxy.close(); up.close();
});

test('builder turns are off by default; on, the turn uses the "builder" ACP agent, its worktree is handed to the builder and back, and the token never reaches argv', async () => {
  const db = openDatabase(':memory:'); assert.equal(builderTurnsOn(db, {} as NodeJS.ProcessEnv), false, 'off by default');
  db.prepare("INSERT INTO settings(key, value, updated_at, updated_by) VALUES ('builder_turns', 'true', 't', 't')").run(); assert.equal(builderTurnsOn(db, {} as NodeJS.ProcessEnv), true);
  const acp = fs.readFileSync(path.join(ROOT, 'engine', 'src', 'runtime', 'claude-acp.ts'), 'utf8'); assert.match(acp, /\/acp spawn \$\{req\.asBuilder \? 'builder' : 'claude'\}/);
  const oc = JSON.parse(fs.readFileSync(path.join(ROOT, 'computer', 'runtime', 'openclaw.json'), 'utf8'));
  assert.equal(oc.plugins.entries.acpx.config.agents.builder.command, '/opt/claudebot/bin/claude-acp-builder'); assert.ok(oc.acp.allowedAgents.includes('builder')); assert.equal(oc.agents.entries.builder.runtime.acp.agent, 'builder');
  const wrap = fs.readFileSync(path.join(ROOT, 'computer', 'runtime', 'claude-acp-as-builder'), 'utf8');
  assert.match(wrap, /IFS= read -r CLAUDE_CODE_OAUTH_TOKEN < "\$TOK"/, 'read from its file'); assert.doesNotMatch(wrap.split('\n').filter((l) => /^exec /.test(l)).join('\n'), /TOK|TOKEN/, 'not in the exec line (argv)');
  assert.match(wrap, /HTTPS_PROXY=\$P/); assert.match(fs.readFileSync(path.join(ROOT, 'computer', 'runtime', 'claude-acp-builder'), 'utf8'), /exec sudo -n -u claudebot-builder -H /);
  // The computer runtime hands the worktree over before the turn and back after it, then removes the capability.
  const { ComputerRuntime, VM_REPOS } = await import('../../src/runtime/computer.ts'); const { issueCapability } = await import('../../src/broker/capabilities.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-')); const ws = path.join(tmp, 'workspaces'); const runDir = path.join(tmp, 'run'); const dir = path.join(ws, 'general', 'tasks', 'job-b2'); fs.mkdirSync(dir, { recursive: true });
  issueCapability(runDir, { id: 'job-b2', agent_role: 'coordinator' } as never, dir, ['run_project_check']);
  const calls: string[] = []; let at = -1; const wt = `${VM_REPOS}/demo-worktrees/job-b2`;
  const inner = { id: 'claude-acp', describe: () => ({ label: 'x', route: 'r', account: '' }), health: async () => ({}) as never, cancel: async () => {}, startTurn: async () => { at = calls.length; return { ok: true, text: 'done' } as never; } };
  const rt = new ComputerRuntime(inner as never, { hostWorkspaces: ws, runDir, enginePort: 1, log: { info: () => {}, warn: () => {} }, exec: async (cmd: string, args: string[]) => { if (cmd === 'ssh') calls.push(args.at(-1)!); return ''; } });
  await rt.startTurn({ jobId: 'job-b2', sessionRef: 'job-b2', role: 'coordinator', cwd: dir, vmCwd: wt, asBuilder: true, prompt: 'p', resume: false, timeoutMs: 1000 } as never);
  const to = calls.findIndex((c) => c === `sudo -n /opt/claudebot/bin/claudebot-handover '${wt}' claudebot-builder turn`); const back = calls.findIndex((c) => c.startsWith(`sudo -n /opt/claudebot/bin/claudebot-handover '${wt}' "$(stat -c %U`));
  const rm = calls.findIndex((c) => c.startsWith('rm -f') && c.includes('capability.json'));
  assert.ok(to >= 0 && to < at, 'handed to the builder before the turn'); assert.ok(back >= at && back < rm, 'handed back after the turn, before the capability is removed');
  calls.length = 0; await rt.startTurn({ jobId: 'job-b2', sessionRef: 'job-b2', role: 'coordinator', cwd: dir, vmCwd: wt, prompt: 'p', resume: false, timeoutMs: 1000 } as never);
  assert.ok(!calls.some((c) => c.includes('claudebot-handover')), 'not a builder turn: no hand-over');
  // The token is installed over stdin only.
  const { LimaHost } = await import('../../src/computer/host.ts'); const seen: Array<{ args: string[]; input?: string }> = [];
  const host = new LimaHost({ home: tmp, secretsDir: path.join(tmp, 's'), exec: async (args: string[], input?: string) => { seen.push({ args, input }); return ''; } } as never);
  const tok = 'sk-ant-oat01-' + 'Z'.repeat(40); await host.setBuilderToken(tok);
  assert.ok(!seen[0].args.join(' ').includes(tok), 'not in argv'); assert.equal(seen[0].input, `${tok}\n`); assert.match(seen[0].args.join(' '), /umask 377/);
  await assert.rejects(() => host.setBuilderToken('not a token; rm -rf /'), /does not look like a token/);
});
