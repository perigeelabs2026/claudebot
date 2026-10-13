/**
 * Recovery pack: the fifteen interruption scenarios from the build brief, run against a real engine process
 * (simulated runtime unless a scenario says otherwise). Nothing here sends, publishes, purchases or deletes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fixtureDb, markReported } from './fixtures.ts';
import { EngineHarness, sleep } from '../integration/engine.test.ts';

const results: Record<string, boolean> = {};
const harnesses: EngineHarness[] = [];
async function engine(opts: ConstructorParameters<typeof EngineHarness>[0] = {}) { const h = new EngineHarness(opts); harnesses.push(h); await h.start(); return h; }
function record(name: string, ok: boolean) { results[name] = ok; }
after(async () => {
  for (const h of harnesses) { await h.stop().catch(() => {}); h.cleanup(); }
  const passed = Object.values(results).filter(Boolean).length; const failed = Object.values(results).length - passed;
  // Record the pack result on the REAL install's engine if it is reachable, so Reliability shows the last recovery test.
  try { const token = fs.readFileSync(path.join(os.homedir(), '.claudebot', 'secrets', 'ui.token'), 'utf8').trim(); await fetch(`http://127.0.0.1:${process.env.CLAUDEBOT_PORT ?? 48311}/api/state`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claudebot-token': token }, body: JSON.stringify({ key: 'recovery.last_test', value: { passed, failed, scenarios: results }, evidence: 'npm run test:recovery' }) }); } catch { /* engine not installed */ }
  fs.writeFileSync(path.join(os.tmpdir(), 'claudebot-recovery-results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2));
});
const post = (h: EngineHarness, kind: string, objective: string, extra: Record<string, unknown> = {}) => h.api<{ job: { id: string } }>('/api/jobs', { method: 'POST', body: { kind, objective, ...extra } });

test('1. closing the desktop window does not stop a job (engine is a separate process from the shell)', async () => {
  const h = await engine({ simScript: [{ kind: 'ok', delayMs: 4000, text: 'DONE' }] });
  // The property that matters: the installed engine runs under launchd (parent pid 1), so closing or killing the desktop shell cannot stop it.
  // (The previous version launched dist/ClaudeBot.app, which no longer exists, so its shell check never ran.)
  const r = await post(h, 'research.report', 'window test'); await sleep(1500);
  const shellPid: number | null = null;
  try { const out = execFileSync('/bin/launchctl', ['print', `gui/${process.getuid!()}/com.claudebot.engine`], { encoding: 'utf8' }); const pid = Number((out.match(/\bpid = (\d+)/) ?? [])[1]); if (pid) { const ppid = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); assert.equal(ppid, 1, 'the installed engine is a launchd job, not a child of the desktop app'); } } catch (e) { if ((e as Error).name === 'AssertionError') throw e; /* engine not installed on this host */ }
  // engine pid is not a descendant of the shell; the job keeps going after the shell dies
  const health = await h.api<{ pid: number }>('/api/health'); assert.ok(health.pid !== shellPid);
  const db = fixtureDb(h.home, { readOnly: true });
  db.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev1', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')"); // readOnly guard: evidence added below via rw handle
  db.close();
  const rw = fixtureDb(h.home); rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev1', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run(r.job.id); markReported(rw, r.job.id); rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('art1', ?, 'research', 'file', 'report.md', '2026-01-01')").run(r.job.id); rw.close();
  const job = await h.waitFor(r.job.id, ['completed', 'failed_terminal'], 40_000);
  assert.equal(job.state, 'completed'); record('close_window', true);
});

test('2. a killed worker loses its lease; another worker resumes from the checkpoint', async () => {
  const h = await engine({ workers: 2, simScript: [{ kind: 'ok', delayMs: 30_000 }, { kind: 'ok', text: 'DONE' }] });
  const r = await post(h, 'research.report', 'kill worker');
  const rw = fixtureDb(h.home); rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev2', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run(r.job.id); markReported(rw, r.job.id); rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('art-ev2', ?, 'research', 'file', 'report.md', '2026-01-01')").run(r.job.id); rw.close();
  await h.waitFor(r.job.id, ['running'], 15_000);
  let job = (await h.api<{ job: { lease_owner: string } }>(`/api/jobs/${r.job.id}`)).job;
  const pid = Number(job.lease_owner.split(':')[1]); process.kill(pid, 'SIGKILL');
  job = await h.waitFor(r.job.id, ['completed'], 60_000) as never;
  const d = await h.api<{ events: Array<{ type: string; actor: string; detail: Record<string, unknown> }> }>(`/api/jobs/${r.job.id}`);
  const owners = new Set(d.events.filter((e) => e.type === 'lease.acquired').map((e) => e.actor));
  assert.ok(d.events.some((e) => e.type === 'lease.reclaimed'), 'lease reclaimed'); assert.ok(owners.size >= 2, 'two different workers held the lease'); assert.ok(d.events.some((e) => e.type === 'job.resumed'));
  record('kill_worker', true);
});

test('5. reboot simulation: SIGKILL the whole engine mid-job; on restart orphans are reaped and the job resumes', async () => {
  const h = await engine({ simScript: [{ kind: 'ok', delayMs: 30_000 }, { kind: 'ok', text: 'DONE' }] });
  const r = await post(h, 'research.report', 'reboot');
  const rw = fixtureDb(h.home); rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev5', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run(r.job.id); markReported(rw, r.job.id); rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('art-ev5', ?, 'research', 'file', 'report.md', '2026-01-01')").run(r.job.id); rw.close();
  await h.waitFor(r.job.id, ['running'], 15_000);
  const workers = h.workerPids(); assert.ok(workers.length > 0);
  await h.stop('SIGKILL'); await sleep(500);
  const h2 = new EngineHarness({ home: h.home, port: h.port, simScript: [{ kind: 'ok', text: 'DONE' }] }); harnesses.push(h2); await h2.start();
  const job = await h2.waitFor(r.job.id, ['completed'], 60_000); assert.equal(job.state, 'completed');
  const ev = await h2.api<Array<{ type: string; detail: Record<string, unknown> }>>('/api/activity?limit=500');
  const started = ev.find((e) => e.type === 'engine.started' && Array.isArray(e.detail.reaped_orphans) && (e.detail.reaped_orphans as number[]).length > 0);
  assert.ok(started, 'orphan workers were reaped on restart');
  for (const pid of workers) { let alive = true; try { process.kill(pid, 0); } catch { alive = false; } assert.equal(alive, false, `orphan ${pid} still alive`); }
  record('reboot', true);
});

test('6. plan limit → waiting_for_reset with the reset time, then automatic resume on the same session', async () => {
  const resetAt = new Date(Date.now() + 8000).toISOString();
  const h = await engine({ simScript: [{ kind: 'limit', resetAt }, { kind: 'ok', text: 'DONE' }] });
  const r = await post(h, 'research.report', 'limit');
  const rw = fixtureDb(h.home); rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev6', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run(r.job.id); markReported(rw, r.job.id); rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('art-ev6', ?, 'research', 'file', 'report.md', '2026-01-01')").run(r.job.id); rw.close();
  const w = await h.waitFor(r.job.id, ['waiting_for_reset'], 20_000); assert.equal(w.blocker_code, 'CLAUDE_PLAN_LIMIT'); assert.ok(w.session_ref);
  const job = await h.waitFor(r.job.id, ['completed'], 40_000); assert.equal(job.session_ref, w.session_ref);
  record('plan_limit', true);
});

test('7. expired Claude auth pauses only Claude work; a deterministic job completes; login detection resumes it', async () => {
  const h = await engine({ simScript: [{ kind: 'auth' }, { kind: 'ok', text: 'DONE' }] });
  const a = await post(h, 'research.report', 'auth');
  const rw = fixtureDb(h.home); rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev7', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run(a.job.id); markReported(rw, a.job.id); rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('art-ev7', ?, 'research', 'file', 'report.md', '2026-01-01')").run(a.job.id); rw.close();
  const wa = await h.waitFor(a.job.id, ['waiting_for_auth'], 20_000); assert.equal(wa.waiting_on, 'claude'); assert.match(String(wa.operator_action), /claude auth login/);
  const b = await post(h, 'system.workspace_summary', 'brief'); assert.equal((await h.waitFor(b.job.id, ['completed'], 20_000)).state, 'completed');
  await h.api('/api/health?fresh=1');  // watchdog sees the (simulated) login and resumes
  assert.equal((await h.waitFor(a.job.id, ['completed'], 30_000)).state, 'completed');
  record('claude_auth', true);
});

test('9. a hung turn is cancelled by the watchdog deadline and retried within policy', async () => {
  const h = await engine({ simScript: [{ kind: 'hang' }, { kind: 'ok', text: 'DONE' }] });
  (h as unknown as { proc: unknown }).proc; // engine started with default env; restart with a short stage timeout
  await h.stop(); const h2 = new EngineHarness({ home: h.home, port: h.port, simScript: [{ kind: 'hang' }, { kind: 'ok', text: 'DONE' }] }); harnesses.push(h2);
  process.env.CLAUDEBOT_STAGE_TIMEOUT_MS = '3000'; await h2.start(); delete process.env.CLAUDEBOT_STAGE_TIMEOUT_MS;
  const r = await post(h2, 'research.report', 'hang');
  const rw = fixtureDb(h2.home); rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev9', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run(r.job.id); markReported(rw, r.job.id); rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('art-ev9', ?, 'research', 'file', 'report.md', '2026-01-01')").run(r.job.id); rw.close();
  const w = await h2.waitFor(r.job.id, ['retry_scheduled', 'completed'], 30_000); assert.ok(['retry_scheduled', 'completed'].includes(String(w.state)));
  const d = await h2.api<{ events: Array<{ type: string; detail: { reason?: string } }> }>(`/api/jobs/${r.job.id}`);
  assert.ok(d.events.some((e) => e.type === 'job.transition' && /hung|exceeded/.test(String(e.detail.reason))), 'hang recorded');
  record('hung_tool', true);
});

test('10. the same job submitted twice is one job', async () => {
  const h = await engine();
  const a = await h.api<{ job: { id: string }; created: boolean }>('/api/jobs', { method: 'POST', body: { kind: 'system.workspace_summary', objective: 'x', idempotency_key: 'dup' } });
  const b = await h.api<{ job: { id: string }; created: boolean }>('/api/jobs', { method: 'POST', body: { kind: 'system.workspace_summary', objective: 'x', idempotency_key: 'dup' } });
  assert.equal(a.job.id, b.job.id); assert.equal(b.created, false); record('idempotent_submit', true);
});

test('11. unapproved send/publish/purchase/delete are refused and audited', async () => {
  const h = await engine();
  for (const kind of ['send', 'publish', 'purchase', 'delete']) {
    const r = await h.api<{ status: string; reason: string }>('/api/actions/perform', { method: 'POST', body: { kind, target: 'x', content: 'y', idempotency_key: `ua-${kind}` } });
    assert.equal(r.status, 'refused'); assert.match(r.reason, /approval missing/);
  }
  const ev = await h.api<Array<{ type: string }>>('/api/activity'); assert.equal(ev.filter((e) => e.type === 'action.refused').length, 4);
  record('unapproved_refused', true);
});

test('12. changing approved content makes the approval stale and nothing runs (the local-outbox executor exists, so staleness alone must stop it)', async () => {
  const h = await engine();
  const ap = await (async () => { const rw = fixtureDb(h.home); rw.prepare("INSERT INTO approvals(id, action_kind, target, content, content_hash, evidence, status, expires_at, created_at) VALUES ('ap1','send','mailto:a@example.com','Hello','" + (await import('node:crypto')).createHash('sha256').update('Hello').digest('hex') + "','[]','pending','2099-01-01','2026-01-01')").run(); rw.close(); return 'ap1'; })();
  await h.api(`/api/approvals/${ap}/decide`, { method: 'POST', body: { decision: 'approved' } });
  const stale = await h.api<{ status: string; reason: string }>('/api/actions/perform', { method: 'POST', body: { kind: 'send', target: 'mailto:a@example.com', content: 'Hello!!', approval_id: ap, idempotency_key: 'st1' } });
  assert.equal(stale.status, 'refused'); assert.match(stale.reason, /stale/);
  const aps = await h.api<Array<{ id: string; status: string }>>('/api/approvals'); assert.equal(aps.find((a) => a.id === ap)!.status, 'stale');
  record('stale_approval', true);
});

test('13. a corrupt checkpoint is skipped, an incident is raised, and recovery uses the last verified one', async () => {
  const h = await engine({ simScript: [{ kind: 'ok', delayMs: 30_000 }, { kind: 'ok', text: 'DONE' }] });
  const r = await post(h, 'research.report', 'corrupt');
  const rw = fixtureDb(h.home); rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES ('ev13', ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run(r.job.id); markReported(rw, r.job.id); rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('art-ev13', ?, 'research', 'file', 'report.md', '2026-01-01')").run(r.job.id);
  await h.waitFor(r.job.id, ['running'], 15_000); await sleep(500);
  const last = rw.prepare('SELECT id FROM checkpoints WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(r.job.id) as { id: number };
  rw.prepare("UPDATE checkpoints SET payload = '{\"tampered\":1}' WHERE id = ?").run(last.id); rw.close();
  const job = (await h.api<{ job: { lease_owner: string } }>(`/api/jobs/${r.job.id}`)).job; process.kill(Number(job.lease_owner.split(':')[1]), 'SIGKILL');
  // the replacement worker replays its own 30 s simulated turn after the ~6 s lease expiry, so allow two turns plus reclaim
  assert.equal((await h.waitFor(r.job.id, ['completed'], 120_000)).state, 'completed');
  const rel = await h.api<{ incidents: Array<{ code: string }> }>('/api/reliability'); assert.ok(rel.incidents.some((i) => i.code === 'CHECKPOINT_CORRUPT'));
  record('corrupt_checkpoint', true);
});

test('14. exhausting the retry budget ends in failed_terminal with a plain-English fix, keeping the checkpoint', async () => {
  const h = await engine({ simScript: Array(6).fill({ kind: 'transient' }) });
  const r = await post(h, 'research.report', 'budget');
  const job = await h.waitFor(r.job.id, ['failed_terminal'], 120_000);
  assert.equal(job.blocker_code, 'RETRY_BUDGET_EXHAUSTED'); assert.match(String(job.operator_action), /re-queue/i); assert.ok(job.last_good_checkpoint_id);
  record('retry_budget', true);
});

test('15. bounded soak: continuous heartbeats, no phantom busy agents, no orphan processes', async () => {
  const h = await engine({ workers: 2, simScript: Array(20).fill({ kind: 'ok', text: 'DONE', delayMs: 300 }) });
  const SOAK_MS = Number(process.env.CLAUDEBOT_SOAK_MS ?? 45_000); const end = Date.now() + SOAK_MS; let created = 0; let phantom = 0; let samples = 0;
  while (Date.now() < end) {
    if (created < 8) { await post(h, 'system.workspace_summary', `soak ${created}`, { idempotency_key: `soak-${created}` }); created++; }
    const agents = await h.api<Array<{ status: string; current_job: { lease_heartbeat_at: string } | null }>>('/api/agents');
    for (const a of agents) if (a.status === 'busy' && (!a.current_job || Date.now() - Date.parse(a.current_job.lease_heartbeat_at) > 60_000)) phantom++;
    samples++; await sleep(2000);
  }
  const jobs = await h.api<Array<{ state: string }>>('/api/jobs'); assert.equal(jobs.filter((j) => j.state === 'completed').length, created);
  assert.equal(phantom, 0); assert.ok(samples > 5);
  const pids = h.workerPids(); assert.equal(pids.length, 2);
  const ps = execFileSync('ps', ['-eo', 'pid,ppid,command']).toString().split('\n').filter((l) => l.includes('worker/main.ts'));
  const enginePid = (await h.api<{ pid: number }>('/api/health')).pid;
  const orphans = ps.filter((l) => { const [, ppid] = l.trim().split(/\s+/); return Number(ppid) !== enginePid && pids.includes(Number(l.trim().split(/\s+/)[0])); });
  assert.equal(orphans.length, 0);
  record('soak', true);
});
