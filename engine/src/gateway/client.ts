import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Logger } from '../log.ts';

/** Minimal OpenClaw Gateway WebSocket client (protocol v4): connect → hello-ok → req/res/event frames. */
export interface GatewayClientOptions { url: string; tokenFile: string; log: Logger; clientId?: string; connectTimeoutMs?: number }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
export type GatewayEvent = { event: string; payload: Record<string, unknown>; seq?: number };

export class GatewayError extends Error {
  code: string; retryable: boolean; details?: unknown;
  constructor(code: string, message: string, retryable = false, details?: unknown) { super(message); this.code = code; this.retryable = retryable; this.details = details; }
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(e: GatewayEvent) => void>();
  private opts: GatewayClientOptions;
  hello: Record<string, unknown> | null = null;
  constructor(opts: GatewayClientOptions) { this.opts = opts; }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN && this.hello !== null; }

  onEvent(fn: (e: GatewayEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private readToken(): string {
    const t = fs.readFileSync(this.opts.tokenFile, 'utf8').trim();
    if (!t) throw new GatewayError('NO_TOKEN', `gateway token file ${this.opts.tokenFile} is empty`);
    return t;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const token = this.readToken();
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new GatewayError('CONNECT_TIMEOUT', `no hello-ok within ${timeoutMs}ms`, true)); try { ws.close(); } catch {} }, timeoutMs);
      let sentConnect = false;
      const sendConnect = () => {
        if (sentConnect) return; sentConnect = true;
        const id = crypto.randomUUID();
        this.pending.set(id, { resolve: (v) => { clearTimeout(timer); this.hello = v as Record<string, unknown>; resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer: setTimeout(() => {}, 0) });
        ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params: {
          minProtocol: 4, maxProtocol: 4,
          client: { id: this.opts.clientId ?? 'gateway-client', version: '0.1.0', platform: 'macos', mode: 'backend' },
          role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], caps: [], commands: [], permissions: {},
          auth: { token }, locale: 'en-US', userAgent: 'claudebot/0.1.0',
        } }));
      };
      ws.addEventListener('open', () => { /* wait briefly for connect.challenge; send connect either way */ setTimeout(sendConnect, 150); });
      ws.addEventListener('message', (ev) => this.onMessage(String(ev.data), sendConnect));
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new GatewayError('WS_ERROR', `websocket error connecting to ${this.opts.url}`, true)); });
      ws.addEventListener('close', (ev) => { this.hello = null; const err = new GatewayError('WS_CLOSED', `gateway connection closed (${ev.code})`, true); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); } this.pending.clear(); clearTimeout(timer); reject(err); });
    });
  }

  private onMessage(raw: string, onChallenge?: () => void) {
    let frame: { type: string; id?: string; ok?: boolean; payload?: unknown; error?: { code: string; message: string; retryable?: boolean; details?: unknown }; event?: string; seq?: number };
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') { onChallenge?.(); return; }
      const e: GatewayEvent = { event: frame.event!, payload: (frame.payload ?? {}) as Record<string, unknown>, seq: frame.seq };
      for (const l of this.listeners) { try { l(e); } catch (err) { this.opts.log.warn('event listener threw', { err }); } }
      return;
    }
    if (frame.type === 'res' && frame.id) {
      const p = this.pending.get(frame.id); if (!p) return; this.pending.delete(frame.id); clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(new GatewayError(frame.error?.code ?? 'ERROR', frame.error?.message ?? 'gateway error', frame.error?.retryable ?? false, frame.error?.details));
    }
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.connected) await this.connect();
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new GatewayError('RPC_TIMEOUT', `${method} timed out after ${timeoutMs}ms`, true)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  close(): void { try { this.ws?.close(); } catch {} this.ws = null; this.hello = null; }
}
