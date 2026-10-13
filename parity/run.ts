/**
 * Parity runner: native Claude Code vs ClaudeBot wrapper, on an ISOLATED temporary engine home.
 * Never touches the production database, workspaces or ports. It shares the local OpenClaw gateway (the product has one) but uses its own
 * control session (agent:parity:control), labels every ACP session `parity-<task>` and closes them all at the end. Uses the authenticated isolated
 * Claude profile read-only for login (CLAUDE_CONFIG_DIR is passed through; transcripts it writes there are removed at the end).
 * Writes parity/report.md and a JSON summary; exits non-zero when a case fails on the wrapper side only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { encodeProjectDir } from '../engine/src/maintenance/purge.ts';
const execFileP = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude');
const CFG = process.env.CLAUDEBOT_CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claudebot', 'claude');
const OC = path.join(os.homedir(), '.local', 'bin', 'openclaw');
const PROD_HOME = path.join(os.homedir(), '.claudebot');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Case { name: string; prompt: string; followup?: string; expect: string[]; artifact?: string }
function loadCases(): Case[] {
  return fs.readdirSync(path.join(ROOT, 'parity', 'cases')).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const t = fs.readFileSync(path.join(ROOT, 'parity', 'cases', f), 'utf8'); const g = (k: string) => (t.match(new RegExp(`^${k}: (.*)$`, 'm')) ?? [])[1];
    return { name: f.replace(/\.md$/, ''), prompt: g('prompt')!, followup: g('followup'), expect: (g('expect') ?? '').split(',').map((s) => s.trim()).filter(Boolean), artifact: g('artifact') };
  });
}

class TempEngine {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudebot-parity-'))); port = 48700 + Math.floor(Math.random() * 200); token = crypto.randomBytes(24).toString('base64url'); proc: ChildProcess | null = null;
  constructor() { fs.mkdirSync(path.join(this.home, 'secrets'), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(this.home, 'secrets', 'ui.token'), this.token + '\n', { mode: 0o600 }); fs.copyFileSync(path.join(PROD_HOME, 'secrets', 'gateway.token'), path.join(this.home, 'secrets', 'gateway.token')); fs.chmodSync(path.join(this.home, 'secrets', 'gateway.token'), 0o600); }
  wsId = '';
  async start() {
    const out = fs.openSync(path.join(this.home, 'engine.log'), 'a');
    this.proc = spawn(process.execPath, [path.join(ROOT, 'engine', 'src', 'supervisor', 'main.ts')], { env: { ...process.env, CLAUDEBOT_HOME: this.home, CLAUDEBOT_PORT: String(this.port), CLAUDEBOT_WORKERS: '2', CLAUDEBOT_CLAUDE_CONFIG_DIR: CFG, CLAUDEBOT_SKIP_AUTH_PRECHECK: '1', CLAUDEBOT_CONTROL_SESSION: 'agent:parity:control', CLAUDEBOT_SESSION_LABEL_PREFIX: 'parity-' }, stdio: ['ignore', out, out] });
    const deadline = Date.now() + 30_000; let up = false; while (Date.now() < deadline) { try { await this.api('/api/health'); up = true; break; } catch { await sleep(300); } } if (!up) throw new Error('temp engine did not start');
    this.wsId = (await this.api<{ id: string }>('/api/workspaces', { method: 'POST', body: { name: 'Parity (temporary)', worker_limit: 4 } })).id;
    // A lenient owner workflow for parity: one Claude turn, no evidence/artifact contract, so the comparison is about the reply and files, not contract strictness.
    const r = await this.api<{ error?: string; errors?: string[] }>('/api/workflows', { method: 'POST', body: { id: 'parity.turn', name: 'Parity turn', default_agent: 'builder', stages: [{ name: 'prepare', kind: 'deterministic', fn: 'prepare_workspace' }, { name: 'turn', kind: 'claude', timeoutMs: 15 * 60_000, prompt: 'Task: {{objective}}\nWork inside the current folder. If you write files, register each with write_artifact. End your reply with DONE on its own line.' }], contract: { requires_keys: ['summary'] } } });
    if (r.error || r.errors) throw new Error('parity workflow: ' + (r.error ?? r.errors?.join('; ')));
  }
  async api<T = Record<string, unknown>>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> { const r = await fetch(`http://127.0.0.1:${this.port}${p}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', 'x-claudebot-token': this.token }, body: init.body ? JSON.stringify(init.body) : undefined }); return r.json() as Promise<T>; }
  async stop() { if (this.proc) { const p = this.proc; this.proc = null; p.kill('SIGTERM'); await new Promise<void>((r) => { p.on('exit', () => r()); setTimeout(r, 20_000); }); } }
  /** Cleanup lifecycle: close ACP sessions this engine spawned, delete its Claude transcripts, remove the home. */
  async cleanup() {
    try { const keys = (fs.readFileSync(path.join(this.home, 'engine.log'), 'utf8').match(/agent:[a-z_]+:acp:[0-9a-f-]{36}/g) ?? []); for (const k of new Set(keys)) await closeAcp(k); } catch { /* best effort */ }
    const projects = path.join(CFG, 'projects'); const prefix = encodeProjectDir(path.join(this.home, 'workspaces'));
    if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects)) if (d.startsWith(prefix)) fs.rmSync(path.join(projects, d), { recursive: true, force: true });
    fs.rmSync(this.home, { recursive: true, force: true });
  }
}
async function closeAcp(key: string) {
  const { GatewayClient } = await import('../engine/src/gateway/client.ts'); const { createLogger } = await import('../engine/src/log.ts');
  const gw = new GatewayClient({ url: 'ws://127.0.0.1:48310', tokenFile: path.join(PROD_HOME, 'secrets', 'gateway.token'), log: createLogger({ name: 'parity', stream: { write: () => true } as never }) });
  try { await gw.connect(); await gw.call('chat.send', { sessionKey: 'agent:parity:control', message: `/acp close ${key}`, idempotencyKey: crypto.randomUUID() }, 20_000); await sleep(1500); } catch { /* */ } finally { gw.close(); }
}

async function native(c: Case, dir: string): Promise<{ text: string; files: string[]; ms: number }> {
  const t0 = Date.now(); let text = '';
  const run = async (prompt: string, extra: string[] = []) => { const { stdout } = await execFileP(CLAUDE, ['-p', prompt, '--output-format', 'json', '--max-turns', '8', ...extra], { cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: CFG }, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(stdout) as { result?: string; is_error?: boolean }; };
  const a = await run(c.prompt); text = String(a.result ?? '');
  if (c.followup) { const b = await run(c.followup, ['--continue']); text += '\n' + String(b.result ?? ''); }
  return { text, files: fs.readdirSync(dir).filter((f) => !f.startsWith('.')), ms: Date.now() - t0 };
}

async function wrapper(e: TempEngine, c: Case): Promise<{ text: string; files: string[]; state: string; ms: number; checkpoints: number; artifacts: number }> {
  const t0 = Date.now();
  const r = await e.api<{ job: { id: string } }>('/api/tasks', { method: 'POST', body: { workspace_id: e.wsId, kind: 'parity.turn', objective: c.prompt + (c.followup ? `\nThen: ${c.followup}` : '') } });
  let job: Record<string, unknown> = {}; const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) { const d = await e.api<{ job: Record<string, unknown> }>(`/api/jobs/${r.job.id}`); job = d.job; if (['completed', 'failed_terminal', 'waiting_for_auth', 'waiting_for_reset', 'cancelled'].includes(String(job.state))) break; await sleep(3000); }
  const d = await e.api<{ checkpoints: unknown[]; artifacts: unknown[]; events: Array<{ type: string; detail: Record<string, unknown> }> }>(`/api/jobs/${r.job.id}`);
  const ws = path.join(e.home, 'workspaces', e.wsId, 'tasks', r.job.id);
  const files = fs.existsSync(ws) ? fs.readdirSync(ws).filter((f) => !f.startsWith('.') && f !== 'JOB.md') : [];
  // The final reply lives in the last 'after' checkpoint of the turn stage (summary) in the temp DB.
  const { DatabaseSync } = await import('node:sqlite'); const tdb = new DatabaseSync(path.join(e.home, 'data', 'claudebot.sqlite'), { readOnly: true });
  const cp = tdb.prepare("SELECT payload FROM checkpoints WHERE job_id = ? AND stage_name = 'turn' AND phase = 'after' ORDER BY id DESC LIMIT 1").get(r.job.id) as { payload: string } | undefined; tdb.close();
  const summary = cp ? String(((JSON.parse(cp.payload) as { result?: { summary?: string } }).result ?? {}).summary ?? '') : '';
  const text = [summary, String(job.failure_detail ?? ''), ...files.filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(ws, f), 'utf8'))].join('\n');
  return { text, files, state: String(job.state), ms: Date.now() - t0, checkpoints: d.checkpoints.length, artifacts: d.artifacts.length };
}

/** Residue from a previous run that was killed mid-case: temp homes/native dirs under the OS temp dir and the transcripts they left in the isolated profile. */
function sweepStaleResidue(): { dirs: number; transcripts: number } {
  let dirs = 0; let transcripts = 0;
  const tmp = fs.realpathSync(os.tmpdir());
  for (const d of fs.readdirSync(tmp)) if (/^claudebot-parity-/.test(d)) { fs.rmSync(path.join(tmp, d), { recursive: true, force: true }); dirs++; }
  const projects = path.join(CFG, 'projects'); const prefix = encodeProjectDir(path.join(tmp, 'claudebot-parity-'));
  if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects)) if (d.startsWith(prefix)) { fs.rmSync(path.join(projects, d), { recursive: true, force: true }); transcripts++; }
  return { dirs, transcripts };
}

async function main() {
  const stale = sweepStaleResidue(); if (stale.dirs || stale.transcripts) console.error(`parity: swept residue from an earlier run (${stale.dirs} temp dirs, ${stale.transcripts} transcript dirs)`);
  const status = JSON.parse((() => { try { return execFileSync(CLAUDE, ['auth', 'status'], { env: { ...process.env, CLAUDE_CONFIG_DIR: CFG } }).toString(); } catch (e) { return String((e as { stdout?: Buffer }).stdout ?? '{}'); } })()) as { loggedIn?: boolean };
  const lines: string[] = [`# Parity report (${new Date().toISOString()})`, '', `Isolated Claude profile login: ${status.loggedIn ? 'yes' : 'no'}. Runner home: temporary (never the production database).`, ''];
  if (!status.loggedIn) { lines.push('## HUMAN_CHECK_REQUIRED', '', `Sign in first: \`CLAUDE_CONFIG_DIR=${CFG} claude auth login --claudeai\``); fs.writeFileSync(path.join(ROOT, 'parity', 'report.md'), lines.join('\n') + '\n'); console.log(lines.join('\n')); process.exit(3); }
  const e = new TempEngine(); let failed = 0; const summary: unknown[] = [];
  let bailing = false;
  const bail = (sig: string) => { if (bailing) return; bailing = true; console.error(`parity: ${sig}; stopping the temporary engine and removing its residue`); e.stop().then(() => e.cleanup()).finally(() => { sweepStaleResidue(); process.exit(130); }); };
  process.on('SIGTERM', () => bail('SIGTERM')); process.on('SIGINT', () => bail('SIGINT')); process.on('SIGHUP', () => bail('SIGHUP'));
  try {
    await e.start();
    lines.push('| case | native | wrapper | expect native | expect wrapper | files native | files wrapper | checkpoints | artifacts | verdict |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const c of loadCases()) {
      const ndir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudebot-parity-native-')));
      const n = await native(c, ndir).catch((err) => ({ text: `ERROR ${(err as Error).message}`, files: [] as string[], ms: 0 }));
      const w = await wrapper(e, c).catch((err) => ({ text: `ERROR ${(err as Error).message}`, files: [] as string[], state: 'error', ms: 0, checkpoints: 0, artifacts: 0 }));
      const hit = (t: string) => c.expect.filter((k) => t.toLowerCase().includes(k.toLowerCase())).length;
      const hn = hit(n.text); const hw = hit(w.text);
      const verdict = w.state === 'completed' && hw >= hn ? 'PASS' : w.state === 'completed' && hw > 0 ? 'PARTIAL' : 'FAIL';
      if (verdict === 'FAIL') failed++;
      lines.push(`| ${c.name} | ${n.text.length} chars, ${(n.ms / 1000).toFixed(0)}s | ${w.state}, ${(w.ms / 1000).toFixed(0)}s | ${hn}/${c.expect.length} | ${hw}/${c.expect.length} | ${n.files.join(' ') || '-'} | ${w.files.join(' ') || '-'} | ${w.checkpoints} | ${w.artifacts} | ${verdict} |`);
      summary.push({ case: c.name, native: { chars: n.text.length, ms: n.ms, files: n.files, hits: hn }, wrapper: { state: w.state, ms: w.ms, files: w.files, hits: hw, checkpoints: w.checkpoints, artifacts: w.artifacts }, verdict });
      const prefix = encodeProjectDir(ndir); const projects = path.join(CFG, 'projects'); if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects)) if (d.startsWith(prefix)) fs.rmSync(path.join(projects, d), { recursive: true, force: true });
      fs.rmSync(ndir, { recursive: true, force: true });
    }
    lines.push('', 'Dimensions not covered by cases: usage-limit behavior (exercised by the recovery pack with the adapter phrasing), restart recovery (recovery pack), approval behavior (recovery pack), browser capability (role-gated `browser_read`; a case needs an owner-signed-in site).');
  } finally { await e.stop(); await e.cleanup(); }
  fs.writeFileSync(path.join(ROOT, 'parity', 'report.md'), lines.join('\n') + '\n'); fs.writeFileSync(path.join(ROOT, 'parity', 'report.json'), JSON.stringify({ at: new Date().toISOString(), cases: summary }, null, 2));
  console.log(lines.join('\n'));
  process.exit(failed ? 1 : 0);
}
await main();
