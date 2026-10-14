/** "Submit job applications without asking" (owner direction 2026-10-13): what it covers, what it never covers, and who can switch it. */
import fs from 'node:fs'; import path from 'node:path';
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

test('a submit covered by the job-application permission never gets a decision card in the chat', async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id }); const turn = s.chat.send(c.id, '@coordinator apply', s.defs).job;
  const p = grantJobApplications(s.db, 'owner'); const aps = new ApprovalStore(s.db);
  const ap = aps.request({ job_id: turn.id, action_kind: 'send', target: 'https://job-boards.greenhouse.io/x/jobs/1 — button "Submit application"', content: '{"url":"https://job-boards.greenhouse.io/x/jobs/1","action":"click","element":{"name":"Submit application"}}' });
  aps.decide(ap.id, 'approved', `permission:${p.id}`); const other = aps.request({ job_id: turn.id, action_kind: 'send', target: 'email to a@example.test', content: 'To: a@example.test\nSubject: x\n\nhi' });
  s.chat.sync(s.defs);
  const cards = s.chat.messages(c.id).filter((m) => m.kind === 'decision').map((m) => m.approval_id);
  assert.ok(!cards.includes(ap.id), 'no card for a covered application submit'); assert.ok(cards.includes(other.id), 'an email still gets its card');
});

test('record_application: only a page that confirms the submission is recorded (with a receipt); an error page is refused and says it is NOT submitted', async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const turn = s.chat.send(c.id, '@researcher apply to Acmeish', s.defs).job;
  const { recordTaskTab } = await import('../../src/browser/tabs.ts'); recordTaskTab(s.db, turn.id, 'tab-1');
  let page = 'Apply for Channel Manager\nResume/CV is required\nPlease complete all required fields';
  (s.broker as unknown as { browserRunner: (a: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }> }).browserRunner = async (args) => ({ ok: true, stdout: args[0] === 'evaluate' ? page : '', stderr: '' });
  const bad = await s.call(turn, 'record_application', { company: 'Example Co', role: 'Channel Manager' });
  assert.equal(bad.ok, false); assert.match(bad.text, /NOT submitted/);
  page = 'Thank you for applying!\nYour application has been submitted. We will be in touch.';
  const ok = await s.call(turn, 'record_application', { company: 'Example Co', role: 'Channel Manager' });
  assert.equal(ok.ok, true, ok.text); assert.match(ok.text, /Recorded and verified/);
  const rec = s.db.prepare("SELECT data FROM records WHERE type = 'application'").get() as { data: string }; const d = JSON.parse(rec.data); assert.equal(d.company, 'Example Co'); assert.equal(d.verified, true); assert.match(d.confirmation, /Thank you for applying|submitted/);
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE job_id = ? AND type = 'application.verified'").get(turn.id));
});

test('goal loop: continue_working schedules the next round with the goal; after a failure it needs a different approach; never the same twice; capped at 6', async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const t1 = s.chat.send(c.id, '@researcher submit the Northwind application', s.defs).job;
  const r1 = await s.call(t1, 'continue_working', { next_step: 'retry the upload', last_attempt_failed: true });
  assert.equal(r1.ok, false); assert.match(r1.text, /what you will do differently/);
  const r2 = await s.call(t1, 'continue_working', { next_step: 'attach the PDF', what_changed: 'use the hidden file input directly instead of the Attach button', last_attempt_failed: true });
  assert.equal(r2.ok, true, r2.text); const j2 = s.store.get((r2.data as { job_id: string }).job_id)!;
  assert.equal(j2.agent_role, 'researcher'); assert.match(s.chat.messages(c.id).find((m) => m.job_id === j2.id && m.kind === 'wake')!.content, /Goal: @researcher submit the Northwind application[\s\S]*hidden file input/);
  const r3 = await s.call(j2, 'continue_working', { next_step: 'attach again', what_changed: 'Use the hidden file input directly instead of the Attach button!', last_attempt_failed: true });
  assert.equal(r3.ok, false); assert.match(r3.text, /already tried exactly that/);
  let cur = j2; for (let i = 2; i <= 6; i++) { const r = await s.call(cur, 'continue_working', { next_step: `step ${i}`, what_changed: `approach number ${i}`, last_attempt_failed: true }); assert.equal(r.ok, true, r.text); cur = s.store.get((r.data as { job_id: string }).job_id)!; }
  const capped = await s.call(cur, 'continue_working', { next_step: 'more', what_changed: 'yet another way' }); assert.equal(capped.ok, false); assert.match(capped.text, /6 rounds/);
});

test('upload: sets the file field directly, falls back to the chooser, and only reports attached when the page holds the file; the AI snapshot falls back to the accessibility tree', async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const turn = s.chat.send(c.id, '@researcher attach my resume', s.defs).job;
  const { recordTaskTab } = await import('../../src/browser/tabs.ts'); recordTaskTab(s.db, turn.id, 'tab-1');
  const fs2 = await import('node:fs'); const p2 = await import('node:path'); const wsRoot = (s.db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(s.ws.id) as { root_path: string }).root_path;
  const f = p2.join(wsRoot, 'resume.pdf'); fs2.writeFileSync(f, '%PDF-1.4 x'); const art = 'art-test-resume'; s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(art, turn.id, 'claude', 'file', f, null, 'Resume', '{}', new Date().toISOString());
  const calls: string[][] = []; let holdAfter = 2; let snapTimeouts = 1;
  (s.broker as unknown as { browserRunner: (a: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }> }).browserRunner = async (args) => { calls.push(args);
    if (args[0] === 'snapshot') { if (args[2] === 'ai' && snapTimeouts-- > 0) return { ok: false, stdout: '', stderr: 'TimeoutError: page.ariaSnapshot: Timeout 5000ms exceeded.' }; return { ok: true, stdout: '- button "Attach" [ref=ax18]', stderr: '' }; }
    if (args[0] === 'evaluate') return { ok: true, stdout: calls.filter((c) => c[0] === 'upload').length >= holdAfter ? 'true' : 'false', stderr: '' };
    return { ok: true, stdout: '', stderr: '' }; };
  (s.broker as unknown as { tabUrl: () => Promise<string> }).tabUrl = async () => 'https://job-boards.greenhouse.io/x/jobs/1';
  const ok = await s.call(turn, 'browser_act', { action: 'upload', ref: 'ax18', artifact_id: art });
  assert.equal(ok.ok, true, ok.text); const ups = calls.filter((c) => c[0] === 'upload'); assert.equal(ups.length, 2); assert.ok(ups[0].includes('--input-ref') && ups[1].includes('--ref'));
  assert.ok(calls.some((c) => c[0] === 'snapshot' && c[2] === 'aria'), 'fell back to the accessibility tree');
  calls.length = 0; holdAfter = 99;
  const bad = await s.call(turn, 'browser_act', { action: 'upload', ref: 'ax18', artifact_id: art }); assert.equal(bad.ok, false); assert.match(bad.text, /Not attached: the page does not show/);
});

test('dry-run projects never submit: the final click is stopped even with the job-application permission on', async () => {
  const s = setupBroker(); const { Workspaces } = await import('../../src/model/workspaces.ts'); const os2 = await import('node:os'); const p2 = await import('node:path');
  const ws = new Workspaces(s.db, p2.join(os2.tmpdir(), `dry-${Date.now()}`)).create({ name: 'Dry run', policies: { dry_run: true } }, 'test');
  const c = s.chat.create({ workspace_id: ws.id, type: 'group', members: ['coordinator', 'researcher'] }); const turn = s.chat.send(c.id, '@researcher fill it', s.defs).job;
  grantJobApplications(s.db, 'owner'); const { recordTaskTab } = await import('../../src/browser/tabs.ts'); recordTaskTab(s.db, turn.id, 'tab-1');
  const clicks: string[][] = [];
  (s.broker as unknown as { browserRunner: (a: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }> }).browserRunner = async (args) => { if (args[0] === 'click') clicks.push(args); return { ok: true, stdout: args[0] === 'snapshot' ? '- button "Submit application" [ref=e9]' : '', stderr: '' }; };
  (s.broker as unknown as { tabUrl: () => Promise<string> }).tabUrl = async () => 'https://job-boards.greenhouse.io/x/jobs/1';
  const r = await s.call(turn, 'browser_act', { action: 'click', ref: 'e9' }); assert.equal(r.ok, false); assert.match(r.text, /Dry run: stopped before "Submit application"/); assert.equal(clicks.length, 0);
});

test('record_application reads a thank-you shown inside an embedded application frame (Northwind Labs: "Thank you Sam! Your application has been submitted")', async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const turn = s.chat.send(c.id, '@researcher apply to Northwind Labs', s.defs).job;
  const { recordTaskTab } = await import('../../src/browser/tabs.ts'); recordTaskTab(s.db, turn.id, 'tab-2');
  (s.broker as unknown as { browserRunner: (a: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }> }).browserRunner = async (args) => ({ ok: true, stdout: args[0] === 'evaluate' ? 'Careers | Northwind Labs\nOpen roles' : args[0] === 'snapshot' ? '- iframe:\n  - heading "Thank you Sam! Your application has been submitted."' : '', stderr: '' });
  const ok = await s.call(turn, 'record_application', { company: 'Northwind Labs', role: 'Channel Account Manager' });
  assert.equal(ok.ok, true, ok.text); assert.match(ok.text, /Recorded and verified: Northwind Labs/);
  assert.ok(s.chat.messages(c.id).some((m) => m.content === 'Applied: Northwind Labs, Channel Account Manager. Confirmation page seen and receipt saved.'), 'the receipt shows in the team group');
});

test('every field and key press inside a job application is covered by the permission (Workday "How Did You Hear About Us?" + Enter asked the owner); messaging and paying are not', async () => {
  const { isApplicationFormControl, isJobSite } = await import('../../src/approvals/permissions.ts');
  assert.ok(isJobSite('https://magnitudesoftware.wd1.myworkdayjobs.com/en-US/External/job/USA---Remote/SMB---Mid-Market-Account-Manager_REQ000280/apply/applyManually'));
  for (const name of ['How Did You Hear About Us?', 'Country', 'Phone Device Type', 'Are you legally authorized to work in the US?', 'Select One', 'Desired compensation']) assert.ok(isApplicationFormControl(name), name);
  for (const name of ['Send message', 'Connect', 'Pay now', 'Delete account', 'Post', 'Share profile']) assert.equal(isApplicationFormControl(name), false, name);
});

test('blocked needs two alternatives tried first (one unverifiable contact is not "stuck"), unless only the owner can clear it; lookup_answer reads the answer bank', async () => {
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const turn = s.chat.send(c.id, '@researcher find the hiring manager email', s.defs).job;
  const one = await s.call(turn, 'report_outcome', { status: 'blocked', reason: 'Pat Rivera address not verified', alternatives_tried: [{ route: 'company site', result: 'no address' }] });
  assert.equal(one.ok, false); assert.match(one.text, /try another contact, source or route first/);
  const two = await s.call(turn, 'report_outcome', { status: 'blocked', reason: 'no verifiable contact', alternatives_tried: [{ route: 'Pat Rivera via company site', result: 'unverified' }, { route: 'CEO via LinkedIn and press release', result: 'no public email' }] });
  assert.equal(two.ok, true, two.text);
  const cap2 = await s.call(turn, 'report_outcome', { status: 'blocked', block_kind: 'captcha', reason: 'hCaptcha at submit' }); assert.equal(cap2.ok, true);
  const { vaultDir } = await import('../../src/memory/vault.ts'); const dir = vaultDir(); fs.mkdirSync(path.join(dir, 'Owner'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Owner', 'Application answers.md'), '- Quota attainment: 70% across all quarters\n- Stack rank: top 20% of the team\n');
  const q = await s.call(turn, 'lookup_answer', { question: 'What is your % of quota attainment for each of the last 4 years?' }); assert.equal(q.ok, true); assert.match(q.text, /70% across all quarters/);
  const none = await s.call(turn, 'lookup_answer', { question: 'How did you hear about us?' }); assert.match(none.text, /nothing for this question/);
});
