/** jobs.follow_up_email (coordinator brief 2026-10-14): its own workflow and contract, created by a verified application, proven from
 *  the Sent folder or by what was tried, never sent twice, re-queued from an old failed follow-up, and a never-passed workflow's check
 *  failures kept out of the assistant's failure streak. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupBroker } from './helpers-broker.ts';
import { grantEmails } from '../../src/approvals/permissions.ts';
import { DETERMINISTIC } from '../../src/worker/deterministic.ts';
import { FOLLOWUP_KIND, followupKey, requeueFollowUp, failedFollowUps, isSentSearchUrl, createFollowUp } from '../../src/jobs/followup.ts';
import { failureStreaks, unprovenWorkflows, STREAK } from '../../src/cos/watch.ts';
import { recordTaskTab } from '../../src/browser/tabs.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import type { Job } from '../../src/jobs/types.ts';

type Runner = (a: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
function browser(s: ReturnType<typeof setupBroker>, state: { url: string; page: string; clicks?: string[][] }) {
  (s.broker as unknown as { browserRunner: Runner }).browserRunner = async (args) => { if (args[0] === 'click') state.clicks?.push(args); return { ok: true, stdout: args[0] === 'evaluate' ? state.page : args[0] === 'snapshot' ? '- button "Send" [ref=e5]' : '', stderr: '' }; };
  (s.broker as unknown as { tabUrl: () => Promise<string> }).tabUrl = async () => state.url;
}
/** A verified application (record_application on a confirmation page), as the Web reader does it. */
async function apply(s: ReturnType<typeof setupBroker>, company = 'Northwind') {
  const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'browser_operator'] });
  const turn = s.chat.send(c.id, '@browser_operator apply', s.defs).job; recordTaskTab(s.db, turn.id, 'tab-a');
  browser(s, { url: 'https://job-boards.greenhouse.io/northwind/jobs/1', page: 'Thank you for applying!\nYour application has been submitted.' });
  const r = await s.call(turn, 'record_application', { company, role: 'Account Executive' }); assert.equal(r.ok, true, r.text);
  return (r.data as { record_id: string }).record_id;
}
const fail = (s: ReturnType<typeof setupBroker>, j: Job, code: string, reason = 'check failed') => { s.store.transition(j.id, 'leased', 'w'); s.store.transition(j.id, 'running', 'w'); s.store.failTerminal(j.id, 'w', reason, 'see task', code); };
const verify = (s: ReturnType<typeof setupBroker>, j: Job) => DETERMINISTIC.verify_followup({ db: s.db, store: s.store, job: s.store.get(j.id)!, workspace: s.tmp, previous: {}, actor: 'w' } as never);

test('the workflow: its own stages and contract (requires_outcome, a proof check), owned by the reviewer; not the research contract', () => {
  const s = setupBroker(); const wf = s.defs.getWorkflow(FOLLOWUP_KIND)!;
  assert.deepEqual(wf.stages.map((x) => x.name), ['prepare', 'find_contact', 'send', 'verify']);
  assert.equal(wf.stages[3].fn, 'verify_followup'); assert.equal(wf.default_agent, 'reviewer');
  assert.deepEqual(wf.contract, { requires_keys: ['summary', 'followup'], requires_outcome: true });
  assert.equal(s.defs.getWorkflow('browser.read_task')!.contract.validator, 'evidence_has_sources', 'the research contract is untouched');
  assert.match(wf.stages[1].prompt!, /Check the Sent folder first/);
});

test('application.verified creates jobs.follow_up_email under followup:<record> (never a browser task); only while emails may be sent, only in real projects', async () => {
  const s = setupBroker();
  const r0 = await apply(s); assert.equal(s.db.prepare('SELECT 1 FROM jobs WHERE idempotency_key = ?').get(followupKey(r0)), undefined, 'emails permission off: no follow-up');
  grantEmails(s.db, 'owner:test', { max_per_day: 50, days: null });
  const r1 = await apply(s, 'Globex'); const f = s.db.prepare('SELECT kind, agent_role, inputs FROM jobs WHERE idempotency_key = ?').get(followupKey(r1)) as { kind: string; agent_role: string; inputs: string };
  assert.equal(f.kind, FOLLOWUP_KIND); assert.equal(f.agent_role, 'reviewer'); assert.equal(JSON.parse(f.inputs).company, 'Globex');
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'browser.read_task'").get() as { n: number }).n, 0);
  s.db.prepare("UPDATE workspaces SET policies = json_set(COALESCE(policies, '{}'), '$.test', 1) WHERE id = ?").run(s.ws.id);
  const r2 = await apply(s, 'Initech'); assert.equal(s.db.prepare('SELECT 1 FROM jobs WHERE idempotency_key = ?').get(followupKey(r2)), undefined, 'a test project gets none');
});

test('record_followup: "sent" only from a Sent-folder search showing the recipient; "no_address" needs what was tried; not outside a follow-up task', async () => {
  const s = setupBroker(); grantEmails(s.db, 'owner:test', { max_per_day: 50, days: null }); const rec = await apply(s);
  const f = s.store.get((s.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(followupKey(rec)) as { id: string }).id)!; recordTaskTab(s.db, f.id, 'tab-f');
  const st = { url: 'https://mail.google.com/mail/u/0/#inbox', page: '' }; browser(s, st);
  assert.match((await s.call(f, 'record_followup', { result: 'sent', recipient: 'jane@northwind.example' })).text, /not a webmail Sent-folder search/);
  st.url = 'https://mail.google.com/mail/u/0/#search/in%3Asent+to%3Ajane%40northwind.example'; st.page = 'No messages matched your search';
  assert.match((await s.call(f, 'record_followup', { result: 'sent', recipient: 'jane@northwind.example' })).text, /does not show an email to jane@northwind\.example/);
  assert.equal((await s.call(f, 'record_followup', { result: 'no_address', tried: [] })).ok, false);
  st.page = 'Sent\nTo: jane@northwind.example\nFollowing up on my Account Executive application';
  const ok = await s.call(f, 'record_followup', { result: 'sent', recipient: 'Jane@Northwind.example' }); assert.equal(ok.ok, true, ok.text);
  const ev = JSON.parse((s.db.prepare("SELECT detail FROM job_events WHERE job_id = ? AND type = 'followup.sent'").get(f.id) as { detail: string }).detail);
  assert.deepEqual([ev.record, ev.recipient, ev.sent_search_url], [rec, 'jane@northwind.example', st.url]);
  assert.equal(JSON.parse((s.db.prepare('SELECT data FROM records WHERE id = ?').get(rec) as { data: string }).data).followup.sent_to, 'jane@northwind.example');
  const other = s.chat.send(s.chat.create({ workspace_id: s.ws.id }).id, '@coordinator hi', s.defs).job;
  assert.match((await s.call(other, 'record_followup', { result: 'no_address', tried: ['x'] })).text, /follow-up email tasks only/);
  assert.equal(isSentSearchUrl('https://outlook.office.com/mail/sentitems'), true); assert.equal(isSentSearchUrl('https://mail.google.com.evil.example/#sent'), false);
});

test('verify_followup passes on proof only: sent + Sent URL + a sourced published address at the domain, or no_address with what was tried', async () => {
  const s = setupBroker(); grantEmails(s.db, 'owner:test', { max_per_day: 50, days: null }); const rec = await apply(s);
  const f = s.store.get((s.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(followupKey(rec)) as { id: string }).id)!;
  const r0 = await verify(s, f); assert.equal(r0.ok, false); assert.match((r0 as { reason: string }).reason, /record_followup was never called/);
  s.store.event(f.id, 'w', 'followup.sent', { record: rec, recipient: 'jane@northwind.example', sent_search_url: 'https://mail.google.com/mail/u/0/#search/in%3Asent+to%3Ajane' });
  const r1 = await verify(s, f); assert.equal(r1.ok, false); assert.match((r1 as { reason: string }).reason, /published @northwind\.example address/);
  s.db.prepare('INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES (?,?,?,?,?,?,?)').run('ev1', f.id, 'Pattern', 'sales@globex.example', 'https://globex.example/team', 'B', new Date().toISOString());
  assert.equal((await verify(s, f)).ok, false, 'an address at another domain proves nothing');
  s.db.prepare('INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES (?,?,?,?,?,?,?)').run('ev2', f.id, 'Published address', 'Press contact: press@northwind.example (first@ pattern)', 'https://northwind.example/press', 'A', new Date().toISOString());
  const ok = await verify(s, f); assert.equal(ok.ok, true); assert.equal((ok as unknown as { payload: { followup: string } }).payload.followup, 'sent');
  const g = s.store.create({ idempotency_key: 'fx', kind: FOLLOWUP_KIND, objective: 'x', success_contract: {}, agent_role: 'reviewer', inputs: { record: 'r' } }).job;
  s.store.event(g.id, 'w', 'followup.no_address', { record: 'r', tried: [] }); assert.equal((await verify(s, g)).ok, false);
  s.store.event(g.id, 'w', 'followup.no_address', { record: 'r', tried: ['careers page', 'LinkedIn', 'first.last@ pattern: no published example'] });
  assert.deepEqual((await verify(s, g) as unknown as { payload: { followup: string } }).payload.followup, 'no_address');
});

test('never twice: webmail Send in a follow-up task is refused once that application\'s follow-up is recorded as sent', async () => {
  const s = setupBroker(); grantEmails(s.db, 'owner:test', { max_per_day: 50, days: null }); const rec = await apply(s);
  const f = s.store.get((s.db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(followupKey(rec)) as { id: string }).id)!; recordTaskTab(s.db, f.id, 'tab-f');
  const st = { url: 'https://mail.google.com/mail/u/0/#inbox?compose=new', page: '', clicks: [] as string[][] }; browser(s, st);
  const first = await s.call(f, 'browser_act', { action: 'click', ref: 'e5' }); assert.equal(first.ok, true, first.text); assert.equal(st.clicks.length, 1);
  s.store.event(f.id, 'w', 'followup.sent', { record: rec, recipient: 'jane@northwind.example', sent_search_url: 'https://mail.google.com/mail/u/0/#sent' });
  const again = await s.call(f, 'browser_act', { action: 'click', ref: 'e5' }); assert.equal(again.ok, false); assert.match(again.text, /already recorded as sent to jane@northwind\.example/); assert.equal(st.clicks.length, 1);
});

test('requeue: a failed follow-up on the old browser task is re-created on jobs.follow_up_email under the same key; Sent is checked first, never a double send', async () => {
  const s = setupBroker(); const rec = await apply(s);
  const old = s.store.create({ idempotency_key: followupKey(rec), kind: 'browser.read_task', objective: 'Follow up with Northwind', success_contract: {}, agent_role: 'browser_operator', workspace_id: s.ws.id, inputs: { urls: 'x' } }).job;
  assert.match((requeueFollowUp(s.db, s.store, rec) as { reason: string }).reason, /is queued, not failed/);
  // The old task pressed Send under an approval before its research contract failed.
  const ap = new ApprovalStore(s.db).request({ job_id: old.id, action_kind: 'send', target: 'https://mail.google.com/ — button "Send"', content: 'To: jane@northwind.example' });
  s.store.event(old.id, 'w', 'action.performed', { approval_id: ap.id, kind: 'send', via: 'browser_act' });
  fail(s, old, 'CONTRACT_UNMET', 'success contract unmet: evidence 0 < required 1');
  assert.deepEqual(failedFollowUps(s.db), [rec]);
  const r = requeueFollowUp(s.db, s.store, rec, 'owner:test'); assert.equal(r.ok, true);
  const nj = (r as { job: Job }).job; assert.equal(nj.kind, FOLLOWUP_KIND); assert.equal(nj.idempotency_key, followupKey(rec));
  const inputs = JSON.parse(nj.inputs); assert.equal(inputs.previous_task, old.id); assert.match(inputs.previous_send_note, /pressed Send/);
  assert.equal(s.store.get(old.id)!.idempotency_key, `${followupKey(rec)}:replaced:${old.id}`); assert.equal(s.store.get(old.id)!.state, 'failed_terminal', 'history kept');
  assert.match((requeueFollowUp(s.db, s.store, rec) as { reason: string }).reason, /is queued, not failed/, 'one at a time');
  assert.equal(createFollowUp(s.db, s.store, rec)?.id ?? nj.id, nj.id, 'the same key: never a second task');
  // Once Sent shows it, nothing is re-created again.
  fail(s, nj, 'STAGE_FAILED'); s.store.event(nj.id, 'w', 'followup.sent', { record: rec, recipient: 'jane@northwind.example', sent_search_url: 'https://mail.google.com/mail/u/0/#sent' });
  assert.match((requeueFollowUp(s.db, s.store, rec) as { reason: string }).reason, /already sent to jane@northwind\.example/); assert.deepEqual(failedFollowUps(s.db), []);
});

test('streak pause: contract or check failures of a never-passed workflow do not pause the assistant; one line names the workflow; turn failures still count', async () => {
  const s = setupBroker(); s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'reviewer'] });
  const mk = (i: number, kind = FOLLOWUP_KIND) => s.store.create({ idempotency_key: `u${kind}${i}`, kind, objective: `Follow up ${i}`, success_contract: {}, agent_role: 'reviewer', workspace_id: s.ws.id, inputs: {} }).job;
  for (let i = 0; i < STREAK.failures + 1; i++) fail(s, mk(i), i % 2 ? 'CONTRACT_UNMET' : 'STAGE_FAILED', 'no follow-up was recorded');
  assert.deepEqual(failureStreaks(s.db, s.store), [], 'the assistant is not paused');
  assert.equal(s.db.prepare("SELECT 1 FROM runtime_state WHERE key = 'agent.paused.reviewer'").get(), undefined);
  assert.deepEqual(unprovenWorkflows(s.db, s.store), [FOLLOWUP_KIND]); assert.deepEqual(unprovenWorkflows(s.db, s.store), [], 'once');
  const line = (s.db.prepare("SELECT content FROM messages WHERE json_extract(meta, '$.alert_key') = ?").get(`unproven:${FOLLOWUP_KIND}`) as { content: string }).content;
  assert.match(line, /The workflow "Follow-up email" \(jobs\.follow_up_email\) has failed its check 4 times and has never passed \(last: no follow-up was recorded\)\. Reviewer's queue is not paused/);
  // Normal turn failures of the same assistant still count and pause it.
  for (let i = 0; i < STREAK.failures; i++) { const j = mk(100 + i, 'research.report'); s.store.transition(j.id, 'leased', 'w'); s.store.transition(j.id, 'running', 'w'); s.store.failRetryable(j.id, 'w', 'turn failed: socket hang up'); }
  assert.deepEqual(failureStreaks(s.db, s.store), ['reviewer']);
  // A workflow that has passed once is proven: its contract failures count like any other failure.
  const s2 = setupBroker(); s2.chat.create({ workspace_id: s2.ws.id, type: 'group', members: ['coordinator', 'reviewer'] });
  const ok = s2.store.create({ idempotency_key: 'p', kind: 'document.review', objective: 'r', success_contract: {}, agent_role: 'reviewer', workspace_id: s2.ws.id, inputs: {} }).job;
  s2.store.transition(ok.id, 'leased', 'w'); s2.store.transition(ok.id, 'running', 'w'); s2.store.transition(ok.id, 'completed', 'w');
  for (let i = 0; i < STREAK.failures; i++) { const j = s2.store.create({ idempotency_key: `d${i}`, kind: 'document.review', objective: 'r', success_contract: {}, agent_role: 'reviewer', workspace_id: s2.ws.id, inputs: {} }).job; s2.store.transition(j.id, 'leased', 'w'); s2.store.transition(j.id, 'running', 'w'); s2.store.failTerminal(j.id, 'w', 'contract', 'x', 'CONTRACT_UNMET'); }
  assert.deepEqual(failureStreaks(s2.db, s2.store), ['reviewer']); assert.deepEqual(unprovenWorkflows(s2.db, s2.store), []);
});
