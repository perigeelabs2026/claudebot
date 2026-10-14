// Honesty guard and ledger status: every running/live/submitted count comes from the work record, and a reply that claims something
// happened in the world (submitted, sent, verified, account created, signed in) with no matching record gets a check note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { collectReport } from '../../src/cos/report.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspaces } from '../../src/model/workspaces.ts';
import { bankKnows } from '../../src/memory/answer-bank.ts';
import { Vault } from '../../src/memory/vault.ts';
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

test('test projects (telegram:false, dry_run) are not counted, unless the question is asked inside one', () => {
  const { db, store } = setup(); const wss = new Workspaces(db, fs.mkdtempSync(path.join(os.tmpdir(), 'hws-')));
  const test1 = wss.create({ name: 'Rehearsal', policies: { telegram: false } } as never, 't'); const test2 = wss.create({ name: 'Dry', policies: { dry_run: true } } as never, 't');
  db.prepare('UPDATE workspaces SET policies = ? WHERE id = ?').run(JSON.stringify({ telegram: false }), test1.id); db.prepare('UPDATE workspaces SET policies = ? WHERE id = ?').run(JSON.stringify({ dry_run: true }), test2.id);
  for (let i = 1; i <= 3; i++) { const j = job(store, `real${i}`, `Real ${i}`); store.patch(j.id, { state: 'running' } as never); }
  for (const [k, ws] of [['t1', test1.id], ['t2', test2.id], ['t3', test2.id]] as const) { const j = store.create({ idempotency_key: k, kind: 'research.report', objective: k, success_contract: {}, agent_role: 'researcher', workspace_id: ws, inputs: {} } as never, 'owner').job; store.patch(j.id, { state: 'running' } as never); }
  const asking = job(store, 'ask', 'status?', 'coordinator');
  assert.equal(ledgerStatus(db, { exclude: asking.id }).live, 3, 'only the real project');
  const inTest = store.create({ idempotency_key: 'ask2', kind: 'research.report', objective: 'status?', success_contract: {}, agent_role: 'coordinator', workspace_id: test2.id, inputs: {} } as never, 'owner').job;
  assert.equal(ledgerStatus(db, { exclude: inTest.id }).live, 2, 'asked inside a test project: that project only');
});

test('"verified" needs a *.verified record or a page about the same thing: an earlier send does not count', () => {
  const { db, store } = setup(); const j = job(store, 'v', 'Email Pat');
  event(db, j.id, 'action.performed', { kind: 'send', via: 'browser_act' });
  assert.match(honestyNotes(db, 'I verified the address.', j.id, null).join(''), /nothing was verified/, 'a send is not a verification');
  event(db, j.id, 'browser.read', { url: 'https://globex.example/team/pat-rivera' });
  assert.deepEqual(honestyNotes(db, "I verified Pat Rivera's role on the Globex team page.", j.id, null), [], 'the page read is about what was verified');
  assert.match(honestyNotes(db, 'I verified the mailing address.', j.id, null).join(''), /nothing was verified/, 'a different subject still needs evidence');
  event(db, j.id, 'email.verified', { address: 'x' });
  assert.deepEqual(honestyNotes(db, 'I verified the address.', j.id, null), []);
});

test('Accounts.md does not feed the answer bank: a quota blocker that mentions a .com URL is not bank-known', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-acct-'));
  new Vault(dir).recordAccount('acme.myworkdayjobs.com:owner@example.com', 'Jude');
  assert.equal(bankKnows('The form at https://acme.myworkdayjobs.com/careers asks for quota attainment for 2024', dir), false);
  assert.equal(bankKnows('Sign in at www.example.org or example.io', dir), false);
  fs.writeFileSync(path.join(dir, 'Owner', 'Application answers.md'), '- Quota attainment: 70% across all quarters\n');
  assert.equal(bankKnows('The form at https://acme.myworkdayjobs.com/careers asks for quota attainment for 2024', dir), true, 'the real answer still counts');
});
