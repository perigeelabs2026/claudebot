import path from 'node:path';
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import type { Logger } from '../log.ts';
import type { EngineConfig } from '../config.ts';
import type { ModelRuntime, RuntimeHealth } from '../runtime/types.ts';
import { browserStatus } from '../browser/health.ts';
import { runProbe } from '../infra/probe.ts';

export interface SubsystemHealth { ok: boolean; state: string; detail: string; observed_at: string; evidence?: Record<string, unknown> }
export interface HealthReport { ui: SubsystemHealth; queue: SubsystemHealth; gateway: SubsystemHealth; claude: SubsystemHealth; browser: SubsystemHealth; workers: SubsystemHealth; last_recovery_test?: Record<string, unknown> | null }

export class Watchdog {
  private cfg: EngineConfig; private db: DB; private store: JobStore; private log: Logger; private runtime: ModelRuntime;
  private workersCount: () => number; private workersDesired: () => number;
  last: HealthReport | null = null;
  gatewayRestarts = 0;
  constructor(cfg: EngineConfig, db: DB, store: JobStore, runtime: ModelRuntime, log: Logger, workersCount: () => number, workersDesired: () => number = workersCount) { this.cfg = cfg; this.db = db; this.store = store; this.runtime = runtime; this.log = log; this.workersCount = workersCount; this.workersDesired = workersDesired; }

  private setState(key: string, value: unknown, evidence: string) {
    this.db.prepare('INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at').run(key, JSON.stringify(value), evidence, new Date().toISOString());
  }

  /** Honest placeholder while the first check runs: every subsystem is 'checking', never 'ok'. */
  pendingReport(): HealthReport {
    const t = new Date().toISOString(); const c = (what: string): SubsystemHealth => ({ ok: false, state: 'checking', detail: `${what}: first check in progress`, observed_at: t });
    return { ui: { ok: true, state: 'ok', detail: 'engine API serving', observed_at: t }, queue: c('queue'), gateway: c('gateway'), claude: c('claude'), browser: c('browser'), workers: c('workers'), last_recovery_test: null };
  }

  private inFlight: Promise<HealthReport> | null = null;
  /** Concurrent callers share one in-flight check (the first browser/claude probe can take ~10 s). */
  check(opts: { restartGateway?: boolean } = {}): Promise<HealthReport> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck(opts).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runCheck(opts: { restartGateway?: boolean }): Promise<HealthReport> {
    const t = new Date().toISOString();
    const q = this.db.prepare(`SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`).all() as Array<{ state: string; n: number }>;
    const counts = Object.fromEntries(q.map((r) => [r.state, r.n]));
    const stale = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('leased','running') AND lease_expires_at < ?`).get(t) as { n: number };
    const queue: SubsystemHealth = { ok: stale.n === 0, state: stale.n ? 'stale_leases' : 'ok', detail: `${counts.queued ?? 0} queued, ${(counts.leased ?? 0) + (counts.running ?? 0)} active, ${stale.n} stale leases`, observed_at: t, evidence: counts };
    let rh: RuntimeHealth;
    try { rh = await this.runtime.health(); } catch (e) { rh = { id: this.runtime.id, configured: true, ok: false, state: 'unreachable', detail: (e as Error).message, observedAt: t }; }
    const simulated = this.runtime.id === 'simulated';
    const gatewayOk = !simulated && rh.state !== 'unreachable';
    const gateway: SubsystemHealth = simulated
      ? { ok: true, state: 'bypassed', detail: 'simulated runtime in use; the OpenClaw gateway is not exercised', observed_at: t }
      : { ok: gatewayOk, state: gatewayOk ? 'ok' : 'unreachable', detail: gatewayOk ? `OpenClaw gateway reachable at ${this.cfg.gatewayUrl} (health RPC answered)` : rh.detail, observed_at: t };
    if (!simulated && !gatewayOk && opts.restartGateway) {
      try { this.gatewayRestarts++; this.log.warn('gateway unreachable; restarting service', { attempt: this.gatewayRestarts }); const r = await runProbe(this.cfg.openclawBin, ['--profile', this.cfg.openclawProfile, 'gateway', 'restart'], { timeoutMs: 60_000, label: 'gateway.restart', registryDir: path.join(this.cfg.runDir, 'probes') }); if (!r.ok) throw new Error(r.timedOut ? 'timed out (killed)' : (r.stderr || r.stdout || `exit ${r.code}`).slice(0, 120)); gateway.detail += ' (restart requested)'; } catch (e) { gateway.detail += ` (restart failed: ${(e as Error).message.slice(0, 120)})`; }
    }
    const capacity = this.db.prepare("SELECT value, observed_at FROM runtime_state WHERE key = 'claude.capacity'").get() as { value: string; observed_at: string } | undefined;
    const cap = capacity ? JSON.parse(capacity.value) as { limited?: boolean; reset_at?: string | null } : {};
    const limitedNow = !!cap.limited && (!cap.reset_at || Date.parse(cap.reset_at) > Date.now());
    if (cap.limited && !limitedNow) this.setState('claude.capacity', { limited: false }, 'reset time passed');
    const claude: SubsystemHealth = {
      ok: rh.state === 'ready' && !limitedNow,
      state: limitedNow ? 'limited' : rh.state,
      detail: limitedNow ? `plan limit; resumes ${cap.reset_at ? 'at ' + cap.reset_at : 'after probe'}` : rh.detail,
      observed_at: t, evidence: { account: rh.account ?? null, route: this.runtime.describe().route },
    };
    // "Logged in" is the runtime's verdict (state), never inferred from a missing account object: an unreachable gateway
    // or a runtime without account metadata must not be recorded as a sign-out.
    const loggedIn = rh.state === 'ready' || rh.state === 'limited' || !!rh.account?.loggedIn;
    this.setState('claude.auth', { loggedIn, state: rh.state, subscription: rh.account?.subscription ?? null, email: rh.account?.email ?? null }, `${this.runtime.id} health: ${rh.detail}`);
    // Auth recovered → resume Claude-dependent jobs.
    if (loggedIn) { const resumed = this.store.resumeWaitingOn('claude'); if (resumed.length) this.log.info('claude login detected; resumed jobs', { jobs: resumed.map((j) => j.id) }); }
    const bs = await browserStatus(this.cfg);
    const browser: SubsystemHealth = { ok: bs.ok, state: bs.state, detail: bs.detail, observed_at: t, evidence: { profiles: bs.profiles ?? null } };
    const wc = this.workersCount();
    const workers: SubsystemHealth = { ok: wc > 0, state: wc > 0 ? 'ok' : 'none', detail: `${wc}/${this.workersDesired()} workers alive`, observed_at: t };
    const lastTest = this.db.prepare("SELECT value, observed_at FROM runtime_state WHERE key = 'recovery.last_test'").get() as { value: string; observed_at: string } | undefined;
    const report: HealthReport = { ui: { ok: true, state: 'ok', detail: 'engine API serving', observed_at: t }, queue, gateway, claude, browser, workers, last_recovery_test: lastTest ? { ...JSON.parse(lastTest.value), observed_at: lastTest.observed_at } : null };
    this.last = report;
    this.setState('health.report', report, 'watchdog check');
    return report;
  }
}
