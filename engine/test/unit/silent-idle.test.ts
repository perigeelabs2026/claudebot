// Silent-idle audit (Fable, 2026-10-14): every path that left the team idle with nothing surfaced now posts one line to the team group
// (owner-relevant ones also to Telegram, held in quiet hours). No model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { ClaudeAcpRuntime, classifyFailure, PROBE_COOLDOWN_MS } from '../../src/runtime/claude-acp.ts';
import { validateModel, advertised, startupModelCheck } from '../../src/runtime/model-check.ts';
import { failureStreaks, routineLines, governorLine, starvation, resetLapsed, approvalReminders, STREAK } from '../../src/cos/watch.ts';

function setup() {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const defs = new Definitions(db); defs.seedSystemDefaults();
  const ws = new Workspaces(db, fs.mkdtempSync(path.join(os.tmpdir(), 'si-'))).create({ name: 'Home' }, 't');
  const chat = new ChatStore(db, store); const team = chat.create({ workspace_id: ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const lines = () => chat.messages(team.id).filter((m) => (m.meta as { alert_key?: string }).alert_key);
  const job = (key: string, objective: string, agent = 'researcher', extra: Record<string, unknown> = {}) => store.create({ idempotency_key: key, kind: 'research.report', objective, success_contract: {}, agent_role: agent, workspace_id: ws.id, inputs: {}, ...extra } as never, 'owner').job;
  return { db, store, defs, ws, chat, team, lines, job };
}
const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

test('1: a refused model is its own failure class and never retried; a refused model is not requested again for an hour', async () => {
  const c = classifyFailure({ errorKind: 'MODEL_REFUSED', message: 'The model "claude-fable-5-1" was not accepted: ACP error: unknown model' });
  assert.deepEqual(c, { category: 'model_refused', retryable: false, resetAt: null });
  assert.equal(classifyFailure({ message: 'ACP error: unknown model claude-x' }).category, 'model_refused');
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; ensureModel: (k: string, m?: string, f?: string) => Promise<unknown> };
  const sent: string[] = []; rt.command = async (m) => { sent.push(m); return /claude-mystery-9/.test(m) ? 'ACP error: unknown model' : 'ok'; };
  await rt.ensureModel('s1', 'claude-mystery-9', 'claude-opus-5-5'); await rt.ensureModel('s1', 'claude-mystery-9', 'claude-opus-5-5');
  assert.equal(sent.filter((m) => m.includes('claude-mystery-9')).length, 1, 'the refused model is asked for once');
});

test('1: the model list is harvested from a refusal ("Available models: …"); a usage-only reply stays unverified; a startup probe makes the connection list them', async () => {
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; ensureModel: (k: string, m?: string, f?: string, role?: string) => Promise<unknown>; advertisedModels: (o?: { probe?: boolean }) => Promise<{ models: string[]; reply: string; at: string } | null> };
  const sent: string[] = [];
  rt.command = async (m) => { sent.push(m); return '⚠️ Usage: /acp model <model-id> [session-key|session-id|session-label]'; };
  assert.equal(await rt.advertisedModels(), null, 'no ACP session yet: unverified'); assert.equal(sent.length, 0, 'nothing is probed on the control session');
  assert.equal(await rt.advertisedModels({ sessionKey: 'agent:claude:acp:0a1b' } as never), null, 'a usage-only reply is unverified'); assert.equal(sent[0], '/acp model claudebot-model-probe agent:claude:acp:0a1b', 'the probe sets a known-bad model on a real ACP session');
  rt.command = async (m) => { sent.push(m); return /claude-mystery-9/.test(m) ? 'ACP error: model "claude-mystery-9" is not available. Available models: default, opus, fable, sonnet, haiku, …' : 'ok'; };
  await rt.ensureModel('s1', 'claude-mystery-9', 'claude-opus-5-5', 'researcher');
  const n = sent.length; const v = await rt.advertisedModels();
  assert.deepEqual(v?.models, ['default', 'opus', 'fable', 'sonnet', 'haiku'], 'harvested from the refusal'); assert.match(v!.at, /^\d{4}-/, 'with a timestamp'); assert.equal(sent.length, n, 'no probe once a list is known');
  const rt2 = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as typeof rt;
  rt2.command = async () => 'ACP error: unknown model claudebot-model-probe. Available models: default, opus, fable, sonnet, haiku';
  assert.deepEqual((await rt2.advertisedModels({ sessionKey: 'agent:claude:acp:9f' } as never))?.models, ['default', 'opus', 'fable', 'sonnet', 'haiku'], 'the startup probe harvests the list');
});

test('1: on save, a model the harvested list lacks is blocked in the connection\'s words; an unverified one passes with a note', async () => {
  const listed = { advertisedModels: async () => ({ models: ['default', 'opus', 'sonnet', 'haiku'], reply: 'Available models: default, opus, sonnet, haiku' }) };
  const v = await validateModel(listed, 'claude-fable-5-1'); assert.equal(v.ok, false); assert.match((v as { reason: string }).reason, /does not offer "claude-fable-5-1" \(it is sent as "fable"\)\. It says: Available models: default, opus, sonnet, haiku/);
  assert.deepEqual(await validateModel(listed, 'claude-opus-5-5'), { ok: true });
  assert.deepEqual(await advertised(null), { models: ['default', 'opus', 'sonnet', 'haiku'], reply: null, verified: false });
  const offline = await validateModel(null, 'claude-fable-5-1'); assert.equal(offline.ok, true); assert.match((offline as { note?: string }).note ?? '', /^Could not verify "claude-fable-5-1" yet/);
  assert.deepEqual(await validateModel(null, 'claude-sonnet-5-5'), { ok: true });
});

test('1: the startup check alerts only with a verified list; "could not verify" is recorded, never posted', async () => {
  const { startupModelCheck } = await import('../../src/runtime/model-check.ts');
  const s = setup(); s.defs.upsertAgent({ ...s.defs.getAgent('researcher')!, model: 'claude-fable-5-1' }, 'owner');
  const un = await startupModelCheck(s.db, s.store, null, (id) => s.defs.previousModel(id));
  assert.equal(un.verified, false); assert.equal(s.lines().length, 0, 'no group or Telegram line');
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE type = 'model.unverified'").get(), 'recorded in the event log');
  const ok = await startupModelCheck(s.db, s.store, { advertisedModels: async () => ({ models: ['default', 'opus', 'fable', 'sonnet', 'haiku'], reply: 'Available models: default, opus, fable, sonnet, haiku' }) }, (id) => s.defs.previousModel(id));
  assert.deepEqual(ok.problems, [], 'fable listed live: nothing to report'); assert.equal(s.lines().length, 0);
  await startupModelCheck(s.db, s.store, { advertisedModels: async () => ({ models: ['default', 'opus', 'sonnet', 'haiku'], reply: 'Available models: default, opus, sonnet, haiku' }) }, (id) => s.defs.previousModel(id));
  const l = s.lines(); assert.equal(l.length, 1); assert.match(l[0].content, /model "claude-fable-5-1" is not accepted by the Claude connection \(it says: Available models: default, opus, sonnet, haiku\)/);
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src/supervisor/main.ts'), 'utf8');
  assert.match(main, /runtime\.health\(\)[\s\S]{0,200}startupModelCheck\(/, 'the check waits for a healthy gateway');
});

test('1: three failures by one assistant in 30 minutes post once (group and owner) and pause its queue until a turn works', () => {
  const s = setup(); const t0 = Date.now();
  const flaky = s.job('flaky', 'One flaky task');
  for (let i = 0; i < 3; i++) s.store.event(flaky.id, 'w', 'job.transition', { from: 'running', to: 'retry_scheduled', reason: 'socket hang up' });
  assert.deepEqual(failureStreaks(s.db, s.store, t0), [], 'one task retrying three times is not a streak');
  s.store.transition(flaky.id, 'cancelled', 'owner');
  for (let i = 1; i <= STREAK.failures; i++) { const j = s.job(`f${i}`, `Apply ${i}`); s.store.transition(j.id, 'leased', 'w'); s.store.transition(j.id, 'running', 'w'); s.store.failRetryable(j.id, 'w', 'turn failed: model_refused'); }
  const waiting = s.job('next', 'Apply next');
  assert.deepEqual(failureStreaks(s.db, s.store, t0), ['researcher']);
  assert.deepEqual(failureStreaks(s.db, s.store, t0 + 1000), [], 'posted once per streak');
  const l = s.lines(); assert.equal(l.length, 1); assert.match(l[0].content, /Researcher failed 6 times in the last 30 minutes \(last: turn failed: model_refused\)\. Researcher's queue is paused/);
  assert.equal((l[0].meta as { owner_alert?: boolean }).owner_alert, true, 'the owner hears it too');
  assert.equal(s.store.lease({ owner: 'w9', leaseSeconds: 30 }), undefined, 'the paused assistant\'s queue does not start');
  const owner = s.store.create({ idempotency_key: 'owner-msg', kind: 'chat.turn', objective: 'Jude, what happened?', success_contract: {}, agent_role: 'researcher', workspace_id: s.ws.id, inputs: {} } as never, 'owner').job;
  assert.equal(s.store.lease({ owner: 'w9', leaseSeconds: 30 })?.id, owner.id, 'the owner\'s message still runs: a paused assistant never ignores the owner');
  s.db.prepare("DELETE FROM runtime_state WHERE key = 'agent.paused.researcher'").run();   // what a successful turn or a model change does
  assert.equal(s.store.lease({ owner: 'w9', leaseSeconds: 30 })?.id, waiting.id);
});

test('2: a routine with no conversation posts its failure and its result to the team group', () => {
  const s = setup(); routineLines(s.db, s.store, Date.now() - 1000);   // first tick sets the watermark
  const sched = s.job('r1', 'Check the job boards for new sales roles', 'researcher', { schedule_id: 'sch-1' });
  s.store.transition(sched.id, 'leased', 'w'); s.store.transition(sched.id, 'running', 'w'); s.store.failTerminal(sched.id, 'w', 'the board did not load', 'retry later');
  const ok = s.job('r2', 'Morning digest of saved searches', 'researcher', { schedule_id: 'sch-2' });
  s.store.transition(ok.id, 'leased', 'w'); s.store.transition(ok.id, 'running', 'w'); s.store.transition(ok.id, 'completed', 'w');
  assert.equal(routineLines(s.db, s.store, Date.now() + 1000), 2);
  const text = s.lines().map((m) => m.content).join('\n');
  assert.match(text, /could not finish the routine "Check the job boards for new sales roles": the board did not load/); assert.match(text, /finished the routine "Morning digest of saved searches"/);
  assert.equal(routineLines(s.db, s.store, Date.now() + 2000), 0, 'each once');
});

test('3: a task that keeps losing its worker is not re-leased forever: the third loss goes through the retry budget', () => {
  let t = Date.parse('2026-10-14T10:00:00Z'); const db = openDatabase(':memory:'); const store = new JobStore(db, () => new Date(t).toISOString());
  const { job } = store.create({ idempotency_key: 'crash', kind: 'k', objective: 'o', success_contract: {}, agent_role: 'researcher', inputs: {} } as never, 'owner');
  for (let i = 1; i <= 2; i++) { store.lease({ owner: `w${i}`, leaseSeconds: 30 }); t += 31_000; store.reclaimExpired(); assert.equal(store.get(job.id)!.state, 'queued', `loss ${i} re-queues`); }
  store.lease({ owner: 'w3', leaseSeconds: 30 }); t += 31_000; store.reclaimExpired();
  const j = store.get(job.id)!; assert.equal(j.state, 'retry_scheduled'); assert.equal(j.retry_count, 1); assert.match(j.failure_detail ?? '', /stopped 3 times \(crash loop\)/);
});

test('4: a governor pause posts one line with how many tasks wait, and one when work resumes', () => {
  const s = setup(); s.job('q1', 'Queued one'); s.job('q2', 'Queued two');
  assert.equal(governorLine(s.db, s.store), null, 'running normally: nothing');
  s.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('governor', ?, 't', 't')").run(JSON.stringify({ paused: true, level_pct: 8, floor_pct: 15 }));
  assert.equal(governorLine(s.db, s.store), 'memory'); assert.equal(governorLine(s.db, s.store), null, 'once per change');
  s.db.prepare("UPDATE runtime_state SET value = ? WHERE key = 'governor'").run(JSON.stringify({ paused: false }));
  assert.equal(governorLine(s.db, s.store), 'running');
  const text = s.lines().map((m) => m.content); assert.match(text[0], /New work is paused: this Mac is low on memory \(8% free, floor 15%\)\. 2 tasks wait/); assert.match(text[1], /running normally again/);
});

test('5: a task queued 20 minutes while every worker is busy is surfaced with what it waits behind', () => {
  const s = setup(); const now = Date.now();
  for (let i = 1; i <= 3; i++) { const j = s.job(`b${i}`, `Long browser task ${i}`); s.store.lease({ owner: `w${i}`, leaseSeconds: 3600 }); void j; }
  const late = s.job('late', 'Reply to the recruiter'); s.db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(new Date(now - 25 * 60_000).toISOString(), late.id);
  assert.equal(starvation(s.db, s.store, 4, now), null, 'a free worker: not starved');
  assert.equal(starvation(s.db, s.store, 3, now), late.id);
  assert.match(s.lines()[0].content, /1 task has waited over 20 minutes for a free worker \(oldest: Researcher, "Reply to the recruiter"\)\. All 3 workers are busy with: Researcher, "Long browser task 1"/);
});

test('6: a plan limit with no reset time escalates to the owner once after two hours', () => {
  const s = setup(); const j = s.job('lim', 'Apply to Globex'); s.store.transition(j.id, 'leased', 'w'); s.store.transition(j.id, 'running', 'w'); s.store.waitForReset(j.id, 'w', null, {});
  assert.equal(resetLapsed(s.db, s.store, Date.now()), 0, 'not yet');
  assert.equal(resetLapsed(s.db, s.store, Date.now() + 2 * 3600_000 + 60_000), 1); resetLapsed(s.db, s.store, Date.now() + 3 * 3600_000);
  const l = s.lines(); assert.equal(l.length, 1); assert.match(l[0].content, /plan limit for over two hours with no reset time/); assert.equal((l[0].meta as { owner_alert?: boolean }).owner_alert, true);
});

test('7: a decision unanswered for two hours is re-asked once (held to the daytime by quiet hours)', () => {
  const s = setup(); const j = s.job('ap', 'Email Pat'); const ap = new ApprovalStore(s.db).request({ job_id: j.id, action_kind: 'send', target: 'email to Pat Rivera at Globex', content: 'Hi Pat' });
  assert.equal(approvalReminders(s.db, s.store, Date.now()), 0);
  assert.equal(approvalReminders(s.db, s.store, Date.now() + 2 * 3600_000 + 1000), 1); assert.equal(approvalReminders(s.db, s.store, Date.now() + 3 * 3600_000), 0, 'once');
  assert.match(s.lines()[0].content, /Still waiting on you: Researcher wants to send email to Pat Rivera at Globex\. Open ClaudeBot to allow or deny it\./); void ap;
});

test('1 (upstream 44e8009): a model refused at turn time ("did not advertise that model") runs once more on the fallback, is recorded, and the team and owner are told', async () => {
  const { withModelFallback } = await import('../../src/worker/run.ts');
  const s = setup(); const job = s.job('k', 'x');
  const tried: Array<string | undefined> = [];
  const r = await withModelFallback({ db: s.db, store: s.store } as never, job.id, { id: 'researcher', name: 'Jude (Job Applicator)' }, 'claude-fable-5-1', 'claude-opus-5-5', async (m) => { tried.push(m); return m === 'claude-fable-5-1' ? { ok: false, category: 'internal', message: 'The model "claude-fable-5-1" was not accepted: the ACP agent did not advertise that model', retryable: true } as never : { ok: true, text: 'done', durationMs: 1 }; });
  assert.equal(r.ok, true); assert.deepEqual(tried, ['claude-fable-5-1', 'claude-opus-5-5']); assert.deepEqual((r as { modelFallback?: unknown }).modelFallback, { requested: 'claude-fable-5-1', used: 'claude-opus-5-5', reason: 'the ACP agent did not advertise that model' });
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'model.refused'").get(job.id));
  const l = s.lines(); assert.equal(l.length, 1); assert.match(l[0].content, /^Jude's model "claude-fable-5-1" is not accepted by the Claude connection \(the ACP agent did not advertise that model\)\. Jude is running on claude-opus-5-5 instead/); assert.equal((l[0].meta as { owner_alert?: boolean }).owner_alert, true);
  const other = await withModelFallback({ db: s.db, store: s.store } as never, job.id, undefined, 'claude-opus-5-5', 'claude-sonnet-5-5', async () => ({ ok: false, category: 'transient', message: 'socket hang up', retryable: true }) as never);
  assert.equal(other.ok, false, 'other failures are not retried here');
});

test('1: engine-restart cancellations never count toward a failure streak', () => {
  const s = setup();
  for (let i = 0; i < 3; i++) { const j = s.job(`r${i}`, 'x'); s.store.event(j.id, 'worker', 'job.transition', { from: 'running', to: 'retry_scheduled', reason: 'cancelled: interrupted by an engine shutdown or restart' }); }
  assert.deepEqual(failureStreaks(s.db, s.store), []);
});

test('5b: a task held by its own assistant or project limit while workers are free is surfaced (Jude at 1 behind a long browser task)', () => {
  const s = setup(); const now = Date.now(); s.db.prepare('UPDATE agent_definitions SET concurrency_limit = 1 WHERE id = ?').run('researcher');
  s.job('long', 'Fill the Workday application'); s.store.lease({ owner: 'w1', leaseSeconds: 3600 });
  const late = s.job('late', 'Apply to Globex'); s.db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(new Date(now - 25 * 60_000).toISOString(), late.id);
  assert.equal(starvation(s.db, s.store, 3, now), late.id);
  assert.match(s.lines()[0].content, /"Apply to Globex" has waited over 20 minutes while workers are free: Researcher runs 1 task at a time and is busy with "Fill the Workday application"/);
});

test('1: the refusal cache is per assistant and model: a new session of the same assistant does not ask again', async () => {
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; ensureModel: (k: string, m?: string, f?: string, role?: string) => Promise<unknown> };
  const sent: string[] = []; rt.command = async (m) => { sent.push(m); return /claude-mystery-9/.test(m) ? 'ACP error: unknown model' : 'ok'; };
  await rt.ensureModel('s1', 'claude-mystery-9', 'claude-opus-5-5', 'researcher'); await rt.ensureModel('s2', 'claude-mystery-9', 'claude-opus-5-5', 'researcher');
  assert.equal(sent.filter((m) => m.includes('claude-mystery-9')).length, 1);
  await rt.ensureModel('s3', 'claude-mystery-9', 'claude-opus-5-5', 'builder'); assert.equal(sent.filter((m) => m.includes('claude-mystery-9')).length, 2, 'another assistant asks for itself');
});

test('1: the harvested list expires after an hour, and a save naming a model the cached list lacks probes again before refusing', async () => {
  const { MODEL_LIST_TTL_MS } = await import('../../src/runtime/claude-acp.ts');
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; advertisedModels: (o?: { probe?: boolean; fresh?: boolean }) => Promise<{ models: string[]; at: string } | null>; verified: { models: string[]; reply: string; at: string } | null };
  let list = 'default, opus, sonnet, haiku'; let probes = 0;
  rt.command = async () => { probes++; return `ACP error: unknown model. Available models: ${list}`; };
  const k = { sessionKey: 'agent:claude:acp:1234' } as never;
  assert.deepEqual((await rt.advertisedModels(k))?.models, ['default', 'opus', 'sonnet', 'haiku']); await rt.advertisedModels(k); assert.equal(probes, 1, 'cached while young');
  rt.verified!.at = new Date(Date.now() - MODEL_LIST_TTL_MS - 1000).toISOString(); list = 'default, opus, fable, sonnet, haiku';
  assert.deepEqual((await rt.advertisedModels(k))?.models, ['default', 'opus', 'fable', 'sonnet', 'haiku'], 'an hour-old list is probed again'); assert.equal(probes, 2);
  rt.command = async () => { probes++; return 'Usage: /acp model <model-id>'; }; rt.verified!.at = new Date(0).toISOString();
  assert.ok((await rt.advertisedModels(k))?.models.includes('fable'), 'a probe that lists nothing keeps the older list');
  // Save: the cached list lacks fable; a fresh probe lists it, so the save passes; when the fresh probe still lacks it, it is refused.
  const calls: Array<boolean> = []; let fresh = ['default', 'opus', 'fable', 'sonnet', 'haiku'];
  const gw = { advertisedModels: async (o?: { fresh?: boolean }) => { calls.push(!!o?.fresh); return o?.fresh ? { models: fresh, reply: `Available models: ${fresh.join(', ')}` } : { models: ['default', 'opus', 'sonnet', 'haiku'], reply: 'Available models: default, opus, sonnet, haiku' }; } };
  assert.deepEqual(await validateModel(gw, 'claude-fable-5-1'), { ok: true }); assert.deepEqual(calls, [false, true]);
  fresh = ['default', 'opus', 'sonnet', 'haiku']; const v = await validateModel(gw, 'claude-fable-5-1'); assert.equal(v.ok, false, 'refused only when the fresh probe still lacks it');
});

test('1: the model probe runs on the most recent real ACP session from the jobs table, never the control session; a session error is unverified', async () => {
  const { setupBroker } = await import('./helpers-broker.ts');
  const { latestAcpSession } = await import('../../src/runtime/model-check.ts');
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id }); const t = s.chat.send(c.id, 'hi', s.defs).job;
  assert.equal(latestAcpSession(s.db), null, 'no ACP session yet');
  s.db.prepare("UPDATE jobs SET session_ref = 'agent:control:main', updated_at = '2026-10-14T10:00:00Z' WHERE id = ?").run(t.id);
  assert.equal(latestAcpSession(s.db), null, 'the control session is not an ACP session');
  s.db.prepare("UPDATE jobs SET session_ref = 'agent:claude:acp:00aa11bb', updated_at = '2026-10-14T11:00:00Z' WHERE id = ?").run(t.id);
  assert.equal(latestAcpSession(s.db), 'agent:claude:acp:00aa11bb');
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; advertisedModels: (o?: unknown) => Promise<{ models: string[]; reply: string } | null>; lastEmptyProbe: number; probedSessions: Set<string> };
  const sent: string[] = []; rt.command = async (m) => { sent.push(m); throw new Error('ACP session not found: agent:claude:acp:00aa11bb'); };
  const v = await advertised(rt, { db: s.db }); assert.equal(v.verified, false, 'a session error is unverified, not a refusal'); assert.deepEqual(sent, ['/acp model claudebot-model-probe agent:claude:acp:00aa11bb']);
  rt.command = async (m) => { sent.push(m); return 'ACP error: unknown model claudebot-model-probe. Available models: default, opus, fable, sonnet, haiku'; };
  rt.lastEmptyProbe = 0; rt.probedSessions.clear();
  const v2 = await advertised(rt, { db: s.db }); assert.equal(v2.verified, true); assert.ok(v2.models.includes('fable'));
  assert.ok(sent.every((m) => !/agent:control:main/.test(m)), 'never probed on the control session');
  const r = await startupModelCheck(s.db, s.store, rt as never, (id) => s.defs.previousModel(id)); assert.equal(r.verified, true);
});

test('1: with no ACP session at startup nothing is probed, and the first assistant turn harvests the list', async () => {
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; advertisedModels: (o?: unknown) => Promise<{ models: string[]; reply: string } | null>; probeOn: (k: string) => Promise<boolean>; ensureSession: () => Promise<string>; ensureTimeout: () => Promise<void>; verified: unknown };
  const sent: string[] = []; rt.command = async (m) => { sent.push(m); return /claudebot-model-probe/.test(m) ? 'ACP error: unknown model. Available models: default, opus, fable, sonnet, haiku' : 'ok'; };
  assert.equal(await rt.advertisedModels(), null); assert.equal(sent.length, 0, 'no session: no probe');
  // The first turn: the runtime probes on the session it just spawned, before setting the assistant's model.
  rt.ensureSession = async () => 'agent:claude:acp:abcd'; rt.ensureTimeout = async () => {};
  const gw = { connect: async () => {}, onEvent: () => () => {}, call: async () => { throw new Error('stop here'); } };
  (rt as unknown as { o: { gateway: unknown } }).o.gateway = gw;
  await (rt as unknown as { startTurn: (r: unknown) => Promise<unknown> }).startTurn({ jobId: 'j1', sessionRef: '', prompt: 'hi', cwd: '/tmp', timeoutMs: 60_000, model: 'claude-opus-5-5', role: 'researcher' }).catch(() => {});
  assert.equal(sent[0], '/acp model claudebot-model-probe agent:claude:acp:abcd', 'the first turn probes on its own ACP session');
  assert.ok((await rt.advertisedModels())?.models.includes('fable'), 'the list is known after the first turn'); const n = sent.length;
  await (rt as unknown as { startTurn: (r: unknown) => Promise<unknown> }).startTurn({ jobId: 'j2', sessionRef: '', prompt: 'hi', cwd: '/tmp', timeoutMs: 60_000, model: 'claude-opus-5-5', role: 'researcher' }).catch(() => {});
  assert.equal(sent.slice(n).filter((m) => /claudebot-model-probe/.test(m)).length, 0, 'later turns do not probe again');
});

type ProbeRt = { command: (m: string) => Promise<string>; advertisedModels: (o?: unknown) => Promise<{ models: string[]; reply: string } | null>; probeOn: (k: string, cur?: string) => Promise<string>; ensureModel: (k: string, m?: string) => Promise<unknown>; roleModels: Record<string, string>; models: Map<string, string>; lastEmptyProbe: number; probedSessions: Set<string> };
const probeRt = () => new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as ProbeRt;

test('1 (Fable d160a2c): while the list is unverified each session is probed once, and a probe that lists nothing starts a 10-minute cooldown for every path', async () => {
  const rt = probeRt(); const sent: string[] = []; rt.command = async (m) => { sent.push(m); return 'Usage: /acp model <model-id>'; };
  await rt.advertisedModels({ sessionKey: 'agent:claude:acp:aa' }); assert.equal(sent.length, 1);
  await rt.advertisedModels({ sessionKey: 'agent:claude:acp:aa' }); await rt.advertisedModels({ sessionKeys: ['agent:claude:acp:bb'] }); await rt.probeOn('agent:claude:acp:bb', 'agent:claude:acp:bb');
  assert.equal(sent.length, 1, 'no probe of any session during the cooldown (advertisedModels, saves, startup and turns alike)');
  rt.lastEmptyProbe = Date.now() - PROBE_COOLDOWN_MS - 1;
  await rt.advertisedModels({ sessionKey: 'agent:claude:acp:aa' }); assert.equal(sent.length, 1, 'a session already probed is not asked again');
  await rt.advertisedModels({ sessionKey: 'agent:claude:acp:bb' }); assert.equal(sent.length, 2, 'a new session after the cooldown is');
  assert.equal(PROBE_COOLDOWN_MS, 600_000);
});

test('1 (Fable d160a2c): a probe the gateway accepts is undone: the session model is forgotten and, on another assistant\'s session, set back', async () => {
  const rt = probeRt(); const sent: string[] = []; rt.command = async (m) => { sent.push(m); return 'Model set to claudebot-model-probe.'; };
  rt.models.set('agent:claude:acp:aa', 'claude-opus-5-5');
  assert.equal(await rt.probeOn('agent:claude:acp:aa'), 'empty');
  assert.deepEqual(sent, ['/acp model claudebot-model-probe agent:claude:acp:aa', '/acp model opus agent:claude:acp:aa'], 'the previous model is re-sent');
  assert.equal(rt.models.get('agent:claude:acp:aa'), 'claude-opus-5-5', 'and recorded again once accepted');
  // The turn's own session: forgotten, not restored here (ensureModel sets its model right after).
  const rt2 = probeRt(); const sent2: string[] = []; rt2.command = async (m) => { sent2.push(m); return 'ok'; }; rt2.models.set('agent:claude:acp:bb', 'claude-sonnet-5-5');
  await rt2.probeOn('agent:claude:acp:bb', 'agent:claude:acp:bb'); assert.equal(sent2.length, 1); assert.equal(rt2.models.has('agent:claude:acp:bb'), false, 'so the turn sets the model again');
  // A refusal changes nothing.
  const rt3 = probeRt(); const sent3: string[] = []; rt3.command = async (m) => { sent3.push(m); return 'ACP error: unknown model'; }; rt3.models.set('agent:claude:acp:cc', 'claude-opus-5-5');
  await rt3.probeOn('agent:claude:acp:cc'); assert.equal(sent3.length, 1); assert.equal(rt3.models.get('agent:claude:acp:cc'), 'claude-opus-5-5');
});

test('1 (Fable d160a2c): the last few distinct ACP sessions are tried in order until one lists', async () => {
  const { setupBroker } = await import('./helpers-broker.ts');
  const { latestAcpSessions } = await import('../../src/runtime/model-check.ts');
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id });
  const keys = ['agent:claude:acp:01', 'agent:claude:acp:01', 'agent:claude:acp:02', 'agent:claude:acp:03'];
  keys.forEach((k, i) => { const t = s.chat.send(c.id, `m${i}`, s.defs).job; s.db.prepare('UPDATE jobs SET session_ref = ?, updated_at = ? WHERE id = ?').run(k, `2026-10-14T1${i}:00:00Z`, t.id); });
  assert.deepEqual(latestAcpSessions(s.db), ['agent:claude:acp:03', 'agent:claude:acp:02', 'agent:claude:acp:01'], 'newest first, distinct');
  const rt = probeRt(); const sent: string[] = [];
  rt.command = async (m) => { sent.push(m); if (/acp:03/.test(m)) throw new Error('ACP session not found'); return 'ACP error: unknown model. Available models: default, opus, fable, sonnet, haiku'; };
  const v = await advertised(rt, { db: s.db }); assert.equal(v.verified, true, 'the next candidate lists');
  assert.deepEqual(sent, ['/acp model claudebot-model-probe agent:claude:acp:03', '/acp model claudebot-model-probe agent:claude:acp:02'], 'the broken newest one errors, the next is tried, and the walk stops at the first list');
});

test('1 (Fable 40ac417): after a restart an accepted probe is undone with the model of the assistant whose job ran in that session (jobs.agent_role), never from the key segment, which is the same for every assistant', async () => {
  const { setupBroker } = await import('./helpers-broker.ts');
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id });
  s.db.prepare("UPDATE agent_definitions SET model = 'claude-opus-5-5' WHERE id = 'researcher'").run();
  s.db.prepare("UPDATE agent_definitions SET model = 'claude-haiku-5-5' WHERE id = 'coordinator'").run();
  const jobs: Array<[string, string, string]> = [['agent:claude:acp:7f3c2a10-0001', 'researcher', '2026-10-14T12:00:00Z'], ['agent:claude:acp:7f3c2a10-0002', 'coordinator', '2026-10-14T11:00:00Z']];
  for (const [k, role, at] of jobs) { const t = s.chat.send(c.id, `m ${k}`, s.defs).job; s.db.prepare('UPDATE jobs SET session_ref = ?, agent_role = ?, updated_at = ? WHERE id = ?').run(k, role, at, t.id); }
  const rt = probeRt(); const sent: string[] = []; rt.command = async (m) => { sent.push(m); return /claudebot-model-probe/.test(m) ? 'Model set.' : 'ok'; };
  await advertised(rt, { db: s.db });
  assert.deepEqual(sent.slice(0, 2), ['/acp model claudebot-model-probe agent:claude:acp:7f3c2a10-0001', '/acp model opus agent:claude:acp:7f3c2a10-0001'], 'the researcher (Jude-like, on Opus) gets Opus back, not default');
  assert.equal(sent[3], '/acp model haiku agent:claude:acp:7f3c2a10-0002', 'the lead\'s session gets the lead\'s model');
  // No job for the session and nothing in memory: default.
  const rt2 = probeRt(); const sent2: string[] = []; rt2.command = async (m) => { sent2.push(m); return /claudebot-model-probe/.test(m) ? 'Model set.' : 'ok'; };
  await rt2.probeOn('agent:claude:acp:7f3c2a10-0009'); assert.equal(sent2[1], '/acp model default agent:claude:acp:7f3c2a10-0009', 'nothing known: default');
  // The turn's own session took the probe; the turn names no model: ensureModel resets it from the turn's own assistant, once.
  const rt3 = probeRt(); const sent3: string[] = []; rt3.command = async (m) => { sent3.push(m); return /claudebot-model-probe/.test(m) ? 'Model set.' : 'ok'; }; rt3.roleModels = { builder: 'claude-sonnet-5-5' };
  const ens = rt3.ensureModel as unknown as (k: string, m?: string, f?: string, role?: string) => Promise<unknown>;
  await rt3.probeOn('agent:claude:acp:7f3c2a10-0003', 'agent:claude:acp:7f3c2a10-0003'); assert.equal(sent3.length, 1, 'the turn\'s own session is reset by ensureModel, not here');
  await ens.call(rt3, 'agent:claude:acp:7f3c2a10-0003', undefined, undefined, 'builder'); assert.equal(sent3[1], '/acp model sonnet agent:claude:acp:7f3c2a10-0003');
  await ens.call(rt3, 'agent:claude:acp:7f3c2a10-0003', undefined, undefined, 'builder'); assert.equal(sent3.length, 2, 'reset once');
});

test('1 (Fable 40ac417): the restore after an accepted probe runs inside the walk deadline', async () => {
  const rt = probeRt(); const budgets: number[] = [];
  (rt as unknown as { command: (m: string, t: number) => Promise<string> }).command = async (m, t) => { budgets.push(t); if (/claudebot-model-probe/.test(m)) { await new Promise((r) => setTimeout(r, 300)); return 'Model set.'; } return 'ok'; };
  rt.models.set('agent:claude:acp:7f3c2a10-0004', 'claude-opus-5-5');
  await rt.advertisedModels({ sessionKeys: ['agent:claude:acp:7f3c2a10-0004'], budgetMs: 2000 });
  assert.equal(budgets.length, 2); assert.ok(budgets[0] <= 2000 && budgets[1] <= 2000 - 250, `the restore gets only what is left (${budgets})`);
});

test('1 (Fable f6ef346): a timeout ends the walk, a missing session moves on, the walk is capped at about 20 s, and no second walk follows a timed-out one', async () => {
  const { PROBE_WALK_MS } = await import('../../src/runtime/claude-acp.ts'); assert.equal(PROBE_WALK_MS, 20_000);
  const rt = probeRt(); const sent: string[] = []; const budgets: number[] = [];
  (rt as unknown as { command: (m: string, t: number) => Promise<string> }).command = async (m, t) => { sent.push(m); budgets.push(t);
    if (/acp:01/.test(m)) throw new Error('ACP session not found: agent:claude:acp:01'); if (/acp:02/.test(m)) throw new Error('OpenClaw control request timed out after 20000 ms'); return 'ACP error. Available models: default, opus'; };
  await rt.advertisedModels({ sessionKeys: ['agent:claude:acp:01', 'agent:claude:acp:02', 'agent:claude:acp:03'] });
  assert.deepEqual(sent.map((m) => m.split(' ').pop()), ['agent:claude:acp:01', 'agent:claude:acp:02'], 'not-found continues; the timeout ends the walk');
  assert.ok(budgets.every((b) => b <= 20_000) && budgets[0] <= 20_000);
  await rt.advertisedModels({ fresh: true, sessionKeys: ['agent:claude:acp:03'] }); assert.equal(sent.length, 2, 'no second walk after a timed-out one');
  // The total cap: each probe gets only what is left of the walk budget, and the walk stops when under a second remains.
  const rt2 = probeRt(); const b2: number[] = [];
  (rt2 as unknown as { command: (m: string, t: number) => Promise<string> }).command = async (_m, t) => { b2.push(t); await new Promise((r) => setTimeout(r, 400)); throw new Error('ACP session not found'); };
  const t0 = Date.now(); await rt2.advertisedModels({ sessionKeys: ['agent:claude:acp:1', 'agent:claude:acp:2', 'agent:claude:acp:3', 'agent:claude:acp:4', 'agent:claude:acp:5'], budgetMs: 1800 });
  assert.ok(Date.now() - t0 < 1800, 'the walk ends inside its budget'); assert.ok(b2.length < 5 && b2[1] < b2[0], 'later probes get only the remaining budget');
});

test('1 (Fable f6ef346): an empty, non-error reply to the probe counts as accepted, so the session model is put back', async () => {
  const rt = probeRt(); const sent: string[] = []; rt.command = async (m) => { sent.push(m); return /claudebot-model-probe/.test(m) ? '' : 'ok'; };
  rt.models.set('agent:claude:acp:aa', 'claude-opus-5-5');
  assert.equal(await rt.probeOn('agent:claude:acp:aa'), 'empty'); assert.equal(sent[1], '/acp model opus agent:claude:acp:aa');
});

test('1 (live Mac): an idle or closed session ("Unable to resolve session target") is passed over, not taken as an accepted probe; sessionModels maps keys to their assistant\'s model', async () => {
  const rt = probeRt(); const sent: string[] = [];
  rt.command = async (m) => { sent.push(m); return /7f3c2a10-0005/.test(m) ? '⚠️ Unable to resolve session target: agent:claude:acp:7f3c2a10-0005' : 'ACP error: unknown model. Available models: default, opus, sonnet, haiku'; };
  rt.models.set('agent:claude:acp:7f3c2a10-0005', 'claude-opus-5-5');
  const v = await rt.advertisedModels({ sessionKeys: ['agent:claude:acp:7f3c2a10-0005', 'agent:claude:acp:7f3c2a10-0006'] });
  assert.deepEqual(sent.map((m) => m.split(' ').slice(2).join(' ')), ['claudebot-model-probe agent:claude:acp:7f3c2a10-0005', 'claudebot-model-probe agent:claude:acp:7f3c2a10-0006'], 'no restore was sent to the gone session; the walk moved on');
  assert.ok(v?.models.includes('opus')); assert.equal(rt.models.get('agent:claude:acp:7f3c2a10-0005'), 'claude-opus-5-5', 'nothing forgotten');
  const { setupBroker } = await import('./helpers-broker.ts'); const { sessionModels } = await import('../../src/runtime/model-check.ts');
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id }); s.db.prepare("UPDATE agent_definitions SET model = 'claude-opus-5-5' WHERE id = 'researcher'").run();
  const t = s.chat.send(c.id, 'x', s.defs).job; s.db.prepare("UPDATE jobs SET session_ref = 'agent:claude:acp:7f3c2a10-0007', agent_role = 'researcher' WHERE id = ?").run(t.id);
  assert.deepEqual(sessionModels(s.db, ['agent:claude:acp:7f3c2a10-0007', 'agent:claude:acp:7f3c2a10-0008']), { 'agent:claude:acp:7f3c2a10-0007': 'claude-opus-5-5' });
});
