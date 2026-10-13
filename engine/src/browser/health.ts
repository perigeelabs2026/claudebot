import path from 'node:path';
import type { EngineConfig } from '../config.ts';
import { runProbe, type ProbeResult } from '../infra/probe.ts';

const PROBE_ENV = { ...process.env, OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' };
function probeTimeout(): number { const n = Number(process.env.CLAUDEBOT_PROBE_TIMEOUT_MS ?? 20_000); return Number.isFinite(n) && n >= 1000 ? n : 20_000; }
function why(r: ProbeResult, timeoutMs: number): string {
  const head = r.skipped === 'storm_guard' ? 'refused by the probe storm guard' : r.timedOut ? `timed out after ${timeoutMs} ms (process group killed)` : r.signal ? `killed (${r.signal})` : `exit ${r.code ?? '?'}`;
  return `${head}; ${(r.stderr || r.stdout).replace(/\s+/g, ' ').slice(0, 240)}`;
}
async function openclaw(cfg: EngineConfig, args: string[], label: string, timeoutMs: number, maxBuffer?: number): Promise<ProbeResult> {
  return runProbe(cfg.openclawBin, args, { timeoutMs, label, env: PROBE_ENV, maxBuffer, registryDir: path.join(cfg.runDir, 'probes') });
}

/** Markers that prove a signed-in state without automating any login. Read-only navigation + snapshot. */
const MARKERS: Record<string, { url: string; signedIn: RegExp; signedOut: RegExp }> = {
  'linkedin.com': { url: 'https://www.linkedin.com/feed/', signedIn: /Start a post|feed-shared|Home\b/i, signedOut: /Sign in|Join now|login/i },
  'x.com': { url: 'https://x.com/home', signedIn: /Home|What is happening/i, signedOut: /Sign in|Log in|Create account/i },
  'mail.google.com': { url: 'https://mail.google.com/mail/u/0/#inbox', signedIn: /Inbox|Compose/i, signedOut: /Sign in|Choose an account/i },
};

export async function browserLoginCheck(cfg: EngineConfig, site: string): Promise<{ signed_in: boolean; evidence: string }> {
  const m = MARKERS[site] ?? { url: `https://${site}/`, signedIn: /log ?out|sign ?out|account/i, signedOut: /sign ?in|log ?in/i };
  const args = (sub: string[]) => ['--profile', cfg.openclawProfile, 'browser', '--browser-profile', 'claudebot', '--json', ...sub];
  const step = async (sub: string[], label: string, maxBuffer?: number) => { const r = await openclaw(cfg, args(sub), label, 60_000, maxBuffer); if (!r.ok) throw new Error(`browser ${label} failed: ${why(r, 60_000)}`); return r.stdout; };
  await step(['start'], 'browser.start');
  const pages = async () => { try { return ((await (await fetch(`http://127.0.0.1:${cfg.browserCdpPort}/json`, { signal: AbortSignal.timeout(1500) })).json()) as Array<{ id: string; type: string }>).filter((t) => t.type === 'page').map((t) => t.id); } catch { return [] as string[]; } };
  const before = await pages();
  await step(['open', m.url], 'browser.open');
  await new Promise((r) => setTimeout(r, 3000));
  let stdout: string;
  try { stdout = await step(['snapshot', '--format', 'aria'], 'browser.snapshot', 8 * 1024 * 1024); }
  finally { const opened = (await pages()).filter((id) => !before.includes(id)); for (const id of opened) { try { await fetch(`http://127.0.0.1:${cfg.browserCdpPort}/json/close/${id}`, { signal: AbortSignal.timeout(2000) }); } catch { /* best effort */ } } }   // the check never leaves a tab behind
  const text = stdout.slice(0, 200_000);
  const signedIn = m.signedIn.test(text) && !m.signedOut.test(text.slice(0, 5000));
  return { signed_in: signedIn, evidence: `aria snapshot of ${m.url}: signedIn=${m.signedIn.test(text)} signedOut=${m.signedOut.test(text.slice(0, 5000))}` };
}

export interface BrowserStatus { ok: boolean; state: 'ok' | 'bypassed' | 'profile_missing' | 'probe_failed'; detail: string; profiles?: unknown }

let statusCache: { at: number; value: BrowserStatus } | null = null;
/** Drop the cached profile status (tests, and after the managed profile is created). */
export function resetBrowserStatusCache(): void { statusCache = null; }

/**
 * Managed-profile status. One leashed `openclaw browser profiles` probe at most every
 * CLAUDEBOT_BROWSER_PROBE_TTL_MS (default 30 s) per engine process, whatever the health-poll rate; the
 * simulated runtime never probes (state `bypassed`, like the gateway) unless CLAUDEBOT_BROWSER_PROBE=on.
 */
export async function browserStatus(cfg: EngineConfig, opts: { fresh?: boolean } = {}): Promise<BrowserStatus> {
  if (process.env.CLAUDEBOT_RUNTIME === 'simulated' && process.env.CLAUDEBOT_BROWSER_PROBE !== 'on') {
    return { ok: true, state: 'bypassed', detail: 'simulated runtime in use; the managed browser is not probed' };
  }
  const ttl = Number(process.env.CLAUDEBOT_BROWSER_PROBE_TTL_MS ?? 30_000);
  if (statusCache && !opts.fresh && Date.now() - statusCache.at < ttl) return statusCache.value;
  const timeoutMs = probeTimeout();
  const r = await openclaw(cfg, ['--profile', cfg.openclawProfile, 'browser', '--json', 'profiles'], 'browser.profiles', timeoutMs);
  let value: BrowserStatus;
  if (!r.ok) value = { ok: false, state: 'probe_failed', detail: `browser profiles query failed: ${why(r, timeoutMs)}` };
  else {
    try {
      const j = JSON.parse(r.stdout);
      const list = Array.isArray(j) ? j : (j.profiles ?? []);
      const has = list.some((p: { name?: string; id?: string }) => (p.name ?? p.id) === 'claudebot');
      value = { ok: has, state: has ? 'ok' : 'profile_missing', detail: has ? 'managed profile claudebot present' : 'managed profile claudebot missing', profiles: list.map((p: { name?: string; id?: string }) => p.name ?? p.id) };
    } catch (e) { value = { ok: false, state: 'probe_failed', detail: `browser profiles query returned non-JSON: ${(e as Error).message}; ${r.stdout.replace(/\s+/g, ' ').slice(0, 160)}` }; }
  }
  statusCache = { at: Date.now(), value };
  return value;
}
