import type { ModelRuntime, RuntimeHealth, TurnRequest, TurnResult } from './types.ts';

export type SimScript =
  | { kind: 'ok'; text?: string; delayMs?: number }
  | { kind: 'limit'; resetAt?: string | null }
  | { kind: 'auth' }
  | { kind: 'rate' }
  | { kind: 'hang' }             // never resolves until aborted/timeout
  | { kind: 'crash' }            // simulates the subprocess dying mid-turn
  | { kind: 'transient' };

/**
 * Deterministic runtime for recovery tests. Scripts are consumed in order per session;
 * when the script list is exhausted, turns succeed. Nothing leaves the process.
 */
export class SimulatedRuntime implements ModelRuntime {
  readonly id = 'simulated' as const;
  private scripts: SimScript[];
  private calls: TurnRequest[] = [];
  private aborts = new Map<string, AbortController>();
  authed = true;
  constructor(scripts: SimScript[] = []) { this.scripts = [...scripts]; }
  describe() { return { label: 'Simulated runtime (tests only)', route: 'in-process', account: 'none' }; }
  push(...s: SimScript[]) { this.scripts.push(...s); }
  get history() { return this.calls; }
  async health(): Promise<RuntimeHealth> { return { id: 'simulated', configured: true, ok: this.authed, state: this.authed ? 'ready' : 'auth_required', detail: 'simulated runtime (tests only)', observedAt: new Date().toISOString(), account: { loggedIn: this.authed, method: 'simulated', subscription: 'none' } }; }
  async startTurn(req: TurnRequest): Promise<TurnResult> {
    this.calls.push(req);
    const s = this.scripts.shift() ?? { kind: 'ok' as const };
    const start = Date.now();
    const sid = req.sessionRef.startsWith('sim-') ? req.sessionRef : `sim-${req.sessionRef}`;   // a bound session stays bound, like a real ACP session
    req.onSession?.(sid); req.onHeartbeat?.('simulated turn started');
    switch (s.kind) {
      case 'ok': if (s.delayMs) await sleep(s.delayMs, req.signal); return { ok: true, text: s.text ?? `done: ${req.prompt.slice(0, 40)}`, runtimeSessionId: sid, durationMs: Date.now() - start };
      case 'limit': return { ok: false, category: 'quota_exhausted', message: "You've hit your usage limit", resetAt: s.resetAt ?? null, retryable: true, runtimeSessionId: sid };
      case 'rate': return { ok: false, category: 'rate_limited', message: 'rate limited', retryable: true };
      case 'auth': return { ok: false, category: 'auth_required', message: 'Not logged in · Please run /login', retryable: true };
      case 'transient': return { ok: false, category: 'transient', message: 'temporary network error', retryable: true };
      case 'crash': return { ok: false, category: 'crashed', message: 'claude subprocess exited unexpectedly (simulated)', retryable: true, runtimeSessionId: sid };
      case 'hang': {
        const ac = new AbortController(); this.aborts.set(req.sessionRef, ac);
        try { await sleep(req.timeoutMs, anySignal(req.signal, ac.signal)); return { ok: false, category: 'hung', message: `turn exceeded ${req.timeoutMs}ms (simulated hang)`, retryable: true }; }
        catch { return { ok: false, category: 'cancelled', message: 'cancelled by watchdog', retryable: true }; }
      }
    }
  }
  async cancel(sessionRef: string) { this.aborts.get(sessionRef)?.abort(); }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) { if (!s) continue; if (s.aborted) { ac.abort(); break; } s.addEventListener('abort', () => ac.abort(), { once: true }); }
  return ac.signal;
}
