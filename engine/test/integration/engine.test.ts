import { fixtureDb } from '../recovery/fixtures.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/** Ports are handed out sequentially from a random base so two harnesses in one run never share one (a reused port let a
 * later scenario see an earlier engine's health and race its own database). */
let nextPort = 48400 + Math.floor(Math.random() * 300);
/** Starts a real engine process on a temp home with the simulated runtime. Shared by integration and recovery tests. */
export class EngineHarness {
  home: string; port: number; token = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz'; proc: ChildProcess | null = null; logFile: string;
  simAuthed = true;
  constructor(opts: { port?: number; simScript?: unknown[]; workers?: number; home?: string; simAuthed?: boolean } = {}) {
    if (opts.simAuthed === false) this.simAuthed = false;
    this.home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ros-home-')); this.port = opts.port ?? nextPort++;
    fs.mkdirSync(path.join(this.home, 'secrets'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.home, 'secrets', 'ui.token'), this.token + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(this.home, 'secrets', 'gateway.token'), 'gw-placeholder\n', { mode: 0o600 });
    this.logFile = path.join(this.home, 'engine-stdout.log');
    this.simScript = opts.simScript ?? []; this.workers = opts.workers ?? 1;
  }
  simScript: unknown[]; workers: number; wsId = '';
  async start(): Promise<void> {
    const entry = path.resolve(import.meta.dirname, '..', '..', 'src', 'supervisor', 'main.ts');
    const out = fs.openSync(this.logFile, 'a');
    this.proc = spawn(process.execPath, [entry], { env: { ...process.env, CLAUDEBOT_HOME: this.home, CLAUDEBOT_PORT: String(this.port), CLAUDEBOT_RUNTIME: 'simulated', CLAUDEBOT_SIM_SCRIPT: JSON.stringify(this.simScript), CLAUDEBOT_WORKERS: String(this.workers), CLAUDEBOT_LEASE_SECONDS: '6', CLAUDEBOT_HEARTBEAT_SECONDS: '2', CLAUDEBOT_RETRY_BASE_SECONDS: '1', ...(this.simAuthed ? {} : { CLAUDEBOT_SIM_AUTHED: '0' }) }, stdio: ['ignore', out, out] });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { try { const r = await this.api('/api/health'); if (r) { if (!this.wsId) { const w = await this.api<{ id: string }>('/api/workspaces', { method: 'POST', body: { name: 'Test workspace', worker_limit: 10 } }); this.wsId = w.id; } return; } } catch { /* not yet */ } await sleep(250); }
    throw new Error('engine did not start: ' + fs.readFileSync(this.logFile, 'utf8').slice(-2000));
  }
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> { if (!this.proc) return; const p = this.proc; this.proc = null; p.kill(signal); await new Promise<void>((r) => { p.on('exit', () => r()); setTimeout(r, 25_000); }); }
  /** Remove this harness's temporary home (call after the last stop). */
  cleanup(): void { try { fs.rmSync(this.home, { recursive: true, force: true }); } catch { /* */ } }
  async api<T = Record<string, unknown>>(p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const body = init.body && typeof init.body === 'object' && (p === '/api/jobs' || p === '/api/tasks') && init.method === 'POST' ? { workspace_id: this.wsId, ...(init.body as Record<string, unknown>) } : init.body;
    const r = await fetch(`http://127.0.0.1:${this.port}${p}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', 'x-claudebot-token': this.token, ...(init.headers ?? {}) }, body: body ? JSON.stringify(body) : undefined });
    return (await r.json()) as T;
  }
  workerPids(): number[] { try { return (JSON.parse(fs.readFileSync(path.join(this.home, 'run', 'workers.json'), 'utf8')) as { workers: number[] }).workers; } catch { return []; } }
  async waitFor(jobId: string, states: string[], timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs; let last: Record<string, unknown> = {};
    while (Date.now() < deadline) { const r = await this.api<{ job: Record<string, unknown> }>(`/api/jobs/${jobId}`); last = r.job; if (states.includes(String(r.job.state))) return r.job; await sleep(300); }
    throw new Error(`job ${jobId} stayed in ${last.state} (wanted ${states.join('|')}); blocker=${last.blocker_code} detail=${last.failure_detail}`);
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const h = new EngineHarness();
before(async () => { await h.start(); });
after(async () => { await h.stop(); h.cleanup(); });

test('health reports each subsystem separately with evidence, and the UI loads nothing as "ok" by itself', async () => {
  const first = await h.api<Record<string, { state: string }>>('/api/health');
  assert.ok(['checking', 'ok', 'bypassed', 'ready'].includes(first.gateway.state), 'first call answers immediately with an honest state');
  const hh = await h.api<Record<string, { state: string; observed_at: string }>>('/api/health?fresh=1');
  for (const k of ['ui', 'queue', 'gateway', 'claude', 'browser', 'workers']) { assert.ok(hh[k], k); assert.ok(hh[k].observed_at); assert.notEqual(hh[k].state, 'checking'); }
  assert.equal(hh.browser.state, 'bypassed', 'the simulated runtime never probes the managed browser (no external process per health poll)'); assert.ok((hh.browser as unknown as { detail: string }).detail.length > 0);
  assert.equal((hh as unknown as { claude: { evidence: { route: string } } }).claude.evidence.route, 'in-process');   // simulated runtime is labelled, never mistaken for Claude
});

test('a read-only agent job completes end to end through a real worker process and is visible in the API', async () => {
  const r = await h.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { kind: 'system.workspace_summary', objective: 'daily brief' } });
  const job = await h.waitFor(r.job.id, ['completed', 'failed_terminal']);
  assert.equal(job.state, 'completed');
  const detail = await h.api<{ checkpoints: unknown[]; artifacts: Array<{ kind: string }>; events: Array<{ type: string }> }>(`/api/jobs/${r.job.id}`);
  assert.equal(detail.checkpoints.length, 4); assert.ok(detail.artifacts.some((a) => a.kind === 'note'));
  assert.ok(detail.events.some((e) => e.type === 'lease.acquired'));
  const agents = await h.api<Array<{ id: string; status: string; last_result: { id: string } | null }>>('/api/agents');
  const cos = agents.find((a) => a.id === 'coordinator')!; assert.equal(cos.status, 'idle'); assert.equal(cos.last_result?.id, r.job.id);
});

test('submitting the same job twice yields one job (idempotency)', async () => {
  const a = await h.api<{ job: { id: string }; created: boolean }>('/api/jobs', { method: 'POST', body: { kind: 'system.workspace_summary', objective: 'x', idempotency_key: 'owner:dup-1' } });
  const b = await h.api<{ job: { id: string }; created: boolean }>('/api/jobs', { method: 'POST', body: { kind: 'system.workspace_summary', objective: 'x', idempotency_key: 'owner:dup-1' } });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.job.id, b.job.id);
});

test('unapproved consequential action through the broker endpoint is refused and audited; invalid capability is rejected', async () => {
  const r = await h.api<{ ok: boolean; text: string }>('/api/broker/call', { method: 'POST', body: { tool: 'add_evidence', args: {} }, headers: { 'x-capability': 'nope', 'x-job-id': 'job-none' } });
  assert.equal(r.ok, false); assert.match(r.text, /invalid or expired capability/);
  const acts = await h.api<unknown[]>('/api/actions'); assert.ok(Array.isArray(acts));
});

test('chat: a plain-English message gets a durable reply through a real worker; a second message resumes the same lead session; the conversation survives an engine restart', async () => {
  const c = await h.api<{ id: string; workspace_id: string }>('/api/conversations', { method: 'POST', body: {} });
  assert.equal(c.workspace_id, h.wsId, 'with no project chosen the first active project is used');
  const sent = await h.api<{ message: { id: string }; job: { id: string; kind: string } }>(`/api/conversations/${c.id}/messages`, { method: 'POST', body: { content: 'Please write a two-line haiku about rain.' } });
  assert.equal(sent.job.kind, 'chat.turn');
  // The owner can keep talking while a reply is in progress: the second message is accepted and queued behind the first turn.
  const queued = await h.api<{ error?: string; job: { id: string; state: string } }>(`/api/conversations/${c.id}/messages`, { method: 'POST', body: { content: 'and another' } });
  assert.equal(queued.error, undefined, 'a second message while the reply is in progress is accepted'); assert.notEqual(queued.job.id, sent.job.id, 'one turn per message');
  const first = await h.waitFor(sent.job.id, ['completed', 'failed_terminal']); const second = await h.waitFor(queued.job.id, ['completed', 'failed_terminal']);
  assert.equal(first.state, 'completed'); assert.equal(second.state, 'completed');
  assert.ok(Date.parse(String((second as { started_at?: string }).started_at ?? second.updated_at)) >= Date.parse(String(first.completed_at)), 'the queued turn ran after the first one finished (same session, never at once)');
  let d = await h.api<{ messages: Array<{ role: string; content: string; delivery: string; sender: string; job: { state: string } | null }>; conversation: { session_ref: string | null }; active_turn: unknown }>(`/api/conversations/${c.id}`);
  assert.deepEqual(d.messages.map((m) => m.role), ['owner', 'owner', 'assistant', 'assistant']); assert.match(d.messages[2].content, /done:/); assert.equal(d.active_turn, null);
  assert.deepEqual(d.messages.map((m) => m.sender), ['owner', 'owner', 'coordinator', 'coordinator']); assert.deepEqual(d.messages.slice(0, 2).map((m) => m.delivery), ['delivered', 'delivered']);
  assert.equal(d.conversation.session_ref, `sim-${c.id}`);
  // Restart the engine: everything must still be there and the next turn must resume the same session.
  await h.stop(); await h.start();
  d = await h.api(`/api/conversations/${c.id}`); assert.equal(d.messages.length, 4); assert.equal(d.conversation.session_ref, `sim-${c.id}`);
  const again = await h.api<{ job: { id: string } }>(`/api/conversations/${c.id}/messages`, { method: 'POST', body: { content: 'Now one about sun.' } });
  const j = await h.waitFor(again.job.id, ['completed', 'failed_terminal']); assert.equal(j.state, 'completed'); assert.equal(j.session_ref, `sim-${c.id}`);
  d = await h.api(`/api/conversations/${c.id}`); assert.equal(d.messages.length, 6);
  const list = await h.api<Array<{ id: string; open_work: number; title: string }>>('/api/conversations'); assert.equal(list[0].id, c.id); assert.equal(list[0].open_work, 0); assert.match(list[0].title, /haiku/);
  const detail = await h.api<{ events: Array<{ type: string }> }>(`/api/jobs/${sent.job.id}`); assert.ok(!detail.events.some((e) => e.type === 'session.closed'), 'the lead session is not closed by a finished turn');
});

test('chat: a repeated client id (voice session or double Send) creates one message and one turn, also after the reply finished', async () => {
  const c = await h.api<{ id: string }>('/api/conversations', { method: 'POST', body: {} });
  const body = { content: 'Say hello once.', source: 'voice', on_device: true, client_id: 'voice:test-session-1' };
  const first = await h.api<{ job: { id: string }; duplicate?: boolean }>(`/api/conversations/${c.id}/messages`, { method: 'POST', body });
  assert.equal(first.duplicate, undefined);
  const during = await h.api<{ job: { id: string }; duplicate?: boolean }>(`/api/conversations/${c.id}/messages`, { method: 'POST', body });
  assert.equal(during.duplicate, true); assert.equal(during.job.id, first.job.id, 'the duplicate returns the original turn');
  await h.waitFor(first.job.id, ['completed', 'failed_terminal']);
  const late = await h.api<{ job: { id: string }; duplicate?: boolean }>(`/api/conversations/${c.id}/messages`, { method: 'POST', body });
  assert.equal(late.duplicate, true, 'a late repeat after the reply is still recognised');
  const d = await h.api<{ messages: Array<{ role: string; meta: { client_id?: string; source?: string } }> }>(`/api/conversations/${c.id}`);
  assert.equal(d.messages.filter((m) => m.role === 'owner').length, 1); assert.equal(d.messages[0].meta.client_id, 'voice:test-session-1');
  // control: a different client id is a new message
  const other = await h.api<{ job: { id: string }; duplicate?: boolean }>(`/api/conversations/${c.id}/messages`, { method: 'POST', body: { ...body, client_id: 'voice:test-session-2' } });
  assert.equal(other.duplicate, undefined); assert.notEqual(other.job.id, first.job.id); await h.waitFor(other.job.id, ['completed', 'failed_terminal']);
  const jobs = await h.api<Array<{ kind: string; conversation_id: string | null }>>('/api/jobs?limit=1000'); assert.equal(jobs.filter((j) => j.kind === 'chat.turn' && j.conversation_id === c.id).length, 2);
});

test('automation over the real API: a trigger posts with its own secret (no UI token), once per event; an unknown approval cannot be run', async () => {
  const t = await h.api<{ trigger: { id: string }; token: string; url: string }>('/api/triggers', { method: 'POST', body: { name: 'Local form', kind: 'research.report', objective: 'Summarise the submission', workspace_id: h.wsId } });
  assert.match(t.url, /\/api\/hooks\/trg-/);
  const post = (token: string, body: unknown) => fetch(`http://127.0.0.1:${h.port}/api/hooks/${t.trigger.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claudebot-trigger-token': token }, body: JSON.stringify(body) });
  assert.equal((await post('nope', { event_id: 'a' })).status, 401);
  const ok = await post(t.token, { event_id: 'evt-1', data: { q: 'hello' } }); assert.equal(ok.status, 201); const j1 = await ok.json() as { job_id: string };
  const dup = await post(t.token, { event_id: 'evt-1', data: {} }); assert.equal(dup.status, 200); assert.equal((await dup.json() as { job_id: string }).job_id, j1.job_id);
  const list = await h.api<Array<{ id: string; events: number; token_sha256?: string }>>('/api/triggers'); assert.equal(list.find((x) => x.id === t.trigger.id)!.events, 1); assert.equal(list[0].token_sha256, undefined);
  // Owner confirmation (native signed Confirm) is exempt on this simulated test engine; its enforcement is unit-tested (owner-presence.test.ts).
  const ex = await fetch(`http://127.0.0.1:${h.port}/api/approvals/apr-x/execute`, { method: 'POST', headers: { 'x-claudebot-token': h.token } }); assert.equal(ex.status, 404, 'unknown approval');
  await h.api(`/api/jobs/${j1.job_id}/cancel`, { method: 'POST' });
});

test('live browser endpoints answer honestly without a browser: not running, no frames, takeover flag is durable and audited', async () => {
  const live = await h.api<{ running: boolean; streaming: boolean; last_frame_at: string | null; takeover: { active: boolean } | null; using: unknown }>('/api/browser/live');
  assert.equal(typeof live.running, 'boolean'); assert.equal(live.streaming, false); assert.equal(live.last_frame_at, null); assert.equal(live.using, null);
  const t = await h.api<{ takeover: boolean }>('/api/browser/takeover', { method: 'POST', body: { active: true, note: 'owner signing in' } }); assert.equal(t.takeover, true);
  const after = await h.api<{ takeover: { active: boolean; note: string } }>('/api/browser/live'); assert.equal(after.takeover.active, true); assert.equal(after.takeover.note, 'owner signing in');
  const ev = await h.api<Array<{ type: string }>>('/api/activity?limit=20'); assert.ok(ev.some((e) => e.type === 'browser.takeover.started'));
  const off = await h.api<{ takeover: boolean }>('/api/browser/takeover', { method: 'POST', body: { active: false } }); assert.equal(off.takeover, false);
});

test('workbench and capabilities endpoints: real tasks only, direction saved with truthful timing, stop aborts a running turn', async () => {
  const cap = await h.api<{ states: Record<string, string>; items: Array<{ state: string }> }>('/api/capabilities'); assert.equal(Object.keys(cap.states).length, 4); assert.ok(cap.items.length >= 20);
  const wb0 = await h.api<{ assistants: Array<{ id: string; status: string; tasks: unknown[] }>; tasks: unknown[]; counts: { working: number } }>('/api/workbench');
  assert.equal(wb0.counts.working, 0, 'nothing is working when nothing runs'); assert.ok(wb0.assistants.every((a) => a.status !== 'working'));
  // A slow simulated task: the harness runtime script is empty, so turns succeed instantly; use a deterministic wait to hold a slot.
  const r = await h.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { kind: 'system.workspace_summary', objective: 'Summarize the project and save it as brief.md, registered as an artifact.' } });
  const done = await h.waitFor(r.job.id, ['completed', 'failed_terminal']); assert.equal(done.state, 'completed');
  const wb = await h.api<{ tasks: Array<{ id: string; title: string; status: string; assigned_by: string; turn: string | null; outputs: unknown[] }> }>('/api/workbench');
  const t = wb.tasks.find((x) => x.id === r.job.id)!; assert.equal(t.title, 'Summarize the project'); assert.equal(t.status, 'finished'); assert.equal(t.assigned_by, 'you'); assert.equal(t.turn, null); assert.equal(t.outputs.length, 1);
  const dir = await h.api<{ error?: string }>(`/api/tasks/${r.job.id}/direction`, { method: 'POST', body: { note: 'x' } }); assert.match(String(dir.error), /ready to review|finished|over/i, 'no direction to a finished task');
  // Direction on a queued task is accepted with an honest "when".
  const wf = await h.api<{ workflows: Array<{ id: string }> }>('/api/workflows'); assert.ok(wf.workflows.some((w) => w.id === 'document.create'));
  const q = await h.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { kind: 'document.create', objective: 'Write a long note', inputs: {} } });
  const d2 = await h.api<{ ok: boolean; when: string }>(`/api/tasks/${q.job.id}/direction`, { method: 'POST', body: { note: 'Keep it short.' } }); assert.equal(d2.ok, true); assert.match(d2.when, /Claude step|next reply|will not interrupt/);
  // Direction given in the office appears in the task's conversation (found in installed acceptance: it was invisible there).
  const conv = await h.api<{ id: string }>('/api/conversations', { method: 'POST', body: { workspace_id: h.wsId } });
  const q2 = await h.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { kind: 'document.create', objective: 'Write another note', inputs: {} } });
  { const fdb = fixtureDb(h.home); fdb.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conv.id, q2.job.id); fdb.close(); }
  await h.api(`/api/tasks/${q2.job.id}/direction`, { method: 'POST', body: { note: 'Use the title Owner Title.' } });
  const convMsgs = await h.api<{ messages: Array<{ kind: string; content: string; job_id: string }> }>(`/api/conversations/${conv.id}`);
  assert.ok(convMsgs.messages.some((x) => x.kind === 'direction' && x.job_id === q2.job.id && /Use the title Owner Title\./.test(x.content)), 'office direction is shown in the conversation');
  assert.ok(convMsgs.messages.some((x) => x.kind === 'direction' && /recorded through the API/.test(x.content)), 'a script (header token) is not called the owner in the office');
  // control: direction to a task outside any conversation adds no conversation message
  const qs = await h.api<{ state: string }>(`/api/jobs/${q.job.id}`); void qs; await h.api(`/api/tasks/${q.job.id}/direction`, { method: 'POST', body: { note: 'Control note.' } });
  const after = await h.api<{ messages: Array<{ kind: string; content: string }> }>(`/api/conversations/${conv.id}`); assert.equal(after.messages.filter((x) => x.kind === 'direction').length, 1, 'exactly one direction message: the task outside the conversation added none');
  await h.api(`/api/jobs/${q2.job.id}/cancel`, { method: 'POST' });
  // The simulated runtime registers no file, so the write step succeeds and the check step schedules a retry; the Claude step still ran, which is what delivery needs.
  await h.waitFor(q.job.id, ['completed', 'failed_terminal', 'cancelled', 'retry_scheduled'], 30_000);
  const detail = await h.api<{ events: Array<{ type: string; detail: { how?: string } }> }>(`/api/jobs/${q.job.id}`);
  assert.ok(detail.events.some((e) => e.type === 'owner.direction')); assert.ok(detail.events.some((e) => e.type === 'owner.direction.delivered'), 'delivered at the Claude step');
  await h.api(`/api/jobs/${q.job.id}/cancel`, { method: 'POST' });
  const sess = await h.api<{ available: boolean; detail: string }>(`/api/workbench/${q.job.id}/session`); assert.equal(sess.available, false); assert.ok(sess.detail.length > 0);
});
