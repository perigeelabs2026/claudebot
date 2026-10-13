import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { JobStore } from '../jobs/store.ts';
import type { Logger } from '../log.ts';
import type { EngineConfig } from '../config.ts';
import type { Settings } from '../model/settings.ts';

export interface WorkerInfo { pid: number; startedAt: string; restarts: number; child: ChildProcess; exited: boolean; exitCode: number | null }
export interface Capacity { worker_limit: number; workers_alive: number; active: number; queued: number; waiting: number; governor: { paused: boolean; level_pct: number; floor_pct: number; free_mb: number }; per_workspace: Array<{ workspace_id: string | null; limit: number | null; active: number; queued: number }>; per_agent: Array<{ agent: string; limit: number | null; active: number }> }

/**
 * Spawns and supervises single-job worker children up to the configured global limit, reclaims expired leases,
 * promotes due retries, and publishes the resource-pressure verdict workers consult before taking a new lease.
 */
export class Dispatcher {
  private cfg: EngineConfig; private store: JobStore; private log: Logger; private settings: Settings;
  workers = new Map<number, WorkerInfo>();
  private stopping = false; private restarts = 0;
  private env: NodeJS.ProcessEnv;
  constructor(cfg: EngineConfig, store: JobStore, log: Logger, settings: Settings, env: NodeJS.ProcessEnv = {}) { this.cfg = cfg; this.store = store; this.log = log; this.settings = settings; this.env = env; }

  get desired(): number { const envLimit = process.env.CLAUDEBOT_WORKERS ? Number(process.env.CLAUDEBOT_WORKERS) : null; return Math.max(1, envLimit ?? Number(this.settings.get('worker_limit'))); }

  spawnWorker(): WorkerInfo {
    const entry = path.join(this.cfg.sourceRoot, 'engine', 'src', 'worker', 'main.ts');
    const child = spawn(process.execPath, [entry], { env: { ...process.env, ...this.env, CLAUDEBOT_HOME: this.cfg.home, CLAUDEBOT_SUPERVISOR_PID: String(process.pid), ...(process.env.CLAUDEBOT_SIM_AUTHED ? { CLAUDEBOT_SIM_AUTHED: process.env.CLAUDEBOT_SIM_AUTHED } : {}) }, stdio: ['ignore', 'inherit', 'inherit'] });
    const info: WorkerInfo = { pid: child.pid!, startedAt: new Date().toISOString(), restarts: this.restarts, child, exited: false, exitCode: null };
    this.workers.set(child.pid!, info); this.log.info('worker spawned', { pid: child.pid, desired: this.desired }); this.writePidFile();
    child.on('exit', (code, signal) => { info.exited = true; info.exitCode = code; this.log.warn('worker exited', { pid: info.pid, code, signal }); this.workers.delete(info.pid); this.writePidFile(); if (!this.stopping) { this.restarts++; setTimeout(() => { if (!this.stopping) this.ensureWorkers(); }, Math.min(10_000, 500 * this.restarts)); } });
    return info;
  }

  /** Scale the worker pool to the configured limit: spawn missing workers, ask surplus idle ones to stop. */
  ensureWorkers(): void {
    if (this.stopping) return;
    while (this.workers.size < this.desired) this.spawnWorker();
    if (this.workers.size > this.desired) {
      const leased = new Set((this.store.db.prepare("SELECT lease_owner FROM jobs WHERE state IN ('leased','running') AND lease_owner IS NOT NULL").all() as Array<{ lease_owner: string }>).map((r) => Number(r.lease_owner.split(':')[1])));
      for (const w of [...this.workers.values()].filter((w) => !leased.has(w.pid)).slice(0, this.workers.size - this.desired)) { this.log.info('scaling down idle worker', { pid: w.pid }); w.child.kill('SIGTERM'); }
    }
  }

  /** Resource-pressure governor: when the kernel's available-memory level drops below the floor, NEW starts pause; running work is never killed. */
  governor(): { paused: boolean; level_pct: number; floor_pct: number; free_mb: number } {
    // Pause only when BOTH the kernel's level is under the floor AND fewer than 2 GB of pages are actually reclaimable,
    // so a transient dip of the level during compression never stalls work the machine can carry.
    const floor = Number(this.settings.get('memory_pressure_floor_pct')); const level = memoryLevelPct(); const free = Math.round(freeMemoryMb());
    return { paused: level < floor && free < 2048, level_pct: level, floor_pct: floor, free_mb: free };
  }

  /** Housekeeping tick: reclaim stale leases, promote due retries/probes, publish the governor verdict for workers. */
  tick(): { reclaimed: number; promoted: number } {
    const reclaimed = this.store.reclaimExpired('supervisor'); const promoted = this.store.promoteDue('supervisor');
    if (reclaimed.length) this.log.warn('reclaimed stale leases', { jobs: reclaimed.map((j) => j.id) });
    const g = this.governor();
    this.store.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('governor', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify(g), 'dispatcher tick', new Date().toISOString());
    return { reclaimed: reclaimed.length, promoted: promoted.length };
  }

  capacity(): Capacity {
    const db = this.store.db;
    const row = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...(a as never[])) as { n: number }).n;
    const perWs = db.prepare("SELECT j.workspace_id, w.worker_limit AS wlimit, SUM(CASE WHEN j.state IN ('leased','running') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN j.state = 'queued' THEN 1 ELSE 0 END) AS queued FROM jobs j LEFT JOIN workspaces w ON w.id = j.workspace_id WHERE j.state IN ('leased','running','queued') GROUP BY j.workspace_id").all() as Array<{ workspace_id: string | null; wlimit: number | null; active: number; queued: number }>;
    const perAgent = db.prepare("SELECT j.agent_role AS agent, a.concurrency_limit AS alimit, COUNT(*) AS active FROM jobs j LEFT JOIN agent_definitions a ON a.id = j.agent_role WHERE j.state IN ('leased','running') GROUP BY j.agent_role").all() as Array<{ agent: string; alimit: number | null; active: number }>;
    return { worker_limit: this.desired, workers_alive: this.workers.size, active: row("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('leased','running')"), queued: row("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'"), waiting: row("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('waiting_for_auth','waiting_for_reset','waiting_for_approval','retry_scheduled')"), governor: this.governor(), per_workspace: perWs.map((w) => ({ workspace_id: w.workspace_id, limit: w.wlimit, active: Number(w.active), queued: Number(w.queued) })), per_agent: perAgent.map((a) => ({ agent: a.agent, limit: a.alimit, active: Number(a.active) })) };
  }

  private writePidFile() { fs.mkdirSync(this.cfg.runDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(this.cfg.runDir, 'workers.json'), JSON.stringify({ supervisor: process.pid, workers: [...this.workers.keys()] }), { mode: 0o600 }); }

  /** Kill workers left by a previous supervisor so no orphan keeps running. */
  reapOrphans(): number[] {
    const f = path.join(this.cfg.runDir, 'workers.json'); if (!fs.existsSync(f)) return [];
    const killed: number[] = [];
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { supervisor: number; workers: number[] }; if (j.supervisor === process.pid) return []; for (const pid of j.workers) { try { process.kill(pid, 0); process.kill(pid, 'SIGTERM'); killed.push(pid); } catch { /* not running */ } } } catch { /* ignore */ }
    if (killed.length) this.log.warn('reaped orphan workers from previous supervisor', { killed });
    return killed;
  }

  async stop(graceMs = 20_000): Promise<void> {
    this.stopping = true;
    for (const w of this.workers.values()) { try { w.child.kill('SIGTERM'); } catch { /* */ } }
    const deadline = Date.now() + graceMs; while (this.workers.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    for (const w of this.workers.values()) { try { w.child.kill('SIGKILL'); } catch { /* */ } }
    this.workers.clear(); this.writePidFile();
  }
}

/** macOS: kern.memorystatus_level is the percentage of memory the kernel still considers available (100 = no pressure). */
export function memoryLevelPct(): number {
  if (process.platform === 'darwin') { try { const v = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8', timeout: 2000 }).trim()); if (Number.isFinite(v)) return v; } catch { /* fall through */ } }
  return Math.round((os.freemem() / os.totalmem()) * 100);
}

/** macOS reports low "free" memory by design; count inactive + free pages as available, like Activity Monitor's pressure view. */
export function freeMemoryMb(): number {
  if (process.platform === 'darwin') {
    try { const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }); const page = Number((out.match(/page size of (\d+)/) ?? [])[1] ?? 16384); const g = (k: string) => Number((out.match(new RegExp(`${k}:\\s+(\\d+)`)) ?? [])[1] ?? 0); return ((g('Pages free') + g('Pages inactive') + g('Pages speculative')) * page) / 2 ** 20; } catch { /* fall through */ }
  }
  return os.freemem() / 2 ** 20;
}
