/**
 * Recovery scenarios that need the real OpenClaw ClaudeBot gateway and the real Claude ACP adapter (3, 4, 8).
 * They run the engine on a temp home but point it at the installed ClaudeBot gateway with the product's own token file.
 * The isolated Claude profile is signed in, so the turns are real (small, harmless document tasks). Safety rules:
 *  - only processes this run created are signalled (the adapter whose working directory is inside this run's temp home);
 *  - only resources this run created are removed (its own ACP sessions by key, its own transcript directories by exact prefix);
 *  - fault injection (gateway restart, adapter kill) runs against the ISOLATED test gateway (scripts/isolated-gateway.mjs:
 *    profile claudebot-test, port 48410, its own token, browser off); the owner's ClaudeBot gateway is never restarted;
 *  - scenario 8 needs the real managed browser profile and uses the ClaudeBot gateway read-only (navigation + snapshot, own tab);
 *  - the owner's login, sessions, conversations and browser tabs are never touched.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { fixtureDb, markReported } from './fixtures.ts';
import { sleep } from '../integration/engine.test.ts';
import { GatewayClient } from '../../src/gateway/client.ts';
import { createLogger } from '../../src/log.ts';

const OC = path.join(os.homedir(), '.local', 'bin', 'openclaw');
const realToken = path.join(os.homedir(), '.claudebot', 'secrets', 'gateway.token');
const ISO = { port: 48410, token: path.join(os.homedir(), '.openclaw-claudebot-test', 'secrets', 'gateway.token'), script: path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'isolated-gateway.mjs') };
function gatewayUp(): boolean { try { execFileSync(OC, ['--profile', 'claudebot', 'gateway', 'health'], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; } }
function isoUp(): boolean { try { execFileSync(OC, ['--profile', 'claudebot-test', 'gateway', 'health'], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; } }
function isoRestart(): void { execFileSync(process.execPath, [ISO.script, 'stop'], { stdio: 'ignore', timeout: 30_000 }); execFileSync(process.execPath, [ISO.script, 'start'], { stdio: 'ignore', timeout: 90_000 }); }

class RealEngine {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-real-')); port = 48850 + Math.floor(Math.random() * 100); token = 'real-token-0123456789abcdefghijklmnopqrstuvwxyz'; proc: ChildProcess | null = null; wsId = '';
  isolated: boolean;
  constructor(opts: { isolated?: boolean } = {}) { this.isolated = !!opts.isolated; fs.mkdirSync(path.join(this.home, 'secrets'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(this.home, 'secrets', 'ui.token'), this.token + '\n', { mode: 0o600 }); fs.copyFileSync(this.isolated ? ISO.token : realToken, path.join(this.home, 'secrets', 'gateway.token')); fs.chmodSync(path.join(this.home, 'secrets', 'gateway.token'), 0o600); }
  async start() { const entry = path.resolve(import.meta.dirname, '..', '..', 'src', 'supervisor', 'main.ts'); const out = fs.openSync(path.join(this.home, 'engine.log'), 'a'); this.proc = spawn(process.execPath, [entry], { env: { ...process.env, CLAUDEBOT_HOME: this.home, CLAUDEBOT_PORT: String(this.port), CLAUDEBOT_WORKERS: '1', CLAUDEBOT_LEASE_SECONDS: '20', CLAUDEBOT_HEARTBEAT_SECONDS: '3', CLAUDEBOT_CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claudebot', 'claude'), CLAUDEBOT_SKIP_AUTH_PRECHECK: '1', CLAUDEBOT_CONTROL_SESSION: 'agent:parity:control', CLAUDEBOT_SESSION_LABEL_PREFIX: 'test-', ...(this.isolated ? { CLAUDEBOT_GATEWAY_PORT: String(ISO.port), CLAUDEBOT_OPENCLAW_PROFILE: 'claudebot-test' } : {}) }, stdio: ['ignore', out, out] }); const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { await this.api('/api/health'); const w = await this.api<{ id: string }>('/api/workspaces', { method: 'POST', body: { name: 'Real test workspace' } }); this.wsId = w.id; return; } catch { await sleep(300); } } throw new Error('engine did not start'); }
  async stop() { if (!this.proc) return; const p = this.proc; this.proc = null; p.kill('SIGTERM'); await new Promise<void>((r) => { p.on('exit', () => r()); setTimeout(r, 25_000); }); }
  async api<T = Record<string, unknown>>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> { const r = await fetch(`http://127.0.0.1:${this.port}${p}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', 'x-claudebot-token': this.token }, body: init.body ? JSON.stringify(init.body) : undefined }); return r.json() as Promise<T>; }
  async waitFor(id: string, states: string[], timeoutMs = 60_000) { const end = Date.now() + timeoutMs; let last: Record<string, unknown> = {}; while (Date.now() < end) { last = (await this.api<{ job: Record<string, unknown> }>(`/api/jobs/${id}`)).job; if (states.includes(String(last.state))) return last; await sleep(500); } throw new Error(`job ${id} in ${last.state}, wanted ${states.join('|')}: ${last.failure_detail}`); }
}
const engines: RealEngine[] = [];
/** Claude Code names a project directory after the session cwd with every non-alphanumeric character replaced by '-'. */
function projectPrefix(home: string): string { return fs.realpathSync(home).replace(/[^A-Za-z0-9]/g, '-'); }
/** The adapter process (claude-agent-acp) whose working directory is inside `home`: the only one this run may signal. */
function testAdapterPids(home: string): number[] {
  const real = fs.realpathSync(home); const pids: number[] = [];
  for (const l of execFileSync('ps', ['-eo', 'pid,command']).toString().split('\n')) { if (!l.includes('claude-agent-acp/dist/index.js')) continue; const pid = Number(l.trim().split(/\s+/)[0]); try { const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((x) => x.startsWith('n'))?.slice(1) ?? ''; if (cwd.startsWith(real + path.sep) || cwd === real) pids.push(pid); } catch { /* process gone */ } }
  return pids;
}
async function closeSessions(keys: string[], isolated = false): Promise<void> {
  if (!keys.length) return;
  const gw = new GatewayClient({ url: `ws://127.0.0.1:${isolated ? ISO.port : 48310}`, tokenFile: isolated ? ISO.token : realToken, log: createLogger({ name: 'test', stream: { write: () => true } as unknown as NodeJS.WritableStream }) });
  try { await gw.connect(); for (const k of keys) { try { await gw.call('chat.send', { sessionKey: 'agent:parity:control', message: `/acp close ${k}`, idempotencyKey: crypto.randomUUID() }, 15_000); } catch { /* already closed */ } } await sleep(1500); } catch { /* gateway down */ } finally { gw.close(); }
}
after(async () => {
  for (const e of engines) {
    const keys: string[] = []; try { const db = new (await import('node:sqlite')).DatabaseSync(path.join(e.home, 'data', 'claudebot.sqlite'), { readOnly: true }); for (const r of db.prepare("SELECT session_ref FROM jobs WHERE session_ref LIKE '%:acp:%'").all() as Array<{ session_ref: string }>) keys.push(r.session_ref); db.close(); } catch { /* no db */ }
    await e.stop().catch(() => {});
    await closeSessions(keys, e.isolated);         // only this run's sessions, by exact key
    const projects = path.join(os.homedir(), '.claudebot', 'claude', 'projects'); const prefix = projectPrefix(e.home);
    if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects)) if (d.startsWith(prefix)) fs.rmSync(path.join(projects, d), { recursive: true, force: true });   // only this run's transcript dirs
    fs.rmSync(e.home, { recursive: true, force: true });
  }
});
async function installedIdle(): Promise<boolean> { try { const t = fs.readFileSync(path.join(os.homedir(), '.claudebot', 'secrets', 'ui.token'), 'utf8').trim(); const h = await (await fetch('http://127.0.0.1:48311/api/health', { headers: { 'x-claudebot-token': t } })).json() as { capacity: { active: number } }; return h.capacity.active === 0; } catch { return true; } }
const SMALL = 'Write a two-sentence note about why lighthouses use Fresnel lenses and save it as note.md.';
const up = gatewayUp();

test('3. gateway restart mid-job (ISOLATED test gateway): the job keeps its checkpoint and ACP session reference and resumes afterwards', { skip: !isoUp() && 'isolated test gateway not running (node scripts/isolated-gateway.mjs setup && start)' }, async () => {
  const e = new RealEngine({ isolated: true }); engines.push(e); await e.start();
  const r = await e.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { workspace_id: e.wsId, kind: 'document.create', objective: SMALL } });
  // Wait until the Claude step is bound to a real ACP session, then restart the gateway under it.
  const end = Date.now() + 120_000; let w: Record<string, unknown> = {}; while (Date.now() < end) { w = (await e.api<{ job: Record<string, unknown> }>(`/api/jobs/${r.job.id}`)).job; if (String(w.session_ref ?? '').includes(':acp:') || ['completed', 'failed_terminal'].includes(String(w.state))) break; await sleep(500); }
  assert.ok(String(w.session_ref ?? '').includes(':acp:'), `expected an ACP session key, got ${w.session_ref}`);
  const cpBefore = (await e.api<{ checkpoints: unknown[] }>(`/api/jobs/${r.job.id}`)).checkpoints.length;
  const labPid = execFileSync('/usr/sbin/lsof', ['-t', '-iTCP:48310', '-sTCP:LISTEN']).toString().trim();
  isoRestart();
  const deadline = Date.now() + 60_000; while (Date.now() < deadline && !isoUp()) await sleep(1000); assert.ok(isoUp(), 'isolated gateway back');
  assert.equal(execFileSync('/usr/sbin/lsof', ['-t', '-iTCP:48310', '-sTCP:LISTEN']).toString().trim(), labPid, 'the owner\'s ClaudeBot gateway was not touched');
  const after1 = await e.api<{ job: Record<string, unknown>; checkpoints: unknown[] }>(`/api/jobs/${r.job.id}`);
  assert.ok(after1.checkpoints.length >= cpBefore, 'no checkpoint lost');
  const done = await e.waitFor(r.job.id, ['completed', 'retry_scheduled', 'failed_terminal'], 300_000);
  if (done.state === 'retry_scheduled') { await e.api(`/api/jobs/${r.job.id}/requeue`, { method: 'POST' }); }
  const fin = await e.waitFor(r.job.id, ['completed', 'failed_terminal'], 300_000);
  assert.equal(fin.state, 'completed', `job did not recover: ${fin.failure_detail}`);
  const h = await e.api<{ gateway: { state: string } }>('/api/health?fresh=1'); assert.equal(h.gateway.state, 'ok');
});

test('4. killing this run\'s own Claude adapter (ISOLATED test gateway) records the failure, keeps the job and its checkpoints, and the job recovers', { skip: !isoUp() && 'isolated test gateway not running' }, async () => {
  const e = new RealEngine({ isolated: true }); engines.push(e); await e.start();
  const r = await e.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { workspace_id: e.wsId, kind: 'document.create', objective: SMALL } });
  // Wait for this run's adapter to exist (cwd inside this run's temp home), then kill exactly that process.
  let pids: number[] = []; const end = Date.now() + 120_000; while (Date.now() < end) { pids = testAdapterPids(e.home); const j = (await e.api<{ job: { state: string } }>(`/api/jobs/${r.job.id}`)).job; if (pids.length || ['completed', 'failed_terminal'].includes(j.state)) break; await sleep(500); }
  assert.ok(pids.length >= 1, 'this run started its own adapter');
  const others = execFileSync('ps', ['-eo', 'pid,command']).toString().split('\n').filter((l) => l.includes('claude-agent-acp/dist/index.js')).map((l) => Number(l.trim().split(/\s+/)[0])).filter((p) => !pids.includes(p));
  for (const pid of pids) process.kill(pid, 'SIGKILL');
  const w = await e.waitFor(r.job.id, ['retry_scheduled', 'completed', 'failed_terminal'], 180_000);
  if (w.state === 'retry_scheduled') await e.api(`/api/jobs/${r.job.id}/requeue`, { method: 'POST' });
  const fin = await e.waitFor(r.job.id, ['completed', 'failed_terminal'], 300_000);
  const d = await e.api<{ job: { last_good_checkpoint_id: number }; events: Array<{ type: string; detail: Record<string, unknown> }> }>(`/api/jobs/${r.job.id}`);
  assert.ok(d.job.last_good_checkpoint_id, 'checkpoint kept'); assert.equal(fin.state, 'completed', `job did not recover: ${fin.failure_detail}`);
  for (const p of others) { try { process.kill(p, 0); } catch { assert.fail(`an adapter this run did not own (pid ${p}) disappeared`); } }
});

test('8. expired browser login pauses only browser-dependent work (real managed profile, read-only navigation)', { skip: !up && 'ClaudeBot gateway not reachable' }, async () => {
  const e = new RealEngine(); engines.push(e); await e.start();
  const r = await e.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { workspace_id: e.wsId, kind: 'browser.login_health', objective: 'linkedin.com', inputs: { site: 'linkedin.com' } } });
  const w = await e.waitFor(r.job.id, ['waiting_for_auth', 'completed', 'retry_scheduled', 'failed_terminal'], 180_000);
  if (w.state === 'waiting_for_auth') { assert.equal(w.waiting_on, 'browser:linkedin.com'); assert.match(String(w.operator_action), /sign in/i); }
  else if (w.state === 'completed') { /* profile already signed in: still a valid read-only check */ }
  else assert.fail(`browser check did not resolve to a login state: ${w.state} ${w.failure_detail}`);
  const b = await e.api<{ sites: Array<{ site: string; signed_in: number | null }> }>('/api/browser'); assert.ok(b.sites.some((s) => s.site === 'linkedin.com'));
  const other = await e.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { workspace_id: e.wsId, kind: 'system.workspace_summary', objective: 'unaffected' } });
  assert.equal((await e.waitFor(other.job.id, ['completed'], 30_000)).state, 'completed');
  const db = fixtureDb(e.home, { readOnly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'waiting_for_auth' AND waiting_on LIKE 'browser:%'").get() as { n: number }).n; db.close();
  assert.ok(n <= 1);
});
