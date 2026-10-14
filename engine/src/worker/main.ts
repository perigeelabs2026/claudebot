/** Worker child process: leases one job at a time and runs it. Spawned and supervised by claudebotd. */
import { loadConfig } from '../config.ts';
import { createLogger } from '../log.ts';
import { openDatabase } from '../db/open.ts';
import { JobStore } from '../jobs/store.ts';
import { ApprovalStore } from '../approvals/store.ts';
import { ActionStore } from '../actions/store.ts';
import { GatewayClient } from '../gateway/client.ts';
import { makeRuntime, applyComputerBrowser } from '../runtime/select.ts';
import { SimulatedRuntime } from '../runtime/simulated.ts';
import { runJob } from './run.ts';
import { browserLoginCheck } from '../browser/health.ts';
import path from 'node:path';
import type { ModelRuntime } from '../runtime/types.ts';

const cfg = loadConfig();
const owner = `worker:${process.pid}`;
const log = createLogger({ name: 'worker', file: path.join(cfg.logsDir, 'worker.log'), base: { pid: process.pid } });
const db = openDatabase(cfg.dbPath);
const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
applyComputerBrowser(cfg, db);
const picked = makeRuntime(cfg, db, log); const gateway = picked.gateway; log.info('runtime location', { location: picked.location });
const runtime: ModelRuntime = process.env.CLAUDEBOT_RUNTIME === 'simulated'
  ? Object.assign(new SimulatedRuntime(JSON.parse(process.env.CLAUDEBOT_SIM_SCRIPT ?? '[]')), { authed: process.env.CLAUDEBOT_SIM_AUTHED !== '0' })
  : picked.runtime;
const roles = process.env.CLAUDEBOT_WORKER_ROLES?.split(',').filter(Boolean);
const ac = new AbortController();
let stopping = false;
process.on('SIGTERM', () => { stopping = true; ac.abort('interrupted by an engine shutdown or restart'); log.info('SIGTERM: finishing at next checkpoint boundary'); });
process.on('SIGINT', () => { stopping = true; ac.abort('interrupted by an engine shutdown or restart'); });

async function claudeAvailable() {
  // Test-only: skip the cheap pre-check so the real runtime path (spawn → turn → classification) is exercised.
  if (process.env.CLAUDEBOT_SKIP_AUTH_PRECHECK === '1') return { ok: true };
  const st = db.prepare("SELECT value FROM runtime_state WHERE key = 'claude.capacity'").get() as { value: string } | undefined;
  if (st) { const v = JSON.parse(st.value) as { limited?: boolean; reset_at?: string | null }; const stillLimited = !!v.limited && (!v.reset_at || Date.parse(v.reset_at) > Date.now()); if (stillLimited) return { ok: false, reason: 'limited' as const, resetAt: v.reset_at ?? null }; }
  const auth = db.prepare("SELECT value FROM runtime_state WHERE key = 'claude.auth'").get() as { value: string } | undefined;
  if (auth) { const v = JSON.parse(auth.value) as { loggedIn?: boolean }; if (v.loggedIn === false) return { ok: false, reason: 'auth_required' as const }; }
  return { ok: true };
}

log.info('worker started', { owner, runtime: runtime.id, roles: roles ?? 'all' });
let idle = 0;
while (!stopping) {
  const job = store.lease({ owner, leaseSeconds: cfg.leaseSeconds, roles, fair: true, respectGovernor: true });
  if (!job) { idle++; await new Promise((r) => setTimeout(r, Math.min(5000, 500 * idle))); continue; }
  idle = 0;
  log.info('leased', { jobId: job.id, kind: job.kind });
  try {
    const outcome = await runJob({ db, store, approvals, actions, runtime, log, workspacesDir: cfg.workspacesDir, runDir: cfg.runDir, owner, leaseSeconds: cfg.leaseSeconds, heartbeatSeconds: cfg.heartbeatSeconds, claudeAvailable, browserCheck: (site) => browserLoginCheck(cfg, site), closeTab: async (id) => { try { const r = await fetch(`http://127.0.0.1:${cfg.browserCdpPort}/json/close/${id}`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; } } }, job.id, { signal: ac.signal });
    log.info('job outcome', { jobId: job.id, outcome });
    // Record claude capacity/auth observations from the job's final state so other workers stop early.
    const after = store.get(job.id)!;
    if (after.state === 'waiting_for_reset') db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('claude.capacity', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify({ limited: true, reset_at: after.reset_at }), `job ${job.id} hit a plan limit`, new Date().toISOString());
    if (after.state === 'waiting_for_auth' && after.waiting_on === 'claude') db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('claude.auth', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify({ loggedIn: false }), `job ${job.id} received Authentication required`, new Date().toISOString());
  } catch (e) {
    log.error('runJob threw', { jobId: job.id, err: (e as Error).message });
    try { store.failRetryable(job.id, owner, `worker exception: ${(e as Error).message}`); } catch { /* lease may be gone */ }
  }
}
log.info('worker stopped', { owner });
gateway.close();
process.exit(0);
