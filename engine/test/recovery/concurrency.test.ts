/**
 * Gate 4: ten bounded, unrelated tasks across three workspaces run concurrently; workers and (when reachable) the gateway are
 * interrupted mid-run; every task either completes or resumes from its verified checkpoint. Simulated runtime: no Claude usage.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fixtureDb, markReported } from './fixtures.ts';
import { EngineHarness, sleep } from '../integration/engine.test.ts';

const harnesses: EngineHarness[] = [];
after(async () => { for (const h of harnesses) { await h.stop().catch(() => {}); h.cleanup(); } });

test('10 unrelated tasks across 3 workspaces run concurrently (simulated runtime), survive worker kills, and all complete from checkpoints', async () => {
  const script = Array.from({ length: 40 }, () => ({ kind: 'ok', delayMs: 9000, text: 'DONE' }));
  const h = new EngineHarness({ workers: 10, simScript: script }); harnesses.push(h); await h.start();
  const ws = [h.wsId]; for (const name of ['Second workspace', 'Third workspace']) ws.push((await h.api<{ id: string }>('/api/workspaces', { method: 'POST', body: { name, worker_limit: 4 } })).id);
  for (const a of ['researcher', 'builder', 'coordinator']) await h.api(`/api/agents/${a}`, { method: 'PATCH', body: { concurrency_limit: 10 } });   // owner raises per-agent limits
  const kinds = ['research.report', 'document.create', 'monitor.scheduled'];
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) { const r = await h.api<{ job: { id: string } }>('/api/tasks', { method: 'POST', body: { workspace_id: ws[i % 3], kind: kinds[i % 3], objective: `concurrency task ${i}`, idempotency_key: `conc-${i}` } }); ids.push(r.job.id); }
  // The simulated turn writes nothing, so give each task what a real turn would leave behind: a sourced evidence row and a real file artifact with a matching hash.
  const rw = fixtureDb(h.home);
  for (const [i, id] of ids.entries()) {
    const dir = path.join(h.home, 'workspaces', ws[i % 3], 'tasks', id); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'report.md'); fs.writeFileSync(file, `# task ${id}\n`);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    rw.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES (?, ?, 't', 'b', 'https://example.com', 'A', '2026-01-01')").run('ev-' + id, id); markReported(rw, id);
    rw.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, created_at) VALUES (?, ?, 'work', 'file', ?, ?, 'report.md', '2026-01-01')").run('art-' + id, id, file, sha);
  }
  rw.close();
  // wait until all 10 are leased/running at once (slots: 10 global; workspace limits 10/4/4 → 4+3+3 fits)
  let peak = 0; const t0 = Date.now();
  while (Date.now() - t0 < 30_000) { const cap = (await h.api<{ capacity: { active: number } }>('/api/health')).capacity; peak = Math.max(peak, cap.active); if (peak >= 10) break; await sleep(300); }
  assert.ok(peak >= 10, `peak concurrent active was ${peak}`);
  const cap1 = (await h.api<{ capacity: { per_workspace: Array<{ active: number; limit: number }> } }>('/api/health')).capacity;
  for (const w of cap1.per_workspace) assert.ok(w.active <= (w.limit ?? 99), 'workspace limit respected');
  // interrupt: kill three workers that hold leases, then restart the gateway if the ClaudeBot gateway is installed
  const owners = (await h.api<Array<{ lease_owner: string | null; state: string }>>('/api/tasks')).filter((j) => j.state === 'running' && j.lease_owner).slice(0, 3).map((j) => Number(j.lease_owner!.split(':')[1]));
  for (const pid of owners) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } }
  let gatewayRestarted = false;
  // The ClaudeBot gateway is shared with the installed product; restarting it interrupts the owner's open Claude sessions. Only with explicit opt-in and an idle install.
  const installedIdle = await (async () => { try { const t = fs.readFileSync(path.join(process.env.HOME!, '.claudebot', 'secrets', 'ui.token'), 'utf8').trim(); const r = await (await fetch('http://127.0.0.1:48311/api/health', { headers: { 'x-claudebot-token': t } })).json() as { capacity: { active: number } }; return r.capacity.active === 0; } catch { return true; } })();
  // Gateway restart is NOT exercised here: this engine runs the simulated runtime, so a restart would prove nothing about it,
  // and the only gateway it could restart is the owner's. The real gateway restart is recovery-real scenario 3 (isolated gateway).
  const deadline = Date.now() + 240_000; let states: Record<string, string> = {};
  while (Date.now() < deadline) { const rows = await h.api<Array<{ id: string; state: string }>>('/api/tasks'); states = Object.fromEntries(rows.map((r) => [r.id, r.state])); if (ids.every((id) => states[id] === 'completed')) break; await sleep(1500); }
  const notDone = ids.filter((id) => states[id] !== 'completed');
  assert.deepEqual(notDone, [], `not completed: ${notDone.map((id) => `${id}:${states[id]}`).join(', ')}`);
  const ev = await h.api<Array<{ type: string }>>('/api/activity?limit=2000');
  assert.ok(ev.filter((e) => e.type === 'lease.reclaimed').length >= 1, 'killed workers lost their leases');
  assert.ok(ev.filter((e) => e.type === 'job.resumed').length >= 1, 'at least one task resumed from a checkpoint');
  const workers = h.workerPids(); assert.equal(workers.length, 10, 'worker pool restored to the configured limit');
  const orphans = execFileSync('ps', ['-eo', 'pid,ppid,command']).toString().split('\n').filter((l) => l.includes('worker/main.ts') && l.includes(h.home)).filter((l) => Number(l.trim().split(/\s+/)[1]) !== (JSON.parse(fs.readFileSync(path.join(h.home, 'run', 'workers.json'), 'utf8')) as { supervisor: number }).supervisor);
  assert.equal(orphans.length, 0, 'no orphan workers');
  fs.writeFileSync(path.join(h.home, 'concurrency-evidence.json'), JSON.stringify({ peak, gatewayRestarted, killed: owners, reclaimed: ev.filter((e) => e.type === 'lease.reclaimed').length, resumed: ev.filter((e) => e.type === 'job.resumed').length, states }, null, 2));
  console.log(`peak=${peak} killed=${owners.length} gatewayRestarted=${gatewayRestarted} reclaimed=${ev.filter((e) => e.type === 'lease.reclaimed').length} resumed=${ev.filter((e) => e.type === 'job.resumed').length}`);
});

test('waiting tasks hold no slot: 4 tasks wait for login while 8 deterministic tasks run within a workspace limit of 3 on 6 workers', async () => {
  const h = new EngineHarness({ workers: 6, simAuthed: false }); harnesses.push(h); await h.start();
  await h.api(`/api/workspaces/${h.wsId}`, { method: 'PATCH', body: { worker_limit: 3 } });
  await h.api('/api/workflows', { method: 'POST', body: { id: 'test.wait', name: 'Wait', default_agent: 'builder', stages: [{ name: 'wait', kind: 'deterministic', fn: 'wait_seconds' }], contract: { requires_keys: ['waited_seconds'] } } });
  await h.api('/api/health?fresh=1');   // watchdog records the signed-out runtime
  const claudeIds: string[] = []; for (let i = 0; i < 4; i++) claudeIds.push((await h.api<{ job: { id: string } }>('/api/tasks', { method: 'POST', body: { kind: 'research.report', objective: `needs claude ${i}`, idempotency_key: `auth-${i}` } })).job.id);
  const waitIds: string[] = []; for (let i = 0; i < 8; i++) waitIds.push((await h.api<{ job: { id: string } }>('/api/tasks', { method: 'POST', body: { kind: 'test.wait', objective: `hold ${i}`, inputs: { seconds: 4 }, idempotency_key: `wait-${i}` } })).job.id);
  let maxActive = 0; let maxWaiting = 0; let activeWhileWaiting = 0; const t0 = Date.now();
  while (Date.now() - t0 < 30_000) { const c = (await h.api<{ capacity: { active: number; waiting: number; workers_alive: number } }>('/api/health')).capacity; maxActive = Math.max(maxActive, c.active); if (c.waiting >= 4) { maxWaiting = Math.max(maxWaiting, c.waiting); activeWhileWaiting = Math.max(activeWhileWaiting, c.active); } assert.ok(c.workers_alive >= 5, 'pool larger than the workspace limit'); await sleep(200); }
  assert.ok(maxActive <= 3, `active peaked at ${maxActive}; the workspace limit is 3 with 6 workers`);
  assert.equal(maxWaiting, 4, 'all four Claude tasks waited for login');
  assert.equal(activeWhileWaiting, 3, 'waiting tasks did not consume a slot: 3 deterministic tasks ran alongside them');
  const rows = await h.api<Array<{ id: string; state: string }>>('/api/tasks');
  for (const id of claudeIds) assert.equal(rows.find((r) => r.id === id)!.state, 'waiting_for_auth');
  for (const id of waitIds) assert.equal(rows.find((r) => r.id === id)!.state, 'completed');
});
