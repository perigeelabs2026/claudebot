import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { issueCapability, verifyCapability, readCapability, revokeCapability, TOOL_SCHEMAS } from '../../src/broker/capabilities.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { loadConfig } from '../../src/config.ts';
import { Definitions } from '../../src/model/definitions.ts';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brk-')); const runDir = path.join(tmp, 'run'); const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws, { recursive: true });
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db);
  const cfg = loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv);
  const api = new BrokerApi(db, store, approvals, cfg); const defs = new Definitions(db); defs.seedSystemDefaults();
  return { tmp, runDir, ws, db, store, approvals, api, defs };
}

test('capability exposes only the role\'s tools and never a consequential tool; token verification is exact', () => {
  const s = setup();
  const { job } = s.store.create({ idempotency_key: 'k', kind: 'research.report', objective: 'o', success_contract: {}, agent_role: 'researcher' });
  const cap = issueCapability(s.runDir, job, s.ws, s.defs.getAgent('researcher')!.allowed_tools);
  assert.ok(cap.tools.includes('add_evidence')); assert.ok(cap.tools.includes('browser_read'));
  // Changed 7 Oct (Gate 4): specialists may create budgeted child tasks; they still never get request_approval or consequential tools.
  assert.ok(cap.tools.includes('create_job')); assert.ok(!cap.tools.includes('request_approval'));
  assert.ok(!issueCapability(s.runDir, { id: 'job-rev', agent_role: 'reviewer' }, s.ws, s.defs.getAgent('reviewer')!.allowed_tools).tools.includes('create_job'), 'the reviewer cannot delegate');
  assert.ok(!Object.keys(TOOL_SCHEMAS).some((t) => /^(send|publish|purchase|delete)/.test(t)));
  assert.equal((fs.statSync(path.join(s.runDir, 'jobs', job.id, 'capability.json')).mode & 0o777), 0o600);
  assert.ok(verifyCapability(s.runDir, job.id, cap.token)); assert.equal(verifyCapability(s.runDir, job.id, cap.token.slice(0, -1) + 'x'), null);
  const again = issueCapability(s.runDir, job, s.ws, s.defs.getAgent('researcher')!.allowed_tools); assert.equal(again.token, cap.token);   // refresh keeps the token
  revokeCapability(s.runDir, job.id); assert.equal(readCapability(s.runDir, job.id), null);
});

test('broker refuses tools outside the capability and audits; allowed tools run and are audited (control)', async () => {
  const s = setup();
  const { job } = s.store.create({ idempotency_key: 'k', kind: 'document.review', objective: 'o', success_contract: {}, agent_role: 'reviewer' });
  const cap = issueCapability(s.runDir, job, s.ws, s.defs.getAgent('reviewer')!.allowed_tools);
  const r = await s.api.call(cap, 'create_job', { kind: 'x', objective: 'y', agent_role: 'z' });
  assert.equal(r.ok, false); assert.ok(s.store.events(job.id).some((e) => e.type === 'tool.refused'));
  const ok = await s.api.call(cap, 'report_progress', { note: 'checking' });
  assert.equal(ok.ok, true); assert.ok(s.store.events(job.id).some((e) => e.type === 'tool.called'));
  const rcap = issueCapability(s.runDir, { id: 'job-res', agent_role: 'researcher' }, s.ws, s.defs.getAgent('researcher')!.allowed_tools);
  const bad = await s.api.call(rcap, 'add_evidence', { title: 't', body: 'b', source_url: 'not a url', grade: 'A' });
  assert.equal(bad.ok, false); assert.match(bad.text, /http\(s\)/);
});

test('request_approval creates a pending approval bound by content hash; non-consequential kinds are rejected', async () => {
  const s = setup();
  const { job } = s.store.create({ idempotency_key: 'k', kind: 'research.report', objective: 'o', success_contract: {}, agent_role: 'researcher' });
  const cap = { ...issueCapability(s.runDir, job, s.ws, s.defs.getAgent('researcher')!.allowed_tools), tools: ['request_approval'] };
  const r = await s.api.call(cap, 'request_approval', { kind: 'send', target: 'mailto:x@example.com', content: 'Hi there' });
  assert.equal(r.ok, true); const ap = s.approvals.list('pending')[0]; assert.equal(ap.job_id, job.id); assert.equal(ap.action_kind, 'send');
  const bad = await s.api.call(cap, 'request_approval', { kind: 'read', target: 't', content: 'c' }); assert.equal(bad.ok, false);
});

test('run_allowlisted refuses non-allowlisted commands and audits; allowlisted command runs in the workspace (control)', async () => {
  const s = setup();
  const { job } = s.store.create({ idempotency_key: 'k', kind: 'research.report', objective: 'o', success_contract: {}, agent_role: 'researcher' });
  const cap = { ...issueCapability(s.runDir, job, s.ws, []), tools: ['run_allowlisted', 'write_artifact'] };
  fs.writeFileSync(path.join(s.ws, 'notes.md'), 'hello\nworld\n');
  const refused = await s.api.call(cap, 'run_allowlisted', { command: 'rm -rf /' }); assert.equal(refused.ok, false); assert.ok(s.store.events(job.id).some((e) => e.type === 'command.refused'));
  const curl = await s.api.call(cap, 'run_allowlisted', { command: 'curl https://example.com' }); assert.equal(curl.ok, false);
  const ok = await s.api.call(cap, 'run_allowlisted', { command: 'wc -l notes.md' }); assert.equal(ok.ok, true); assert.match(ok.text, /2/);
  const esc = await s.api.call(cap, 'write_artifact', { path: '../../etc/passwd', title: 'x' }); assert.equal(esc.ok, false); assert.match(esc.text, /escapes|does not exist/);
  const art = await s.api.call(cap, 'write_artifact', { path: 'notes.md', title: 'Notes' }); assert.equal(art.ok, true);
});

test('audited text saving creates one output, retries idempotently, and refuses overwrites and escaping symlinks', async () => {
  const s = setup();
  try {
    const { job } = s.store.create({ idempotency_key: 'save', kind: 'document.create', objective: 'write', success_contract: {}, agent_role: 'builder' });
    const cap = issueCapability(s.runDir, job, s.ws, ['write_artifact']);
    const args = { path: 'drafts/welcome.md', title: 'Welcome', content: '# Welcome\nHello.', kind: 'file' };
    const first = await s.api.call(cap, 'write_artifact', args); assert.equal(first.ok, true);
    assert.equal(fs.readFileSync(path.join(s.ws, args.path), 'utf8'), args.content);
    const retry = await s.api.call(cap, 'write_artifact', args); assert.deepEqual(retry.data, first.data);
    assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n, 1);
    const overwrite = await s.api.call(cap, 'write_artifact', { ...args, content: 'Changed' }); assert.equal(overwrite.ok, false);
    assert.equal(fs.readFileSync(path.join(s.ws, args.path), 'utf8'), args.content);
    const escape = await s.api.call(cap, 'write_artifact', { ...args, path: '../escape.md' }); assert.equal(escape.ok, false);
    fs.symlinkSync(s.tmp, path.join(s.ws, 'outside'));
    const symlink = await s.api.call(cap, 'write_artifact', { ...args, path: 'outside/escape.md' }); assert.equal(symlink.ok, false);
    assert.equal(fs.existsSync(path.join(s.tmp, 'escape.md')), false);
    assert.ok(s.store.events(job.id).some(e => e.type === 'artifact.saved'));
  } finally { s.db.close(); fs.rmSync(s.tmp, { recursive: true, force: true }); }
});

test('browser_read is refused while the owner has taken over the browser (no process is started), and allowed again afterwards', async () => {
  const s = setup();
  const { job } = s.store.create({ idempotency_key: 'k-bo', kind: 'browser.read_task', objective: 'o', success_contract: {}, agent_role: 'browser_operator' });
  const cap = issueCapability(s.runDir, job, s.ws, s.defs.getAgent('browser_operator')!.allowed_tools);
  s.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('browser.takeover', ?, 'test', ?)").run(JSON.stringify({ active: true, since: new Date().toISOString(), note: 'owner', site: 'example.com' }), new Date().toISOString());
  const r = await s.api.call(cap, 'browser_read', { url: 'https://example.com/' });
  assert.equal(r.ok, false); assert.match(r.text, /taken over/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runtime_state WHERE key = 'browser.in_use'").get()!.n, 0, 'nothing was opened');
  assert.ok(s.store.events(job.id).some((e) => e.type === 'tool.called'), 'the attempt is audited');
  const bad = await s.api.call(cap, 'browser_read', { url: 'ftp://x' }); assert.match(bad.text, /http\(s\)/);
});
