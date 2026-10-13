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
import { ChatStore, plainState } from '../../src/chat/store.ts';
import { BrokerApi } from '../../src/broker/api.ts';
import { issueCapability } from '../../src/broker/capabilities.ts';
import { loadConfig } from '../../src/config.ts';
import { readArtifact } from '../../src/broker/artifact-access.ts';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-')); const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db);
  const defs = new Definitions(db); defs.seedSystemDefaults(); const wsm = new Workspaces(db, path.join(tmp, 'ws'));
  const a = wsm.create({ name: 'Project A' }, 't'); const b = wsm.create({ name: 'Project B' }, 't');
  const chat = new ChatStore(db, store); const broker = new BrokerApi(db, store, approvals, loadConfig({ CLAUDEBOT_HOME: tmp } as NodeJS.ProcessEnv));
  const art = (jobId: string, root: string, name: string, text: string) => { const f = path.join(root, 'tasks', jobId, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); const id = 'art-' + crypto.randomBytes(4).toString('hex'); db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, created_at) VALUES (?, ?, 'x', 'file', ?, ?, ?, ?)").run(id, jobId, f, crypto.createHash('sha256').update(text).digest('hex'), name, new Date().toISOString()); return { id, file: f }; };
  return { tmp, db, store, defs, a, b, chat, broker, art };
}

test('the lead reads complete specialist results of its own conversation (paged to the end); other conversations, projects, tampered and escaping files are refused explicitly', async () => {
  const s = setup();
  const conv = s.chat.create({ workspace_id: s.a.id }); const { job: turn } = s.chat.send(conv.id, 'research and review', s.defs);
  const mk = (kind: string, extra: Record<string, unknown> = {}) => { const wf = s.defs.getWorkflow(kind)!; return s.store.create({ idempotency_key: Math.random() + kind, kind, objective: 'o', success_contract: wf.contract, agent_role: wf.default_agent, workspace_id: s.a.id, ...extra }).job; };
  const review = mk('document.review', { parent_id: turn.id }); s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conv.id, review.id);
  const long = 'Verdict: PASS\n' + 'filler '.repeat(20_000) + '\nFIX 2: replace "guaranteed" with "may help".\n';
  const r1 = s.art(review.id, s.a.root_path, 'review.md', long);
  const cap = issueCapability(path.join(s.tmp, 'run'), turn, path.join(s.a.root_path, 'conversations', conv.id), s.defs.getAgent('coordinator')!.allowed_tools, 3600, conv.id);
  const first = await s.broker.call(cap, 'read_artifact', { id: r1.id }); assert.equal(first.ok, true); const p1 = JSON.parse(first.text);
  assert.equal(p1.total_chars, long.length); assert.ok(p1.next_offset > 0); assert.ok(!p1.content.includes('FIX 2'));
  let all = p1.content; let next = p1.next_offset; let pages = 1; while (next !== null) { const pg = JSON.parse((await s.broker.call(cap, 'read_artifact', { id: r1.id, offset: next })).text); all += pg.content; next = pg.next_offset; pages++; }
  assert.equal(all, long, 'paging reassembles the exact file'); assert.ok(pages >= 3); assert.match(all, /FIX 2: replace "guaranteed" with "may help"/);
  // another conversation in the same project → refused
  const other = s.chat.create({ workspace_id: s.a.id }); const { job: t2 } = s.chat.send(other.id, 'x', s.defs); const oj = mk('document.create'); s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(other.id, oj.id); const r2 = s.art(oj.id, s.a.root_path, 'secret.md', 'other');
  const refused = await s.broker.call(cap, 'read_artifact', { id: r2.id }); assert.equal(refused.ok, false); assert.match(refused.text, /outside this conversation/);
  // another project (even if somehow linked) → refused
  const bj = s.store.create({ idempotency_key: 'b', kind: 'document.create', objective: 'o', success_contract: {}, agent_role: 'builder', workspace_id: s.b.id }).job; const r3 = s.art(bj.id, s.b.root_path, 'b.md', 'project b');
  assert.equal(readArtifact(s.db, turn.id, r3.id).ok, false);
  // a dependency of a specialist is readable by that specialist
  const draft = mk('document.create', { depends_on: [review.id] }); s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conv.id, draft.id); assert.equal(readArtifact(s.db, draft.id, r1.id).ok, true);
  // a specialist does not read a sibling it does not depend on, even in the same conversation
  const sibling = mk('research.report', { parent_id: turn.id }); s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conv.id, sibling.id);
  const sib = readArtifact(s.db, sibling.id, r1.id); assert.equal(sib.ok, false, 'sibling specialist refused');
  // a dependency on another conversation's task is refused at creation and never grants reads
  const leadCap = cap; const dep = await s.broker.call(leadCap, 'create_job', { kind: 'document.create', objective: 'use the other conversation', depends_on: [oj.id] }); assert.equal(dep.ok, false); assert.match(dep.text, /not found in this conversation/);
  const sneaky = mk('document.create', { depends_on: [oj.id] }); s.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conv.id, sneaky.id); assert.equal(readArtifact(s.db, sneaky.id, r2.id).ok, false, 'a cross-conversation dependency grants nothing');
  // tampered file → explicit error, no content
  fs.appendFileSync(r1.file, 'tamper'); const t = readArtifact(s.db, turn.id, r1.id); assert.equal(t.ok, false); assert.match((t as { reason: string }).reason, /changed after it was saved/);
  // a symlink escaping the project folder → refused
  const outside = path.join(s.tmp, 'outside.md'); fs.writeFileSync(outside, 'x'); const link = path.join(s.a.root_path, 'tasks', review.id, 'link.md'); fs.symlinkSync(outside, link); s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, created_at) VALUES ('art-link', ?, 'x', 'file', ?, NULL, 'link', ?)").run(review.id, link, new Date().toISOString());
  const esc = readArtifact(s.db, turn.id, 'art-link'); assert.equal(esc.ok, false); assert.match((esc as { reason: string }).reason, /outside its project folder/);
  assert.ok(s.store.events(turn.id).some((e) => e.type === 'artifact.read_refused'));
});

test('outcome labels: legacy completions without an outcome read "outcome not recorded"; engine-verified workflows record success', () => {
  const s = setup();
  assert.equal(plainState({ state: 'completed', outcome: null, kind: 'browser.read_task', blocker_code: null, waiting_on: null, reset_at: null, retry_at: null }), 'Finished (outcome not recorded)');
  assert.equal(plainState({ state: 'completed', outcome: 'success', kind: 'browser.read_task', blocker_code: null, waiting_on: null, reset_at: null, retry_at: null }), 'Finished');
  assert.equal(plainState({ state: 'completed', outcome: null, kind: 'chat.turn', blocker_code: null, waiting_on: null, reset_at: null, retry_at: null }), 'Finished');
  const wf = s.defs.getWorkflow('system.workspace_summary')!; const { job } = s.store.create({ idempotency_key: 'w', kind: wf.id, objective: 'o', success_contract: wf.contract, agent_role: 'coordinator', workspace_id: s.a.id });
  s.store.lease({ owner: 'w', leaseSeconds: 30 }); s.store.transition(job.id, 'running', 'w');
  s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, title, created_at) VALUES ('n1', ?, 'x', 'note', 'n', ?)").run(job.id, new Date().toISOString());
  const r = s.store.complete(job.id, 'w', { brief_path: '/x' }); assert.equal(r.ok, true); assert.equal(s.store.get(job.id)!.outcome, 'success'); assert.match(s.store.get(job.id)!.outcome_detail, /engine/);
});
