/**
 * Turns that run inside the assistants' computer (phase 2). The engine and the ledger stay on the Mac; the OpenClaw gateway,
 * acpx and Claude Code run in the VM. Each task folder is copied into the VM before a turn and back after it (no shared folders,
 * by design), the VM gets this task's capability and the claudebot tool bridge, and the turn runs there with the VM path as cwd.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ModelRuntime, TurnRequest, TurnResult, RuntimeHealth } from './types.ts';
import { readCapability } from '../broker/capabilities.ts';
const run = promisify(execFile);

export const VM_DATA = '/mnt/lima-claudebot-computer-data';
export const VM_WORKSPACES = `${VM_DATA}/workspace`;
const NAME = process.env.CLAUDEBOT_COMPUTER_NAME ?? 'claudebot-computer';
const SSH_CONFIG = path.join(os.homedir(), '.lima', NAME, 'ssh.config');
const SSH_HOST = `lima-${NAME}`;
const EXCLUDE = ['--exclude', '.mcp.json', '--exclude', '.claudebot/', '--exclude', '.claude/', '--exclude', '/shared'];
/** The team's shared folder inside the computer: every task folder gets it as ./shared (same files for every assistant). */
export const VM_SHARED = `${VM_WORKSPACES}/_shared`;

/** The VM path of a host task folder; only folders under the engine's workspaces root are ever mapped. */
export function vmPath(hostWorkspaces: string, hostDir: string): string {
  const rel = path.relative(path.resolve(hostWorkspaces), path.resolve(hostDir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refused: ${hostDir} is not a task folder under ${hostWorkspaces}`);
  return path.posix.join(VM_WORKSPACES, ...rel.split(path.sep));
}
/** The capability key a task folder's .mcp.json names (written by the worker just before the turn). */
export function capabilityKey(hostDir: string): string | null {
  try { const j = JSON.parse(fs.readFileSync(path.join(hostDir, '.mcp.json'), 'utf8')) as { mcpServers?: { claudebot?: { args?: string[] } } }; const a = j.mcpServers?.claudebot?.args ?? []; const i = a.indexOf('--job'); return i >= 0 ? a[i + 1] ?? null : null; } catch { return null; }
}

/** `claude auth status` inside the computer (JSON; never tokens). */
export async function computerAuthStatus(): Promise<string> {
  try { return (await run('ssh', ['-F', SSH_CONFIG, SSH_HOST, `CLAUDE_CONFIG_DIR=${VM_DATA}/claude $HOME/.local/bin/claude auth status`], { timeout: 20_000 })).stdout; }
  catch (e) { const out = (e as { stdout?: string }).stdout; if (out && out.trim().startsWith('{')) return out; throw e; }
}

/** One window per assistant (one shared profile: every window sees the same sign-ins). Which screen each assistant uses. */
export function screenFor(agentRole: string, screens = 3): number { const fixed: Record<string, number> = { researcher: 1, browser_operator: 2 }; return Math.min(screens, fixed[agentRole] ?? 3); }
/** Open a page in a NEW window of the shared browser (DevTools via the local proxy) and move that window to the assistant's screen. */
// One window opens at a time: computerd places the newest browser window, so two assistants opening at once must not interleave.
let placing: Promise<unknown> = Promise.resolve();
export function openOnScreen(cdpPort: number, url: string, screen: number, token: string | null): Promise<{ ok: true; targetId: string } | { ok: false; error: string }> {
  const run = placing.then(() => openOnScreenNow(cdpPort, url, screen, token)); placing = run.catch(() => null); return run;
}
async function openOnScreenNow(cdpPort: number, url: string, screen: number, token: string | null): Promise<{ ok: true; targetId: string } | { ok: false; error: string }> {
  try {
    const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(5000) })).json() as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    const targetId = await new Promise<string>((resolve, reject) => { const tm = setTimeout(() => { reject(new Error('the browser did not answer')); }, 15_000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, newWindow: true } }));
      ws.onmessage = (e) => { const d = JSON.parse(String(e.data)); if (d.id === 1) { clearTimeout(tm); if (d.result?.targetId) resolve(d.result.targetId); else reject(new Error(d.error?.message ?? 'no window')); } };
      ws.onerror = () => { clearTimeout(tm); reject(new Error('could not reach the browser')); }; });
    ws.close();
    await new Promise((r) => setTimeout(r, 600));   // let the window manager map the new window
    await fetch(`http://127.0.0.1:47777/place?screen=${screen}`, { method: 'POST', headers: { authorization: `Bearer ${token ?? ''}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    return { ok: true, targetId };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** OpenClaw's temp root inside the computer (TMPDIR on the data disk, readable by the snap Chromium): uploads/ and downloads/ live here. */
let tmpRootCache: string | null = null;
export async function computerTmpRoot(): Promise<string> {
  if (tmpRootCache) return tmpRootCache;
  const uid = (await run('ssh', ['-F', SSH_CONFIG, '-o', 'BatchMode=yes', SSH_HOST, 'id -u'], { timeout: 20_000 })).stdout.trim();
  tmpRootCache = `${VM_DATA}/tmp/openclaw-${uid}`; return tmpRootCache;
}

/** Put one file at the same path inside the computer (OpenClaw's uploads folder), and fetch one back. Content goes over ssh stdin/stdout. */
export async function toComputer(dest: string, buf: Buffer): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => { const c = execFile('ssh', ['-F', SSH_CONFIG, '-o', 'BatchMode=yes', SSH_HOST, `mkdir -p '${path.posix.dirname(dest)}' && umask 077 && cat > '${dest}'`], { timeout: 60_000 }, (e) => resolve(e ? { ok: false, error: e.message.slice(0, 160) } : { ok: true })); c.stdin?.end(buf); });
}
export async function fromComputer(src: string, dest: string): Promise<{ ok: boolean; error?: string }> {
  try { const r = await new Promise<Buffer>((resolve, reject) => execFile('ssh', ['-F', SSH_CONFIG, '-o', 'BatchMode=yes', SSH_HOST, `cat '${src}' && rm -f '${src}'`], { encoding: 'buffer', maxBuffer: 60 * 1024 * 1024, timeout: 120_000 }, (e, out) => e ? reject(e) : resolve(out as Buffer))); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, r, { mode: 0o600 }); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message.slice(0, 160) }; }
}

export class ComputerRuntime implements ModelRuntime {
  readonly id = 'claude-acp' as const;
  /** turns get ./shared, the team's folder in the computer */
  readonly sharedFolder = true;
  private inner: ModelRuntime; private o: { hostWorkspaces: string; runDir: string; enginePort: number; log: { info: (m: string, d?: Record<string, unknown>) => void; warn: (m: string, d?: Record<string, unknown>) => void }; exec?: (cmd: string, args: string[], input?: string) => Promise<string> };
  constructor(inner: ModelRuntime, o: ComputerRuntime['o']) { this.inner = inner; this.o = o; }
  describe() { const d = this.inner.describe(); return { ...d, label: `${d.label}, inside the assistants' computer`, route: d.route.replace('OpenClaw Gateway', 'OpenClaw Gateway (in the assistants\' computer)') }; }
  health(): Promise<RuntimeHealth> { return this.inner.health(); }
  cancel(ref: string) { return this.inner.cancel(ref); }
  closeSession(ref: string) { return this.inner.closeSession?.(ref) ?? Promise.resolve(); }
  inspectSession(ref: string) { return this.inner.inspectSession?.(ref) ?? Promise.reject(new Error('not supported')); }
  private async x(cmd: string, args: string[], input?: string): Promise<string> {
    if (this.o.exec) return this.o.exec(cmd, args, input);
    if (input === undefined) return (await run(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 })).stdout;
    return new Promise((resolve, reject) => { const c = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (e, out) => e ? reject(e) : resolve(out)); c.stdin?.end(input); });
  }
  private ssh(remote: string, input?: string) { return this.x('ssh', ['-F', SSH_CONFIG, SSH_HOST, remote], input); }
  private rsync(from: string, to: string) { return this.x('rsync', ['-rlt', ...EXCLUDE, '-e', `ssh -F ${SSH_CONFIG}`, from, to]); }

  async startTurn(req: TurnRequest): Promise<TurnResult> {
    const hostDir = req.cwd; let vmDir: string;
    try { vmDir = vmPath(this.o.hostWorkspaces, hostDir); } catch (e) { return { ok: false, category: 'access_denied', message: (e as Error).message, retryable: false } as TurnResult; }
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    try {
      await this.ssh(`mkdir -p ${q(vmDir)}/.claudebot ${q(VM_SHARED)} && chmod 700 ${q(vmDir)}/.claudebot && ln -sfn ${q(VM_SHARED)} ${q(vmDir)}/shared`);
      if (fs.existsSync(hostDir)) await this.rsync(`${hostDir}/`, `${SSH_HOST}:${vmDir}/`);
      const key = capabilityKey(hostDir); const cap = key ? readCapability(this.o.runDir, key) : null;
      if (cap) {
        await this.ssh(`umask 077; cat > ${q(vmDir)}/.claudebot/capability.json`, JSON.stringify({ token: cap.token, job_id: cap.job_id, key: cap.key ?? key }));
        await this.ssh(`cat > ${q(vmDir)}/.mcp.json`, JSON.stringify({ mcpServers: { claudebot: { command: '/opt/node/bin/node', args: ['/opt/claudebot/broker-bridge.mjs'], env: { CLAUDEBOT_ENGINE: `http://host.lima.internal:${this.o.enginePort}`, CLAUDEBOT_CAP_FILE: `${vmDir}/.claudebot/capability.json` } } } }, null, 2));
      }
    } catch (e) { return { ok: false, category: 'crashed', message: `could not prepare the task folder in the assistants' computer: ${(e as Error).message.slice(0, 200)}`, retryable: true } as TurnResult; }
    let r: TurnResult;
    try {
      r = await this.inner.startTurn({ ...req, cwd: vmDir });
      // "Sign in again" only when Claude in the computer really is signed out. A computer that was restarting or briefly unreachable
      // is a transient failure (retried), never a sign-in request to the owner.
      if (!r.ok && (r as { category?: string }).category === 'auth_required') {
        let signedIn = false; try { signedIn = (JSON.parse(await computerAuthStatus()) as { loggedIn?: boolean }).loggedIn === true; } catch { signedIn = false; }
        let reachable = true; try { await computerAuthStatus(); } catch { reachable = false; }
        if (signedIn || !reachable) r = { ...(r as object), category: 'transient', retryable: true, message: `the assistants' computer was not ready (${signedIn ? 'Claude is signed in' : 'unreachable'}); retrying` } as TurnResult;
      }
    }
    finally {
      // Files the turn wrote in the computer come back to the task folder on the Mac (results, drafts, downloads).
      try { fs.mkdirSync(hostDir, { recursive: true }); await this.rsync(`${SSH_HOST}:${vmDir}/`, `${hostDir}/`); } catch (e) { this.o.log.warn('copying files back from the assistants\' computer failed', { err: (e as Error).message.slice(0, 200), hostDir }); }
    }
    return r;
  }
}
