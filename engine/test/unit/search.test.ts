import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { searchScoped, ftsQuery } from '../../src/search/index.ts';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-')); const db = openDatabase(':memory:'); const store = new JobStore(db);
  const defs = new Definitions(db); defs.seedSystemDefaults(); const wsm = new Workspaces(db, path.join(tmp, 'ws'));
  const A = wsm.create({ name: 'A' }, 't'); const B = wsm.create({ name: 'B' }, 't'); const chat = new ChatStore(db, store);
  const mk = (kind: string, ws: string, conv: string | null, extra: Record<string, unknown> = {}) => { const wf = defs.getWorkflow(kind)!; const j = store.create({ idempotency_key: crypto.randomUUID(), kind, objective: 'o', success_contract: wf.contract, agent_role: wf.default_agent, workspace_id: ws, ...extra } as never).job; if (conv) db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conv, j.id); return j; };
  const art = (jobId: string, text: string) => { const f = path.join(tmp, `${jobId}.md`); fs.writeFileSync(f, text); const id = 'art-' + crypto.randomBytes(4).toString('hex'); db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, jobId, 's', 'file', f, crypto.createHash('sha256').update(text).digest('hex'), `Result of ${jobId}`, '{}', new Date().toISOString()); return { id, f }; };
  const ev = (jobId: string, title: string, body: string) => db.prepare("INSERT INTO memory_evidence(id, job_id, title, body, source_url, grade, created_at) VALUES (?,?,?,?,?,?,?)").run('ev-' + crypto.randomBytes(4).toString('hex'), jobId, title, body, 'https://example.org/src', 'A', new Date().toISOString());
  return { tmp, db, store, defs, A, B, chat, mk, art, ev };
}

test('search: a specialist sees its conversation, its project\'s evidence and readable results only; provenance is returned', () => {
  const s = setup();
  const c1 = s.chat.create({ workspace_id: s.A.id }); const { job: lead1 } = s.chat.send(c1.id, 'Find facts about Fresnel lenses for lighthouses', s.defs);
  const c2 = s.chat.create({ workspace_id: s.A.id }); s.chat.send(c2.id, 'Private plan: Fresnel budget for the other conversation', s.defs);
  const r1 = s.mk('research.report', s.A.id, c1.id, { parent_id: lead1.id }); const sib = s.mk('document.create', s.A.id, c2.id);
  s.art(r1.id, '# Report\nFresnel lenses concentrate light into a beam.'); s.art(sib.id, 'Fresnel secret from the other conversation');
  s.ev(r1.id, 'Fresnel lens history', 'Invented by Augustin Fresnel in 1822.');
  const bJob = s.mk('research.report', s.B.id, null); s.ev(bJob.id, 'Fresnel in project B', 'Should never appear in project A');
  const hits = searchScoped(s.db, r1.id, 'fresnel').hits;
  assert.ok(hits.some((h) => h.kind === 'result' && h.job_id === r1.id && /concentrate/.test(h.snippet)), 'own result found, with snippet');
  assert.ok(hits.some((h) => h.kind === 'evidence' && h.source === 'https://example.org/src' && h.job_id === r1.id), 'evidence with its source');
  assert.ok(hits.some((h) => h.kind === 'message' && h.conversation_id === c1.id), 'own conversation message');
  assert.ok(!hits.some((h) => h.conversation_id === c2.id || h.job_id === sib.id), 'nothing from the other conversation');
  assert.ok(!hits.some((h) => /project B/.test(h.title)), 'nothing from the other project');
  for (const h of hits) { assert.ok(h.ref && h.created_at && h.kind); }
});

test('search: the lead searches its project\'s conversations but not other projects; results still follow read scope', () => {
  const s = setup();
  const c1 = s.chat.create({ workspace_id: s.A.id }); const { job: lead1 } = s.chat.send(c1.id, 'Lighthouse question', s.defs);
  const c2 = s.chat.create({ workspace_id: s.A.id }); s.chat.send(c2.id, 'Last week we decided the Fresnel note goes in the handbook', s.defs);
  const c3 = s.chat.create({ workspace_id: s.B.id }); s.chat.send(c3.id, 'Fresnel in another project entirely', s.defs);
  const other = s.mk('document.create', s.A.id, c2.id); s.art(other.id, 'Fresnel handbook draft (other conversation)');
  const hits = searchScoped(s.db, lead1.id, 'fresnel').hits;
  assert.ok(hits.some((h) => h.kind === 'message' && h.conversation_id === c2.id), 'the lead finds an earlier conversation of the same project');
  assert.ok(!hits.some((h) => h.conversation_id === c3.id), 'never another project');
  assert.ok(!hits.some((h) => h.kind === 'result' && h.job_id === other.id), 'a result outside this conversation stays unreadable, so it is not shown either');
  const owner = searchScoped(s.db, null, 'fresnel', { owner: {} }).hits; assert.ok(owner.some((h) => h.conversation_id === c3.id), 'the owner searches everything');
});

test('search: query text cannot inject FTS operators; a changed result is re-indexed; unknown requester sees nothing', () => {
  const s = setup();
  assert.equal(ftsQuery('NEAR( "x" OR y* -z'), '"NEAR"* AND "OR"*');
  const c1 = s.chat.create({ workspace_id: s.A.id }); const { job: lead } = s.chat.send(c1.id, 'hi', s.defs);
  const j = s.mk('document.create', s.A.id, c1.id, { parent_id: lead.id }); const a = s.art(j.id, 'alpha content');
  assert.equal(searchScoped(s.db, j.id, 'alpha').hits.length, 1);
  assert.doesNotThrow(() => searchScoped(s.db, j.id, '") OR 1=1 --'));
  fs.writeFileSync(a.f, 'bravo content'); s.db.prepare('UPDATE artifacts SET sha256 = ? WHERE id = ?').run(crypto.createHash('sha256').update('bravo content').digest('hex'), a.id);
  assert.equal(searchScoped(s.db, j.id, 'alpha').hits.filter((h) => h.kind === 'result').length, 0, 'old text gone');
  assert.equal(searchScoped(s.db, j.id, 'bravo').hits.filter((h) => h.kind === 'result').length, 1, 'new text indexed');
  assert.equal(searchScoped(s.db, 'job-nope', 'alpha').hits.length, 0);
  fs.rmSync(s.tmp, { recursive: true, force: true });
});
