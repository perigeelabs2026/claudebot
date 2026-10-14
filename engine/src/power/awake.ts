/**
 * Keeps the Mac awake only while assistants have active work.
 * On each tick it counts jobs in leased/running; while that count is above zero exactly one
 * `/usr/bin/caffeinate -i -t 600` child is kept alive (respawned when it exits, refreshed every ~5 min
 * so a missed tick never leaves a gap). With no active work, or on stop(), the child is killed and the
 * Mac may sleep normally. macOS only; a no-op elsewhere.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log.ts';

export interface AwakeChild { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean; on(event: 'exit', fn: () => void): unknown; on(event: 'error', fn: (e: Error) => void): unknown; unref?(): void }
export type AwakeSpawn = (cmd: string, args: string[]) => AwakeChild;

export const CAFFEINATE = '/usr/bin/caffeinate';
export const CAFFEINATE_ARGS = ['-i', '-t', '600'];

const defaultSpawn: AwakeSpawn = (cmd, args) => nodeSpawn(cmd, args, { stdio: 'ignore' }) as ChildProcess as AwakeChild;

export class KeepAwake {
  private child: AwakeChild | null = null;
  private startedAt = 0;
  private stopped = false;
  private wasHolding = false;
  private readonly spawn: AwakeSpawn;
  private readonly platform: string;
  private readonly refreshMs: number;
  private readonly now: () => number;

  private readonly db: DatabaseSync;
  private readonly log?: Pick<Logger, 'info' | 'warn'>;

  constructor(db: DatabaseSync, log?: Pick<Logger, 'info' | 'warn'>, opts: { spawn?: AwakeSpawn; platform?: string; refreshMs?: number; now?: () => number } = {}) {
    this.db = db; this.log = log;
    this.spawn = opts.spawn ?? defaultSpawn;
    this.platform = opts.platform ?? process.platform;
    this.refreshMs = opts.refreshMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean { return this.platform === 'darwin'; }
  get holding(): boolean { return this.child !== null; }

  activeCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('leased','running')").get() as { n: number }).n;
  }

  /** Returns the active job count it saw (0 when disabled or stopped). */
  tick(): number {
    if (!this.enabled || this.stopped) return 0;
    let n = 0;
    try { n = this.activeCount(); } catch (e) { this.log?.warn('keep-awake count failed', { err: (e as Error).message }); return 0; }
    if (n > 0) {
      if (this.child && this.now() - this.startedAt >= this.refreshMs) this.release(false);   // refresh before caffeinate's own 600 s timeout
      if (!this.child) this.hold(n);
    } else if (this.child) {
      this.release(true);
    }
    return n;
  }

  stop(): void {
    this.stopped = true;
    if (this.child) this.release(true);
  }

  private hold(active: number): void {
    let c: AwakeChild;
    try { c = this.spawn(CAFFEINATE, CAFFEINATE_ARGS); } catch (e) { this.log?.warn('keep-awake could not start caffeinate', { err: (e as Error).message }); return; }
    const first = !this.wasHolding;
    this.child = c; this.startedAt = this.now(); this.wasHolding = true;
    c.on('exit', () => { if (this.child === c) this.child = null; });   // respawned on the next tick while work remains
    c.on('error', (e) => { if (this.child === c) this.child = null; this.log?.warn('keep-awake caffeinate error', { err: e.message }); });
    c.unref?.();
    if (first) this.log?.info('keeping the Mac awake while assistants work', { active, pid: c.pid });
  }

  private release(final: boolean): void {
    const c = this.child; this.child = null;
    if (c && c.exitCode === null && c.signalCode === null) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
    if (final && this.wasHolding) { this.wasHolding = false; this.log?.info('no active work; the Mac may sleep again'); }
  }
}
