// Honesty guard and ledger status: every running/live/submitted count comes from the work record, and a reply that claims something
// happened in the world (submitted, sent, verified, account created, signed in) with no matching record gets a check note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { collectReport } from '../../src/cos/report.ts';
import { claimsIn, honestyNotes, ledgerStatus, statusNote } from '../../src/cos/honesty.ts';

function setup() { const db = openDatabase(':memory:'); const store = new JobStore(db); new Definitions(db).seedSystemDefaults(); return { db, store }; }
const job = (store: JobStore, key: string, objective: string, agent = 'researcher') => store.create({ idempotency_key: key, kind: 'research.report', objective, success_contract: {}, agent_role: agent, inputs: {} }, 'owner').job;
const event = (db: ReturnType<typeof setup>['db'], jobId: string, type: string, detail: Record<string, unknown>) => db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(jobId, new Date().toISOString(), 'agent:x', type, JSON.stringify(detail));

test('a fixture with 9 live tasks reports 9: the morning report, the lead\'s status block and the count check all read the ledger', () => {
  const { db, store } = setup();
  for (let i = 1; i <= 9; i++) { const j = job(store, `live${i}`, `Apply to company ${i}`); store.patch(j.id, { state: 'running' } as never); }
  const rep = store.create({ idempotency_key: 'rep', kind: 'report.morning', objective: 'Write the morning report', success_contract: {}, agent_role: 'coordinator', inputs: {} }, 'owner').job; store.patch(rep.id, { state: 'running' } as never);
  assert.match(collectReport(db, rep.id, null).report_text, /Live tasks \(9: 9 running, 0 queued or waiting\)/, 'the morning report says 9');
  const asking = job(store, 'turn', 'Owner asked for status', 'coordinator'); store.patch(asking.id, { state: 'running' } as never);
  const st9 = ledgerStatus(db, { exclude: asking.id }); assert.equal(st9.live, 9, 'the lead\'s own turn is not counted'); assert.equal(st9.running, 9);
  assert.match(st9.text, /9 live tasks \(9 running, 0 queued or waiting\)/);
  assert.match(statusNote('Quiet morning: nothing is running right now.', st9) ?? '', /the work record shows 9 running/);
  assert.match(statusNote('0 running, all done.', st9) ?? '', /9 running/);
  assert.match(statusNote('Three tasks are running.', st9) ?? '', /9 running/);
  assert.equal(statusNote('Nine tasks are running: the applications.', st9), null);
  assert.equal(statusNote('9 running and nothing waiting on you.', st9), null);
  assert.match(statusNote('We submitted 4 applications today.', st9) ?? '', /0 applications submitted and verified/);
});

test('claims: sent, verified, account created and signed in are recognised; negated, conditional and future sentences are not', () => {
  assert.deepEqual(claimsIn('I sent the email to Pat at Globex.'), ['sent']);
  assert.deepEqual(claimsIn('The connection request was sent.'), ['sent']);
  assert.deepEqual(claimsIn('Jude verified the address.'), ['verified']);
  assert.deepEqual(claimsIn('I created your Workday account.'), ['account']);
  assert.deepEqual(claimsIn('I signed in to LinkedIn.'), ['signed_in']);
  assert.deepEqual(claimsIn('I submitted the application to Globex.'), ['submitted']);
  for (const quiet of ['I have not sent it yet.', 'I will send it once the address is verified.', 'Should I send the email?', 'You need to sign in to Workday.', 'The draft is ready; nothing was sent.', 'The address could not be verified.', 'I sent in nothing today.'])
    assert.deepEqual(claimsIn(quiet).filter((c) => c !== 'submitted'), [], quiet);
});

test('"sent" with no action.performed gets the check note; with the performed send it does not', () => {
  const { db, store } = setup(); const j = job(store, 't', 'Email Pat');
  assert.deepEqual(honestyNotes(db, 'I sent the email to Pat.', j.id, null), ['ClaudeBot check: no sent message is recorded for this reply, so treat any message mentioned above as not yet sent.']);
  assert.match(honestyNotes(db, 'I created your Workday account and signed in.', j.id, null).join('\n'), /no account sign-up[\s\S]*no successful sign-in/);
  assert.match(honestyNotes(db, 'Jude verified the address.', j.id, null).join(''), /nothing was verified/);
  event(db, j.id, 'action.performed', { kind: 'send', via: 'browser_act' });
  event(db, j.id, 'account.password_set', { account: 'workday:owner@example.com' });
  event(db, j.id, 'browser.act', { action: 'click', name: 'Sign in', commit: true });
  assert.deepEqual(honestyNotes(db, 'I sent the email to Pat. I created your Workday account and signed in.', j.id, null), []);
});
