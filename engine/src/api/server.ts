import { verifyOwnerPresence, confirmSubject } from './owner-presence.ts';
import { createTrigger, listTriggers, receiveEvent } from '../automation/triggers.ts';
import { cancelDescendants } from '../coord/delegation.ts';
import { searchScoped } from '../search/index.ts';
import http from 'node:http';
import fs from 'node:fs';
import { Vault } from '../memory/vault.ts';
import { LimaHost, ComputerToken } from '../computer/host.ts';
import net from 'node:net';
import { runtimeLocation } from '../runtime/select.ts';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { JobStore } from '../jobs/store.ts';
import { ApprovalStore } from '../approvals/store.ts';
import { ActionStore } from '../actions/store.ts';
import { BrokerApi } from '../broker/api.ts';
import { verifyCapability, TOOL_SCHEMAS } from '../broker/capabilities.ts';
import type { EngineConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import type { Watchdog } from '../supervisor/watchdog.ts';
import type { Dispatcher } from '../supervisor/dispatcher.ts';
import type { Scheduler } from '../supervisor/scheduler.ts';
import { listBackups } from '../supervisor/backup.ts';
import type { ModelRuntime } from '../runtime/types.ts';
import { Definitions, STAGE_KINDS } from '../model/definitions.ts';
import { Workspaces } from '../model/workspaces.ts';
import { Settings } from '../model/settings.ts';
import { DETERMINISTIC } from '../worker/deterministic.ts';
import { workbenchSnapshot } from '../model/workbench.ts';
import { CAPABILITIES, CAPABILITY_STATES } from '../model/capabilities.ts';
import { taskTitle, eventWording } from '../model/wording.ts';
import { ChatStore, CHAT_WORKFLOW, plainState, ChatRuleError, turnState } from '../chat/store.ts';
import { Assistants } from '../chat/assistants.ts';
import { homeSnapshot } from '../model/home.ts';
import { saveAttachment, AttachmentError, exportConversation } from '../chat/attachments.ts';
import { hasToken, saveToken, checkToken, newPairingCode, binding as tgBinding, unbind as tgUnbind } from '../telegram/bridge.ts';
import { proposePermission, activatePermission, revokePermission, listPermissions, grantJobApplications } from '../approvals/permissions.ts';
import { computeGovernor, setOverride, revokeOverride, deferralOf, refreshGovernor, perTurnWeeklyCost, resetTime } from '../usage/governor.ts';
import { latestReport, priorityOf } from '../cos/report.ts';
import type { BrowserLive } from '../browser/live.ts';
import { browserLoginCheck } from '../browser/health.ts';
import { releaseTaskTabs, cdpCloser } from '../browser/tabs.ts';

/** The model the product's Claude Code sessions actually ran, read from the newest transcript in the isolated profile (not a setting). */
function observedModel(configDir: string): { model: string | null; observed_at: string | null; source: string } {
  try {
    const root = path.join(configDir, 'projects'); let newest: { f: string; t: number } | null = null;
    for (const d of fs.readdirSync(root)) { const dir = path.join(root, d); let names: string[] = []; try { names = fs.readdirSync(dir); } catch { continue; } for (const n of names) { if (!n.endsWith('.jsonl')) continue; const t = fs.statSync(path.join(dir, n)).mtimeMs; if (!newest || t > newest.t) newest = { f: path.join(dir, n), t }; } }
    if (!newest) return { model: null, observed_at: null, source: 'no Claude session yet' };
    const size = fs.statSync(newest.f).size; const fd = fs.openSync(newest.f, 'r'); const len = Math.min(size, 262_144); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const ms = [...buf.toString('utf8').matchAll(/"model":"([^"]+)"/g)].map((m) => m[1]).filter((m) => m !== '<synthetic>');
    return { model: ms[ms.length - 1] ?? null, observed_at: new Date(newest.t).toISOString(), source: 'newest transcript in the isolated Claude profile' };
  } catch { return { model: null, observed_at: null, source: 'transcripts unreadable' }; }
}

export interface ApiDeps { cfg: EngineConfig; db: DB; store: JobStore; approvals: ApprovalStore; actions: ActionStore; log: Logger; watchdog: Watchdog; dispatcher: Dispatcher; scheduler: Scheduler; runtime: ModelRuntime; runtimes: ModelRuntime[]; definitions: Definitions; workspaces: Workspaces; settings: Settings; chat: ChatStore; live: BrowserLive; version: string; startedAt: string; productName: string }

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
type Req = http.IncomingMessage; type Res = http.ServerResponse;

/** Models an assistant can run on (all through the owner's Claude subscription; verified accepted by the ACP agent). */
export const AGENT_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

export class ApiServer {
  computerBusy: string | null = null;
  private computerHost: LimaHost | null = null;
  computer(): LimaHost { return this.computerHost ??= new LimaHost({ home: this.d.cfg.home, secretsDir: this.d.cfg.secretsDir }); }
  private d: ApiDeps; server: http.Server; private sse = new Set<Res>(); private uiToken: string; private uiDir: string;
  constructor(d: ApiDeps) {
    this.d = d; this.uiToken = fs.readFileSync(d.cfg.uiTokenFile, 'utf8').trim(); this.uiDir = path.join(d.cfg.sourceRoot, 'engine', 'ui');
    this.server = http.createServer((req, res) => { this.handle(req, res).catch((e) => { d.log.error('request failed', { url: req.url, err: (e as Error).message }); if (!res.headersSent) this.json(res, 500, { error: (e as Error).message }); }); });
    // Live screens of the assistants' computer for the app (noVNC): the app's own session authenticates here, and the engine adds
    // the per-install token on the way to computerd. The browser page never sees that token.
    this.server.on('upgrade', (req, socket) => {
      const url = new URL(req.url ?? '/', 'http://x'); const m = /^\/api\/computer\/screen\/(\d+)$/.exec(url.pathname);
      if (!m || !this.authed(req as Req, url)) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
      const tok = new ComputerToken(d.cfg.secretsDir).get(); const up = net.connect(47777, '127.0.0.1');
      up.once('error', () => socket.destroy());
      up.once('connect', () => { const hdrs = Object.entries(req.headers).filter(([k]) => !['host', 'authorization', 'cookie'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('\r\n'); up.write(`GET /screen/${m[1]} HTTP/1.1\r\nHost: 127.0.0.1:47777\r\nAuthorization: Bearer ${tok ?? ''}\r\n${hdrs}\r\n\r\n`); up.pipe(socket); socket.pipe(up); });
      const end = () => { up.destroy(); socket.destroy(); }; socket.on('error', end); socket.on('close', end); up.on('close', end);
    });
  }
  listen(): Promise<number> { return new Promise((r) => this.server.listen(this.d.cfg.enginePort, '127.0.0.1', () => r((this.server.address() as { port: number }).port))); }
  close(): void { for (const s of this.sse) s.end(); void this.d.live.close(); this.server.close(); }
  broadcast(event: string, payload: unknown): void { const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`; for (const s of this.sse) s.write(line); }

  private json(res: Res, code: number, body: unknown) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
  private authed(req: Req, url: URL): boolean {
    const header = req.headers['x-claudebot-token']; const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('ros='))?.slice(4);
    const q = url.searchParams.get('t'); const t = (typeof header === 'string' ? header : undefined) ?? cookie ?? q;
    return !!t && t.length === this.uiToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.uiToken));
  }
  /** Request bodies are capped (default 2 MB; 128 KB for event hooks, read before their secret is checked). */
  private async body(req: Req, max = 2 * 1024 * 1024): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let n = 0; for await (const c of req) { n += (c as Buffer).length; if (n > max) { req.destroy(); throw new Error('request body too large'); } chunks.push(c as Buffer); } const s = Buffer.concat(chunks).toString(); return s ? JSON.parse(s) : {}; }

  private async handle(req: Req, res: Res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = req.headers.origin; if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return this.json(res, 403, { error: 'origin not allowed' });
    if (url.pathname === '/' && url.searchParams.get('t')) { if (!this.authed(req, url)) return this.json(res, 401, { error: 'bad token' }); const go = (url.searchParams.get('go') ?? '').replace(/[^\w./-]/g, ''); res.writeHead(302, { 'set-cookie': `ros=${this.uiToken}; Path=/; HttpOnly; SameSite=Strict`, location: go ? `/#${go}` : '/' }); return res.end(); }
    if (!url.pathname.startsWith('/api/')) return this.static(url.pathname, res);
    // Event triggers authenticate with their own secret (not the UI token), so a local tool can post events without UI access.
    const hk = url.pathname.match(/^\/api\/hooks\/([A-Za-z0-9_-]+)$/);
    if (hk && req.method === 'POST') { if (Number(req.headers['content-length'] ?? 0) > 128 * 1024) return this.json(res, 413, { error: 'event too large' }); let b: Record<string, unknown> = {}; try { b = await this.body(req, 128 * 1024) as Record<string, unknown>; } catch (e) { return this.json(res, /too large/.test((e as Error).message) ? 413 : 400, { error: (e as Error).message.includes('large') ? 'event too large' : 'invalid JSON' }); } const tok = String(req.headers['x-claudebot-trigger-token'] ?? (String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || '')); const r = receiveEvent(this.d.db, this.d.store, hk[1], tok || undefined, b); if (r.status === 201) this.broadcast('jobs', { trigger: hk[1] }); return this.json(res, r.status, r.body); }
    // Tool calls from a task's own Claude session (on this Mac or inside the assistants' computer) authenticate with that task's
    // capability alone: a random per-task token whose tools are scoped to the task. They never carry, or need, the app's token.
    const brokerPath = url.pathname === '/api/broker/call' || url.pathname === '/api/broker/tools';
    if (brokerPath && req.headers['x-capability']) {
      const { cfg } = this.d; const token = String(req.headers['x-capability']); const jobId = String(req.headers['x-job-id'] ?? ''); const key = String(req.headers['x-capability-key'] ?? jobId);
      const cap = verifyCapability(cfg.runDir, key, token); if (!cap || cap.job_id !== jobId) return this.json(res, 403, { ok: false, text: 'invalid or expired capability' });
      if (url.pathname === '/api/broker/tools') return this.json(res, 200, { tools: cap.tools.filter((t) => TOOL_SCHEMAS[t]).map((name) => ({ name, description: TOOL_SCHEMAS[name].description, inputSchema: TOOL_SCHEMAS[name].inputSchema })) });
    } else if (!this.authed(req, url)) return this.json(res, 401, { error: 'unauthorized' });
    const p = url.pathname; const m = req.method ?? 'GET'; const { db, store, approvals, cfg, definitions: defs, workspaces: ws, settings } = this.d;
    const wsFilter = url.searchParams.get('workspace') ?? undefined;

    // ---- live + health ----
    if (p === '/api/events' && m === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`); this.sse.add(res); req.on('close', () => this.sse.delete(res)); return; }
    if (p === '/api/health') { const fresh = url.searchParams.get('fresh') === '1'; let h = this.d.watchdog.last; if (fresh) h = await this.d.watchdog.check(); else if (!h) { this.d.watchdog.check().catch(() => {}); h = this.d.watchdog.pendingReport(); } return this.json(res, 200, { ...h, product: this.d.productName, version: this.d.version, started_at: this.d.startedAt, pid: process.pid, worker_processes: [...this.d.dispatcher.workers.values()].map((w) => ({ pid: w.pid, started_at: w.startedAt })), capacity: this.d.dispatcher.capacity() }); }
    if (p === '/api/overview') return this.json(res, 200, this.overview(wsFilter));
    if (p === '/api/usage' && m === 'GET') { const g = computeGovernor(db); const names = new Map(defs.listAgents({ includeDisabled: true }).map((a) => [a.id, a.name]));
      const deferred = (db.prepare("SELECT id, kind, state, schedule_id, inputs, objective, agent_role FROM jobs WHERE state IN ('queued','retry_scheduled') ORDER BY created_at").all() as Array<{ id: string; kind: string; state: string; schedule_id: string | null; inputs: string; objective: string; agent_role: string }>).map((j) => ({ id: j.id, title: taskTitle(j.objective), agent: names.get(j.agent_role) ?? j.agent_role, label: deferralOf(j, g, priorityOf(db, j.id)?.rank ?? null) })).filter((j) => j.label);
      const reading = g.reading ? { ...g.reading, windows: g.reading.windows.map((w) => ({ ...w, resets_iso: (() => { const t = resetTime(w.resets_at, g.reading!.observed_at); return t ? new Date(t).toISOString() : null; })() })) } : null;
      return this.json(res, 200, { level: g.level, measured_level: g.measured_level, pct: g.pct, stale: g.stale, reading, override: g.override, low_power_pct: g.low_power_pct, stop_pct: g.stop_pct, source: 'Claude Code /usage through the ClaudeBot route (account-wide subscription limits)', deferred: deferred.length, deferred_jobs: deferred.slice(0, 30), per_turn: perTurnWeeklyCost(db) }); }
    if (p === '/api/usage/override' && m === 'POST') { const b = await this.body(req); try { const o = setOverride(db, { mode: b.mode === 'low_power' ? 'low_power' : 'normal', minutes: Number(b.minutes ?? 60), reason: String(b.reason ?? ''), by: 'owner', via: b.via === 'telegram' ? 'telegram' : 'app' }); refreshGovernor(db); this.broadcast('settings', { usage_override: o.id }); return this.json(res, 201, o); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } }
    const ovm = p.match(/^\/api\/usage\/override\/([^/]+)\/revoke$/);
    if (ovm && m === 'POST') { const ok = revokeOverride(db, ovm[1], 'owner'); refreshGovernor(db); this.broadcast('settings', { usage_override: ovm[1] }); return ok ? this.json(res, 200, { revoked: true }) : this.json(res, 404, { error: 'no active override with that id' }); }
    if (p === '/api/reports/latest' && m === 'GET') return this.json(res, 200, { report: latestReport(db), running: db.prepare("SELECT id, state FROM jobs WHERE kind = 'report.morning' AND state NOT IN ('completed','failed_terminal','cancelled') ORDER BY created_at DESC LIMIT 1").get() ?? null, last_failed: db.prepare("SELECT id, failure_detail, updated_at FROM jobs WHERE kind = 'report.morning' AND state = 'failed_terminal' ORDER BY updated_at DESC LIMIT 1").get() ?? null });
    if (p === '/api/reports/morning' && m === 'POST') { const wf = defs.getWorkflow('report.morning'); if (!wf) return this.json(res, 500, { error: 'report workflow missing' }); const running = db.prepare("SELECT id FROM jobs WHERE kind = 'report.morning' AND state NOT IN ('completed','failed_terminal','cancelled')").get() as { id: string } | undefined; if (running) return this.json(res, 200, { job: { id: running.id }, already_running: true }); const r = store.create({ idempotency_key: `report:owner:${Date.now()}`, kind: wf.id, objective: 'Write the morning report', success_contract: wf.contract, agent_role: wf.default_agent, priority: 1, inputs: {} }, 'owner'); this.broadcast('jobs', { id: r.job.id }); return this.json(res, 201, { job: { id: r.job.id, state: r.job.state } }); }
    if (p === '/api/home' && m === 'GET') return this.json(res, 200, homeSnapshot(db, { workspace: wsFilter ?? null }));
    if (p === '/api/workbench' && m === 'GET') return this.json(res, 200, workbenchSnapshot(db, { workspace: wsFilter, freshSeconds: Math.max(15, cfg.heartbeatSeconds * 3) }));
    if (p === '/api/capabilities' && m === 'GET') return this.json(res, 200, { states: CAPABILITY_STATES, items: CAPABILITIES, openclaw: { version: '2026.9.8', plugin: '@openclaw/acpx', note: 'ClaudeBot tasks are Claude Code ACP harness sessions, not native OpenClaw sub-agents. The claudebot tool bridge is the only bridge; OpenClaw platform tools are not exposed into Claude sessions.' } });
    const inspect = p.match(/^\/api\/workbench\/([^/]+)\/session$/);
    if (inspect && m === 'GET') {
      const j = store.get(inspect[1]); if (!j) return this.json(res, 404, { error: 'task not found' });
      if (!j.session_ref) return this.json(res, 200, { available: false, detail: 'This task has not started a Claude session yet.' });
      if (j.kind !== 'chat.turn' && store.events(j.id).some(e => e.type === 'session.closed')) return this.json(res, 200, { available: false, detail: 'This task finished and its Claude process was released. Saved work remains available.' });
      if (!this.d.runtime.inspectSession) return this.json(res, 200, { available: false, detail: 'Session inspection is not supported by this runtime.' });
      try { return this.json(res, 200, { available: true, session: j.session_ref, runtime: j.runtime_id, ...await this.d.runtime.inspectSession(j.session_ref) }); }
      catch (e) { return this.json(res, 503, { error: `Could not inspect OpenClaw session: ${(e as Error).message}` }); }
    }

    // ---- workspaces ----
    if (p === '/api/workspaces' && m === 'GET') return this.json(res, 200, ws.list({ includeArchived: url.searchParams.get('archived') === '1' }).map((w) => ({ ...w, ...this.wsStats(w.id) })));
    if (p === '/api/workspaces' && m === 'POST') { const b = await this.body(req); if (!b.name || !String(b.name).trim()) return this.json(res, 400, { error: 'name is required' }); try { const w = ws.create({ name: String(b.name).trim(), description: String(b.description ?? ''), agent_team: (b.agent_team as string[]) ?? [], policies: (b.policies as Record<string, unknown>) ?? {}, worker_limit: Number(b.worker_limit ?? settings.get('default_workspace_worker_limit')), root_path: b.root_path ? String(b.root_path) : undefined }, 'owner'); this.broadcast('workspaces', { id: w.id }); return this.json(res, 201, w); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } }
    if (p === '/api/workspaces/import' && m === 'POST') { const b = await this.body(req); try { const w = ws.importConfig(b, 'owner'); this.broadcast('workspaces', { id: w.id }); return this.json(res, 201, w); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } }
    const wm = p.match(/^\/api\/workspaces\/([^/]+)(?:\/(archive|restore|duplicate|export|policy))?$/);
    if (wm) {
      const w = ws.get(wm[1]); if (!w) return this.json(res, 404, { error: 'workspace not found' });
      if (!wm[2] && m === 'GET') return this.json(res, 200, { ...w, ...this.wsStats(w.id), objectives: db.prepare('SELECT * FROM objectives WHERE workspace_id = ? ORDER BY priority, created_at').all(w.id), schedules: this.d.scheduler.list().filter((s) => s.workspace_id === w.id), agents: defs.listAgents().filter((a) => !w.agent_team.length || w.agent_team.includes(a.id)).map((a) => ({ id: a.id, name: a.name, purpose: a.purpose, is_system: a.is_system })) });
      if (!wm[2] && (m === 'PATCH' || m === 'PUT')) { const b = await this.body(req); const patch: Record<string, unknown> = {}; for (const k of ['name', 'description', 'agent_team', 'enabled_skills', 'connectors', 'policies', 'memory_scope', 'worker_limit']) if (k in b) patch[k] = b[k]; const u = ws.update(w.id, patch as never, 'owner'); this.broadcast('workspaces', { id: w.id }); return this.json(res, 200, u); }
      if (wm[2] === 'archive' && m === 'POST') { const open = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ? AND state IN ('leased','running')").get(w.id) as { n: number }).n; if (open) return this.json(res, 409, { error: `${open} task(s) are running; wait or cancel them first` }); const u = ws.archive(w.id, 'owner'); this.broadcast('workspaces', { id: w.id }); return this.json(res, 200, u); }
      if (wm[2] === 'restore' && m === 'POST') { const u = ws.restore(w.id, 'owner'); this.broadcast('workspaces', { id: w.id }); return this.json(res, 200, u); }
      if (wm[2] === 'duplicate' && m === 'POST') { const b = await this.body(req); const c = ws.duplicate(w.id, String(b.name ?? `${w.name} copy`), 'owner', { includeObjectives: !!b.include_objectives }); this.broadcast('workspaces', { id: c?.id }); return this.json(res, 201, c); }
      if (wm[2] === 'export' && m === 'GET') return this.json(res, 200, ws.exportConfig(w.id));
      if (wm[2] === 'policy' && m === 'GET') return this.json(res, 200, ws.effectivePolicy(w.id, defs.getAgent(url.searchParams.get('agent') ?? ''), Number(settings.get('worker_limit'))));
    }

    // ---- objectives ----
    if (p === '/api/objectives' && m === 'GET') return this.json(res, 200, db.prepare(`SELECT * FROM objectives ${wsFilter ? 'WHERE workspace_id = ?' : ''} ORDER BY priority, created_at DESC`).all(...(wsFilter ? [wsFilter] : [])));
    if (p === '/api/objectives' && m === 'POST') { const b = await this.body(req); if (!b.workspace_id || !ws.get(String(b.workspace_id))) return this.json(res, 400, { error: 'workspace_id is required and must exist' }); if (!b.title || !String(b.title).trim()) return this.json(res, 400, { error: 'title is required' }); const id = `obj-${crypto.randomBytes(4).toString('hex')}`; const t = new Date().toISOString(); db.prepare('INSERT INTO objectives(id, title, description, status, created_at, workspace_id, priority, success_criteria, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, String(b.title).trim(), String(b.description ?? ''), 'active', t, String(b.workspace_id), Number(b.priority ?? 5), String(b.success_criteria ?? ''), t); store.event(null, 'owner', 'objective.created', { id, workspace_id: b.workspace_id, title: b.title }); this.broadcast('objectives', { id }); return this.json(res, 201, db.prepare('SELECT * FROM objectives WHERE id = ?').get(id)); }
    const om = p.match(/^\/api\/objectives\/([^/]+)$/);
    if (om && (m === 'PATCH' || m === 'DELETE')) { const o = db.prepare('SELECT * FROM objectives WHERE id = ?').get(om[1]); if (!o) return this.json(res, 404, { error: 'not found' }); if (m === 'DELETE') { const open = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE objective_id = ? AND state NOT IN ('completed','failed_terminal','cancelled')").get(om[1]) as { n: number }).n; if (open) return this.json(res, 409, { error: `${open} open task(s) reference this objective` }); db.prepare("UPDATE objectives SET status = 'closed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), om[1]); store.event(null, 'owner', 'objective.closed', { id: om[1] }); return this.json(res, 200, { id: om[1], status: 'closed' }); } const b = await this.body(req); db.prepare('UPDATE objectives SET title = COALESCE(?, title), description = COALESCE(?, description), priority = COALESCE(?, priority), success_criteria = COALESCE(?, success_criteria), status = COALESCE(?, status), updated_at = ? WHERE id = ?').run(...([b.title ?? null, b.description ?? null, b.priority ?? null, b.success_criteria ?? null, b.status ?? null, new Date().toISOString(), om[1]] as never[])); store.event(null, 'owner', 'objective.updated', { id: om[1] }); return this.json(res, 200, db.prepare('SELECT * FROM objectives WHERE id = ?').get(om[1])); }

    // ---- tasks (jobs) ----
    if ((p === '/api/tasks' || p === '/api/jobs') && m === 'GET') { const state = url.searchParams.get('state'); return this.json(res, 200, store.list({ state: state ? (state.split(',') as never) : undefined, limit: Number(url.searchParams.get('limit') ?? 300), workspace: wsFilter }).map((j) => ({ ...j, title: taskTitle(j.objective) }))); }
    if ((p === '/api/tasks' || p === '/api/jobs') && m === 'POST') {
      const b = await this.body(req);
      const wf = defs.getWorkflow(String(b.kind ?? b.workflow)); if (!wf || !wf.enabled) return this.json(res, 400, { error: `unknown or disabled workflow ${b.kind ?? b.workflow}` });
      const wsId = b.workspace_id ? String(b.workspace_id) : null; if (!wsId || !ws.get(wsId)) return this.json(res, 400, { error: 'workspace_id is required and must name an active workspace' });
      if (ws.get(wsId)!.status !== 'active') return this.json(res, 409, { error: 'workspace is archived' });
      const inputs = (b.inputs as Record<string, unknown>) ?? {}; const missing = wf.inputs.filter((i) => i.required && !(i.name in inputs) && !(i.name === 'question' || i.name === 'brief' || i.name === 'goal' || i.name === 'check' || i.name === 'change' || i.name === 'urls' || i.name === 'hypothesis' || i.name === 'account')).map((i) => i.name);
      if (missing.length) return this.json(res, 400, { error: `missing required inputs: ${missing.join(', ')}` });
      const agent = b.agent ? String(b.agent) : wf.default_agent; const ad = defs.getAgent(agent); if (!ad || !ad.enabled) return this.json(res, 400, { error: `agent ${agent} is unknown or disabled` });
      const team = ws.get(wsId)!.agent_team; if (team.length && !team.includes(agent)) return this.json(res, 400, { error: `agent ${agent} is not on this workspace's team` });
      const r = store.create({ idempotency_key: String(b.idempotency_key ?? `owner:${wf.id}:${crypto.randomUUID()}`), kind: wf.id, objective: String(b.objective ?? wf.description), success_contract: wf.contract, agent_role: agent, inputs, priority: Number(b.priority ?? 5), workspace_id: wsId, objective_id: b.objective_id ? String(b.objective_id) : null, depends_on: Array.isArray(b.depends_on) ? (b.depends_on as string[]) : [] }, 'owner');
      this.broadcast('jobs', { id: r.job.id }); return this.json(res, r.created ? 201 : 200, r);
    }
    const jm = p.match(/^\/api\/(?:tasks|jobs)\/([^/]+)(?:\/(cancel|requeue|direction))?$/);
    if (jm) {
      const job = store.get(jm[1]); if (!job) return this.json(res, 404, { error: 'not found' });
      if (jm[2] === 'direction' && m === 'POST') {
        const b = await this.body(req); const note = String(b.note ?? '').trim(); if (!note) return this.json(res, 400, { error: 'write the direction' }); if (note.length > 4000) return this.json(res, 400, { error: 'direction too long (4,000 characters max)' });
        if (job.kind === CHAT_WORKFLOW) return this.json(res, 409, { error: 'this is a conversation reply; say it to the lead assistant as a message in the conversation' });
        if (['completed', 'failed_terminal', 'cancelled'].includes(job.state)) return this.json(res, 409, { error: `this task is ${plainState(job).toLowerCase()}; send the direction to the lead assistant in the conversation instead` });
        // The app authenticates with its cookie (the owner, in the office panel); scripts use the header token. Record which, so the wording stays true.
        const via = req.headers['x-claudebot-token'] ? 'api' : 'office';
        store.event(job.id, 'owner', 'owner.direction', { note, via });
        // Show the direction in the task's conversation, so the owner, the lead and later reviewers see who gave it. A failure here never undoes the saved direction.
        if (job.conversation_id) { try { const who = defs.getAgent(job.agent_role)?.name ?? job.agent_role; this.d.chat.add({ conversation_id: job.conversation_id, role: 'system', kind: 'direction', content: via === 'office' ? `You gave direction to ${who} in the office: ${note}` : `Direction for ${who} was recorded through the API: ${note}`, job_id: job.id, meta: { via, agent: job.agent_role } }); this.broadcast('chat', { conversation_id: job.conversation_id }); } catch (e) { this.d.log.warn('direction.conversation_message_failed', { job: job.id, error: (e as Error).message }); } }
        // Truthful delivery: a Claude step reads pending notes when it starts; a running step is not interrupted. The lead sees notes on its next turn via the conversation updates.
        const wf = defs.getWorkflow(job.kind); const stage = wf?.stages[job.stage_index]; const running = ['leased', 'running'].includes(job.state);
        const when = running && stage && ['claude', 'chat'].includes(stage.kind) ? `The assistant is in the middle of step "${stage.name}"; it gets your note at its next Claude step or if this step is tried again. It will not interrupt the current step.` : running ? `The task is in a local engine step ("${stage?.name ?? ''}"); the note is given to the assistant at its next Claude step.` : `The task is ${plainState(job).toLowerCase()}; the note is given to the assistant when it next runs a Claude step.`;
        this.broadcast('jobs', { id: job.id }); return this.json(res, 201, { ok: true, when, job_id: job.id });
      }
      if (jm[2] === 'cancel' && m === 'POST') { if (['completed', 'failed_terminal', 'cancelled'].includes(job.state)) return this.json(res, 409, { error: `task is ${job.state}` }); const wasRunning = ['leased', 'running'].includes(job.state); store.transition(job.id, 'cancelled', 'owner', { next_action: null }, { by: 'owner', via: req.headers['x-claudebot-token'] ? 'api' : 'app' }); /* the app authenticates with its cookie, scripts with a header */ if (wasRunning && job.session_ref && job.session_ref.includes(':acp:')) { this.d.runtime.cancel(job.session_ref).catch(() => {}); } { const kids = cancelDescendants(db, store, job.id, 'owner', 'parent task stopped by the owner'); if (kids.length) store.event(job.id, 'owner', 'cancel.cascaded', { children: kids }); } if (!wasRunning) { releaseTaskTabs(db, job.id, cdpCloser(cfg.browserCdpPort)).then((r) => { if (r.closed.length || r.kept.length) store.event(job.id, 'owner', 'browser.tabs_released', r); }).catch(() => {}); } this.broadcast('jobs', { id: job.id }); return this.json(res, 200, { ...store.get(job.id), stop: wasRunning ? 'The running step is being stopped; the worker releases it within a few seconds. Saved progress and files are kept.' : 'Stopped before it started.' }); }
      if (jm[2] === 'requeue' && m === 'POST') { if (!['failed_terminal', 'waiting_for_approval', 'waiting_for_auth', 'waiting_for_reset', 'retry_scheduled'].includes(job.state)) return this.json(res, 409, { error: `task is ${job.state}` }); db.prepare("UPDATE jobs SET state = 'queued', completed_at = NULL, retry_count = 0, failure_kind = NULL, failure_detail = NULL, blocker_code = NULL, operator_action = NULL, waiting_on = NULL, retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL, next_action = 'resume from last verified checkpoint', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id); store.event(job.id, 'owner', 'job.transition', { from: job.state, to: 'queued', by: 'owner', override: true }); this.broadcast('jobs', { id: job.id }); return this.json(res, 200, store.get(job.id)); }
      const wf = defs.getWorkflow(job.kind);
      return this.json(res, 200, { job: { ...job, title: taskTitle(job.objective), priority: priorityOf(db, job.id), deferred: deferralOf(job, computeGovernor(db), priorityOf(db, job.id)?.rank ?? null) }, events: store.events(job.id).map((e) => ({ ...e, label: eventWording(e.type, e.detail) })), directions: store.events(job.id).filter((e) => e.type === 'owner.direction' || e.type === 'owner.direction.delivered'), checkpoints: db.prepare('SELECT id, stage_index, stage_name, attempt, phase, sha256, session_ref, created_at, length(payload) AS bytes FROM checkpoints WHERE job_id = ? ORDER BY id').all(job.id), artifacts: db.prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at').all(job.id), approvals: db.prepare('SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at').all(job.id), evidence: db.prepare('SELECT id, title, source_url, grade, created_at FROM memory_evidence WHERE job_id = ?').all(job.id), depends: (() => { let ids: string[] = []; try { ids = JSON.parse(job.depends_on || '[]'); } catch { /* */ } return ids.map((id) => db.prepare('SELECT id, kind, state, agent_role, objective, created_at, completed_at FROM jobs WHERE id = ?').get(id) as { id: string; kind: string; state: string; agent_role: string; objective: string; created_at: string; completed_at: string | null } | undefined).filter(Boolean).map((x) => ({ id: x!.id, kind: x!.kind, state: x!.state, agent_role: x!.agent_role, title: taskTitle(x!.objective), created_at: x!.created_at, completed_at: x!.completed_at, sources: (db.prepare('SELECT count(*) AS n FROM memory_evidence WHERE job_id = ?').get(x!.id) as { n: number }).n, file: ((db.prepare("SELECT path FROM artifacts WHERE job_id = ? AND kind = 'file' ORDER BY created_at DESC LIMIT 1").get(x!.id) as { path: string } | undefined)?.path ?? '').split('/').pop() || null })); })(), children: (db.prepare('SELECT id, kind, state, agent_role, objective FROM jobs WHERE parent_id = ? ORDER BY created_at').all(job.id) as Array<{ objective: string }>).map(({ objective, ...c }) => ({ ...c, title: taskTitle(objective) })), stages: wf?.stages.map((s) => ({ name: s.name, kind: s.kind, agent: s.agent ?? null })) ?? [], workflow: wf ? { id: wf.id, name: wf.name } : null, agent: defs.getAgent(job.agent_role) ? { id: job.agent_role, name: defs.getAgent(job.agent_role)!.name } : null, workspace: job.workspace_id ? ws.get(job.workspace_id) : null, runtime: this.d.runtime.describe() });
    }

    // ---- agents ----
    if (p === '/api/agents' && m === 'GET') return this.json(res, 200, defs.listAgents({ includeDisabled: true }).map((a) => ({ ...a, ...this.agentLive(a.id) })));
    if (p === '/api/agents' && m === 'POST') { const b = await this.body(req); const id = String(b.id ?? '').trim() || String(b.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); if (!id || !b.name || !b.purpose) return this.json(res, 400, { error: 'id/name and purpose are required' }); const tools = ((b.allowed_tools as string[]) ?? []).filter((t) => t in TOOL_SCHEMAS); const a = defs.upsertAgent({ ...(b as Record<string, never>), id, name: String(b.name), purpose: String(b.purpose), allowed_tools: tools }, 'owner'); this.broadcast('agents', { id }); return this.json(res, 201, a); }
    const mem = p.match(/^\/api\/agents\/([^/]+)\/memory$/);
    if (mem) { const ag = defs.getAgent(mem[1]); if (!ag) return this.json(res, 404, { error: 'not found' }); const v = new Vault();
      if (m === 'GET') { const n = v.readNote(ag); return this.json(res, 200, { path: n.path, text: n.text, vault: v.dir, obsidian_url: `obsidian://open?path=${encodeURIComponent(n.path)}` }); }
      if (m === 'PUT') { const b = await this.body(req); const r = v.writeNote(ag, String(b.text ?? '')); if (!r.ok) return this.json(res, 400, { error: r.reason }); store.event(null, 'owner', 'memory.edited', { assistant: ag.id }); return this.json(res, 200, { ok: true }); } }
    const am2 = p.match(/^\/api\/agents\/([^/]+)(?:\/(enable|disable|duplicate))?$/);
    if (am2) {
      const a = defs.getAgent(am2[1]); if (!a) return this.json(res, 404, { error: 'agent not found' });
      if (!am2[2] && m === 'GET') return this.json(res, 200, { ...a, ...this.agentLive(a.id), tool_catalogue: Object.keys(TOOL_SCHEMAS) });
      if (!am2[2] && (m === 'PATCH' || m === 'PUT')) { const b = await this.body(req); if (b.model !== undefined && !AGENT_MODELS.includes(String(b.model))) return this.json(res, 400, { error: `Pick one of: ${AGENT_MODELS.join(', ')}` }); const tools = Array.isArray(b.allowed_tools) ? (b.allowed_tools as string[]).filter((t) => t in TOOL_SCHEMAS) : undefined; const u = defs.upsertAgent({ ...a, ...(b as Record<string, never>), id: a.id, name: String(b.name ?? a.name), purpose: String(b.purpose ?? a.purpose), allowed_tools: tools ?? a.allowed_tools }, 'owner'); this.broadcast('agents', { id: a.id }); return this.json(res, 200, u); }
      if (!am2[2] && m === 'DELETE') { const r = defs.deleteAgent(a.id, 'owner'); this.broadcast('agents', { id: a.id }); return this.json(res, r.ok ? 200 : 409, r); }
      if (am2[2] === 'enable' || am2[2] === 'disable') { defs.setAgentEnabled(a.id, am2[2] === 'enable', 'owner'); this.broadcast('agents', { id: a.id }); return this.json(res, 200, defs.getAgent(a.id)); }
      if (am2[2] === 'duplicate' && m === 'POST') { const b = await this.body(req); const nid = String(b.id ?? `${a.id}_copy`); const c = defs.duplicateAgent(a.id, nid, 'owner'); this.broadcast('agents', { id: nid }); return this.json(res, 201, c); }
    }

    // ---- workflows ----
    if (p === '/api/workflows' && m === 'GET') return this.json(res, 200, { workflows: defs.listWorkflows({ includeDisabled: true }), stage_kinds: STAGE_KINDS, deterministic_functions: Object.keys(DETERMINISTIC) });
    if (p === '/api/workflows' && m === 'POST') { const b = await this.body(req); const id = String(b.id ?? '').trim() || String(b.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, ''); const r = defs.upsertWorkflow({ id, name: String(b.name ?? id), description: String(b.description ?? ''), default_agent: String(b.default_agent ?? ''), stages: (b.stages as never) ?? [], contract: (b.contract as never) ?? {}, inputs: (b.inputs as never) ?? [] }, 'owner'); if (!r.ok) return this.json(res, 400, r); this.broadcast('workflows', { id }); return this.json(res, 201, r.workflow); }
    const wfm = p.match(/^\/api\/workflows\/([^/]+)(?:\/(enable|disable|duplicate))?$/);
    if (wfm) {
      const w = defs.getWorkflow(wfm[1]); if (!w) return this.json(res, 404, { error: 'workflow not found' });
      if (!wfm[2] && m === 'GET') return this.json(res, 200, w);
      if (!wfm[2] && (m === 'PATCH' || m === 'PUT')) { const b = await this.body(req); const r = defs.upsertWorkflow({ ...w, ...(b as Record<string, never>), id: w.id }, 'owner'); if (!r.ok) return this.json(res, 400, r); this.broadcast('workflows', { id: w.id }); return this.json(res, 200, r.workflow); }
      if (!wfm[2] && m === 'DELETE') { const r = defs.deleteWorkflow(w.id, 'owner'); return this.json(res, r.ok ? 200 : 409, r); }
      if (wfm[2] === 'enable' || wfm[2] === 'disable') { defs.setWorkflowEnabled(w.id, wfm[2] === 'enable', 'owner'); this.broadcast('workflows', { id: w.id }); return this.json(res, 200, defs.getWorkflow(w.id)); }
      if (wfm[2] === 'duplicate' && m === 'POST') { const b = await this.body(req); const nid = String(b.id ?? `${w.id}.copy`); const r = defs.duplicateWorkflow(w.id, nid, 'owner'); if (!r.ok) return this.json(res, 400, r); this.broadcast('workflows', { id: nid }); return this.json(res, 201, r.workflow); }
    }

    // ---- templates ----
    if (p === '/api/templates' && m === 'GET') return this.json(res, 200, defs.listPacks());
    const tm = p.match(/^\/api\/templates\/([^/]+)\/(install|uninstall)$/);
    if (tm && m === 'POST') { const r = tm[2] === 'install' ? defs.installPack(tm[1], 'owner') : defs.uninstallPack(tm[1], 'owner'); this.broadcast('workflows', { pack: tm[1] }); return this.json(res, r.ok ? 200 : 409, r); }

    // ---- automations (schedules) ----
    if (p === '/api/automations' || p === '/api/schedules') { if (m === 'GET') return this.json(res, 200, this.d.scheduler.list().filter((s) => !wsFilter || s.workspace_id === wsFilter).map((s) => ({ ...s, last_job: db.prepare('SELECT id, kind, state, outcome, completed_at FROM jobs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 1').get(s.id) ?? null })));   /* each routine with its last run, so the screen can say where that run's output went */ if (m === 'POST') { const b = await this.body(req); if (!b.workspace_id || !ws.get(String(b.workspace_id))) return this.json(res, 400, { error: 'workspace_id is required' }); try { const s = this.d.scheduler.add({ name: String(b.name ?? ''), kind: String(b.kind), objective: String(b.objective ?? ''), cron: b.cron ? String(b.cron) : null, every_seconds: b.every_seconds ? Number(b.every_seconds) : null, workspace_id: String(b.workspace_id), inputs: (b.inputs as Record<string, unknown>) ?? {} }); this.broadcast('automations', { id: s.id }); return this.json(res, 201, s); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } } }
    const sm = p.match(/^\/api\/(?:automations|schedules)\/([^/]+)(?:\/(enable|disable))?$/);
    if (sm) { if (sm[2] && m === 'POST') { this.d.scheduler.setEnabled(sm[1], sm[2] === 'enable'); return this.json(res, 200, this.d.scheduler.get(sm[1])); } if (!sm[2] && m === 'DELETE') { this.d.scheduler.remove(sm[1]); return this.json(res, 200, { id: sm[1], removed: true }); } }

    // ---- approvals / actions ----
    if (p === '/api/approvals' && m === 'GET') return this.json(res, 200, approvals.list(url.searchParams.get('status') as never ?? undefined));
    if (p === '/api/triggers' && m === 'GET') return this.json(res, 200, listTriggers(db));
    if (p === '/api/triggers' && m === 'POST') { const b = await this.body(req); try { const r = createTrigger(db, { name: String(b.name ?? ''), kind: String(b.kind ?? ''), objective: String(b.objective ?? ''), workspace_id: b.workspace_id ? String(b.workspace_id) : null }, 'owner'); return this.json(res, 201, { ...r, url: `http://127.0.0.1:${this.d.cfg.enginePort}/api/hooks/${r.trigger.id}`, note: 'The token is shown once. Send it as the x-claudebot-trigger-token header with JSON {"event_id": "...", "data": {...}}.' }); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } }
    const trm = p.match(/^\/api\/triggers\/([^/]+)$/); if (trm && m === 'DELETE') { db.prepare('UPDATE triggers SET enabled = 0 WHERE id = ?').run(trm[1]); store.event(null, 'owner', 'trigger.disabled', { id: trm[1] }); return this.json(res, 200, { ok: true }); }
    // Run an approved action exactly once (owner only: the app's cookie, not a script's header token). Idempotent per approval.
    const apx = p.match(/^\/api\/approvals\/([^/]+)\/execute$/);
    if (apx && m === 'POST') {
      { const pr = verifyOwnerPresence(db, this.d.cfg.secretsDir, 'execute', apx[1], confirmSubject(db, 'execute', apx[1])?.binding ?? '', req.headers); if (!pr.ok) return this.json(res, 403, { error: pr.error }); }
      const a = approvals.get(apx[1]); if (!a) return this.json(res, 404, { error: 'approval not found' });
      const prior = this.d.actions.byKey(`approval:${a.id}`); if (prior && prior.status !== 'pending') return this.json(res, 200, { status: prior.status === 'performed' ? 'already_performed' : prior.status, action: prior });
      const out = await this.d.actions.perform({ job_id: a.job_id, idempotency_key: `approval:${a.id}`, kind: a.action_kind, target: a.target, content: a.content, approval_id: a.id, actor: 'owner' });
      this.broadcast('jobs', { approval: a.id }); return this.json(res, 200, out);
    }
    const acr = p.match(/^\/api\/actions\/([^/]+)\/resolve$/);
    if (acr && m === 'POST') {
      const b = await this.body(req); { const pr = verifyOwnerPresence(db, this.d.cfg.secretsDir, b.outcome === 'performed' ? 'resolve_performed' : 'resolve_not_performed', acr[1], confirmSubject(db, b.outcome === 'performed' ? 'resolve_performed' : 'resolve_not_performed', acr[1])?.binding ?? '', req.headers); if (!pr.ok) return this.json(res, 403, { error: pr.error }); } try { return this.json(res, 200, this.d.actions.resolve(acr[1], b.outcome === 'performed' ? 'performed' : 'not_performed', 'owner')); } catch (e) { return this.json(res, 409, { error: (e as Error).message }); }
    }
    // Telegram (gate 6): the owner pastes the bot token and makes a one-time pairing code here; the token is never returned.
    if (p === '/api/telegram' && m === 'GET') { const b = tgBinding(db); const er = (db.prepare("SELECT value FROM runtime_state WHERE key = 'telegram.error'").get() as { value: string } | undefined); const err = er ? (JSON.parse(er.value) as { error: string | null }).error : null; const bt = (db.prepare("SELECT value FROM runtime_state WHERE key = 'telegram.bot'").get() as { value: string } | undefined); return this.json(res, 200, { configured: hasToken(this.d.cfg.secretsDir), bound: !!b, chat: b?.user ?? null, bound_at: b?.bound_at ?? null, bot: !err && bt ? (JSON.parse(bt.value) as { bot: string }).bot : null, problem: err ? (/^telegram getUpdates: Unauthorized/i.test(err) ? 'Telegram rejected this token: it is not a current token for any bot. Get a fresh one from @BotFather (send /token, pick your bot) and paste it here.' : err.startsWith('telegram ') ? `Telegram is not reachable right now (${err.replace(/^telegram \w+: /, '')}).` : err) : null }); }
    if (p.startsWith('/api/telegram/') && m === 'POST' && (req.headers['x-claudebot-token'] || url.searchParams.get('t'))) return this.json(res, 403, { error: 'Telegram is set up in the ClaudeBot app' });
    if (p === '/api/telegram/token' && m === 'POST') { const b = await this.body(req); try { saveToken(this.d.cfg.secretsDir, String(b.token ?? '')); store.event(null, 'owner', 'telegram.token_set', {}); const ck = await checkToken(db, this.d.cfg.secretsDir); return this.json(res, 200, { configured: true, ...ck }); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } }
    if (p === '/api/telegram/pair' && m === 'POST') { if (!hasToken(this.d.cfg.secretsDir)) return this.json(res, 409, { error: 'paste the bot token first' }); return this.json(res, 200, newPairingCode(db)); }
    if (p === '/api/telegram/unbind' && m === 'POST') { tgUnbind(db); return this.json(res, 200, { bound: false }); }
    // Standing permissions: proposed from a real approval in the owner's app session, active only after the owner's native confirmation of the exact scope.
    if (p === '/api/permissions' && m === 'GET') return this.json(res, 200, listPermissions(db).map((x) => ({ ...x, agent_name: defs.getAgent(x.agent_id)?.name ?? x.agent_id })));
    if (p === '/api/permissions/propose' && m === 'POST') { if (req.headers['x-claudebot-token']) return this.json(res, 403, { error: 'standing permissions are created in the ClaudeBot app' }); const b = await this.body(req); try { const ap = approvals.get(String(b.approval_id ?? '')); const agent = ap?.job_id ? store.get(ap.job_id)?.agent_role : null; const pm = proposePermission(db, { approval_id: String(b.approval_id ?? ''), max_per_day: b.max_per_day as number | undefined, days: b.days as number | undefined, reason: b.reason ? String(b.reason) : undefined, agent_name: agent ? defs.getAgent(agent)?.name : undefined }, 'owner'); return this.json(res, 201, pm); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } }
    if (p === '/api/permissions/job-applications' && m === 'POST') { if (req.headers['x-claudebot-token']) return this.json(res, 403, { error: 'switched on from the app only' }); const pm = grantJobApplications(db, 'owner', { reason: 'switched on in Settings' }); this.broadcast('approvals', {}); return this.json(res, 200, pm); }
    const pmm = p.match(/^\/api\/permissions\/([^/]+)\/(activate|revoke)$/);
    if (pmm && m === 'POST') {
      if (pmm[2] === 'revoke') { const ok = revokePermission(db, pmm[1], 'owner'); this.broadcast('settings', { permission: pmm[1] }); return ok ? this.json(res, 200, { revoked: true }) : this.json(res, 404, { error: 'no active permission with that id' }); }
      { const pr = verifyOwnerPresence(db, this.d.cfg.secretsDir, 'permit', pmm[1], confirmSubject(db, 'permit', pmm[1])?.binding ?? '', req.headers); if (!pr.ok) return this.json(res, 403, { error: pr.error }); }
      try { const pm = activatePermission(db, pmm[1], 'owner');
        // The request it was created from is allowed too ("Always allow follow-ups like this" includes this one), and runs once.
        if (pm.from_approval) { const ap = approvals.get(pm.from_approval); if (ap && ap.status === 'pending') { approvals.decide(ap.id, 'approved', `permission:${pm.id}`, 'allowed with the standing permission it created'); if (ap.job_id) { const j = store.get(ap.job_id); if (j && j.state === 'waiting_for_approval') store.transition(j.id, 'queued', 'owner', { waiting_on: null, blocker_code: null, operator_action: null, next_action: 'resume after owner decision' }, { approval: ap.id, decision: 'approved' }); } } }
        this.broadcast('approvals', { permission: pm.id }); return this.json(res, 200, pm); } catch (e) { return this.json(res, 409, { error: (e as Error).message }); }
    }
    // Ask again after expiry, or edit the exact text before deciding (the old request is superseded). Owner only: the app's session.
    const apr2 = p.match(/^\/api\/approvals\/([^/]+)\/(retry|revise)$/);
    if (apr2 && m === 'POST') { const b = await this.body(req); const ttl = Number(this.d.settings.get('approval_ttl_minutes') ?? 720) * 60; try { const n = apr2[2] === 'retry' ? approvals.retry(apr2[1], 'owner', ttl) : approvals.revise(apr2[1], String(b.content ?? ''), 'owner', ttl); this.d.chat.sync(defs); this.broadcast('approvals', { id: n.id }); this.broadcast('chat', {}); return this.json(res, 201, n); } catch (e) { return this.json(res, 409, { error: (e as Error).message }); } }
    const apm = p.match(/^\/api\/approvals\/([^/]+)\/decide$/);
    if (apm && m === 'POST') { const b = await this.body(req); if (b.decision === 'approved') { const pr = verifyOwnerPresence(db, this.d.cfg.secretsDir, 'approve', apm[1], confirmSubject(db, 'approve', apm[1])?.binding ?? '', req.headers); if (!pr.ok) return this.json(res, 403, { error: pr.error }); } const d = b.decision === 'approved' ? 'approved' : 'rejected'; try { const a = approvals.decide(apm[1], d, 'owner', b.note ? String(b.note) : undefined); if (a.job_id) { const j = store.get(a.job_id); if (j && j.state === 'waiting_for_approval') store.transition(j.id, 'queued', 'owner', { waiting_on: null, blocker_code: null, operator_action: null, next_action: 'resume after owner decision' }, { approval: a.id, decision: d }); } if (d === 'approved') this.d.chat.resumeForApproval(a.id, defs); this.broadcast('approvals', { id: a.id }); this.broadcast('chat', {}); return this.json(res, 200, a); } catch (e) { return this.json(res, 409, { error: (e as Error).message }); } }
    if (p === '/api/actions' && m === 'GET') return this.json(res, 200, this.d.actions.list());
    if (p === '/api/actions/perform' && m === 'POST') { const b = await this.body(req); { const pr = verifyOwnerPresence(db, this.d.cfg.secretsDir, 'execute', String(b.approval_id ?? ''), confirmSubject(db, 'execute', String(b.approval_id ?? ''))?.binding ?? '', req.headers); if (!pr.ok) return this.json(res, 403, { error: pr.error }); } const r = await this.d.actions.perform({ job_id: b.job_id ? String(b.job_id) : null, idempotency_key: String(b.idempotency_key ?? crypto.randomUUID()), kind: String(b.kind), target: String(b.target), content: String(b.content ?? ''), approval_id: b.approval_id ? String(b.approval_id) : null, actor: 'owner' }); this.broadcast('jobs', { action: r.action?.id ?? null }); return this.json(res, r.status === 'refused' ? 403 : 200, r); }


    // ---- conversations (chat-first) ----
    if (p === '/api/conversations' && m === 'GET') return this.json(res, 200, this.d.chat.list({ workspace: wsFilter, includeArchived: url.searchParams.get('archived') === '1' }));
    if (p === '/api/conversations' && m === 'POST') { const b = await this.body(req); const wsId = b.workspace_id ? String(b.workspace_id) : this.defaultWorkspace().id; const w = ws.get(wsId); if (!w || w.status !== 'active') return this.json(res, 400, { error: 'project not found or archived' }); let c; try { c = this.d.chat.create({ workspace_id: wsId, title: b.title ? String(b.title) : '', type: b.type === 'group' ? 'group' : 'direct', members: Array.isArray(b.members) ? b.members.map(String) : b.agent_id ? [String(b.agent_id)] : undefined }); } catch (e) { return this.json(res, 400, { error: (e as Error).message, code: e instanceof ChatRuleError ? e.code : undefined }); } this.broadcast('chat', { conversation_id: c.id }); return this.json(res, 201, c); }
    // Owner attachments (Phase 4): checked, saved in the project with hash and provenance, registered as a result of this conversation.
    const exm = p.match(/^\/api\/conversations\/([^/]+)\/export$/);
    if (exm && m === 'POST') { try { const r = exportConversation(db, exm[1]); const msg = this.d.chat.add({ conversation_id: exm[1], role: 'system', kind: 'result', sender: 'system', content: `Chat export (${r.messages} messages)`, job_id: r.job_id, artifact_id: r.artifact_id, meta: { state: 'completed', file_verified: true, export: true } }); this.broadcast('chat', { conversation_id: exm[1] }); return this.json(res, 201, { ...r, message_id: msg.id }); } catch (e) { return this.json(res, e instanceof AttachmentError ? 400 : 500, { error: (e as Error).message }); } }
    const atm = p.match(/^\/api\/conversations\/([^/]+)\/attachments$/);
    if (atm && m === 'POST') { const b = await this.body(req, 15 * 1024 * 1024); try { const bytes = Buffer.from(String(b.content_b64 ?? ''), 'base64'); const r = saveAttachment(db, { conversation_id: atm[1], name: String(b.name ?? ''), bytes }); const msg = this.d.chat.add({ conversation_id: atm[1], role: 'owner', kind: 'attachment', sender: 'owner', content: `Attached ${path.basename(r.path).slice(9)}`, job_id: r.job_id, artifact_id: r.artifact_id, meta: { sha256: r.sha256, bytes: r.bytes } }); this.broadcast('chat', { conversation_id: atm[1] }); return this.json(res, 201, { ...r, message_id: msg.id }); } catch (e) { return this.json(res, e instanceof AttachmentError ? 400 : 500, { error: (e as Error).message }); } }
    // Reactions on any message (owner only through the API; assistants react through their own turns in a later gate).
    const rm = p.match(/^\/api\/messages\/([^/]+)\/reactions$/);
    if (rm && m === 'POST') { const b = await this.body(req); try { const out = this.d.chat.react(rm[1], 'owner', String(b.emoji ?? ''), b.on !== false); const msg = this.d.chat.message(rm[1])!; this.broadcast('chat', { conversation_id: msg.conversation_id }); return this.json(res, 200, { reactions: out }); } catch (e) { return this.json(res, e instanceof ChatRuleError && e.code === 'not_found' ? 404 : 400, { error: (e as Error).message }); } }
    // Assistants from plain words: the Chief of Staff drafts (a real Claude turn), the owner names and confirms.
    if (p === '/api/assistants/draft' && m === 'POST') { const b = await this.body(req); const description = String(b.description ?? '').trim(); if (description.length < 8) return this.json(res, 400, { error: 'describe the assistant in a sentence or two' }); if (description.length > 2000) return this.json(res, 400, { error: 'keep the description under 2,000 characters' }); const wf = defs.getWorkflow('assistant.draft'); if (!wf) return this.json(res, 500, { error: 'draft workflow missing' }); const r = store.create({ idempotency_key: `assistant-draft:${crypto.createHash('sha256').update(description + (b.client_id ?? Date.now())).digest('hex').slice(0, 24)}`, kind: wf.id, objective: `Draft a new assistant: ${description.slice(0, 300)}`, success_contract: wf.contract, agent_role: wf.default_agent, workspace_id: b.workspace_id ? String(b.workspace_id) : this.defaultWorkspace().id, priority: 2, inputs: { description } }, 'owner'); this.broadcast('jobs', { id: r.job.id }); return this.json(res, 201, { job: { id: r.job.id, state: r.job.state } }); }
    const adm = p.match(/^\/api\/assistants\/draft\/(job-[^/]+)$/);
    if (adm && m === 'GET') { const j = store.get(adm[1]); if (!j || j.kind !== 'assistant.draft') return this.json(res, 404, { error: 'not found' }); const d = new Assistants(db).byJob(j.id) ?? null; const cp = store.latestVerified(j.id); let summary: string | null = null; try { const pl = cp ? JSON.parse(cp.payload) as { result?: { summary?: string } } : null; summary = pl?.result?.summary ?? null; } catch { /* */ } let description = ''; try { description = String((JSON.parse(j.inputs || '{}') as { description?: string }).description ?? ''); } catch { /* */ } return this.json(res, 200, { job: { id: j.id, state: j.state, turn_state: turnState(j, cfg.heartbeatSeconds), plain_state: plainState(j), failure_detail: j.failure_detail, operator_action: j.operator_action }, draft: d, summary, description }); }
    const dgm = p.match(/^\/api\/assistants\/drafts\/([^/]+)$/);
    if (dgm && m === 'GET') { const d = new Assistants(db).get(dgm[1]); const trial = d ? db.prepare('SELECT id, state FROM jobs WHERE idempotency_key = ?').get(`assistant-trial:${d.id}`) ?? null : null; return d ? this.json(res, 200, { ...d, trial }) : this.json(res, 404, { error: 'draft not found' }); }
    // Try one run first: a single sample run of the drafted job by an existing assistant, before the owner creates it. Once per draft.
    const dtm = p.match(/^\/api\/assistants\/drafts\/([^/]+)\/trial$/);
    if (dtm && m === 'POST') { const d = new Assistants(db).get(dtm[1]); if (!d) return this.json(res, 404, { error: 'draft not found' }); if (d.status !== 'pending') return this.json(res, 409, { error: `draft is ${d.status}` });
      const f = d.draft as unknown as { name?: string; purpose?: string; instructions?: string; tools?: string[] }; const kind = (f.tools ?? []).some((t) => t === 'search' || t === 'browser') ? 'research.report' : 'document.create'; const wf = defs.getWorkflow(kind); if (!wf) return this.json(res, 500, { error: 'workflow missing' });
      const objective = `Trial run for the drafted assistant "${f.name ?? 'new assistant'}" (not created yet): ${f.purpose ?? ''} Work as its instructions say: ${String(f.instructions ?? '').slice(0, 1200)} This is one sample run for the owner to judge the draft: save what it would deliver in the task folder and do not send, publish, buy or delete anything.`;
      const r = store.create({ idempotency_key: `assistant-trial:${d.id}`, kind: wf.id, objective, success_contract: wf.contract, agent_role: wf.default_agent, workspace_id: this.defaultWorkspace().id, priority: 2, inputs: { draft_id: d.id, trial: true } }, 'owner'); this.broadcast('jobs', { id: r.job.id }); return this.json(res, r.created ? 201 : 200, { job: { id: r.job.id, state: r.job.state }, already: !r.created }); }
    const dcm = p.match(/^\/api\/assistants\/drafts\/([^/]+)\/(confirm|discard)$/);
    if (dcm && m === 'POST') { const b = await this.body(req); const A = new Assistants(db); try { if (dcm[2] === 'discard') { A.discard(dcm[1]); return this.json(res, 200, A.get(dcm[1])); } const a = A.confirm(dcm[1], { name: b.name ? String(b.name) : undefined, role: b.role ? String(b.role) : undefined, purpose: b.purpose ? String(b.purpose) : undefined, responsibilities: Array.isArray(b.responsibilities) ? b.responsibilities.map(String) : undefined, instructions: b.instructions ? String(b.instructions) : undefined }); this.broadcast('agents', { id: a.id }); return this.json(res, 201, a); } catch (e) { return this.json(res, e instanceof ChatRuleError && e.code === 'not_found' ? 404 : 400, { error: (e as Error).message, code: e instanceof ChatRuleError ? e.code : undefined }); } }
    const cm = p.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|archive|reset-session|members))?$/);
    if (cm) {
      const c = this.d.chat.get(cm[1]); if (!c) return this.json(res, 404, { error: 'conversation not found' });
      if (!cm[2] && m === 'GET') return this.json(res, 200, this.conversationDetail(c.id));
      if (cm[2] === 'messages' && m === 'POST') {
        const b = await this.body(req); const content = String(b.content ?? '').trim(); if (!content) return this.json(res, 400, { error: 'say what you would like done' }); if (content.length > 20_000) return this.json(res, 400, { error: 'message too long (20,000 characters max)' });
        // Idempotent submission: a client id (one per voice session or Send press) is stored with the message; repeating it returns the original.
        const clientId = typeof b.client_id === 'string' && b.client_id.length > 0 && b.client_id.length <= 200 ? b.client_id : null;
        if (clientId) { const dup = this.d.chat.byClientId(c.id, clientId); if (dup) { this.d.store.event(dup.job_id ?? null, 'owner', 'message.duplicate_ignored', { conversation_id: c.id, message_id: dup.id, client_id: clientId }); return this.json(res, 200, { message: dup, job: dup.job_id ? store.get(dup.job_id) : null, duplicate: true }); } }
        // The owner can keep talking while work runs: new messages queue behind the assistant's current turn.
        const mentions = Array.isArray(b.mentions) ? b.mentions.map(String).slice(0, 12) : undefined; const replyTo = typeof b.reply_to === 'string' && b.reply_to ? b.reply_to : null;
        try { const meta: Record<string, unknown> = b.source === 'voice' ? { source: 'voice', recognition: b.fixture === true ? 'on-device (macOS), from a recorded test file, not the microphone' : b.on_device === true ? 'on-device (macOS)' : b.on_device === false ? 'Apple server (owner consented)' : 'unknown', ...(b.fixture === true ? { fixture: true } : {}) } : {}; if (clientId) meta.client_id = clientId; const r = this.d.chat.send(c.id, content, defs, 'owner', meta, { mentions, reply_to: replyTo }); this.broadcast('chat', { conversation_id: c.id }); for (const j of r.jobs) this.broadcast('jobs', { id: j.id }); return this.json(res, 201, { message: r.message, job: r.job, jobs: r.jobs.map((j) => ({ id: j.id, agent_role: j.agent_role, state: j.state })), routed: r.routed }); } catch (e) { return this.json(res, 400, { error: (e as Error).message, code: e instanceof ChatRuleError ? e.code : undefined }); }
      }
      if (!cm[2] && m === 'PATCH') { const b = await this.body(req); if (b.title !== undefined) { const n = String(b.title).replace(/\s+/g, ' ').trim(); if (!n) return this.json(res, 400, { error: 'give the chat a name' }); this.d.chat.setTitle(c.id, n); } if (b.purpose !== undefined) db.prepare('UPDATE conversations SET purpose = ?, updated_at = ? WHERE id = ?').run(String(b.purpose).trim().slice(0, 1000), new Date().toISOString(), c.id); store.event(null, 'owner', 'conversation.edited', { conversation_id: c.id, title: b.title !== undefined, purpose: b.purpose !== undefined }); this.broadcast('chat', { conversation_id: c.id }); return this.json(res, 200, this.conversationDetail(c.id)); }
      if (cm[2] === 'members' && m === 'DELETE') { const b = await this.body(req); try { this.d.chat.removeMember(c.id, String(b.agent_id ?? '')); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } this.broadcast('chat', { conversation_id: c.id }); return this.json(res, 200, this.conversationDetail(c.id)); }
      if (cm[2] === 'members' && m === 'POST') { const b = await this.body(req); try { this.d.chat.addMember(c.id, String(b.agent_id ?? '')); } catch (e) { return this.json(res, 400, { error: (e as Error).message, code: e instanceof ChatRuleError ? e.code : undefined }); } this.broadcast('chat', { conversation_id: c.id }); return this.json(res, 200, this.conversationDetail(c.id)); }
      if (cm[2] === 'archive' && m === 'POST') { const active = this.d.chat.activeTurn(c.id); if (active) return this.json(res, 409, { error: 'a reply is in progress' }); this.d.chat.archive(c.id, 'owner'); for (const mem of this.d.chat.members(c.id)) if (mem.session_ref) { if (this.d.runtime.closeSession) this.d.runtime.closeSession(mem.session_ref).catch(() => {}); this.d.chat.setSession(c.id, null, mem.agent_id); } this.broadcast('chat', { conversation_id: c.id }); return this.json(res, 200, this.d.chat.get(c.id)); }
      if (cm[2] === 'reset-session' && m === 'POST') { const active = this.d.chat.activeTurn(c.id); if (active) return this.json(res, 409, { error: 'a reply is in progress' }); for (const mem of this.d.chat.members(c.id)) if (mem.session_ref) { if (this.d.runtime.closeSession) await this.d.runtime.closeSession(mem.session_ref).catch(() => {}); this.d.chat.setSession(c.id, null, mem.agent_id); } store.event(null, 'owner', 'conversation.session_reset', { id: c.id }); return this.json(res, 200, this.d.chat.get(c.id)); }
    }

    // ---- live browser ----
    if (p === '/api/browser/stream' && m === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }); this.d.live.subscribe(res); return; }
    if (p === '/api/browser/live' && m === 'GET') return this.json(res, 200, await this.liveStatus());
    if (p === '/api/browser/takeover' && m === 'POST') {
      const b = await this.body(req); const active = !!b.active; const site = b.site ? String(b.site).toLowerCase().replace(/^www\./, '') : null;
      this.d.live.setTakeover(active, b.note ? String(b.note) : null, site, 'owner');
      let login: { site: string; signed_in: boolean; evidence: string; resumed: string[] } | null = null;
      if (!active && site) {
        // The owner says they are done: verify the sign-in state read-only (never automating it) and resume paused work.
        try { const r = await browserLoginCheck(cfg, site); db.prepare('INSERT INTO browser_sites(site, profile, signed_in, check_method, last_checked_at, evidence) VALUES (?,?,?,?,?,?) ON CONFLICT(site) DO UPDATE SET signed_in=excluded.signed_in, check_method=excluded.check_method, last_checked_at=excluded.last_checked_at, evidence=excluded.evidence').run(site, 'claudebot', r.signed_in ? 1 : 0, 'dom-marker', new Date().toISOString(), r.evidence); const resumed = r.signed_in ? store.resumeWaitingOn(`browser:${site}`, 'owner').map((j) => j.id) : []; login = { site, ...r, resumed }; if (resumed.length) this.broadcast('jobs', { resumed }); } catch (e) { login = { site, signed_in: false, evidence: `check failed: ${(e as Error).message}`, resumed: [] }; }
      }
      this.broadcast('browser', { takeover: active }); return this.json(res, 200, { takeover: active, login });
    }
    if (p === '/api/browser/arrange' && m === 'POST') { const b = await this.body(req); try { const r = await this.d.live.arrange({ left: Number(b.left), top: Number(b.top), width: Number(b.width), height: Number(b.height) }); return this.json(res, r.ok ? 200 : 409, r); } catch (e) { return this.json(res, 409, { ok: false, detail: (e as Error).message }); } }
    if (p === '/api/browser/follow' && m === 'POST') { const b = await this.body(req); const r = await this.d.live.follow(String(b.id ?? '')); return this.json(res, r.ok ? 200 : 404, r); }
    if (p === '/api/browser/front' && m === 'POST') { try { return this.json(res, 200, await this.d.live.bringToFront()); } catch (e) { return this.json(res, 409, { ok: false, detail: (e as Error).message }); } }

    // ---- the assistants' computer (Lima VM): status, and the owner's Update / Reset to snapshot / Recover ----
    if (p === '/api/computer' && m === 'GET') return this.json(res, 200, { ...(await this.computer().status()), busy: this.computerBusy, location: runtimeLocation(db) });
    if (p === '/api/computer/takeover' && m === 'POST') {   // owner takes over one screen: input on there only, assistants' browser paused
      if (req.headers['x-claudebot-token']) return this.json(res, 403, { error: 'taken over from the app only' });
      const b = await this.body(req); const n = Math.max(1, Number(b.screen ?? 1)); const on = !!b.active; const tok = new ComputerToken(cfg.secretsDir).get();
      const r = await fetch(`http://127.0.0.1:47777/input/${n}?on=${on ? 1 : 0}`, { method: 'POST', headers: { authorization: `Bearer ${tok ?? ''}` } }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
      if (!r.ok) return this.json(res, 502, { error: 'the assistants\' computer did not switch input' });
      this.d.live.setTakeover(on, on ? `screen ${n}` : null, b.site ? String(b.site) : null, 'owner'); store.event(null, 'owner', on ? 'computer.takeover_started' : 'computer.takeover_ended', { screen: n });
      this.broadcast('browser', { takeover: on }); return this.json(res, 200, { takeover: on, screen: n });
    }
    if (p === '/api/computer/location' && m === 'POST') {   // where assistants' Claude turns run; switching back to the Mac is the rollback
      if (req.headers['x-claudebot-token']) return this.json(res, 403, { error: 'changed from the app only' });
      const b = await this.body(req); const loc = b.location === 'computer' ? 'computer' : 'mac';
      if (loc === 'computer' && (await this.computer().status()).state !== 'running') return this.json(res, 409, { error: 'start the computer first' });
      if ((db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('leased','running')").get() as { n: number }).n) return this.json(res, 409, { error: 'wait until nothing is running, then switch' });
      settings.set('runtime_location', loc, 'owner'); store.event(null, 'owner', 'runtime.location_changed', { location: loc });
      setTimeout(() => process.exit(0), 800);   // launchd restarts the engine; workers start on the chosen route
      return this.json(res, 202, { location: loc, restarting: true });
    }
    const cmp = p.match(/^\/api\/computer\/(update|reset|recover|snapshot)$/);
    if (cmp && m === 'POST') {
      if (req.headers['x-claudebot-token']) return this.json(res, 403, { error: 'the computer is changed from the app only' });
      if (this.computerBusy) return this.json(res, 409, { error: `the computer is busy (${this.computerBusy})` });
      const b = await this.body(req); this.computerBusy = cmp[1]; store.event(null, 'owner', `computer.${cmp[1]}`, { snapshot: b.snapshot ?? null });
      const h = this.computer(); const job = cmp[1] === 'update' ? h.update() : cmp[1] === 'reset' ? h.reset(b.snapshot ? String(b.snapshot) : undefined) : cmp[1] === 'snapshot' ? h.snapshot('manual') : h.up();
      job.then(() => store.event(null, 'engine', `computer.${cmp[1]}_done`, {}), (e: Error) => store.event(null, 'engine', `computer.${cmp[1]}_failed`, { error: e.message.slice(0, 300) })).finally(() => { this.computerBusy = null; this.broadcast('computer', {}); });
      return this.json(res, 202, { started: cmp[1] });
    }
    // ---- artifacts / memory / browser / connections / activity / reliability / settings ----
    if (p === '/api/search' && m === 'GET') { const q = url.searchParams.get('q') ?? ''; return this.json(res, 200, searchScoped(db, null, q, { owner: { workspace_id: wsFilter ?? null }, limit: Number(url.searchParams.get('limit') ?? 20), kinds: url.searchParams.get('kinds')?.split(',').filter(Boolean) })); }
    if (p === '/api/artifacts' && m === 'GET') return this.json(res, 200, db.prepare(`SELECT a.*, j.kind AS task_kind, j.workspace_id AS ws FROM artifacts a LEFT JOIN jobs j ON j.id = a.job_id ${wsFilter ? 'WHERE j.workspace_id = ?' : ''} ORDER BY a.created_at DESC LIMIT 500`).all(...(wsFilter ? [wsFilter] : [])));
    const artm = p.match(/^\/api\/artifacts\/([^/]+)(?:\/(review|download|raw))?$/);
    if (artm) { const a = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artm[1]) as { path: string | null } | undefined; if (!a) return this.json(res, 404, { error: 'not found' }); if (artm[2] === 'review' && m === 'POST') { const b = await this.body(req); const st = ['accepted', 'rejected', 'unreviewed'].includes(String(b.review_state)) ? String(b.review_state) : 'unreviewed'; db.prepare('UPDATE artifacts SET review_state = ? WHERE id = ?').run(st, artm[1]); store.event(null, 'owner', 'artifact.reviewed', { id: artm[1], review_state: st }); return this.json(res, 200, { id: artm[1], review_state: st }); } if (artm[2] === 'raw') { if (!a.path || !fs.existsSync(a.path)) return this.json(res, 404, { error: 'the file is no longer on disk' }); const ext = path.extname(a.path).toLowerCase(); if (!['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return this.json(res, 415, { error: 'only PDFs and images preview inline' }); res.writeHead(200, { 'content-type': MIME[ext], 'content-disposition': 'inline', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }); fs.createReadStream(a.path).pipe(res); return; } if (artm[2] === 'download') { if (!a.path || !fs.existsSync(a.path)) return this.json(res, 404, { error: 'the file is no longer on disk' }); const name = path.basename(a.path).replace(/[^\w.\- ]+/g, '_'); res.writeHead(200, { 'content-type': MIME[path.extname(a.path)] ?? 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' }); fs.createReadStream(a.path).pipe(res); store.event(null, 'owner', 'artifact.downloaded', { id: artm[1] }); return; } let content: string | null = null; let format: string | null = null; if (a.path && fs.existsSync(a.path)) { const ext = path.extname(a.path).toLowerCase(); const size = fs.statSync(a.path).size; if (ext === '.pdf') format = 'pdf'; else if (ext === '.docx') { format = 'docx'; try { content = execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', a.path], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }).toString('utf8'); } catch { content = null; } } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) format = 'image'; else if (size < 512 * 1024) content = fs.readFileSync(a.path, 'utf8'); } return this.json(res, 200, { ...a, content, format }); }
    if (p === '/api/browser') return this.json(res, 200, { sites: db.prepare('SELECT * FROM browser_sites ORDER BY site').all(), status: this.d.watchdog.last?.browser ?? null, active_jobs: store.list({ state: ['leased', 'running'] }).filter((j) => j.kind.startsWith('browser.')), profile: 'claudebot', live: await this.liveStatus() });
    if (p === '/api/connections') { const claude = this.d.watchdog.last?.claude ?? null; const gw = this.d.watchdog.last?.gateway ?? null; const rts = await Promise.all(this.d.runtimes.map(async (r) => ({ id: r.id, ...r.describe(), health: await r.health().catch((e) => ({ state: 'error', detail: (e as Error).message })) }))); return this.json(res, 200, { claude: { ...claude, observed_model: observedModel(cfg.claudeConfigDir), config_dir: cfg.claudeConfigDir, executable: cfg.claudeExecutable, reconnect_command: `CLAUDE_CONFIG_DIR=${cfg.claudeConfigDir} ${cfg.claudeExecutable} auth login --claudeai` }, gateway: { ...gw, url: cfg.gatewayUrl, profile: cfg.openclawProfile, token_storage: 'file SecretRef (never shown)' }, runtimes: rts, connectors: [{ id: 'managed-browser', label: 'Managed browser profile', state: this.d.watchdog.last?.browser?.state ?? 'unknown' }] }); }
    if (p === '/api/memory') return this.json(res, 200, { rules: db.prepare(`SELECT * FROM memory_rules ${wsFilter ? 'WHERE workspace_id = ?' : ''} ORDER BY updated_at DESC`).all(...(wsFilter ? [wsFilter] : [])), evidence: db.prepare(`SELECT * FROM memory_evidence ${wsFilter ? 'WHERE workspace_id = ?' : ''} ORDER BY created_at DESC LIMIT 300`).all(...(wsFilter ? [wsFilter] : [])), proposals: db.prepare(`SELECT * FROM memory_proposals ${wsFilter ? 'WHERE workspace_id = ?' : ''} ORDER BY created_at DESC`).all(...(wsFilter ? [wsFilter] : [])) });
    const pm = p.match(/^\/api\/memory\/proposals\/([^/]+)\/decide$/);
    if (pm && m === 'POST') { const b = await this.body(req); const status = b.decision === 'accepted' ? 'accepted' : 'declined'; db.prepare('UPDATE memory_proposals SET status = ?, decided_at = ? WHERE id = ?').run(status, new Date().toISOString(), pm[1]); if (status === 'accepted') { const prop = db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(pm[1]) as { title: string; body: string; workspace_id: string | null } | undefined; if (prop) db.prepare('INSERT INTO memory_rules(id, title, body, source, created_at, updated_at, workspace_id) VALUES (?,?,?,?,?,?,?)').run(`rule-${crypto.randomBytes(4).toString('hex')}`, prop.title, prop.body, `proposal ${pm[1]} accepted by owner`, new Date().toISOString(), new Date().toISOString(), prop.workspace_id); } store.event(null, 'owner', `proposal.${status}`, { id: pm[1] }); return this.json(res, 200, { id: pm[1], status }); }
    if (p === '/api/activity') { const after = Number(url.searchParams.get('after') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 200); const rows = db.prepare(`SELECT e.seq, e.job_id, e.at, e.actor, e.type, e.detail, j.workspace_id FROM job_events e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.seq > ? ${wsFilter ? 'AND j.workspace_id = ?' : ''} ORDER BY e.seq DESC LIMIT ?`).all(...([after, ...(wsFilter ? [wsFilter] : []), limit] as never[])) as Array<{ detail: string }>; return this.json(res, 200, rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }))); }
    if (p === '/api/reliability') return this.json(res, 200, { health: this.d.watchdog.last, workers: [...this.d.dispatcher.workers.values()].map((w) => ({ pid: w.pid, started_at: w.startedAt })), capacity: this.d.dispatcher.capacity(), backups: listBackups(cfg.backupsDir), incidents: db.prepare('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 100').all(), gateway_restarts: this.d.watchdog.gatewayRestarts, recovery_tests: (db.prepare("SELECT key, value, observed_at FROM runtime_state WHERE key LIKE 'recovery.%'").all() as Array<{ key: string; value: string; observed_at: string }>).map((x) => ({ key: x.key, ...JSON.parse(x.value), observed_at: x.observed_at })) });
    if (p === '/api/settings' && m === 'GET') return this.json(res, 200, { ...settings.all(), runtime: { worker_processes: this.d.dispatcher.workers.size, capacity: this.d.dispatcher.capacity() } });
    if (p === '/api/settings' && (m === 'PATCH' || m === 'PUT')) { const b = await this.body(req); try { for (const [k, v] of Object.entries(b)) { if (!['worker_limit', 'memory_pressure_floor_pct', 'default_workspace_worker_limit', 'approval_ttl_minutes', 'usage_low_power_pct', 'usage_stop_pct'].includes(k)) return this.json(res, 400, { error: `unknown setting ${k}` }); settings.set(k, v, 'owner'); } this.d.dispatcher.ensureWorkers(); this.broadcast('settings', b); refreshGovernor(db); return this.json(res, 200, settings.all()); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); } }
    if (p === '/api/owner/confirm-subject' && m === 'GET') { const q = new URL(req.url ?? '/', 'http://x').searchParams; const sub = confirmSubject(db, String(q.get('action') ?? ''), String(q.get('id') ?? '')); return sub ? this.json(res, 200, sub) : this.json(res, 404, { error: 'nothing to confirm' }); }
    if (p === '/api/state' && m === 'POST') { const b = await this.body(req); if (String(b.key ?? '').startsWith('executor.')) return this.json(res, 403, { error: 'executor registrations are recorded by the engine only' }); db.prepare('INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at').run(String(b.key), JSON.stringify(b.value), String(b.evidence ?? 'owner/test'), new Date().toISOString()); return this.json(res, 200, { ok: true }); }
    if (p === '/api/broker/call' && m === 'POST') { const token = String(req.headers['x-capability'] ?? ''); const jobId = String(req.headers['x-job-id'] ?? ''); const capKey = String(req.headers['x-capability-key'] ?? jobId); const cap = verifyCapability(cfg.runDir, capKey, token); if (cap && cap.job_id !== jobId) { store.event(jobId || null, 'broker', 'tool.refused', { reason: 'capability bound to another job' }); return this.json(res, 403, { ok: false, text: 'capability is bound to another task' }); } if (!cap) { store.event(jobId || null, 'broker', 'tool.refused', { reason: 'invalid capability' }); return this.json(res, 403, { ok: false, text: 'invalid or expired capability' }); } const b = await this.body(req); const r = await new BrokerApi(db, store, approvals, cfg).call(cap, String(b.tool), (b.args as Record<string, unknown>) ?? {}); this.broadcast('jobs', { id: jobId }); return this.json(res, 200, r); }
    // ---- deprecated revenue surface ----
    if (p === '/api/revenue') { res.setHeader('deprecation', 'true'); return this.json(res, 410, { error: 'removed', hint: 'Revenue is an optional template pack. Install it from Templates; its records live under /api/records?type=revenue.*' }); }
    if (p === '/api/records' && m === 'GET') { const type = url.searchParams.get('type'); return this.json(res, 200, db.prepare(`SELECT * FROM records WHERE (? IS NULL OR type LIKE ?) ${wsFilter ? 'AND workspace_id = ?' : ''} ORDER BY updated_at DESC LIMIT 500`).all(...([type, type ? type.replace('*', '%') : null, ...(wsFilter ? [wsFilter] : [])] as never[]))); }
    return this.json(res, 404, { error: 'not found' });
  }


  /** The project used when the owner just starts talking: the first active one, or a new "General" project. */
  private defaultWorkspace() {
    const list = this.d.workspaces.list(); if (list.length) return list[0];
    const w = this.d.workspaces.create({ name: 'General', description: 'Everyday requests that do not belong to a specific project.', worker_limit: Number(this.d.settings.get('default_workspace_worker_limit')) }, 'system');
    this.broadcast('workspaces', { id: w.id }); return w;
  }
  private async liveStatus() {
    const s = await this.d.live.status(); const defs = this.d.definitions;
    let using: { job_id: string; objective: string; assistant: string; state: string; plain_state: string } | null = null;
    if (s.in_use) { const j = this.d.store.get(s.in_use.job_id); if (j && ['leased', 'running'].includes(j.state)) using = { job_id: j.id, objective: j.objective, assistant: defs.getAgent(j.agent_role)?.name ?? j.agent_role, state: j.state, plain_state: plainState(j) }; }
    const waiting = (this.d.db.prepare("SELECT id, objective, agent_role, waiting_on FROM jobs WHERE state = 'waiting_for_auth' AND waiting_on LIKE 'browser:%' ORDER BY updated_at DESC").all() as Array<{ id: string; objective: string; agent_role: string; waiting_on: string }>).map((j) => ({ job_id: j.id, objective: j.objective, assistant: defs.getAgent(j.agent_role)?.name ?? j.agent_role, site: j.waiting_on.slice(8) }));
    return { ...s, using, waiting_for_sign_in: waiting };
  }
  private conversationDetail(id: string) {
    const { db, store } = this.d; const defs = this.d.definitions; const c = this.d.chat.get(id)!;
    const gov = computeGovernor(db);
    const jobOf = (jid: string | null) => { if (!jid) return null; const j = store.get(jid); if (!j) return null; const pr = priorityOf(db, j.id); return { id: j.id, kind: j.kind, state: j.state, turn_state: turnState(j, this.d.cfg.heartbeatSeconds), deferred: deferralOf(j, gov, pr?.rank ?? null), priority: pr, outcome: j.outcome, plain_state: plainState(j), agent: defs.getAgent(j.agent_role)?.name ?? j.agent_role, agent_role: j.agent_role, stage_name: j.stage_name, next_action: j.next_action, operator_action: j.operator_action, blocker_code: j.blocker_code, waiting_on: j.waiting_on, lease_heartbeat_at: j.lease_heartbeat_at, started_at: j.started_at, created_at: j.created_at, sources: (db.prepare('SELECT count(*) AS n FROM memory_evidence WHERE job_id = ?').get(j.id) as { n: number }).n, feeds: (db.prepare("SELECT count(*) AS n FROM jobs WHERE depends_on LIKE '%' || ? || '%'").get(j.id) as { n: number }).n, retry_at: j.retry_at, reset_at: j.reset_at, failure_detail: j.failure_detail, updated_at: j.updated_at, completed_at: j.completed_at, workflow: defs.getWorkflow(j.kind)?.name ?? j.kind }; };
    const names = new Map(defs.listAgents({ includeDisabled: true }).map((a) => [a.id, a.name]));
    const turnsFor = (mid: string) => (db.prepare(`SELECT id FROM jobs WHERE kind = '${CHAT_WORKFLOW}' AND message_id = ? ORDER BY created_at`).all(mid) as Array<{ id: string }>).map((r) => jobOf(r.id));
    const messages = this.d.chat.messages(id).map((msg) => ({ ...msg, sender_name: msg.sender === 'owner' ? 'You' : msg.sender === 'system' ? 'ClaudeBot' : (names.get(msg.sender) ?? msg.sender), reactions: this.d.chat.reactions(msg.id), turns: msg.role === 'owner' || msg.kind === 'handoff' ? turnsFor(msg.id) : undefined, job: jobOf(msg.job_id), artifact: msg.artifact_id ? ((): Record<string, unknown> | null => { const a = db.prepare('SELECT id, title, kind, path, sha256, review_state, version FROM artifacts WHERE id = ?').get(msg.artifact_id) as Record<string, unknown> | undefined; if (!a) return null; let bytes: number | null = null; try { if (typeof a.path === 'string' && path.isAbsolute(a.path)) bytes = fs.statSync(a.path).size; } catch { /* missing file: no size shown */ } return { ...a, bytes }; })() : null, approval: msg.approval_id ? (db.prepare('SELECT id, action_kind, target, status, content_hash, decided_at, expires_at, created_at, content FROM approvals WHERE id = ?').get(msg.approval_id) ?? null) : null, action: msg.approval_id ? (db.prepare('SELECT id, status, refusal_reason, performed_at, receipt, resolved_at FROM actions WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(msg.approval_id) ?? null) : null }));
    const delegations = this.d.chat.delegations(id).map((j) => ({ ...jobOf(j.id)!, objective: j.objective, title: taskTitle(j.objective), artifacts: db.prepare('SELECT id, title, kind, path, review_state FROM artifacts WHERE job_id = ? ORDER BY created_at').all(j.id) }));
    const active = this.d.chat.activeTurn(id);
    const members = this.d.chat.members(id).map((mem) => { const a = defs.getAgent(mem.agent_id); const t = this.d.chat.activeTurn(id, mem.agent_id); return { agent_id: mem.agent_id, name: a?.name ?? mem.agent_id, role: a?.role ?? '', purpose: a?.purpose ?? '', color_index: a?.color_index ?? null, enabled: !!a?.enabled, session_open: !!mem.session_ref, turn: t ? jobOf(t.id) : null }; });
    return { conversation: c, workspace: c.workspace_id ? this.d.workspaces.get(c.workspace_id) ?? null : null, members, messages, delegations, active_turn: active ? jobOf(active.id) : null, lead: defs.getAgent('coordinator')?.name ?? 'Chief of Staff' };
  }
  private wsStats(id: string) {
    const { db } = this.d; const fresh = new Date(Date.now() - 60_000).toISOString();
    const counts = Object.fromEntries((db.prepare('SELECT state, COUNT(*) AS n FROM jobs WHERE workspace_id = ? GROUP BY state').all(id) as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));
    const active = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ? AND state IN ('leased','running') AND lease_heartbeat_at >= ?").get(id, fresh) as { n: number }).n;
    return { task_counts: counts, active, objectives_count: (db.prepare("SELECT COUNT(*) AS n FROM objectives WHERE workspace_id = ? AND status = 'active'").get(id) as { n: number }).n, artifacts_count: (db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id = ? OR job_id IN (SELECT id FROM jobs WHERE workspace_id = ?)').get(id, id) as { n: number }).n, last_activity: (db.prepare('SELECT MAX(updated_at) AS t FROM jobs WHERE workspace_id = ?').get(id) as { t: string | null }).t };
  }
  private agentLive(id: string) {
    const { db } = this.d; const fresh = new Date(Date.now() - 60_000).toISOString();
    const live = db.prepare("SELECT id, kind, stage_name, lease_owner, lease_heartbeat_at, next_action, workspace_id FROM jobs WHERE agent_role = ? AND state IN ('leased','running') AND lease_heartbeat_at >= ? ORDER BY lease_heartbeat_at DESC").all(id, fresh);
    const last = db.prepare("SELECT id, kind, state, completed_at, blocker_code, objective FROM jobs WHERE agent_role = ? AND state IN ('completed','failed_terminal') AND kind NOT IN ('report.morning','priority.rank','owner.upload') ORDER BY completed_at DESC LIMIT 1").get(id);
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE agent_role = ? AND state IN ('waiting_for_auth','waiting_for_reset','waiting_for_approval','retry_scheduled','queued')").get(id) as { n: number }).n;
    // Needs the owner: a task of this assistant is parked on the owner (approval or sign-in), or an approval it asked for is still pending.
    const needs = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE agent_role = ? AND state IN ('waiting_for_auth','waiting_for_approval')").get(id) as { n: number }).n
      + (db.prepare("SELECT COUNT(*) AS n FROM approvals a JOIN jobs j ON j.id = a.job_id WHERE j.agent_role = ? AND a.status = 'pending' AND j.state NOT IN ('waiting_for_approval')").get(id) as { n: number }).n;
    return { status: live.length ? 'busy' : 'idle', active_tasks: live, last_result: last ?? null, waiting_tasks: waiting, needs_owner: needs };
  }
  private overview(wsFilter?: string) {
    const { db, store } = this.d; const args = wsFilter ? [wsFilter] : []; const where = wsFilter ? 'WHERE workspace_id = ?' : '';
    const counts = Object.fromEntries((db.prepare(`SELECT state, COUNT(*) AS n FROM jobs ${where} GROUP BY state`).all(...args) as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));
    const active = store.list({ state: ['leased', 'running'], workspace: wsFilter });
    const blockers = db.prepare(`SELECT id, kind, agent_role, state, blocker_code, operator_action, waiting_on, workspace_id FROM jobs WHERE blocker_code IS NOT NULL AND state NOT IN ('completed','cancelled') ${wsFilter ? 'AND workspace_id = ?' : ''} ORDER BY updated_at DESC`).all(...args);
    const pending = db.prepare(`SELECT id, job_id, action_kind, target, expires_at FROM approvals WHERE status = 'pending' ${wsFilter ? 'AND workspace_id = ?' : ''} ORDER BY created_at DESC`).all(...args);
    const objectives = db.prepare(`SELECT * FROM objectives WHERE status = 'active' ${wsFilter ? 'AND workspace_id = ?' : ''} ORDER BY priority`).all(...args);
    const recent = db.prepare(`SELECT e.seq, e.job_id, e.at, e.actor, e.type, e.detail FROM job_events e LEFT JOIN jobs j ON j.id = e.job_id ${wsFilter ? 'WHERE j.workspace_id = ?' : ''} ORDER BY e.seq DESC LIMIT 12`).all(...args) as Array<{ detail: string }>;
    return { workspaces: this.d.workspaces.list().length, counts, active, blockers, pending_approvals: pending, objectives, recent: recent.map((r) => ({ ...r, detail: JSON.parse(r.detail) })), health: this.d.watchdog.last, claude: this.d.watchdog.last?.claude ?? null, capacity: this.d.dispatcher.capacity(), product: this.d.productName };
  }
  private static(pathname: string, res: Res) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const file = path.resolve(this.uiDir, rel);
    if (!file.startsWith(this.uiDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    // The page asks for its scripts and styles with their file times, so a reload always gets the files on disk (WebKit can keep subresources in memory).
    if (rel === 'index.html') { const v = (f: string) => { try { return Math.floor(fs.statSync(path.join(this.uiDir, f)).mtimeMs).toString(36); } catch { return '0'; } }; const html = fs.readFileSync(file, 'utf8').replace(/(href|src)="\/([\w-]+\.(?:css|js))"/g, (_m, attr: string, f: string) => `${attr}="/${f}?v=${v(f)}"`); res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }); res.end(html); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(file).pipe(res);
  }
}
