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
import { ClaudeAcpRuntime, classifyFailure } from '../../src/runtime/claude-acp.ts';
import { validateModel, checkModelAliases, advertised } from '../../src/runtime/model-check.ts';
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

test('1: a model is checked against the connection\'s own list, at startup and on save, and refused in its own words', async () => {
  const gw = { advertisedModels: async () => ({ models: ['default', 'opus', 'sonnet', 'haiku'], reply: 'Available models: default, opus, sonnet, haiku' }) };
  const v = await validateModel(gw, 'claude-fable-5-1'); assert.equal(v.ok, false); assert.match((v as { reason: string }).reason, /does not offer "claude-fable-5-1" \(it is sent as "fable"\)\. It says: Available models: default, opus, sonnet, haiku/);
  assert.deepEqual(await validateModel(gw, 'claude-opus-5-5'), { ok: true });
  assert.deepEqual((await advertised(null)).models, ['default', 'opus', 'fable', 'sonnet', 'haiku'], 'no list from the connection: the verified fallback list');
  const s = setup(); s.defs.upsertAgent({ ...s.defs.getAgent('researcher')!, model: 'claude-fable-5-1' }, 'owner');
  const probs = checkModelAliases(s.db, (id) => s.defs.previousModel(id), (await advertised(gw)).models);
  assert.deepEqual(probs.map((p) => [p.agent, p.model]), [['researcher', 'claude-fable-5-1']], 'this morning\'s alias would have been caught at startup');
  // The connection's runtime asks with `/acp model` and reads the names it lists.
  const rt = new ClaudeAcpRuntime({ gateway: {} as never, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' }) as unknown as { command: (m: string) => Promise<string>; advertisedModels: () => Promise<unknown> };
  rt.command = async (m) => (m === '/acp model' ? 'Current model: default. Available: default, opus, fable, sonnet, haiku' : '');
  assert.deepEqual(rt.advertisedModels && (await rt.advertisedModels() as { models: string[] }).models, ['default', 'opus', 'fable', 'sonnet', 'haiku']);
  rt.command = async () => 'Usage: /acp model <id> <session>'; assert.equal(await rt.advertisedModels(), null);
});

test('1: three failures by one assistant in 30 minutes post once (group and owner) and pause its queue until a turn works', () => {
  const s = setup(); const t0 = Date.now();
  for (let i = 1; i <= STREAK.failures; i++) { const j = s.job(`f${i}`, `Apply ${i}`); s.store.transition(j.id, 'leased', 'w'); s.store.transition(j.id, 'running', 'w'); s.store.failRetryable(j.id, 'w', 'turn failed: model_refused'); }
  const waiting = s.job('next', 'Apply next');
  assert.deepEqual(failureStreaks(s.db, s.store, t0), ['researcher']);
  assert.deepEqual(failureStreaks(s.db, s.store, t0 + 1000), [], 'posted once per streak');
  const l = s.lines(); assert.equal(l.length, 1); assert.match(l[0].content, /Researcher failed 3 times in the last 30 minutes \(last: turn failed: model_refused\)\. Researcher's queue is paused/);
  assert.equal((l[0].meta as { owner_alert?: boolean }).owner_alert, true, 'the owner hears it too');
  assert.equal(s.store.lease({ owner: 'w9', leaseSeconds: 30 }), undefined, 'the paused assistant\'s queue does not start');
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
