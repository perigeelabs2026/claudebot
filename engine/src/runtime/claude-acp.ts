import { runProbe } from '../infra/probe.ts';
import crypto from 'node:crypto';
import { redact, type Logger } from '../log.ts';
import { GatewayClient, GatewayError, type GatewayEvent } from '../gateway/client.ts';
import type { ModelRuntime, RuntimeHealth, TurnRequest, TurnResult, FailureCategory } from './types.ts';


export interface ClaudeAcpOptions {
  gateway: GatewayClient; log: Logger;
  claudeExecutable: string; claudeConfigDir: string;
  /** maps an ClaudeBot agent id to the OpenClaw agent id (defaults to identity) */
  agentIdForRole?: (role: string) => string;
  /** where Claude runs elsewhere (the assistants' computer): returns `claude auth status` JSON from there */
  authProbe?: () => Promise<string>;
}

/** Classify a turn failure from the Gateway/adapter error text. Exported for tests. */
export function classifyFailure(input: { errorKind?: string | null; message?: string | null; detail?: Record<string, unknown> | null }): { category: FailureCategory; retryable: boolean; resetAt: string | null } {
  const msg = (input.message ?? '').toString();
  const kind = (input.errorKind ?? '').toString().toLowerCase();
  const d = input.detail ?? {};
  const prf = String((d as Record<string, unknown>).providerRuntimeFailureKind ?? (d as Record<string, unknown>).failoverReason ?? '').toLowerCase();
  const lower = msg.toLowerCase();
  if (kind.includes('quota') || prf.includes('quota') || /usage limit|hit your limit|limit reached|out of .*credits|plan limit/.test(lower)) {
    return { category: 'quota_exhausted', retryable: true, resetAt: parseResetAt(msg) };
  }
  if (kind.includes('rate') || prf.includes('rate') || /rate.?limit|429|too many requests/.test(lower)) return { category: 'rate_limited', retryable: true, resetAt: parseResetAt(msg) };
  if (kind.includes('auth') || prf.includes('auth') || /please run \/login|not logged in|session expired|authentication_failed|authentication required|auth_required|oauth|unauthorized|401/.test(lower)) return { category: 'auth_required', retryable: true, resetAt: null };
  if (kind.includes('access') || prf.includes('access') || /verification_required|permission_error|403/.test(lower)) return { category: 'access_denied', retryable: false, resetAt: null };
  if (/cancel|abort/.test(lower)) return { category: 'cancelled', retryable: true, resetAt: null };
  if (/exited|crash|spawn|enoent|killed|signal/.test(lower)) return { category: 'crashed', retryable: true, resetAt: null };
  if (/timeout|timed out|hung/.test(lower)) return { category: 'hung', retryable: true, resetAt: null };
  if (/econnrefused|econnreset|network|socket|unavailable|503|502|overloaded|529/.test(lower)) return { category: 'transient', retryable: true, resetAt: null };
  return { category: 'internal', retryable: true, resetAt: null };
}

/** Parse "resets 3pm (America/Phoenix)", "resets at 10:30am", ISO timestamps, or "resets in 2 hours 10 minutes". */
export function parseResetAt(text: string, now: Date = new Date()): string | null {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/);
  if (iso) { const t = Date.parse(iso[0]); if (!Number.isNaN(t)) return new Date(t).toISOString(); }
  const rel = text.match(/resets?\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (rel && (rel[1] || rel[2])) { const ms = (Number(rel[1] ?? 0) * 3600 + Number(rel[2] ?? 0) * 60) * 1000; return new Date(now.getTime() + ms).toISOString(); }
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_]+)\))?/i);
  if (clock) {
    let h = Number(clock[1]); const m = Number(clock[2] ?? 0); const ap = clock[3]?.toLowerCase(); const tz = clock[4];
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    return nextOccurrence(h, m, tz, now).toISOString();
  }
  return null;
}

function nextOccurrence(h: number, m: number, tz: string | undefined, now: Date): Date {
  // Compute the wall-clock time in tz (or local) for today; if it's in the past, use tomorrow.
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, h, m, 0);
  // offset between tz wall clock and UTC at 'now'
  const nowWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  const offsetMs = nowWall - now.getTime();
  let target = utcGuess - offsetMs;
  if (target <= now.getTime()) target += 24 * 3600 * 1000;
  return new Date(target);
}

/** Claude Code's ACP agent advertises its models by alias (default, opus, sonnet, haiku, or a full id such as claude-fable-5-1[1m]).
 *  ClaudeBot stores full model ids; these map to the alias the agent advertises. Anything else passes through unchanged. */
export const ACP_MODEL_ALIAS: Record<string, string> = { 'claude-opus-5-5': 'opus', 'claude-sonnet-5-5': 'sonnet', 'claude-haiku-5-5': 'haiku' };
export const acpModel = (id: string) => ACP_MODEL_ALIAS[id] ?? id;

export class ClaudeAcpRuntime implements ModelRuntime {
  readonly id = 'claude-acp' as const;
  private o: ClaudeAcpOptions;
  private activeRuns = new Map<string, string>(); // sessionRef → runId
  constructor(o: ClaudeAcpOptions) { this.o = o; }

  describe() { return { label: 'Claude Code via OpenClaw ACP (acpx)', route: 'ClaudeBot → OpenClaw Gateway → acpx → claude-agent-acp → official Claude Code → user subscription', account: `CLAUDE_CONFIG_DIR=${this.o.claudeConfigDir}` }; }

  /** Health = official `claude auth status` in the dedicated config dir (never prints tokens) + gateway reachability. */
  async health(): Promise<RuntimeHealth> {
    const observedAt = new Date().toISOString();
    let account: RuntimeHealth['account'] | undefined; let authDetail = '';
    try {
      // `claude auth status` exits non-zero when logged out but still prints JSON; read stdout either way. Never print tokens.
      const probe = this.o.authProbe ? { stdout: await this.o.authProbe(), stderr: '', code: 0, signal: null, timedOut: false, skipped: undefined } as Awaited<ReturnType<typeof runProbe>> : await runProbe(this.o.claudeExecutable, ['auth', 'status'], { timeoutMs: 20_000, label: 'claude.auth_status', env: { ...process.env, CLAUDE_CONFIG_DIR: this.o.claudeConfigDir } });
      const stdout = probe.stdout;
      if (!stdout.trim()) throw new Error(probe.timedOut ? 'claude auth status timed out after 20 s (process group killed)' : probe.skipped === 'storm_guard' ? probe.stderr : `claude auth status exit ${probe.code ?? probe.signal}: ${probe.stderr.replace(/\s+/g, ' ').slice(0, 160)}`);
      const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
      account = { loggedIn: !!j.loggedIn, method: j.authMethod, subscription: j.subscriptionType, email: j.email };
      authDetail = j.loggedIn ? `logged in (${j.authMethod}, ${j.subscriptionType ?? 'unknown plan'})` : 'not logged in';
    } catch (e) { authDetail = `claude auth status failed: ${(e as Error).message}`; account = { loggedIn: false }; }
    let gatewayOk = false; let gwDetail = '';
    try { await this.o.gateway.connect(); await this.o.gateway.call('health', {}, 8000); gatewayOk = true; gwDetail = 'gateway reachable'; } catch (e) { gwDetail = `gateway: ${(e as Error).message}`; }
    const state: RuntimeHealth['state'] = !gatewayOk ? 'unreachable' : !account?.loggedIn ? 'auth_required' : 'ready';
    return { id: 'claude-acp', configured: true, ok: state === 'ready', state, detail: `${authDetail}; ${gwDetail}`, observedAt, account };
  }

  /** Control session used only for gateway-local /acp commands (never model turns). One shared key; replies are matched by runId so several workers never read each other's replies. */
  private controlKey = process.env.CLAUDEBOT_CONTROL_SESSION ?? 'agent:control:main';
  private labelPrefix = process.env.CLAUDEBOT_SESSION_LABEL_PREFIX ?? '';

  /** Run a gateway-local command through chat.send and return the reply text. Serialized per process; matched by runId. */
  private controls: Promise<unknown> = Promise.resolve();
  private command(message: string, timeoutMs = 60_000): Promise<string> {
    const run = this.controls.then(() => this.commandNow(message, timeoutMs));
    this.controls = run.catch(() => {});
    return run;
  }
  private async commandNow(message: string, timeoutMs: number): Promise<string> {
    const gw = this.o.gateway; await gw.connect();
    let text = ''; let err = ''; let runId: string | null = null; let settled = false;
    let resolveDone: () => void = () => {}; const done = new Promise<void>((r) => { resolveDone = r; });
    const early: Array<Record<string, unknown>> = [];   // replies that arrive before chat.send has told us our run id
    const consider = (p: Record<string, unknown>) => {
      if (settled) return;
      if (runId && runId !== 'unknown' && p.runId && p.runId !== runId) return;   // another process's reply on the shared control session (the gateway stamps replies with the run id)
      if (p.state === 'final') { text = extractText((p.message as { content?: unknown } | undefined)?.content); settled = true; resolveDone(); }
      if (p.state === 'error') { err = String(p.errorMessage ?? 'command error'); settled = true; resolveDone(); }
    };
    const off = gw.onEvent((e) => {
      if (e.event !== 'chat' || e.payload.sessionKey !== this.controlKey) return;
      if (!runId) { early.push(e.payload); return; }
      consider(e.payload);
    });
    const timer = setTimeout(() => { if (!settled) { err = `OpenClaw control request timed out after ${timeoutMs} ms`; resolveDone(); } }, timeoutMs);
    try {
      const sent = await gw.call<{ runId?: string }>('chat.send', { sessionKey: this.controlKey, message, idempotencyKey: crypto.randomUUID() }, 30_000);
      runId = sent.runId ?? 'unknown';
      for (const p of early) consider(p);
      await done;
    } finally { clearTimeout(timer); off(); }
    if (err) throw new GatewayError('COMMAND_FAILED', err, true);
    return text;
  }

  /** Spawn (or reuse) the persistent ACP session bound to this job. Returns the OpenClaw session key. */
  async ensureSession(req: TurnRequest): Promise<string> {
    if (req.resume && req.sessionRef.includes(':acp:')) {
      const st = await this.command(`/acp status ${req.sessionRef}`).catch(() => '');
      if (/session:\s*agent:/.test(st) && !/Unknown|not found/i.test(st)) return req.sessionRef;
    }
    if (req.probeOnly) throw new GatewayError('ACP_SESSION_GONE', 'probe: the session is gone; nothing was spawned', false);
    const reply = await this.command(`/acp spawn claude --mode persistent --thread off --label ${this.labelPrefix}${req.label ?? req.jobId} --cwd ${req.cwd}`);
    const key = (reply.match(/agent:[a-z_]+:acp:[0-9a-f-]+/i) ?? [])[0];
    if (!key) throw new GatewayError('ACP_SPAWN_FAILED', reply.slice(0, 300), /sandbox|unavailable|timeout/i.test(reply));
    return key;
  }

  async doctor(): Promise<string> { return this.command('/acp doctor'); }

  /** acpx applies its configured per-turn timeout (180 s here) to every session; the documented `/acp timeout` control raises it per session to the stage's own budget so long steps are not cut off silently. */
  private timeouts = new Map<string, number>();
  /** set once the backend answers ACP_BACKEND_UNSUPPORTED_CONTROL, so we stop asking on every turn */
  timeoutUnsupported = false;
  private async ensureTimeout(sessionKey: string, timeoutMs: number): Promise<void> {
    const secs = Math.max(60, Math.min(3600, Math.ceil(timeoutMs / 1000)));
    if (this.timeouts.get(sessionKey) === secs) return;
    if (this.timeoutUnsupported) return;
    try {
      const reply = await this.command(`/acp timeout ${secs} ${sessionKey}`, 20_000);
      if (/ACP error|UNSUPPORTED|does not accept/i.test(reply)) { this.timeoutUnsupported = true; this.o.log.warn('acp per-session timeout is not supported by this backend; the plugin default (timeoutSeconds) applies to every turn', { sessionKey, reply: reply.slice(0, 160) }); return; }
      this.timeouts.set(sessionKey, secs); this.o.log.info('acp session timeout set', { sessionKey, secs, reply: reply.slice(0, 120) });
    } catch (e) { this.o.log.warn('acp timeout not applied; the plugin default applies', { sessionKey, err: (e as Error).message }); }
  }

  /** Each assistant runs on its own model (Edit assistant > Advanced). Set with the documented `/acp model <id> <session>` control
   *  before the turn; if the backend refuses the model, the turn fails and says so rather than running on another model. */
  private models = new Map<string, string>();
  private async ensureModel(sessionKey: string, model: string | undefined): Promise<void> {
    if (!model || this.models.get(sessionKey) === model) return;
    const reply = await this.command(`/acp model ${acpModel(model)} ${sessionKey}`, 20_000);
    if (/ACP error|unknown|invalid|not (available|allowed|supported|found)|unsupported|usage:/i.test(reply)) throw new GatewayError('MODEL_REFUSED', `The model "${model}" was not accepted: ${redact(reply).slice(0, 200)}`, false);
    this.models.set(sessionKey, model); this.o.log.info('acp session model set', { sessionKey, model, reply: reply.slice(0, 120) });
  }

  async inspectSession(sessionRef: string): Promise<{ text: string; observed_at: string }> {
    if (!/^agent:[a-z_]+:acp:[0-9a-f-]+$/i.test(sessionRef)) throw new Error('Only a recorded ACP session can be inspected');
    return { text: redact(await this.command(`/acp status ${sessionRef}`, 20_000)).slice(0, 8000), observed_at: new Date().toISOString() };
  }

  async startTurn(req: TurnRequest): Promise<TurnResult> {
    const start = Date.now();
    const gw = this.o.gateway;
    let sessionKey = req.sessionRef;
    let text = ''; let errorMessage: string | null = null; let errorKind: string | null = null; let errorDetail: Record<string, unknown> | null = null; let runId: string | null = null;
    const off = gw.onEvent((e: GatewayEvent) => {
      const p = e.payload;
      if (e.event === 'chat' && p.sessionKey === sessionKey && (!runId || p.runId === runId)) {
        if (p.state === 'delta') req.onHeartbeat?.('assistant text');
        if (p.state === 'final') { text = extractText((p.message as { content?: unknown } | undefined)?.content) || text; }
        if (p.state === 'error') { errorMessage = String(p.errorMessage ?? 'run error'); errorKind = (p.errorKind as string) ?? null; errorDetail = (p.errorDetail as Record<string, unknown>) ?? null; }
      }
      if (e.event === 'agent' && runId && p.runId === runId) req.onHeartbeat?.(`agent ${String(p.stream ?? 'event')}`);
    });
    try {
      await gw.connect();
      sessionKey = await this.ensureSession(req);
      if (!req.probeOnly) await this.ensureTimeout(sessionKey, req.timeoutMs);
      if (!req.probeOnly) await this.ensureModel(sessionKey, req.model);
      req.onSession?.(sessionKey);
      req.onHeartbeat?.(`acp session ${sessionKey}`);
      if (req.signal?.aborted) { await this.cancel(sessionKey); return { ok: false, category: 'cancelled', message: 'stopped before the turn started', retryable: true, runtimeSessionId: sessionKey }; }
      const res = await gw.call<{ runId?: string }>('agent', {
        message: req.prompt, sessionKey, idempotencyKey: `claudebot:${req.jobId}:${crypto.randomUUID()}`, deliver: false,
        timeout: Math.ceil(req.timeoutMs / 1000), acpTurnSource: 'manual_spawn', label: `claudebot ${req.jobId}`,
      }, 30_000);
      runId = res.runId ?? null;
      if (runId) this.activeRuns.set(req.sessionRef, runId);
      req.onHeartbeat?.(`run admitted`);
      const deadline = Date.now() + req.timeoutMs;
      let wait: { status: string; error?: string } = { status: 'pending' };
      while (Date.now() < deadline) {
        if (req.signal?.aborted) { await this.cancel(sessionKey); return { ok: false, category: 'cancelled', message: 'cancelled by watchdog', retryable: true, runtimeSessionId: sessionKey }; }
        const slice = Math.min(20_000, deadline - Date.now());
        const aborted = new Promise<{ status: string }>((resolve) => { if (!req.signal) return; if (req.signal.aborted) resolve({ status: 'aborted' }); else req.signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true }); });
        wait = await Promise.race([gw.call<{ status: string; error?: string }>('agent.wait', { runId, timeoutMs: slice }, slice + 5000), aborted]);
        if (wait.status === 'aborted') { await this.cancel(sessionKey); return { ok: false, category: 'cancelled', message: typeof req.signal?.reason === 'string' ? req.signal.reason : 'stopped', retryable: true, runtimeSessionId: sessionKey }; }
        req.onHeartbeat?.(`waiting (${wait.status})`);
        if (wait.status === 'ok' || wait.status === 'error') break;
      }
      if (wait.status === 'ok') {
        if (!text && !req.probeOnly) text = await this.lastAssistantText(sessionKey);
        return { ok: true, text, durationMs: Date.now() - start, runtimeSessionId: sessionKey };
      }
      if (wait.status === 'error' || errorMessage) {
        const msg = errorMessage ?? wait.error ?? 'run error';
        const c = classifyFailure({ errorKind, message: msg, detail: errorDetail });
        return { ok: false, category: c.category, message: msg, resetAt: c.resetAt, retryable: c.retryable, runtimeSessionId: sessionKey, detail: errorDetail ?? undefined };
      }
      await this.cancel(sessionKey);
      return { ok: false, category: 'hung', message: `turn exceeded ${req.timeoutMs}ms`, retryable: true, runtimeSessionId: sessionKey };
    } catch (e) {
      const err = e as GatewayError;
      const c = classifyFailure({ errorKind: err.code, message: err.message });
      const category = c.category === 'internal' && err instanceof GatewayError && err.retryable ? 'transient' : c.category;
      return { ok: false, category, message: err.message, resetAt: c.resetAt, retryable: true, runtimeSessionId: sessionKey };
    } finally { off(); this.activeRuns.delete(req.sessionRef); }
  }

  private async lastAssistantText(sessionKey: string): Promise<string> {
    try {
      const h = await this.o.gateway.call<{ messages?: Array<{ role: string; content: unknown }> }>('chat.history', { sessionKey, limit: 5 }, 10_000);
      const last = [...(h.messages ?? [])].reverse().find((m) => m.role === 'assistant');
      return extractText(last?.content);
    } catch { return ''; }
  }

  async cancel(sessionRef: string): Promise<void> {
    const runId = this.activeRuns.get(sessionRef);
    try { await this.o.gateway.call('chat.abort', runId ? { runId, sessionKey: sessionRef } : { sessionKey: sessionRef }, 8000); } catch (e) { this.o.log.warn('cancel failed', { sessionRef, err: (e as Error).message }); }
    if (sessionRef.includes(':acp:')) { try { await this.command(`/acp cancel ${sessionRef}`, 15_000); } catch { /* best effort */ } }
  }

  /** Queue an instruction on a session: OpenClaw runs it after the in-flight turn ends (it never interrupts the running turn). */
  async steerSession(sessionKey: string, instruction: string): Promise<string> { return this.command(`/acp steer --session ${sessionKey} ${instruction.replace(/\s+/g, ' ').slice(0, 2000)}`, 30_000); }

  async closeSession(sessionKey: string): Promise<void> { try { await this.command(`/acp close ${sessionKey}`, 20_000); } catch (e) { this.o.log.warn('close failed', { sessionKey, err: (e as Error).message }); } }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return splitRunOn(content);
  // Separate text blocks (before and after a tool call) are separate paragraphs; joining them bare ran sentences together ("changelog.v2.1").
  // The answer is the text after the turn's last tool use; earlier text blocks are mid-turn narration ("I just need the ref…").
  if (Array.isArray(content)) {
    const blocks = content as Array<unknown>; let lastTool = -1;
    blocks.forEach((b, i) => { if (b && typeof b === 'object' && 'type' in b && /tool/.test(String((b as { type: unknown }).type))) lastTool = i; });
    const texts = (from: number) => blocks.slice(from).map((b) => (typeof b === 'string' ? b : (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))).filter((t) => t.trim().length);
    let parts = texts(lastTool + 1); if (!parts.length) parts = texts(0);
    // The gateway's final message drops the tool calls but keeps each text block, so mid-turn notes ("Truncated JSON; use regex.") arrive as
    // separate blocks ahead of the answer. Each block was written after a tool call: keep the last, or from the longest one when the last is a short sign-off.
    if (lastTool < 0 && parts.length > 1) { const longest = parts.reduce((bi, p, i) => (p.length >= parts[bi].length ? i : bi), 0); const last = parts.length - 1; parts = parts.slice(parts[last].length >= 300 || longest === last ? last : longest); }
    return splitRunOn(parts.reduce((acc, t) => (!acc ? t : /\s$/.test(acc) || /^\s/.test(t) ? acc + t : `${acc}\n\n${t}`), ''));
  }
  return '';
}

/* Streamed text from before and after a tool call can arrive as one block with no break ("check the quotes myself.Draft v2 fails").
   A sentence end glued to a capitalised word is split into paragraphs; dotted names (v2.1, README.md, e.g.) are left alone. */
export function splitRunOn(text: string): string {
  return text.replace(/(\b[a-z]{2,}[.!?])([A-Z](?:[a-z]+\b|\s))/g, '$1\n\n$2');
}
export const extractTextForTest = extractText;
