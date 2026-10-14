// The approval allowlist: only a message to a person, a purchase, a public post or a delete waits for the owner's card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_ALLOWLIST, classifyControl, classifyComposer } from '../../src/approvals/allowlist.ts';
import { decide, type SnapshotElement } from '../../src/browser/act-policy.ts';
import { classifyBlocked } from '../../src/cos/owner-needs.ts';
import { describeApproval } from '../../src/approvals/describe.ts';

const btn = (name: string, role = 'button'): SnapshotElement => ({ ref: 'e1', role, name });
const click = (name: string, role = 'button') => decide({ action: 'click', ref: 'e1' }, btn(name, role));

// Real button and link names from applicant-tracking sites (Workday, Greenhouse, Lever, iCIMS, Ashby, SmartRecruiters, ADP,
// Taleo, SuccessFactors, BambooHR, Jobvite, LinkedIn Easy Apply, Indeed) and their sign-up and account pages.
const ATS = [
  'Apply', 'Apply now', 'Apply Now', 'Apply for this job', 'Apply for this position', 'Apply to job', 'Apply with LinkedIn', 'Apply with Indeed', 'Apply manually',
  'Apply with resume', 'Easy Apply', 'Quick apply', 'Start application', 'Start Your Application', 'Begin application', 'Continue application', 'Resume application',
  'Submit', 'Submit application', 'Submit Application', 'Submit your application', 'Submit my application', 'Submit and continue', 'Submit answers', 'Submit assessment',
  'Submit form', 'Submit for review', 'Submit questionnaire', 'Submit resume', 'Submit profile', 'Send application', 'Send my application', 'Send resume', 'Send verification code',
  'Send code', 'Resend code', 'Send link', 'Send me a link', 'Send magic link', 'Next', 'Next step', 'Next page', 'Next: Review', 'Save and Continue', 'Save & Continue',
  'Save and continue later', 'Save and next', 'Save', 'Save draft', 'Save profile', 'Save changes', 'Continue', 'Continue to application', 'Continue to next step', 'Continue with email',
  'Continue with Google', 'Continue with LinkedIn', 'Continue as guest', 'Proceed', 'Proceed to review', 'Review', 'Review application', 'Review and submit', 'Back', 'Previous',
  'Accept', 'Accept all', 'Accept all cookies', 'Accept cookies', 'Accept terms', 'Accept and continue', 'I accept', 'Agree', 'I agree', 'Agree and continue', 'Agree & Join',
  'I have read and agree', 'Acknowledge', 'I acknowledge', 'Confirm', 'Confirm email', 'Confirm and continue', 'Confirm details', 'Confirm application', 'Verify', 'Verify email',
  'Verify code', 'Verify and continue', 'Sign up', 'Sign Up', 'Signup', 'Sign up with email', 'Sign up for free', 'Register', 'Register now', 'Create account', 'Create Account',
  'Create an account', 'Create my account', 'Create profile', 'Create candidate account', 'Join', 'Join now', 'Join now for free', 'Get started', 'Sign in', 'Sign In', 'Log in',
  'Login', 'Log In', 'Sign in with Google', 'Sign in with LinkedIn', 'Forgot password?', 'Reset password', 'Set password', 'Change password', 'Upload', 'Upload resume',
  'Upload Resume', 'Upload a file', 'Upload CV', 'Upload cover letter', 'Attach', 'Attach resume', 'Attach file', 'Attach cover letter', 'Choose file', 'Choose File', 'Browse',
  'Select file', 'Replace file', 'Remove file', 'Remove attachment', 'Remove', 'Autofill with resume', 'Autofill from resume', 'Import from LinkedIn', 'Use my last application',
  'Add', 'Add another', 'Add experience', 'Add education', 'Add work experience', 'Add skill', 'Add language', 'Add website', 'Add certification', 'Edit', 'Edit profile', 'Done',
  'Finish', 'Finish application', 'Complete', 'Complete application', 'Complete profile', 'Complete assessment', 'Start assessment', 'Begin assessment', 'Start', 'Begin',
  'Yes', 'No', 'OK', 'Ok', 'Got it', 'Close', 'Cancel', 'Skip', 'Skip for now', 'Not now', 'Maybe later', 'Dismiss', 'Show more', 'See more', 'View job', 'View details',
  'View all jobs', 'Search', 'Search jobs', 'Find jobs', 'Filter', 'Clear filters', 'Sort', 'Load more', 'Show all', 'Opt in', 'Opt out', 'Subscribe to job alerts',
  'Create job alert', 'Set alert', 'Turn on job alerts', 'Follow', 'Save job', 'Unsave', 'Book a time', 'Schedule interview', 'Schedule', 'Book interview', 'Reserve a slot',
  'Select time', 'Confirm time', 'Authorize', 'Allow', 'Approve', 'Grant access', 'Connect calendar', 'I am not a robot', 'Start EEO survey', 'Decline to self identify',
  'I don\'t wish to answer', 'Prefer not to say', 'Download', 'Print', 'Go to dashboard', 'Return to job search', 'Withdraw', 'Update application', 'Submit EEO information',
];

test('about 200 real applicant-tracking button and link names all run without a card', () => {
  assert.ok(ATS.length >= 200, `${ATS.length} names`);
  for (const name of ATS) {
    for (const role of ['button', 'link']) { const d = click(name, role); assert.equal(d.verdict, 'allow', `${role} "${name}" → ${JSON.stringify(d)}`); assert.equal(classifyControl(name, role), null, name); }
  }
  // Enter in an ordinary application field submits the form: no card either.
  for (const f of ['First name', 'Email', 'Phone', 'LinkedIn profile URL', 'Why do you want to work here?', 'Desired salary', 'Cover letter']) assert.equal(decide({ action: 'press', key: 'Enter' }, undefined, btn(f, 'textbox')).verdict, 'allow', f);
});

test('one negative per allowlisted kind: a message, a purchase, a public post and a delete still wait for the owner', () => {
  const cases: Array<[string, string, string]> = [
    ['Send', 'button', 'send'], ['Send message', 'button', 'send'], ['Send InMail', 'button', 'send'], ['Connect', 'button', 'send'], ['Reply', 'button', 'send'], ['Send email', 'button', 'send'],
    ['Buy now', 'button', 'purchase'], ['Pay $49', 'button', 'purchase'], ['Place order', 'button', 'purchase'], ['Submit order', 'button', 'purchase'], ['Checkout', 'link', 'purchase'],
    ['Post', 'button', 'publish'], ['Publish', 'button', 'publish'], ['Tweet', 'button', 'publish'], ['Repost', 'button', 'publish'], ['Comment', 'button', 'publish'],
    ['Delete', 'button', 'delete'], ['Delete account', 'link', 'delete'], ['Close my account', 'button', 'delete'], ['Remove connection', 'button', 'delete'],
  ];
  for (const [name, role, kind] of cases) { const d = click(name, role); assert.equal(d.verdict, 'needs_approval', `${role} "${name}"`); assert.equal((d as { action_kind: string }).action_kind, kind, name); }
  // Enter in a message box or a post composer is the same as its Send/Post button.
  assert.equal((decide({ action: 'press', key: 'Enter' }, undefined, btn('Write a message…', 'textbox')) as { action_kind?: string }).action_kind, 'send');
  assert.equal((decide({ action: 'press', key: 'Enter' }, undefined, btn('What do you want to talk about?', 'textbox')) as { action_kind?: string }).action_kind, 'publish');
  assert.equal(classifyComposer('First name'), null);
  // A "Message" or "Reply" link only opens a composer.
  assert.equal(click('Message', 'link').verdict, 'allow'); assert.equal(click('Reply', 'link').verdict, 'allow');
  assert.deepEqual(APPROVAL_ALLOWLIST.map((e) => e.kind).sort(), ['delete', 'publish', 'purchase', 'send']);
});

test('submit-type controls are allowed but marked as a commit for the audit trail; credential fields are still refused', () => {
  assert.deepEqual(click('Submit application'), { verdict: 'allow', reason: 'button "Submit application" (not on the approval allowlist)', commit: true });
  assert.equal(decide({ action: 'type', ref: 'e1', text: 'x' }, btn('Password', 'textbox')).verdict, 'refuse');
});

test('owner-needs and the card wording read the same table', () => {
  assert.equal(classifyBlocked({ kind: 'blocker', title: 'Apply', detail: 'needs the owner\'s approval to send the follow-up email' }), 'owner');
  assert.equal(classifyBlocked({ kind: 'blocker', title: 'Apply', detail: 'the hiring manager\'s email address could not be found' }), 'team', 'finding an address is team work');
  assert.equal(classifyBlocked({ kind: 'blocker', title: 'Upgrade', detail: 'the site wants a payment to continue' }), 'owner');
  assert.equal(describeApproval({ action_kind: 'publish', target: 'LinkedIn post', content: 'Hello' }).label, 'Publish');
  assert.equal(describeApproval({ action_kind: 'send', target: 'Pat', content: 'Hello' }).label, 'Send a message');
});

test('a checkout page: a bare Confirm, Continue or Submit (or Enter) is the purchase; Workday "Delete" entry buttons do not make a page a delete', () => {
  const card: SnapshotElement[] = [btn('Card number', 'textbox'), btn('Expiration (MM/YY)', 'textbox'), btn('CVV', 'textbox'), btn('Confirm'), btn('Continue'), btn('Submit')];
  const payBtn: SnapshotElement[] = [btn('Shipping address', 'textbox'), btn('Place order'), btn('Submit')];
  for (const page of [card, payBtn]) for (const name of ['Confirm', 'Continue', 'Submit', 'OK', 'Complete']) {
    const d = decide({ action: 'click', ref: 'e1' }, btn(name), undefined, page); assert.equal(d.verdict, 'needs_approval', `${name} on a checkout page`); assert.equal((d as { action_kind: string }).action_kind, 'purchase');
  }
  assert.equal(decide({ action: 'press', key: 'Enter' }, undefined, btn('Name on card', 'textbox'), card).verdict, 'needs_approval');
  const workday: SnapshotElement[] = [btn('Job Title', 'textbox'), btn('Delete'), btn('Certification expiration date', 'textbox'), btn('Save and Continue')];
  assert.equal(decide({ action: 'click', ref: 'e1' }, btn('Save and Continue'), undefined, workday).verdict, 'allow');
  assert.equal(decide({ action: 'press', key: 'Enter' }, undefined, btn('Job Title', 'textbox'), workday).verdict, 'allow');
});

// Replay of the 18 approval cards the owner actually got on 2026-10-14 (scrubbed: action, control, role, host). None may card again.
const REPLAY: Array<[string, string, string, string]> = [
  ['click', 'Apply to Channel Sales Manager (West Coast) on company website', 'link', 'www.linkedin.com'],
  ['click', 'Apply on company website', 'link', 'www.linkedin.com'],
  ...Array.from({ length: 7 }, (): [string, string, string, string] => ['click', 'Submit application', 'button', 'job-boards.greenhouse.io']),
  ['click', 'Submit application', 'button', 'www.comeet.com'],
  ['click', 'Apply', 'button', 'myjobs.adp.com'],
  ['click', 'Apply now', 'button', 'ats.rippling.com'],
  ['click', 'Apply', 'button', 'ats.rippling.com'],
  ['click', 'Submit application', 'button', 'jobs.lever.co'],
  ['click', 'Submit application', 'button', 'www.esri.com'],
  ['click', 'Apply Manually', 'button', 'magnitudesoftware.wd1.myworkdayjobs.com'],
  ['press', 'How Did You Hear About Us?', 'textbox', 'magnitudesoftware.wd1.myworkdayjobs.com'],
];

test('replay: 17 of the owner\'s 18 real cards from 2026-10-14 (browser clicks and Enter) no longer card', () => {
  assert.equal(REPLAY.length, 17);
  for (const [action, name, role, host] of REPLAY) {
    const d = action === 'press' ? decide({ action: 'press', key: 'Enter' }, undefined, btn(name, role)) : decide({ action: 'click', ref: 'e1' }, btn(name, role));
    assert.equal(d.verdict, 'allow', `${action} ${role} "${name}" on ${host}`);
  }
});

// Card 2 of the replay. KNOWN FAILURE: the change that approves a no-recipient "send" (a batch of job applications) on the spot in
// request_approval was refused by this build session's safety check as a security weakening, so this request still makes a card
// unless the owner's "Submit job applications without asking" permission is on. Kept as a todo so the gap stays visible.
test('replay card 2: request_approval for a batch of job applications with no email recipient does not card', { todo: 'request_approval allowlist change not applied (blocked by the build session\'s safety check); still cards when the job-application permission is off' }, async () => {
  const { setupBroker } = await import('./helpers-broker.ts');
  const s = setupBroker(); const c = s.chat.create({ workspace_id: s.ws.id });
  const t = s.chat.send(c.id, '@coordinator apply to all 8 now', s.defs).job;
  const r = await s.call(t, 'request_approval', { kind: 'send', target: 'Job applications (8 roles) via each posting page', content: 'Submit these 8 applications with the tailored resumes' });
  assert.doesNotMatch(r.text, /the owner must approve/);
});
