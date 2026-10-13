import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { ActionStore } from '../../src/actions/store.ts';
import { SimulatedRuntime, type SimScript } from '../../src/runtime/simulated.ts';
import { runJob, type RunDeps } from '../../src/worker/run.ts';
import { createLogger } from '../../src/log.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';

function deps(scripts: SimScript[] = [], extra: Partial<RunDeps> = {}) {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const actions = new ActionStore(db, approvals);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ros-'));
  const runtime = new SimulatedRuntime(scripts);
  const log = createLogger({ name: 't', stream: { write: () => true } as unknown as NodeJS.WritableStream });
  const d: RunDeps = { db, store, approvals, actions, runtime, log, workspacesDir: path.join(tmp, 'ws'), runDir: path.join(tmp, 'run'), owner: 'worker:test', leaseSeconds: 30, heartbeatSeconds: 1, ...extra };
  const defs = new Definitions(db); defs.seedSystemDefaults(); defs.installPack('revenue_ops', 'test');
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test workspace' }, 'test');
  return { ...d, tmp, runtime, defs, wsId: ws.id };
}
function leased(d: ReturnType<typeof deps>, kind: string, objective = 'o', role?: string) {
  const wf = d.defs.getWorkflow(kind)!;
  const { job } = d.store.create({ idempotency_key: `k-${kind}-${Math.random()}`, kind, objective, success_contract: wf.contract, agent_role: role ?? wf.default_agent, workspace_id: d.wsId });
  return d.store.lease({ owner: 'worker:test', leaseSeconds: 30 })!;
}
function addEvidence(d: ReturnType<typeof deps>, jobId: string, url: string | null) {
  d.db.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES (?,?,?,?,?,?,?)").run('ev-' + Math.random(), jobId, 't', 'b', url, 'B', new Date().toISOString());
  d.db.prepare("UPDATE jobs SET outcome = 'success' WHERE id = ?").run(jobId);   // research contracts now also require the assistant's own outcome report
  d.db.prepare("INSERT OR IGNORE INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES (?,?,?,?,?,?)").run('art-' + jobId, jobId, 'research', 'file', 'report.md', new Date().toISOString());
}

test('deterministic read-only job completes end to end with checkpoints before and after each stage', async () => {
  const d = deps(); const j = leased(d, 'system.workspace_summary');
  const out = await runJob(d, j.id);
  assert.equal(out, 'completed'); const job = d.store.get(j.id)!; assert.equal(job.state, 'completed');
  const cps = d.db.prepare('SELECT stage_name, phase FROM checkpoints WHERE job_id = ? ORDER BY id').all(j.id) as unknown as Array<{ stage_name: string; phase: string }>;
  assert.deepEqual(cps.map((c) => `${c.stage_name}/${c.phase}`), ['collect/before', 'collect/after', 'write_brief/before', 'write_brief/after']);
  assert.ok(fs.existsSync(path.join(d.workspacesDir, d.wsId, 'tasks', j.id, 'brief.md')));
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id = ? AND kind = 'note'").get(j.id)!.n, 1);
});

test('claude plan limit → waiting_for_reset with the session preserved; resume continues from the same stage and session', async () => {
  const d = deps([{ kind: 'limit', resetAt: '2026-10-06T23:00:00Z' }, { kind: 'ok', text: 'summary line\nDONE' }]);
  const j = leased(d, 'research.report');
  assert.equal(await runJob(d, j.id), 'paused');
  let job = d.store.get(j.id)!; assert.equal(job.state, 'waiting_for_reset'); assert.equal(job.reset_at, '2026-10-06T23:00:00.000Z'.replace('.000', '')); assert.equal(job.session_ref, 'sim-' + j.id);
  // promote and resume
  d.db.prepare("UPDATE jobs SET retry_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(j.id); d.store.promoteDue();
  addEvidence(d, j.id, 'https://example.com/a');
  d.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  assert.equal(await runJob(d, j.id), 'completed');
  job = d.store.get(j.id)!; assert.equal(job.state, 'completed');
  const calls = d.runtime.history; assert.equal(calls.length, 2); assert.equal(calls[1].resume, true); assert.equal(calls[1].sessionRef, 'sim-' + j.id);
  const before = d.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE job_id = ? AND stage_name = 'research' AND phase = 'before'").get(j.id)!.n; assert.equal(before, 2);
  assert.ok(d.store.events(j.id).some((e) => e.type === 'job.resumed'));
});

test('claude auth failure pauses only claude work; a deterministic job still completes', async () => {
  const d = deps([{ kind: 'auth' }]);
  const a = leased(d, 'research.report'); assert.equal(await runJob(d, a.id), 'paused');
  const ja = d.store.get(a.id)!; assert.equal(ja.state, 'waiting_for_auth'); assert.equal(ja.waiting_on, 'claude'); assert.match(ja.operator_action!, /claude auth login/);
  const b = leased(d, 'system.workspace_summary'); assert.equal(await runJob(d, b.id), 'completed');   // control
});

test('hung turn is cancelled by the abort signal and scheduled for retry; crash is retried too', async () => {
  const d = deps([{ kind: 'hang' }]); const j = leased(d, 'research.report');
  const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
  const out = await runJob(d, j.id, { signal: ac.signal });
  assert.equal(out, 'retry'); assert.equal(d.store.get(j.id)!.state, 'retry_scheduled');
  const d2 = deps([{ kind: 'crash' }]); const j2 = leased(d2, 'research.report');
  assert.equal(await runJob(d2, j2.id), 'retry'); assert.match(d2.store.get(j2.id)!.failure_detail!, /crashed/);
});

test('unsourced evidence fails verification terminally with a plain-English fix; sourced passes (control)', async () => {
  const d = deps([{ kind: 'ok', text: 'DONE' }]); const j = leased(d, 'research.report');
  d.runtime.push({ kind: 'ok' });
  // evidence gets added "by the agent" during the turn: emulate by adding before verify runs — add unsourced
  addEvidence(d, j.id, null);
  assert.equal(await runJob(d, j.id), 'failed'); const job = d.store.get(j.id)!; assert.equal(job.state, 'failed_terminal'); assert.match(job.operator_action!, /cite sources/);
  const d2 = deps([{ kind: 'ok', text: 'DONE' }]); const j2 = leased(d2, 'research.report'); addEvidence(d2, j2.id, 'https://example.com');
  assert.equal(await runJob(d2, j2.id), 'completed');
});

test('approval gate pauses the job; approval resumes it; the consequential action is still refused (no executor) and audited', async () => {
  const d = deps([{ kind: 'ok', text: 'DONE' }]); const j = leased(d, 'rev.account_outreach_draft'); addEvidence(d, j.id, 'https://example.com/x');
  const ap = d.approvals.request({ job_id: j.id, action_kind: 'send', target: 'mailto:a@example.com', content: 'Hello' });
  assert.equal(await runJob(d, j.id), 'paused'); let job = d.store.get(j.id)!; assert.equal(job.state, 'waiting_for_approval'); assert.equal(job.waiting_on, `approval:${ap.id}`);
  d.approvals.decide(ap.id, 'approved', 'owner'); d.store.transition(j.id, 'queued', 'owner'); d.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  assert.equal(await runJob(d, j.id), 'completed');
  const r = await d.actions.perform({ job_id: j.id, idempotency_key: `${j.id}:${ap.id}`, kind: 'send', target: 'mailto:a@example.com', content: 'Hello', approval_id: ap.id, actor: 'worker:test' });
  assert.equal(r.status, 'refused'); assert.ok(d.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'action.refused'").get(j.id));
});

test('browser login expired pauses only browser-dependent work with the site identity', async () => {
  const d = deps([], { browserCheck: async () => ({ signed_in: false, evidence: 'login page' }) });
  const { job } = d.store.create({ idempotency_key: 'b1', kind: 'browser.login_health', objective: 'check', success_contract: { requires_keys: ['signed_in'] }, agent_role: 'browser_operator', inputs: { site: 'linkedin.com' }, workspace_id: d.wsId });
  d.store.lease({ owner: 'worker:test', leaseSeconds: 30 });
  assert.equal(await runJob(d, job.id), 'paused'); const jb = d.store.get(job.id)!; assert.equal(jb.state, 'waiting_for_auth'); assert.equal(jb.waiting_on, 'browser:linkedin.com');
  assert.equal((d.db.prepare('SELECT signed_in FROM browser_sites WHERE site = ?').get('linkedin.com') as { signed_in: number }).signed_in, 0);
  const d2 = deps([], { browserCheck: async () => ({ signed_in: true, evidence: 'feed' }) });
  const { job: j2 } = d2.store.create({ idempotency_key: 'b2', kind: 'browser.login_health', objective: 'check', success_contract: { requires_keys: ['signed_in'] }, agent_role: 'browser_operator', inputs: { site: 'linkedin.com' }, workspace_id: d2.wsId });
  d2.store.lease({ owner: 'worker:test', leaseSeconds: 30 }); assert.equal(await runJob(d2, j2.id), 'completed');
});

test('resume after a corrupt latest checkpoint uses the previous verified one and records an incident', async () => {
  const d = deps([{ kind: 'ok', text: 'DONE' }]); const j = leased(d, 'research.report'); addEvidence(d, j.id, 'https://example.com');
  // run only the first stage by aborting after it: simulate by running then corrupting the last checkpoint and re-running
  assert.equal(await runJob(d, j.id), 'completed');
  const last = d.db.prepare('SELECT id FROM checkpoints WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(j.id) as { id: number };
  d.db.prepare("UPDATE checkpoints SET payload = '{\"tampered\":true}' WHERE id = ?").run(last.id);
  const cp = d.store.latestVerified(j.id)!; assert.notEqual(cp.id, last.id);
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE code = 'CHECKPOINT_CORRUPT'").get()!.n, 1);
});

test('watchdog never records a sign-out from a health report that merely lacks account metadata (seam: watchdog → worker gate)', async () => {
  const { Watchdog } = await import('../../src/supervisor/watchdog.ts');
  const { loadConfig } = await import('../../src/config.ts');
  const d = deps(); const cfg = loadConfig({ CLAUDEBOT_HOME: d.tmp, CLAUDEBOT_OPENCLAW_BIN: '/usr/bin/false' } as NodeJS.ProcessEnv);
  type RH = import('../../src/runtime/types.ts').RuntimeHealth;
  const rt = { id: 'claude-acp' as const, describe: () => ({ label: 'x', route: 'r', account: 'a' }), health: (async () => ({ id: 'claude-acp' as const, configured: true, ok: true, state: 'ready' as const, detail: 'ready without account object', observedAt: new Date().toISOString() })) as () => Promise<RH>, startTurn: async () => ({ ok: true as const, text: '', durationMs: 0 }), cancel: async () => {} };
  const w = new Watchdog(cfg, d.db, d.store, rt, d.log, () => 1);
  await w.check();
  const row = d.db.prepare("SELECT value FROM runtime_state WHERE key = 'claude.auth'").get() as { value: string }; assert.equal(JSON.parse(row.value).loggedIn, true);
  // control: an auth_required verdict is recorded as signed out
  rt.health = async () => ({ id: 'claude-acp' as const, configured: true, ok: false, state: 'auth_required' as const, detail: 'not logged in', observedAt: new Date().toISOString(), account: { loggedIn: false } });
  await w.check(); const row2 = d.db.prepare("SELECT value FROM runtime_state WHERE key = 'claude.auth'").get() as { value: string }; assert.equal(JSON.parse(row2.value).loggedIn, false);
});
