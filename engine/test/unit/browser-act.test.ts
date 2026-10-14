import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { issueCapability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';
import { recordTaskTab } from '../../src/browser/tabs.ts';
import { parseSnapshot, decide } from '../../src/browser/act-policy.ts';

// The snapshot below is the real `openclaw browser snapshot --format ai` output of https://httpbin.org/forms/post (7 Oct 2026),
// trimmed, plus a search box. The browser itself is FAKED here (no Chrome, no network): these tests prove the policy and the
// broker's bookkeeping, not that clicks reach a real page.
const SNAP = `- generic [ref=e2]:
  - paragraph [ref=e3]:
      - textbox "Customer name:" [ref=e5]
      - textbox "Telephone:" [ref=e8]
  - group "Pizza Size" [ref=e12]:
        - radio "Small" [ref=e16]
        - checkbox "Bacon" [ref=e27]
      - textbox "Password" [ref=e50]
      - searchbox "Search this site" [ref=e60]
      - link "About us" [ref=e61]
      - button "Download PDF menu" [ref=e62]
  - paragraph [ref=e43]:
    - button "Submit order" [ref=e44]`;

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-')); const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db);
  const defs = new Definitions(db); defs.seedSystemDefaults(); const w = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'P' }, 't');
  const wf = defs.getWorkflow('browser.read_task')!;
  const job = store.create({ idempotency_key: 'b1', kind: wf.id, objective: 'o', success_contract: wf.contract, agent_role: 'browser_operator', workspace_id: w.id } as never).job;
  const wsDir = path.join(tmp, 'task'); fs.mkdirSync(wsDir, { recursive: true });
  const cap = issueCapability(path.join(tmp, 'run'), job, wsDir, defs.getAgent('browser_operator')!.allowed_tools);
  const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp, CLAUDEBOT_BROWSER_CDP_PORT: '1' } as NodeJS.ProcessEnv));
  const calls: string[][] = [];
  broker.browserRunner = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'snapshot') return { ok: true, stdout: SNAP, stderr: '' } as never;
    if (args[0] === 'download') { fs.writeFileSync(args[2], 'PDF-BYTES'); return { ok: true, stdout: '', stderr: '' } as never; }
    return { ok: true, stdout: 'ok', stderr: '' } as never;
  };
  return { tmp, db, store, approvals, broker, cap, job, calls, wsDir };
}
const acts = (s: ReturnType<typeof setup>, verb: string) => s.calls.filter((c) => c[0] === verb);

test('act policy: parses real snapshot lines and classifies preparation, consequential and forbidden actions', () => {
  const els = parseSnapshot(SNAP); const el = (r: string) => els.find((e) => e.ref === r);
  assert.deepEqual(el('e44'), { ref: 'e44', role: 'button', name: 'Submit order' });
  assert.equal(decide({ action: 'type', ref: 'e5', text: 'x' }, el('e5')).verdict, 'allow');
  assert.equal(decide({ action: 'type', ref: 'e50', text: 'x' }, el('e50')).verdict, 'refuse');
  const sub = decide({ action: 'click', ref: 'e44' }, el('e44')); assert.equal(sub.verdict, 'needs_approval'); assert.equal((sub as { action_kind: string }).action_kind, 'purchase');
  assert.equal(decide({ action: 'click', ref: 'e61' }, el('e61')).verdict, 'allow');
  assert.equal(decide({ action: 'click', ref: 'e16' }, el('e16')).verdict, 'allow');
  assert.equal(decide({ action: 'press', key: 'Enter' }, undefined, el('e60')).verdict, 'allow', 'Enter in a search box');
  assert.equal(decide({ action: 'press', key: 'Enter' }, undefined, el('e5'), els).verdict, 'needs_approval', 'Enter in a form whose button places an order');
  assert.equal(decide({ action: 'press', key: 'Enter' }, undefined, el('e5')).verdict, 'allow', 'Enter in an ordinary form field is not on the approval allowlist');
  assert.equal(decide({ action: 'press', key: 'Meta+a' }, undefined).verdict, 'refuse');
  assert.equal(decide({ action: 'download', ref: 'e62' }, el('e62')).verdict, 'allow');
  assert.equal(decide({ action: 'click', ref: 'e99' }, undefined).verdict, 'refuse', 'unknown element');
});

test('browser_act: without the task tab, during takeover, or into a password field nothing runs', async () => {
  const s = setup();
  let r = await s.broker.call(s.cap, 'browser_act', { action: 'type', ref: 'e5', text: 'A' }); assert.equal(r.ok, false); assert.match(r.text, /browser_read first/);
  recordTaskTab(s.db, s.job.id, 'TAB1');
  s.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('browser.takeover', ?, 't', 't')").run(JSON.stringify({ active: true }));
  r = await s.broker.call(s.cap, 'browser_act', { action: 'type', ref: 'e5', text: 'A' }); assert.equal(r.ok, false); assert.match(r.text, /taken over/);
  s.db.prepare("DELETE FROM runtime_state WHERE key = 'browser.takeover'").run();
  r = await s.broker.call(s.cap, 'browser_act', { action: 'type', ref: 'e50', text: 'hunter2' }); assert.equal(r.ok, false); assert.match(r.text, /credential or payment/);
  assert.equal(acts(s, 'type').length, 0, 'never typed');
  const refused = s.db.prepare("SELECT count(*) AS n FROM job_events WHERE type = 'browser.act_refused'").get() as { n: number }; assert.equal(refused.n, 1, 'the refusal is audited');
});

test('browser_act: preparation runs; a submit waits for an exact approval, runs once when approved, and goes stale if the values change', async () => {
  const s = setup(); recordTaskTab(s.db, s.job.id, 'TAB1');
  let r = await s.broker.call(s.cap, 'browser_act', { action: 'type', ref: 'e5', text: 'Test Customer' }); assert.equal(r.ok, true);
  assert.deepEqual(acts(s, 'type')[0], ['type', 'e5', 'Test Customer', '--target-id', 'TAB1']);
  r = await s.broker.call(s.cap, 'browser_act', { action: 'click', ref: 'e44' }); assert.equal(r.ok, false); assert.match(r.text, /owner's approval/);
  const aprId = (r.data as { approval_id: string }).approval_id; assert.match(aprId, /^apr-/);
  assert.equal(acts(s, 'click').length, 0, 'nothing submitted without approval');
  const again = await s.broker.call(s.cap, 'browser_act', { action: 'click', ref: 'e44' }); assert.equal((again.data as { approval_id: string }).approval_id, aprId, 'an identical request reuses the pending approval');
  const apr = s.approvals.get(aprId)!; assert.equal(apr.action_kind, 'purchase'); assert.match(apr.evidence, /Test Customer/, 'the owner sees the values that would be submitted');
  // An approval with the wrong id or still pending does not run it.
  r = await s.broker.call(s.cap, 'browser_act', { action: 'click', ref: 'e44', approval_id: aprId }); assert.equal(r.ok, false); assert.equal(acts(s, 'click').length, 0);
  s.approvals.decide(aprId, 'approved', 'owner');
  r = await s.broker.call(s.cap, 'browser_act', { action: 'click', ref: 'e44', approval_id: aprId }); assert.equal(r.ok, true); assert.match(r.text, /uncertain/);
  assert.equal(acts(s, 'click').length, 1, 'clicked exactly once');
  const act = s.db.prepare("SELECT status, approval_id, kind FROM actions WHERE idempotency_key = ?").get(`browser:${aprId}`) as { status: string; approval_id: string; kind: string }; assert.equal(act.status, 'performed'); assert.equal(act.kind, 'purchase');
  assert.equal(s.approvals.get(aprId)!.status, 'consumed');
  r = await s.broker.call(s.cap, 'browser_act', { action: 'click', ref: 'e44', approval_id: aprId }); assert.equal(r.ok, false); assert.equal(acts(s, 'click').length, 1, 'never twice');
  // Material change: approve, then change a value → the approval is stale and nothing is clicked.
  r = await s.broker.call(s.cap, 'browser_act', { action: 'click', ref: 'e44' }); const apr2 = (r.data as { approval_id: string }).approval_id; s.approvals.decide(apr2, 'approved', 'owner');
  await s.broker.call(s.cap, 'browser_act', { action: 'type', ref: 'e8', text: '555-0100' });
  r = await s.broker.call(s.cap, 'browser_act', { action: 'click', ref: 'e44', approval_id: apr2 }); assert.equal(r.ok, false); assert.match(r.text, /stale/);
  assert.equal(acts(s, 'click').length, 1); assert.equal(s.approvals.get(apr2)!.status, 'stale');
});

test('browser_act: Enter in a search box runs; Enter in a form field waits; type+submit types first and holds only the submit', async () => {
  const s = setup(); recordTaskTab(s.db, s.job.id, 'TAB1');
  let r = await s.broker.call(s.cap, 'browser_act', { action: 'type', ref: 'e60', text: 'fresnel', submit: true }); assert.equal(r.ok, true);
  assert.deepEqual(acts(s, 'type')[0], ['type', 'e60', 'fresnel', '--submit', '--target-id', 'TAB1']);
  r = await s.broker.call(s.cap, 'browser_act', { action: 'type', ref: 'e5', text: 'Name', submit: true }); assert.equal(r.ok, false); assert.match(r.text, /approval/);
  const t = acts(s, 'type'); assert.deepEqual(t[1], ['type', 'e5', 'Name', '--target-id', 'TAB1'], 'typed without submitting');
  assert.equal(acts(s, 'press').length, 0);
});

test('browser_act: a download lands in the task folder and is registered with its hash', async () => {
  const s = setup(); recordTaskTab(s.db, s.job.id, 'TAB1');
  const r = await s.broker.call(s.cap, 'browser_act', { action: 'download', ref: 'e62', filename: '../../menu.pdf' }); assert.equal(r.ok, true);
  const art = s.db.prepare("SELECT path, sha256 FROM artifacts WHERE job_id = ?").get(s.job.id) as { path: string; sha256: string };
  assert.equal(path.dirname(art.path), path.join(path.resolve(s.wsDir), 'downloads'), 'the filename cannot escape the task folder');
  assert.equal(art.sha256, crypto.createHash('sha256').update('PDF-BYTES').digest('hex'));
  fs.rmSync(s.tmp, { recursive: true, force: true });
});
