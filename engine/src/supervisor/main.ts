/** claudebot engine supervisor: API/UI, scheduler, dispatcher, watchdog, backups. */
import { isBrowserRequest } from '../actions/store.ts';
import { governorTick, seedMorningRoutine } from '../cos/supervise.ts';
import { TelegramBridge } from '../telegram/bridge.ts';
import { getPermission, expireDuePermissions } from '../approvals/permissions.ts';
import { ensureOwnerKey } from '../api/owner-presence.ts';
import { localOutbox, LOCAL_OUTBOX_KINDS } from '../actions/executors.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { createLogger } from '../log.ts';
import { openDatabase, integrityCheck } from '../db/open.ts';
import { JobStore } from '../jobs/store.ts';
import { ApprovalStore } from '../approvals/store.ts';
import { ActionStore } from '../actions/store.ts';
import { GatewayClient } from '../gateway/client.ts';
import { makeRuntime, applyComputerBrowser, COMPUTER_CDP_PROXY_PORT, VM_CDP_PORT } from '../runtime/select.ts';
import { startCdpProxy } from '../computer/cdp-proxy.ts';
import { ComputerToken } from '../computer/host.ts';
import { SimulatedRuntime } from '../runtime/simulated.ts';
import { anthropicApiStub, bedrockStub, vertexStub, claudeWorkStub } from '../runtime/stubs.ts';
import { Dispatcher } from './dispatcher.ts';
import { Scheduler } from './scheduler.ts';
import { reapOrphanProbes, killAllProbes } from '../infra/probe.ts';
import { memoryLevelPct } from './dispatcher.ts';
import { Watchdog } from './watchdog.ts';
import { snapshot } from './backup.ts';
import { ApiServer } from '../api/server.ts';
import { Definitions } from '../model/definitions.ts';
import { Settings } from '../model/settings.ts';
import { Workspaces } from '../model/workspaces.ts';
import type { ModelRuntime } from '../runtime/types.ts';
import { ChatStore } from '../chat/store.ts';
import { BrowserLive } from '../browser/live.ts';
import { KeepAwake } from '../power/awake.ts';
import { releaseTabsOfFinishedTasks, cdpCloser } from '../browser/tabs.ts';

const cfg = loadConfig();
const VERSION = JSON.parse(fs.readFileSync(path.join(cfg.sourceRoot, 'engine', 'package.json'), 'utf8')).version as string;
for (const d of [cfg.dataDir, cfg.secretsDir, cfg.runDir, cfg.logsDir, cfg.backupsDir, cfg.workspacesDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const log = createLogger({ name: 'claudebotd', file: path.join(cfg.logsDir, 'engine.log'), base: { pid: process.pid } });
const startedAt = new Date().toISOString();

// Startup integrity
const db = openDatabase(cfg.dbPath);
const integrity = integrityCheck(db);
if (!integrity.ok) { log.error('database integrity check failed', { detail: integrity.detail }); process.exit(2); }
const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
// The only enabled executor writes approved sends/publishes to a local outbox on this Mac (nothing leaves the machine).
for (const k of LOCAL_OUTBOX_KINDS) actions.registerExecutor(k, localOutbox(cfg.home));
{ const n = actions.recoverInterrupted(); if (n.length) log.warn('actions interrupted mid-execution are now uncertain', { actions: n }); }
// Seed protected system definitions (idempotent; owner-defined rows are never touched; no business data is created)
const definitions = new Definitions(db); const settings = new Settings(db); const workspaces = new Workspaces(db, cfg.workspacesDir);
definitions.seedSystemDefaults();
if (!fs.existsSync(cfg.uiTokenFile)) { fs.writeFileSync(cfg.uiTokenFile, (await import('node:crypto')).randomBytes(27).toString('base64url') + '\n', { mode: 0o600 }); }

if (applyComputerBrowser(cfg, db)) { startCdpProxy({ listenPort: COMPUTER_CDP_PROXY_PORT, computerdPort: 47777, vmCdpPort: VM_CDP_PORT, token: () => new ComputerToken(cfg.secretsDir).get(), log }); log.info('browser lives in the assistants\' computer', { cdp: COMPUTER_CDP_PROXY_PORT }); }
const picked = makeRuntime(cfg, db, log); const gateway = picked.gateway; log.info('runtime location', { location: picked.location });
const simulated = process.env.CLAUDEBOT_RUNTIME === 'simulated';
const runtime: ModelRuntime = simulated ? Object.assign(new SimulatedRuntime(), { authed: process.env.CLAUDEBOT_SIM_AUTHED !== '0' }) : picked.runtime;
const runtimes: ModelRuntime[] = [runtime, claudeWorkStub, anthropicApiStub, bedrockStub, vertexStub];
const dispatcher = new Dispatcher(cfg, store, log, settings, simulated ? { CLAUDEBOT_RUNTIME: 'simulated', CLAUDEBOT_SIM_SCRIPT: process.env.CLAUDEBOT_SIM_SCRIPT ?? '[]' } : {});
const scheduler = new Scheduler(db, store);
ensureOwnerKey(cfg.secretsDir);   // owner-presence signatures for approve / run / settle (see api/owner-presence.ts)
// A parent's 'waiting for children' mark is held only while its wait call runs in this process; after a restart none is running.
db.prepare("UPDATE jobs SET waiting_on = NULL WHERE waiting_on LIKE 'children:%'").run();
const watchdog = new Watchdog(cfg, db, store, runtime, log, () => dispatcher.workers.size, () => dispatcher.desired);
const chat = new ChatStore(db, store); const live = new BrowserLive(cfg, db, log);
const api = new ApiServer({ cfg, db, store, approvals, actions, log, watchdog, dispatcher, scheduler, runtime, runtimes, definitions, workspaces, settings, chat, live, version: VERSION, startedAt, productName: String(settings.get('product_name')) });

// Recovery on start: orphans, stale leases, due retries, backup
const reaped = dispatcher.reapOrphans();
const reapedProbes = reapOrphanProbes(path.join(cfg.runDir, 'probes'), log);
const recovered = dispatcher.tick();
store.event(null, 'supervisor', 'engine.started', { version: VERSION, pid: process.pid, reaped_orphans: reaped, reaped_probes: reapedProbes, reclaimed: recovered.reclaimed, promoted: recovered.promoted, integrity: integrity.detail, runtime: runtime.id });
await snapshot(db, cfg.backupsDir, 20, 'startup').catch((e) => log.warn('startup backup failed', { err: (e as Error).message }));

const port = await api.listen();
log.info('engine listening', { port, version: VERSION, runtime: runtime.id });
fs.writeFileSync(path.join(cfg.runDir, 'engine.json'), JSON.stringify({ pid: process.pid, port, started_at: startedAt, version: VERSION }), { mode: 0o600 });
dispatcher.ensureWorkers();
await watchdog.check().catch((e) => log.warn('initial watchdog check failed', { err: (e as Error).message }));

const timers: NodeJS.Timeout[] = [];
// Workers write replies and state straight to the database; this cheap watermark check tells open windows within ~2 s.
// It watches messages, job events and approvals, not job timestamps: heartbeats update jobs every few seconds and write no event.
let mark = '';
timers.push(setInterval(() => { try { const r = db.prepare("SELECT (SELECT max(seq) FROM messages) AS m, (SELECT max(seq) FROM job_events) AS j, (SELECT max(coalesce(decided_at, created_at)) FROM approvals) AS a").get() as { m: number | null; j: number | null; a: string | null }; const next = `${r.m}|${r.j}|${r.a}`; if (mark && next !== mark) { api.broadcast('chat', { changed: true }); api.broadcast('jobs', { changed: true }); } mark = next; } catch (e) { log.warn('change watch failed', { err: (e as Error).message }); } }, 2_000));
timers.push(setInterval(() => { const t = dispatcher.tick(); if (t.reclaimed || t.promoted) api.broadcast('jobs', t); dispatcher.ensureWorkers(); try { const touched = chat.sync(definitions); if (touched.length) api.broadcast('chat', { conversations: touched }); } catch (e) { log.warn('chat sync failed', { err: (e as Error).message }); } }, 5_000));
// Idle lead sessions hold an adapter and a Claude process each; close them after CLAUDEBOT_CHAT_IDLE_CLOSE_MS (default 20 min). The next message respawns with the durable transcript.
timers.push(setInterval(() => { const tight = memoryLevelPct() < 35;   /* under memory pressure (load test 2026-10-13: 13 idle Claude processes, level 31%), idle chat sessions close after 3 minutes instead of 20 */
  const idleMs = tight ? 3 * 60_000 : Number(process.env.CLAUDEBOT_CHAT_IDLE_CLOSE_MS ?? 20 * 60_000); for (const c of chat.idleSessions(idleMs)) { if (!runtime.closeSession) continue; const ref = c.session_ref; chat.setSession(c.conversation_id, null, c.agent_id); runtime.closeSession(ref).then(() => { store.event(null, 'supervisor', 'conversation.session_closed', { id: c.conversation_id, agent: c.agent_id, reason: 'idle' }); log.info('closed idle assistant session', { conversation: c.conversation_id, agent: c.agent_id }); }).catch((e) => log.warn('idle session close failed', { conversation: c.conversation_id, err: (e as Error).message })); } }, 60_000));
timers.push(setInterval(() => { const r = scheduler.tick(); if (r.some((x) => x.created)) api.broadcast('jobs', { scheduled: r }); }, 60_000));
try { governorTick(db, store); } catch { /* first tick at boot: an override that expired while the engine was down stops applying now */ }
try { seedMorningRoutine(db, scheduler); } catch (e) { log.warn('morning routine not seeded', { err: (e as Error).message }); }
// Standing permissions: an approval the owner's permission covered runs once through the same executor (idempotent per approval).
// The assistants' computer: one data-disk snapshot a night while the Mac is awake (2–5 am local, when nothing is running there).
timers.push(setInterval(async () => { try {
  const hr = new Date().getHours(); if (hr < 2 || hr >= 5 || api.computerBusy) return;
  const host = api.computer(); const st = await host.status(); if (st.state !== 'running') return;
  if (st.snapshots[0] && Date.now() - Date.parse(st.snapshots[0].at) < 20 * 3600_000) return;
  if ((db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('leased','running')").get() as { n: number }).n) return;
  api.computerBusy = 'snapshot'; try { await host.snapshot('nightly'); store.event(null, 'engine', 'computer.snapshot_done', { nightly: true }); } finally { api.computerBusy = null; }
} catch (e) { log.warn('nightly computer snapshot failed', { err: (e as Error).message }); } }, 15 * 60_000));
let permRunning = false;
timers.push(setInterval(async () => { if (permRunning) return; permRunning = true; try {
  for (const a of db.prepare("SELECT id, job_id, action_kind, target, content, decided_by FROM approvals WHERE status = 'approved' AND decided_by LIKE 'permission:%'").all() as Array<{ id: string; job_id: string | null; action_kind: string; target: string; content: string; decided_by: string }>) {
    if (actions.byKey(`approval:${a.id}`)) continue;
    if (isBrowserRequest(a.content)) continue;   // performed by the assistant in the browser (browser_act), never by this runner
    { const pk = (db.prepare('SELECT action_kind FROM standing_permissions WHERE id = ?').get(a.decided_by.slice('permission:'.length)) as { action_kind: string } | undefined)?.action_kind; if (pk === 'job_application') continue; }   // applications are submitted by the assistant on the job site, never written to the outbox
    // Revoked, expired, or the task stopped since it was allowed: nothing runs, and the card says why.
    const pm = getPermission(db, a.decided_by.slice('permission:'.length)); const jobState = a.job_id ? store.get(a.job_id)?.state : null;
    if (!pm || pm.status !== 'active' || pm.expires_at <= new Date().toISOString() || jobState === 'cancelled') { db.prepare("UPDATE approvals SET status = 'stale', decision_note = ? WHERE id = ? AND status = 'approved'").run(!pm || pm.status !== 'active' ? 'permission revoked before it ran' : jobState === 'cancelled' ? 'task stopped before it ran' : 'permission expired before it ran', a.id); store.event(a.job_id, 'system', 'permission.skipped', { approval: a.id }); api.broadcast('approvals', { id: a.id }); continue; }
    const out = await actions.perform({ job_id: a.job_id, idempotency_key: `approval:${a.id}`, kind: a.action_kind, target: a.target, content: a.content, approval_id: a.id, actor: a.decided_by });
    store.event(a.job_id, a.decided_by, 'permission.performed', { approval: a.id, status: out.status }); api.broadcast('approvals', { id: a.id }); api.broadcast('chat', {});
  }
} catch (e) { log.warn('permission run failed', { err: (e as Error).message }); } finally { permRunning = false; } }, 5_000));
timers.push(setInterval(() => { try { expireDuePermissions(db); } catch { /* */ } }, 60_000));
timers.push(setInterval(() => { try { const g = governorTick(db, store); if (g.changed) api.broadcast('settings', { usage_level: g.level }); if (g.rankJob) api.broadcast('jobs', { id: g.rankJob }); } catch (e) { log.warn('governor tick failed', { err: (e as Error).message }); } }, 30_000));
// Browser tabs recorded for tasks that are over (including tasks cancelled while paused, which no worker touches again) are closed; owner tabs are never recorded, so never closed.
timers.push(setInterval(() => { releaseTabsOfFinishedTasks(db, cdpCloser(cfg.browserCdpPort)).then((r) => { for (const x of r) store.event(x.job_id, 'supervisor', 'browser.tabs_released', { ...x, by: 'sweep' }); }).catch((e) => log.warn('tab sweep failed', { err: (e as Error).message })); }, 60_000));
releaseTabsOfFinishedTasks(db, cdpCloser(cfg.browserCdpPort)).then((r) => { for (const x of r) store.event(x.job_id, 'supervisor', 'browser.tabs_released', { ...x, by: 'startup sweep' }); }).catch(() => {});
timers.push(setInterval(() => { reapOrphanProbes(path.join(cfg.runDir, 'probes'), log); watchdog.check({ restartGateway: !simulated }).then((h) => api.broadcast('health', h)).catch((e) => log.warn('watchdog failed', { err: (e as Error).message })); }, 60_000));
timers.push(setInterval(() => { snapshot(db, cfg.backupsDir, 20, 'auto').catch((e) => log.warn('backup failed', { err: (e as Error).message })); }, 6 * 3600_000));
// Keep the Mac awake (caffeinate -i) only while a job is leased or running, so the engine never sleeps mid-task; released when idle.
const keepAwake = new KeepAwake(db, log);
try { keepAwake.tick(); } catch (e) { log.warn('keep-awake tick failed', { err: (e as Error).message }); }
timers.push(setInterval(() => { try { keepAwake.tick(); } catch (e) { log.warn('keep-awake tick failed', { err: (e as Error).message }); } }, 30_000));
timers.push(setInterval(() => api.broadcast('tick', { at: new Date().toISOString(), active: store.list({ state: ['leased', 'running'] }).length }), 10_000));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return; shuttingDown = true;
  log.info('shutdown requested', { signal });
  for (const t of timers) clearInterval(t);
  keepAwake.stop();
  await dispatcher.stop(20_000);
  killAllProbes();
  store.reclaimExpired('supervisor');
  store.event(null, 'supervisor', 'engine.stopped', { signal, pid: process.pid });
  api.close(); gateway.close();
  try { fs.rmSync(path.join(cfg.runDir, 'engine.json')); } catch { /* */ }
  db.close();
  process.exit(0);
}
// Telegram bridge: idle until the owner pastes a bot token in Settings; then long-polls (owner-bound chat only).
const telegram = new TelegramBridge({ db, secretsDir: cfg.secretsDir, chat, approvals, defs: definitions, store, defaultWorkspace: () => (db.prepare("SELECT id FROM workspaces WHERE status = 'active' ORDER BY created_at LIMIT 1").get() as { id: string }).id, onChange: (c) => api.broadcast("chat", { conversation_id: c }), log: log as never });
void telegram.run(() => shuttingDown);
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (e) => { log.error('uncaught exception', { err: e.message, stack: e.stack }); });
process.on('unhandledRejection', (e) => { log.error('unhandled rejection', { err: (e as Error)?.message ?? String(e) }); });
