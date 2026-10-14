// Morning report: the snapshot comes from live task state and verified application records, and "Needs the owner" holds only
// what truly needs the owner (a deterministic classifier moves the rest to "Being fixed by the team").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { homeSnapshot } from '../../src/model/home.ts';
import { collectReport, liveTasks, submittedApplications, saveReport } from '../../src/cos/report.ts';
import { classifyBlocked, partitionOwnerNeeds } from '../../src/cos/owner-needs.ts';

function setup() { const db = openDatabase(':memory:'); const store = new JobStore(db); new Definitions(db).seedSystemDefaults(); return { db, store }; }
const job = (store: JobStore, key: string, kind: string, objective: string, agent = 'researcher') => store.create({ idempotency_key: key, kind, objective, success_contract: {}, agent_role: agent, inputs: {} }, 'owner').job;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
function application(db: ReturnType<typeof setup>['db'], store: JobStore, jobId: string, company: string, role: string, at = iso()) {
  const rec = `rec_${company.toLowerCase()}`;
  db.prepare('INSERT INTO records(id, type, data, job_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(rec, 'application', JSON.stringify({ title: `${company} – ${role}`, company, role, url: 'https://jobs.example/x', submitted_at: at, confirmation: 'Thank you for applying', receipt_artifact: null, verified: true }), jobId, at, at);
  db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(jobId, at, 'agent:browser_operator', 'application.verified', JSON.stringify({ record: rec, company, role }));
  void store;
}

test('classifier: only passwords, codes, CAPTCHAs, personal facts the bank lacks, spend and approvals need the owner; essays are team work', () => {
  const owner = [
    { kind: 'blocker', title: 'Blocked: Apply to Acme', detail: 'The site asks for the account password' },
    { kind: 'blocker', title: 'Blocked: Apply to Beta', detail: 'Enter the verification code sent to their phone' },
    { kind: 'blocker', title: 'Blocked: Apply to Gamma', detail: 'A CAPTCHA appeared on the submit page' },
    { kind: 'question', title: "Answer Jude's question", detail: 'What salary expectation should I put on the Delta form?' },
    { kind: 'blocker', title: 'Blocked: Apply to Epsilon', detail: 'The form asks for last year quota attainment numbers' },
    { kind: 'blocker', title: 'Blocked: Upgrade', detail: 'This needs a purchase of the premium plan' },
    { kind: 'approval', title: "Approve Sailor's email", detail: 'to jane@example.com' },
    { kind: 'sign_in', title: 'Sign in so work can continue: LinkedIn', detail: '' },
    { kind: 'question', title: "Answer Jude's question", detail: 'Which of these two roles should I apply to first?' },
  ];
  for (const x of owner) assert.equal(classifyBlocked(x), 'owner', `${x.detail || x.title} needs the owner`);
  const team = [
    { kind: 'blocker', title: 'Blocked: Apply to Zeta', detail: 'Write a short essay about yourself and why you want this role' },   // drafted from the resume and memory
    { kind: 'blocker', title: 'Blocked: Read the resumes', detail: 'Allow unzip so the archives can be opened' },
    { kind: 'blocker', title: 'Blocked: Read the resumes', detail: 'Extract the zips manually and put them in the shared folder' },
    { kind: 'question', title: "Answer Ivan's question", detail: 'Can you export the chat log so I can read the earlier plan?' },
    { kind: 'question', title: "Answer Ivan's question", detail: 'Please give me access to records so I can check the list' },
    { kind: 'blocker', title: 'Blocked: Tailor resumes', detail: 'Re-run the task once the files are there' },
    { kind: 'blocker', title: 'Blocked: Tailor resumes', detail: 'The task timed out' },
    { kind: 'question', title: "Answer Ivan's question", detail: 'Do you approve enabling the unzip tool?' },
  ];
  for (const x of team) assert.equal(classifyBlocked(x), 'team', `${x.detail} is the team's to fix`);
  const p = partitionOwnerNeeds([...owner, ...team, { kind: 'routine', title: 'Morning report', detail: 'routine' }]);
  assert.equal(p.owner.length, owner.length + 1, 'routines stay where they are'); assert.equal(p.team.length, team.length);
});

test('Home and the report agree: a blocker the team can fix is not counted as needing the owner', () => {
  const { db, store } = setup();
  const blocked = (id: string, action: string) => db.prepare("UPDATE jobs SET state = 'failed_terminal', blocker_code = 'BLOCKED', operator_action = ?, updated_at = ? WHERE id = ?").run(action, iso(), id);
  const a = job(store, 'b1', 'research.report', 'Read the tailored resumes');
  blocked(a.id, 'Allow unzip, or extract the zips manually');
  const b = job(store, 'b2', 'research.report', 'Apply to Acme');
  blocked(b.id, 'Type the verification code Acme sent to your phone');
  const home = homeSnapshot(db);
  assert.equal(home.figures.needs_you, 1);
  assert.deepEqual(home.today.filter((x) => x.kind === 'blocker').map((x) => x.title), ['Blocked: Apply to Acme']);
  assert.deepEqual(home.being_fixed.map((x) => x.title), ['Blocked: Read the tailored resumes']);
  const rep = job(store, 'rep', 'report.morning', 'Write the morning report', 'coordinator');
  const c = collectReport(db, rep.id, null);
  const owner = c.report_text.split('Needs the owner (1):')[1].split('Being fixed by the team')[0];
  assert.match(owner, /verification code/); assert.doesNotMatch(owner, /unzip/);
  assert.match(c.report_text, /Being fixed by the team \(1\):\n- Blocked: Read the tailored resumes — Allow unzip/);
  const data = JSON.parse((db.prepare('SELECT data FROM reports WHERE id = ?').get(c.report_id) as { data: string }).data) as { figures: { needs_you: number }; being_fixed: unknown[] };
  assert.equal(data.figures.needs_you, 1); assert.equal(data.being_fixed.length, 1);
  assert.equal(saveReport(db, { job_id: rep.id, headline: 'Two things need you today.', lede: 'Jude is applying; one code is needed from you.' }).ok, false, 'the team item is not the owner\'s');
  assert.equal(saveReport(db, { job_id: rep.id, headline: 'One thing needs you today.', lede: 'Jude is applying; one code is needed from you.' }).ok, true);
});

test('the report lists live tasks (chat turns and continuation rounds included) with assistant and objective, and verified applications from the last 24 hours', () => {
  const { db, store } = setup();
  const running = job(store, 'c1', 'chat.turn', 'Continuing (round 3 of 8) for Browser.\nGoal: Submit the remaining job applications\nNext step: Apply to Delta', 'browser_operator');
  db.prepare("UPDATE jobs SET state = 'running', lease_owner = 'worker:t', lease_heartbeat_at = ?, lease_expires_at = ? WHERE id = ?").run(iso(), new Date(Date.now() + 60_000).toISOString(), running.id);
  const queued = job(store, 'c2', 'research.report', 'Find five more sales roles in Phoenix');
  const waiting = job(store, 'c3', 'chat.turn', 'Apply to Gamma', 'browser_operator'); db.prepare("UPDATE jobs SET state = 'waiting_for_approval' WHERE id = ?").run(waiting.id);
  const done = job(store, 'c4', 'research.report', 'An old finished task'); db.prepare("UPDATE jobs SET state = 'completed', completed_at = ? WHERE id = ?").run(iso(), done.id);
  const rep = job(store, 'rep', 'report.morning', 'Write the morning report', 'coordinator');
  application(db, store, running.id, 'Acme', 'Account Executive');
  application(db, store, running.id, 'Beta', 'Sales Manager', iso(3 * 3600_000));
  application(db, store, running.id, 'Oldco', 'SDR', iso(30 * 3600_000));
  db.prepare('INSERT INTO records(id, type, data, job_id, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('rec_unverified', 'application', JSON.stringify({ company: 'Nope', role: 'AE', verified: false }), running.id, iso(), iso());

  const live = liveTasks(db);
  assert.deepEqual(live.map((t) => t.id).sort(), [running.id, queued.id, waiting.id].sort(), 'live = queued, running and waiting tasks; never finished work or the report itself');
  assert.equal(live[0].id, running.id); assert.equal(live[0].title, 'Submit the remaining job applications', 'a continuation round is titled by its goal');
  const apps = submittedApplications(db, iso(24 * 3600_000));
  assert.deepEqual(apps.map((a) => [a.company, a.role, a.verified]), [['Beta', 'Sales Manager', true], ['Acme', 'Account Executive', true]]);

  const c = collectReport(db, rep.id, null);
  assert.match(c.report_text, /Running now: 1\./);
  assert.match(c.report_text, /Live tasks \(3: 1 running, 2 queued or waiting\):/);
  assert.match(c.report_text, /- [^:\n]+: Submit the remaining job applications \(running\)/);
  assert.match(c.report_text, /: Find five more sales roles in Phoenix \(queued\)/);
  assert.match(c.report_text, /: Apply to Gamma \(waiting for an approval\)/);
  assert.match(c.report_text, /Job applications submitted and verified in the last 24 hours \(2\):\n- Beta — Sales Manager \(verified, by [^)]+\)\n- Acme — Account Executive \(verified/);
  assert.doesNotMatch(c.report_text, /Oldco|Nope/); assert.doesNotMatch(c.report_text.split('Live tasks')[1].split('Job applications')[0], /An old finished task/);
  const data = JSON.parse((db.prepare('SELECT data FROM reports WHERE id = ?').get(c.report_id) as { data: string }).data) as { live: unknown[]; applications: unknown[] };
  assert.equal(data.live.length, 3); assert.equal(data.applications.length, 2);
});

test('the writing step is told what needs the owner and what the team fixes', () => {
  const wf = new Definitions(setup().db).getWorkflow('report.morning')!;
  const prompt = JSON.stringify(wf.stages);
  assert.match(prompt, /Being fixed by the team/); assert.match(prompt, /Live tasks/); assert.match(prompt, /Job applications submitted/);
  assert.match(prompt, /unzip/); assert.match(prompt, /verification code/);
});
