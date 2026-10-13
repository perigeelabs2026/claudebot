/**
 * Live view of the ClaudeBot browser (the managed Chrome profile `claudebot`, which OpenClaw starts with a DevTools
 * endpoint). The engine attaches to the page the assistant is using and streams Chrome's own screencast frames to the
 * UI, so what the owner sees beside the conversation is the actual page, not a mock or a stale capture. Every frame
 * carries its capture time; the UI shows the age and says so when frames stop.
 *
 * Nothing here automates a login: the owner takes over by using the real window (we can bring it forward and place
 * it beside the app through DevTools window bounds), and a takeover flag pauses the assistant's browser tool.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import type { DB } from '../db/open.ts';
import type { EngineConfig } from '../config.ts';
import type { Logger } from '../log.ts';

export interface Tab { id: string; url: string; title: string }
export interface LiveStatus {
  running: boolean; cdp_port: number; pid: number | null; detail: string;
  tabs: Tab[]; current: Tab | null;
  in_use: { job_id: string; role: string; url: string; phase: string; at: string } | null;
  takeover: { active: boolean; since: string | null; note: string | null; site: string | null } | null;
  streaming: boolean; subscribers: number; last_frame_at: string | null; frames_sent: number;
  footprint: { processes: number; mb: number; renderers: number; observed_at: string } | null;
}

class Cdp {
  private ws: WebSocket; private seq = 0; private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private handlers = new Map<string, (p: Record<string, unknown>) => void>();
  onClose: (() => void) | null = null;
  private constructor(ws: WebSocket) { this.ws = ws; }
  static connect(url: string, timeoutMs = 3000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url); const c = new Cdp(ws);
      const t = setTimeout(() => { reject(new Error('devtools connect timeout')); try { ws.close(); } catch { /* */ } }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(c); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('devtools websocket error')); });
      ws.addEventListener('message', (ev) => c.onMessage(String(ev.data)));
      ws.addEventListener('close', () => { for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new Error('devtools closed')); } c.pending.clear(); c.onClose?.(); });
    });
  }
  private onMessage(raw: string) {
    let m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined) { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); return; }
    if (m.method) this.handlers.get(m.method)?.(m.params ?? {});
  }
  on(method: string, fn: (p: Record<string, unknown>) => void) { this.handlers.set(method, fn); }
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

export class BrowserLive {
  private cfg: EngineConfig; private db: DB; private log: Logger;
  private subs = new Set<ServerResponse>();
  private cdp: Cdp | null = null; private targetId: string | null = null; private current: Tab | null = null;
  private lastFrame: { data: string; at: string; url: string; title: string; width: number; height: number } | null = null;
  private framesSent = 0; private poll: NodeJS.Timeout | null = null; private starting = false;
  private pidCache: { at: number; pid: number | null } = { at: 0, pid: null };
  private tabsCache: { at: number; tabs: Tab[] } = { at: 0, tabs: [] };
  private footCache: { at: number; value: LiveStatus['footprint'] } = { at: 0, value: null };
  constructor(cfg: EngineConfig, db: DB, log: Logger) { this.cfg = cfg; this.db = db; this.log = log; }

  /** DevTools port of the managed profile, from the OpenClaw profile config (no process spawned). */
  cdpPort(): number {
    const env = Number(process.env.CLAUDEBOT_BROWSER_CDP_PORT); if (Number.isFinite(env) && env > 0) return env;
    try { const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), `.openclaw-${this.cfg.openclawProfile}`, 'openclaw.json'), 'utf8')) as { browser?: { profiles?: Record<string, { cdpPort?: number }> } }; const p = j.browser?.profiles?.claudebot?.cdpPort; if (p) return p; } catch { /* default */ }
    return 48323;
  }
  private base() { return `http://127.0.0.1:${this.cdpPort()}`; }

  async tabs(fresh = false): Promise<Tab[]> {
    if (!fresh && Date.now() - this.tabsCache.at < 1500) return this.tabsCache.tabs;
    try {
      const r = await fetch(`${this.base()}/json`, { signal: AbortSignal.timeout(1500) });
      const list = (await r.json()) as Array<{ id: string; type: string; url: string; title: string }>;
      const tabs = list.filter((t) => t.type === 'page' && !/^(chrome|chrome-untrusted|devtools):/.test(t.url)).map((t) => ({ id: t.id, url: t.url, title: t.title }));
      this.tabsCache = { at: Date.now(), tabs }; return tabs;
    } catch { this.tabsCache = { at: Date.now(), tabs: [] }; return []; }
  }
  private pid(): number | null {
    if (Date.now() - this.pidCache.at < 30_000) return this.pidCache.pid;
    let pid: number | null = null;
    try { const out = execFileSync('/usr/bin/pgrep', ['-f', `remote-debugging-port=${this.cdpPort()} --user-data-dir=`], { encoding: 'utf8', timeout: 2000 }); pid = Number(out.trim().split(/\s+/)[0]) || null; } catch { pid = null; }
    this.pidCache = { at: Date.now(), pid }; return pid;
  }
  /** RSS of the managed Chrome's whole process family (main + helpers), by walking parent pids. Cached 30 s; one `ps` at most. */
  footprint(): LiveStatus['footprint'] {
    if (Date.now() - this.footCache.at < 30_000) return this.footCache.value;
    let value: LiveStatus['footprint'] = null;
    try {
      const rows = execFileSync('/bin/ps', ['-axo', 'pid,ppid,rss,args'], { encoding: 'utf8', timeout: 3000 }).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4).map((c) => ({ pid: Number(c[0]), ppid: Number(c[1]), rss: Number(c[2]), args: c.slice(3).join(' ') }));
      const root = rows.find((r) => r.args.includes(`remote-debugging-port=${this.cdpPort()}`));
      if (root) { const fam = new Set([root.pid]); let grew = true; while (grew) { grew = false; for (const r of rows) if (!fam.has(r.pid) && fam.has(r.ppid)) { fam.add(r.pid); grew = true; } } const f = rows.filter((r) => fam.has(r.pid)); value = { processes: f.length, mb: Math.round(f.reduce((n, r) => n + r.rss, 0) / 1024), renderers: f.filter((r) => /--type=renderer/.test(r.args)).length, observed_at: new Date().toISOString() }; }
    } catch { value = null; }
    this.footCache = { at: Date.now(), value }; return value;
  }
  private state<T>(key: string): T | null { const r = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as { value: string } | undefined; return r ? (JSON.parse(r.value) as T) : null; }

  /** The page to show: the tab the assistant's browser tool is using now; else the tab the owner chose; else the tab of the last task (remembered across restarts); else the first real tab. */
  async pickCurrent(): Promise<Tab | null> {
    const tabs = await this.tabs();
    const inUse = this.state<{ url: string; job_id: string }>('browser.in_use');
    const byUse = inUse ? tabs.find((t) => t.url === inUse.url || t.url.startsWith(inUse.url.replace(/\/$/, ''))) : undefined;
    if (byUse) { this.remember(byUse, inUse!.job_id); return byUse; }
    const chosen = this.state<{ id: string; url: string; by: string }>('browser.follow');
    const byChoice = chosen ? tabs.find((t) => t.id === chosen.id) ?? tabs.find((t) => t.url === chosen.url) : undefined;
    if (byChoice) return byChoice;
    const followed = this.targetId ? tabs.find((t) => t.id === this.targetId) : undefined;
    return followed ?? tabs[0] ?? null;
  }
  private remember(tab: Tab, by: string) {
    const prev = this.state<{ id: string }>('browser.follow'); if (prev?.id === tab.id) return;
    this.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('browser.follow', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify({ id: tab.id, url: tab.url, by }), 'last task tab', new Date().toISOString());
  }
  /** Owner picks the tab to watch (and to take over). */
  async follow(id: string): Promise<{ ok: boolean; detail: string; tab?: Tab }> {
    const tab = (await this.tabs(true)).find((t) => t.id === id); if (!tab) return { ok: false, detail: 'that tab is no longer open' };
    this.remember(tab, 'owner'); this.targetId = null; this.pushStatus(); void this.tick(); return { ok: true, detail: `following ${tab.title || tab.url}`, tab };
  }

  async status(): Promise<LiveStatus> {
    let running = false; let detail = '';
    try { const r = await fetch(`${this.base()}/json/version`, { signal: AbortSignal.timeout(1000) }); running = r.ok; detail = running ? `Open` : `DevTools answered ${r.status}`; } catch { detail = 'ClaudeBot browser is not running (no DevTools endpoint); it starts with the first browser task'; }
    const tabs = running ? await this.tabs() : [];
    const current = running ? await this.pickCurrent() : null;
    if (current) this.current = current;
    return { running, cdp_port: this.cdpPort(), pid: running ? this.pid() : null, detail, tabs, current, in_use: this.state('browser.in_use'), takeover: this.state('browser.takeover'), streaming: !!this.cdp, subscribers: this.subs.size, last_frame_at: this.lastFrame?.at ?? null, frames_sent: this.framesSent, footprint: running ? this.footprint() : null };
  }

  setTakeover(active: boolean, note: string | null, site: string | null, actor = 'owner') {
    const v = { active, since: active ? new Date().toISOString() : null, note, site };
    this.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('browser.takeover', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(JSON.stringify(v), actor, new Date().toISOString());
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(new Date().toISOString(), actor, active ? 'browser.takeover.started' : 'browser.takeover.ended', JSON.stringify(v));
    this.pushStatus();
  }

  // ---- window control through DevTools (no accessibility permission needed) ----
  private async browserCdp(): Promise<Cdp> {
    const r = await fetch(`${this.base()}/json/version`, { signal: AbortSignal.timeout(1500) }); const j = (await r.json()) as { webSocketDebuggerUrl: string };
    return Cdp.connect(j.webSocketDebuggerUrl);
  }
  async arrange(bounds: { left: number; top: number; width: number; height: number }): Promise<{ ok: boolean; detail: string }> {
    const t = await this.pickCurrent(); if (!t) return { ok: false, detail: 'no page to arrange' };
    const c = await this.browserCdp();
    try {
      const { windowId } = await c.call<{ windowId: number }>('Browser.getWindowForTarget', { targetId: t.id });
      await c.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await c.call('Browser.setWindowBounds', { windowId, bounds: { left: Math.round(bounds.left), top: Math.round(bounds.top), width: Math.round(bounds.width), height: Math.round(bounds.height) } });
      return { ok: true, detail: `window ${windowId} placed` };
    } finally { c.close(); }
  }
  async bringToFront(): Promise<{ ok: boolean; detail: string; pid: number | null }> {
    const t = await this.pickCurrent(); if (!t) return { ok: false, detail: 'no page open', pid: this.pid() };
    const c = await Cdp.connect(`ws://127.0.0.1:${this.cdpPort()}/devtools/page/${t.id}`);
    try { await c.call('Page.bringToFront'); return { ok: true, detail: `tab ${t.title || t.url} activated`, pid: this.pid() }; } finally { c.close(); }
  }

  // ---- screencast stream ----
  subscribe(res: ServerResponse) {
    this.subs.add(res);
    res.on('close', () => { this.subs.delete(res); if (!this.subs.size) void this.stop(); });
    void this.status().then((s) => this.send(res, 'status', s));
    if (this.lastFrame) this.send(res, 'frame', this.lastFrame);
    if (!this.poll) this.poll = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }
  private send(res: ServerResponse, event: string, payload: unknown) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { this.subs.delete(res); } }
  private broadcast(event: string, payload: unknown) { for (const s of this.subs) this.send(s, event, payload); }
  private pushStatus() { if (this.subs.size) void this.status().then((s) => this.broadcast('status', s)); }

  private async tick() {
    if (!this.subs.size) return;
    const s = await this.status(); this.broadcast('status', s);
    const want = s.current;
    if (!want) { if (this.cdp) await this.stop(false); return; }
    if (want.id !== this.targetId || !this.cdp) await this.start(want);
    // Chrome's screencast only emits when the page repaints, and an occluded window can go quiet. While someone is
    // watching, fall back to a timestamped capture of the same page when no frame has arrived for a few seconds.
    else if (this.cdp && (!this.lastFrame || Date.now() - Date.parse(this.lastFrame.at) > 4000)) {
      try { const r = await this.cdp.call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 55 }, 4000); this.lastFrame = { data: r.data, at: new Date().toISOString(), url: this.current?.url ?? want.url, title: this.current?.title ?? want.title, width: 0, height: 0 }; this.framesSent++; this.broadcast('frame', { ...this.lastFrame, source: 'capture' }); } catch { /* page busy or gone; the pane shows the frame age */ }
    }
  }
  private async start(tab: Tab) {
    if (this.starting) return; this.starting = true;
    try {
      if (this.cdp) { const old = this.cdp; this.cdp = null; old.onClose = null; old.close(); }
      const c = await Cdp.connect(`ws://127.0.0.1:${this.cdpPort()}/devtools/page/${tab.id}`);
      this.cdp = c; this.targetId = tab.id; this.current = tab;
      c.onClose = () => { if (this.cdp === c) { this.cdp = null; this.targetId = null; this.broadcast('status', { streaming: false, note: 'page closed' }); } };
      c.on('Page.screencastFrame', (p) => {
        const meta = (p.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
        this.lastFrame = { data: String(p.data), at: new Date().toISOString(), url: this.current?.url ?? tab.url, title: this.current?.title ?? tab.title, width: Number(meta.deviceWidth ?? 0), height: Number(meta.deviceHeight ?? 0) };
        this.framesSent++; this.broadcast('frame', this.lastFrame);
        setTimeout(() => { c.call('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {}); }, 200);   // ≤ ~5 frames/s
      });
      c.on('Page.frameNavigated', (p) => { const f = (p.frame ?? {}) as { parentId?: string; url?: string }; if (!f.parentId && f.url && this.current) { this.current = { ...this.current, url: f.url }; this.tabsCache.at = 0; this.pushStatus(); } });
      await c.call('Page.enable');
      await c.call('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1100, maxHeight: 800, everyNthFrame: 1 });
      this.log.info('browser screencast started', { tab: tab.id, url: tab.url });
    } catch (e) { this.log.warn('browser screencast failed', { err: (e as Error).message }); this.cdp = null; this.targetId = null; this.broadcast('status', { streaming: false, note: (e as Error).message }); }
    finally { this.starting = false; }
  }
  async stop(clearPoll = true) {
    const c = this.cdp; this.cdp = null; this.targetId = null;
    if (c) { c.onClose = null; try { await c.call('Page.stopScreencast', {}, 1500); } catch { /* */ } c.close(); this.log.info('browser screencast stopped'); }
    if (clearPoll && this.poll && !this.subs.size) { clearInterval(this.poll); this.poll = null; }
  }
  async close() { for (const s of this.subs) { try { s.end(); } catch { /* */ } } this.subs.clear(); await this.stop(); }
}
