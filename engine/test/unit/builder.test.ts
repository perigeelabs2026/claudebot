// Build tasks after Fable's step-1 spec review: results leave the VM (bundle + patch), the private repo arrives as a bundle (main and
// tags only), no default repository, npm ci without install scripts, the hand-over helper and the builder egress proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../../src/db/open.ts';
import { localShell, ensureClone, prepareWorktree, commitBuild, exportBuild, stageBundle, buildRepo, runBuildCheck, worktreeGitDir } from '../../src/build/repo.ts';

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
  assert.match(r.output, /^# npm ci --ignore-scripts$/m, 'npm ci is in the check output'); assert.equal(r.label, 'npm test', 'the label is still the check');
  fs.rmSync(path.join(w.dir, 'node_modules'), { recursive: true, force: true }); const lock = fs.readFileSync(path.join(w.dir, 'package-lock.json'), 'utf8'); fs.writeFileSync(path.join(w.dir, 'package-lock.json'), '{ not json');
  const bad = await runBuildCheck(sh, w.dir, 'test'); assert.match(bad.output, /npm ci failed; checks run without a fresh install/); assert.match(bad.output, /npm (ERR|error)/i, 'npm\'s own error is kept'); fs.writeFileSync(path.join(w.dir, 'package-lock.json'), lock);
  fs.rmSync(path.join(w.dir, 'node_modules'), { recursive: true, force: true });
  await runBuildCheck(sh, w.dir, 'test', undefined, { installScripts: true }); assert.ok(fs.existsSync(path.join(w.dir, 'PRE_RAN')), 'opted in: they run');
});

test('hand-over helper: only a worktree directly under repos/<app>-worktrees, only to the builder or the engine user; check mode keeps .git and .claudebot', { skip: process.getuid?.() !== 0 && 'needs root (chown)' }, () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-')); const wt = path.join(D, 'repos', 'demo-worktrees', 'job-1'); fs.mkdirSync(path.join(wt, '.claudebot'), { recursive: true }); fs.mkdirSync(path.join(wt, 'src'));
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${D}/repos/demo/.git/worktrees/job-1\n`); fs.writeFileSync(path.join(wt, 'src', 'a.js'), ''); fs.writeFileSync(path.join(wt, '.claudebot', 'capability.json'), '{}');
  const helper = path.join(ROOT, 'computer', 'runtime', 'claudebot-handover'); const env = { ...process.env, CLAUDEBOT_HANDOVER_DATA: D }; delete (env as Record<string, string | undefined>).SUDO_USER;
  const run = (...a: string[]) => execFileSync('bash', [helper, ...a], { env, encoding: 'utf8', stdio: 'pipe' });
  let nobody = 65534; try { nobody = Number(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).trim()); } catch { /* default */ }
  try { execFileSync('id', ['claudebot-builder'], { stdio: 'pipe' }); } catch { /* the builder user only exists in the computer: test the refusals and the engine user */ }
  fs.mkdirSync(path.join(D, 'repos', 'demo'), { recursive: true }); assert.throws(() => run(path.join(D, 'repos', 'demo'), 'root', 'check'), /not a build worktree/);
  assert.throws(() => run('/etc', 'root', 'check'), /not a build worktree/);
  assert.throws(() => run(wt, 'nobody', 'check'), /refused: user nobody/);
  assert.throws(() => run(wt, 'root', 'everything'), /refused: mode/);
  for (const f of [wt, path.join(wt, 'src'), path.join(wt, 'src', 'a.js'), path.join(wt, '.claudebot', 'capability.json')]) fs.chownSync(f, nobody, nobody);   // as if the builder had it (not .git or .claudebot)
  run(wt, 'root', 'check'); assert.equal(fs.statSync(path.join(wt, 'src', 'a.js')).uid, 0); assert.equal(fs.statSync(path.join(wt, '.claudebot', 'capability.json')).uid, nobody, 'check mode leaves .claudebot\'s contents alone');
  // A check that swaps the pointer or .claudebot is refused (exit 3) and nothing is chowned.
  const refused = (re: RegExp) => { fs.chownSync(path.join(wt, 'src', 'a.js'), nobody, nobody); try { run(wt, 'root', 'check'); assert.fail('not refused'); } catch (e) { assert.equal((e as { status: number }).status, 3); assert.match(String((e as { stderr: string }).stderr), re); } assert.equal(fs.statSync(path.join(wt, 'src', 'a.js')).uid, nobody, 'nothing handed over'); };
  const ptr = fs.readFileSync(path.join(wt, '.git'), 'utf8');
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /tmp/evil\n'); refused(/worktree pointer/);
  fs.writeFileSync(path.join(wt, '.git'), ptr); fs.chownSync(path.join(wt, '.git'), nobody, nobody); refused(/worktree pointer/);   // right text, written by the builder
  fs.rmSync(path.join(wt, '.git')); fs.symlinkSync(path.join(D, 'repos', 'demo', 'ptr'), path.join(wt, '.git')); fs.writeFileSync(path.join(D, 'repos', 'demo', 'ptr'), ptr); refused(/worktree pointer/);
  fs.rmSync(path.join(wt, '.git')); fs.writeFileSync(path.join(wt, '.git'), ptr);
  fs.renameSync(path.join(wt, '.claudebot'), path.join(wt, 'cb-old')); fs.symlinkSync('/etc', path.join(wt, '.claudebot')); refused(/\.claudebot was replaced/);
  fs.rmSync(path.join(wt, '.claudebot')); fs.mkdirSync(path.join(wt, '.claudebot')); fs.chownSync(path.join(wt, '.claudebot'), nobody, nobody); refused(/\.claudebot was replaced/);
  fs.rmSync(path.join(wt, '.claudebot'), { recursive: true }); run(wt, 'root', 'check'); assert.equal(fs.statSync(path.join(wt, 'src', 'a.js')).uid, 0, 'no .claudebot at all is fine');
});

test('hand-over helper: handing back kills every process the builder still has first', { skip: (process.getuid?.() !== 0 || process.platform !== 'linux') && 'needs root on Linux (a throwaway user)' }, async () => {
  const B = `cbt${process.pid}`; execFileSync('useradd', ['-M', '-r', '-s', '/usr/sbin/nologin', B]);
  try {
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-')); const wt = path.join(D, 'repos', 'demo-worktrees', 'job-1'); fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.chmodSync(D, 0o755); fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${D}/repos/demo/.git/worktrees/job-1\n`);
    const env = { ...process.env, CLAUDEBOT_HANDOVER_DATA: D, CLAUDEBOT_HANDOVER_BUILDER: B }; delete (env as Record<string, string | undefined>).SUDO_USER;
    const run = (...a: string[]) => execFileSync('bash', [path.join(ROOT, 'computer', 'runtime', 'claudebot-handover'), ...a], { env, encoding: 'utf8', stdio: 'pipe' });
    run(wt, B, 'check'); assert.equal(fs.statSync(path.join(wt, 'src')).uid, Number(execFileSync('id', ['-u', B], { encoding: 'utf8' }).trim()));
    // What a check could leave behind: a detached process still running as the builder, able to write into the worktree later.
    const { spawn } = await import('node:child_process'); const left = spawn('setpriv', ['--reuid', B, '--regid', B, '--clear-groups', 'sleep', '300'], { detached: true, stdio: 'ignore' }); left.unref();
    for (let i = 0; i < 50 && !execFileSync('bash', ['-c', `pgrep -u ${B} || true`], { encoding: 'utf8' }).trim(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(execFileSync('bash', ['-c', `pgrep -u ${B} || true`], { encoding: 'utf8' }).trim(), 'the leftover process is running');
    run(wt, 'root', 'check');
    assert.equal(execFileSync('bash', ['-c', `ps -u ${B} -o stat= | grep -v '^Z' || true`], { encoding: 'utf8' }).trim(), '', 'no builder process survives the hand-back'); assert.equal(fs.statSync(path.join(wt, 'src')).uid, 0);
  } finally { try { execFileSync('pkill', ['-KILL', '-u', B]); } catch { /* none */ } execFileSync('userdel', [B]); }
});

test('commit and export name the worktree\'s git dir explicitly, with hooks and signing off: a rewritten .git pointer or hooks path is not followed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-')); const src = origin(root); const sh = localShell(path.join(root, 'repos'), {} as NodeJS.ProcessEnv); const repo = { app: 'demo', url: src };
  assert.equal(worktreeGitDir('/d/repos/app-worktrees/job-9'), '/d/repos/app/.git/worktrees/job-9');
  assert.ok((await ensureClone(sh, repo)).ok); const w = await prepareWorktree(sh, repo, 'job-gd', 'c') as { dir: string; branch: string; base_commit: string };
  // What a turn or check could leave behind: a pointer to its own repository, a hook, a hooks path and signing in the worktree config.
  const evil = path.join(root, 'evil'); execFileSync('git', ['init', '-q', '-b', 'main', evil]); const evilHead = () => execFileSync('git', ['-C', evil, 'rev-list', '--all']).toString().trim();
  fs.writeFileSync(path.join(w.dir, '.git'), `gitdir: ${evil}/.git\n`);
  const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks); fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch ${root}/HOOK_RAN\n`, { mode: 0o755 });
  execFileSync('git', ['--git-dir', worktreeGitDir(w.dir), 'config', 'core.hooksPath', hooks]); execFileSync('git', ['--git-dir', worktreeGitDir(w.dir), 'config', 'commit.gpgsign', 'true']);
  fs.writeFileSync(path.join(w.dir, 'new.txt'), 'x');
  const c = await commitBuild(sh, w.dir, w.branch, 'msg'); assert.equal(c.ok, true, JSON.stringify(c));
  assert.ok(!fs.existsSync(path.join(root, 'HOOK_RAN')), 'hooks off'); assert.equal(evilHead(), '', 'the planted repository got nothing');
  assert.match(git(src, 'log', '--oneline', '-1', 'main'), /init/, 'main untouched'); assert.match(execFileSync('git', ['--git-dir', worktreeGitDir(w.dir), 'show', '--stat', '--format=%s', 'HEAD']).toString(), /new\.txt/);
  const x = await exportBuild(sh, w.dir, w.base_commit, w.branch); assert.equal(x.ok, true); assert.match((x as { patch: string }).patch, /new\.txt/);
});

test('egress proxy: HTTPS tunnels only to GitHub and npm; any other host and plain HTTP are refused and logged', async () => {
  const { allowed, createProxy } = await import(path.join(ROOT, 'computer', 'runtime', 'egress-proxy.mjs'));
  for (const h of ['github.com', 'registry.npmjs.org', 'REGISTRY.NPMJS.ORG.']) assert.equal(allowed(h), true, h);
  for (const h of ['api.anthropic.com', 'example.com', 'anthropic.com.evil.test', 'evil-github.com', 'pastebin.com', '169.254.169.254']) assert.equal(allowed(h), false, h);
  const logs: string[] = []; const up = new net.Server(); await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r())); const upPort = (up.address() as net.AddressInfo).port;
  up.on('connection', (s) => s.end('hello from upstream'));
  const proxy = createProxy({ log: (l: string) => logs.push(l), connect: () => net.connect(upPort, '127.0.0.1') }); await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r())); const port = (proxy.address() as net.AddressInfo).port;
  const tunnel = (host: string) => new Promise<string>((resolve) => { const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`)); let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => resolve(d)); s.on('close', () => resolve(d)); });
  assert.match(await tunnel('example.com:443'), /403/); assert.match(await tunnel('api.anthropic.com:443'), /403/, 'checks never need Anthropic'); assert.match(await tunnel('registry.npmjs.org:80'), /403/, 'HTTPS only');
  const okRes = await tunnel('registry.npmjs.org:443'); assert.match(okRes, /200 Connection Established/); assert.match(okRes, /hello from upstream/);
  const plain = await new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port, path: 'http://example.com/', headers: { host: 'example.com' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
  assert.equal(plain, 403); assert.ok(logs.some((l) => /refused example\.com:443/.test(l)));
  proxy.close(); up.close();
});

test('builder nftables: the host only on the engine\'s port, DNS only to the VM\'s resolver, and provisioning fills all three in', () => {
  const nft = fs.readFileSync(path.join(ROOT, 'computer', 'runtime', 'builder-egress.nft'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#'));
  const rules = nft.map((l) => l.trim()).filter((l) => / accept$/.test(l) && !l.startsWith('meta skuid'));
  assert.deepEqual(rules, ['oif "lo" tcp dport 18799 accept', 'ip daddr __DNS_IP__ udp dport 53 accept', 'ip daddr __DNS_IP__ tcp dport 53 accept', 'ip daddr __HOST_IP__ tcp dport __ENGINE_PORT__ accept']);
  const prov = fs.readFileSync(path.join(ROOT, 'computer', 'provision-runtime.sh'), 'utf8');
  for (const k of ['__HOST_IP__', '__ENGINE_PORT__', '__DNS_IP__']) assert.match(prov, new RegExp(`s/${k}/`), k);
  assert.match(fs.readFileSync(path.join(ROOT, 'engine', 'src', 'computer', 'host.ts'), 'utf8'), /> \/etc\/claudebot\/engine_port/);
});
