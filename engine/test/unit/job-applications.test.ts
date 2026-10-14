/** "Submit job applications without asking" (owner direction 2026-10-13): what it covers, what it never covers, and who can switch it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJobSite, isApplicationControl, jobApplicationPermission, grantJobApplications } from '../../src/approvals/permissions.ts';
import { decide } from '../../src/browser/act-policy.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { setupBroker } from './helpers-broker.ts';

test('job sites and application controls: ATS hosts, LinkedIn Jobs and careers paths; never messaging, profiles, payments or deletes', () => {
  for (const u of ['https://job-boards.greenhouse.io/acme/jobs/1', 'https://jobs.lever.co/acme/2/apply', 'https://jobs.ashbyhq.com/ramp/x', 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1', 'https://www.linkedin.com/jobs/view/123/', 'https://www.example.com/careers/apply/9']) assert.ok(isJobSite(u), u);
  for (const u of ['https://www.linkedin.com/messaging/thread/1', 'https://www.linkedin.com/in/someone', 'https://mail.google.com/', 'https://shop.example.com/checkout']) assert.ok(!isJobSite(u), u);
  for (const n of ['Submit application', 'Apply', 'Next', 'Continue', 'Review', 'Easy Apply']) assert.ok(isApplicationControl(n), n);
  for (const n of ['Send message', 'Connect', 'Pay now', 'Delete application', 'Withdraw application', 'Share']) assert.ok(!isApplicationControl(n), n);
});

test('browser policy: "Apply…" links are navigation; attaching a file is preparation; submitting still needs approval or the permission', () => {
  assert.equal(decide({ action: 'click', ref: 'e1' }, { ref: 'e1', role: 'link', name: 'Apply on company website' }).verdict, 'allow');
  assert.equal(decide({ action: 'upload', ref: 'e2' }, { ref: 'e2', role: 'button', name: 'Attach resume' }).verdict, 'allow');
  assert.equal(decide({ action: 'click', ref: 'e3' }, { ref: 'e3', role: 'button', name: 'Submit application' }).verdict, 'needs_approval');
  assert.equal(decide({ action: 'upload', ref: 'e4' }, { ref: 'e4', role: 'textbox', name: 'Password' }).verdict, 'refuse');
});

test('the permission covers an application request with no email in it; the lead switches it only on the owner\'s words; switching off asks again', async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id });
  const t1 = s.chat.send(c.id, '@coordinator apply to all 8 now', s.defs).job;
  const ask = await s.call(t1, 'request_approval', { kind: 'send', target: 'Job applications (8 roles) via each posting page', content: 'Submit these 8 applications with the tailored resumes' });
  assert.match(ask.text, /requested; the owner must approve/, 'off: it asks');
  assert.equal((await s.call(t1, 'set_permission', { permission: 'job_applications', on: true, owner_words: 'please do it' })).ok, false, 'words not in the owner message');
  const t2 = s.chat.send(c.id, 'Abdul, submit my job applications without asking from now on', s.defs).job;
  assert.equal((await s.call(t2, 'set_permission', { permission: 'job_applications', on: true, owner_words: 'submit my job applications without asking' })).ok, true);
  assert.ok(jobApplicationPermission(s.db));
  const t3 = s.chat.send(c.id, '@coordinator go', s.defs).job;
  const ok = await s.call(t3, 'request_approval', { kind: 'send', target: 'Job applications (8 roles)', content: 'Submit the 8 applications' }); assert.match(ok.text, /Allowed by the owner's standing permission "Submit job applications without asking"/);
  const em = await s.call(t3, 'request_approval', { kind: 'send', target: 'email to hm@example.test', content: 'To: hm@example.test\nSubject: My application\n\nHi' }); assert.match(em.text, /requested; the owner must approve/, 'an email about an application still asks');
  const t4 = s.chat.send(c.id, 'Abdul, turn off applications without asking', s.defs).job;
  assert.equal((await s.call(t4, 'set_permission', { permission: 'job_applications', on: false, owner_words: 'turn off applications without asking' })).ok, true); assert.equal(jobApplicationPermission(s.db), null);
  assert.equal(new ApprovalStore(s.db).get((ask.data as { id: string }).id)!.status, 'pending');
  assert.equal(grantJobApplications(s.db, 'owner').action_kind, 'job_application');
});

test('a fresh install has "Submit job applications without asking" off: nothing grants it until the owner turns it on', () => {
  const s = setupBroker();
  assert.equal(jobApplicationPermission(s.db), null);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM standing_permissions WHERE action_kind = 'job_application'").get() as { n: number }).n, 0);
});
