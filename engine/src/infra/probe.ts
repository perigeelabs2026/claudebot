/**
 * Leashed external probes.
 *
 * Every external process the engine starts for a health probe (OpenClaw CLI, `claude auth status`, browser
 * checks) runs through here. The guarantees, each of which is tested in test/unit/probe.test.ts:
 *
 *  1. A probe runs in its own process group (detached session) under a tiny perl leash. The leash arms a
 *     kernel alarm and SIGKILLs the whole group when the deadline passes. The alarm lives in the probe's
 *     own group, so it fires even when the engine that started the probe has been SIGKILLed. Without
 *     this, a probe that hangs after its parent dies lives forever (2026-10-06: 192 orphaned
 *     `openclaw browser profiles` probes at ~160 MB each exhausted a 24 GB machine).
 *  2. The engine side also enforces the deadline (belt and braces) and kills stragglers in the group when
 *     the leader exits, so a wrapper's grandchild cannot outlive the probe.
 *  3. A per-process storm guard refuses to start more than CLAUDEBOT_PROBE_MAX_IN_FLIGHT (default 4)
 *     probes at once; the caller gets an immediate failure instead of a new process.
 *  4. Every probe is recorded in <runDir>/probes/<pgid>.json while it runs; `reapOrphanProbes` kills any
 *     recorded group whose engine is gone or whose deadline passed (for the installed engine's restarts).
 *  5. All in-flight groups are killed when the engine process exits normally.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';

export interface ProbeResult {
  ok: boolean; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  timedOut: boolean; killed: boolean; ms: number; pgid: number | null; skipped?: 'storm_guard' | 'spawn_failed';
}
export interface ProbeOptions { timeoutMs: number; label: string; env?: NodeJS.ProcessEnv; cwd?: string; maxBuffer?: number; registryDir?: string }

/** The leash: fork+exec the command, alarm at the deadline, SIGKILL the entire group (including self). */
const LEASH = `#claudebot-probe
my $t = shift @ARGV; my $pid = fork();
exit 125 unless defined $pid;
if ($pid == 0) { exec { $ARGV[0] } @ARGV; exit 127; }
$SIG{ALRM} = sub { kill 'KILL', $pid; kill 'KILL', -$$; exit 124; };
$SIG{TERM} = $SIG{INT} = $SIG{HUP} = sub { kill 'KILL', $pid; kill 'KILL', -$$; exit 143; };
alarm $t;
waitpid($pid, 0); my $st = $?; alarm 0;
{ local $SIG{TERM} = 'IGNORE'; kill 'TERM', -$$; }
exit(($st & 127) ? 128 + ($st & 127) : ($st >> 8));
`;

const inflight = new Map<number, { label: string; child: ChildProcess; file: string | null }>();
let exitHook = false;

function maxInFlight(): number { const n = Number(process.env.CLAUDEBOT_PROBE_MAX_IN_FLIGHT ?? 4); return Number.isFinite(n) && n > 0 ? n : 4; }
function defaultRegistryDir(): string { try { return path.join(loadConfig().runDir, 'probes'); } catch { return path.join(process.env.TMPDIR ?? '/tmp', 'claudebot-probes'); } }

export function killGroup(pgid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean { try { process.kill(-pgid, signal); return true; } catch { return false; } }
export function groupMembers(pgid: number): number[] {
  try { return execFileSync('/usr/bin/pgrep', ['-g', String(pgid)], { encoding: 'utf8', timeout: 3000 }).split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
}
export function inFlightProbes(): Array<{ pgid: number; label: string }> { return [...inflight.entries()].map(([pgid, v]) => ({ pgid, label: v.label })); }

/** Kill every probe group this process started. Returns the number of groups signalled. */
export function killAllProbes(): number {
  let n = 0;
  for (const [pgid, v] of inflight) { if (killGroup(pgid)) n++; if (v.file) { try { fs.rmSync(v.file, { force: true }); } catch { /* ignore */ } } }
  return n;
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }

/**
 * Kill recorded probe groups whose engine process is gone or whose deadline has passed. Only groups whose
 * members still look like probes (perl leash, openclaw, claude, node, sh) are signalled, so a recycled pgid
 * belonging to something else is left alone and its record dropped.
 */
export function reapOrphanProbes(registryDir: string = defaultRegistryDir(), log?: { warn: (msg: string, data?: Record<string, unknown>) => void }): number {
  let files: string[] = []; try { files = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let reaped = 0;
  for (const f of files) {
    const file = path.join(registryDir, f);
    let rec: { pgid: number; label: string; engine_pid: number; deadline: string } | null = null;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } continue; }
    if (!rec || !Number.isInteger(rec.pgid)) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } continue; }
    const ours = rec.engine_pid === process.pid && inflight.has(rec.pgid);
    const engineGone = !alive(rec.engine_pid);
    const expired = Date.parse(rec.deadline) + 5_000 < Date.now();
    if (ours && !expired) continue;
    if (!engineGone && !expired) continue;
    const members = groupMembers(rec.pgid);
    if (members.length) {
      let cmds = '';
      try { cmds = execFileSync('/bin/ps', ['-o', 'command=', '-p', members.join(',')], { encoding: 'utf8', timeout: 3000 }); } catch { /* ignore */ }
      if (/claudebot-probe|openclaw|claude|perl|node|\/bin\/sh/.test(cmds)) { killGroup(rec.pgid); reaped++; log?.warn('orphaned probe group killed', { pgid: rec.pgid, label: rec.label, engine_pid: rec.engine_pid, engine_gone: engineGone, expired, members: members.length }); }
    }
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    inflight.delete(rec.pgid);
  }
  return reaped;
}

/** Start a leashed probe. `pgid` is known immediately; `result` resolves when the group leader exits. */
export function startProbe(cmd: string, args: string[], o: ProbeOptions): { pgid: number | null; result: Promise<ProbeResult> } {
  const t0 = Date.now();
  if (inflight.size >= maxInFlight()) {
    const labels = [...inflight.values()].map((x) => x.label).join(', ');
    return { pgid: null, result: Promise.resolve({ ok: false, code: null, signal: null, stdout: '', stderr: `probe storm guard: ${inflight.size} probes already in flight (${labels}); refused to start ${o.label}`, timedOut: false, killed: false, ms: 0, pgid: null, skipped: 'storm_guard' }) };
  }
  if (!exitHook) { exitHook = true; process.on('exit', () => { killAllProbes(); }); }
  const secs = Math.max(1, Math.ceil(o.timeoutMs / 1000));
  const leash = process.env.CLAUDEBOT_PROBE_LEASH !== 'off';
  const env = o.env ?? process.env;
  let child: ChildProcess;
  try {
    child = leash
      ? spawn('/usr/bin/perl', ['-e', LEASH, '--', String(secs), cmd, ...args], { detached: true, env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(cmd, args, { detached: true, env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { pgid: null, result: Promise.resolve({ ok: false, code: null, signal: null, stdout: '', stderr: `spawn failed: ${(e as Error).message}`, timedOut: false, killed: false, ms: Date.now() - t0, pgid: null, skipped: 'spawn_failed' }) };
  }
  const pgid = child.pid ?? null;
  let file: string | null = null;
  if (pgid) {
    const dir = o.registryDir ?? defaultRegistryDir();
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); file = path.join(dir, `${pgid}.json`); fs.writeFileSync(file, JSON.stringify({ pgid, label: o.label, engine_pid: process.pid, started_at: new Date(t0).toISOString(), deadline: new Date(t0 + o.timeoutMs).toISOString(), cmd, args }), { mode: 0o600 }); } catch { file = null; }
    inflight.set(pgid, { label: o.label, child, file });
  }
  const maxBuffer = o.maxBuffer ?? 8 * 1024 * 1024;
  let stdout = ''; let stderr = ''; let timedOut = false; let killed = false; let overflow = false;
  const hard = setTimeout(() => { timedOut = true; if (pgid) { killed = killGroup(pgid) || killed; } }, o.timeoutMs + 1500);
  const onData = (which: 'out' | 'err') => (chunk: Buffer) => {
    if (which === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
    if (stdout.length + stderr.length > maxBuffer && !overflow) { overflow = true; if (pgid) killGroup(pgid); }
  };
  child.stdout?.on('data', onData('out')); child.stderr?.on('data', onData('err'));
  const result = new Promise<ProbeResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
      clearTimeout(hard);
      if (pgid) { killGroup(pgid); inflight.delete(pgid); }
      if (file) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
      const ms = Date.now() - t0;
      if (!timedOut && (code === 124 || (signal === 'SIGKILL' && ms >= o.timeoutMs - 50))) timedOut = true;
      const ok = !err && !timedOut && !overflow && code === 0;
      resolve({ ok, code, signal, stdout, stderr: err ? `${stderr}${(err as Error).message}` : overflow ? `${stderr} [output over ${maxBuffer} bytes; killed]` : stderr, timedOut, killed: killed || timedOut, ms, pgid, ...(err ? { skipped: 'spawn_failed' as const } : {}) });
    };
    child.once('error', (e) => finish(null, null, e));
    child.once('close', (code, signal) => finish(code, signal));
  });
  return { pgid, result };
}

export function runProbe(cmd: string, args: string[], o: ProbeOptions): Promise<ProbeResult> { return startProbe(cmd, args, o).result; }
