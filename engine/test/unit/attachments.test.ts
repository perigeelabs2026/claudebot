// Phase 4: owner attachments (type, size, text, hash, provenance, access through the existing rules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { saveAttachment, conversationAttachments, exportConversation } from '../../src/chat/attachments.ts';
import { readArtifact } from '../../src/broker/artifact-access.ts';

function setup() { const db = openDatabase(':memory:'); const store = new JobStore(db); const defs = new Definitions(db); defs.seedSystemDefaults(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'att-')); const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test'); const chat = new ChatStore(db, store); return { db, store, defs, ws, chat }; }

test('an attached text file is saved with its hash, readable by the conversation lead, and refused to other conversations', () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const bytes = Buffer.from('# Notes\n\nClaude Code 2.1.296 is pinned.\n');
  const r = saveAttachment(s.db, { conversation_id: c.id, name: 'notes.md', bytes });
  assert.equal(r.sha256, crypto.createHash('sha256').update(bytes).digest('hex')); assert.deepEqual(fs.readFileSync(r.path), bytes);
  assert.equal(conversationAttachments(s.db, c.id).length, 1);
  const turn = s.chat.send(c.id, 'Summarise the notes', s.defs).job;
  const ok = readArtifact(s.db, turn.id, r.artifact_id); assert.equal(ok.ok, true); assert.match((ok as { content: string }).content, /2\.1\.296/);
  const other = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] }); const t2 = s.chat.send(other.id, 'hi', s.defs).job;
  assert.equal(readArtifact(s.db, t2.id, r.artifact_id).ok, false, 'another conversation cannot read it');
});

test('attachments refuse unsupported types, empty, oversized and non-text files, with an explicit error', () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'run.sh', bytes: Buffer.from('echo hi') }), /cannot be attached/);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'a.txt', bytes: Buffer.alloc(0) }), /empty/);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'a.txt', bytes: Buffer.alloc(1024 * 1024 + 1, 97) }), /1 MB/);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'a.txt', bytes: Buffer.from([0xff, 0xfe, 0x00, 0x41]) }), /not readable text/);
  assert.equal(conversationAttachments(s.db, c.id).length, 0);
});

test('PDFs, Word documents and images attach when their bytes match their type (up to 10 MB); documents get a readable text copy', () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const r = saveAttachment(s.db, { conversation_id: c.id, name: 'Pasted image.png', bytes: png }); assert.deepEqual(fs.readFileSync(r.path), png);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'fake.pdf', bytes: Buffer.from('not a pdf') }), /not a real PDF/);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'big.png', bytes: Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]) }), /10 MB/);
  // a real .docx made with textutil gets a text copy the lead can read
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-')); fs.writeFileSync(path.join(tmp, 'a.txt'), 'Quarterly plan: partner revenue up 40%.');
  spawnSync('/usr/bin/textutil', ['-convert', 'docx', path.join(tmp, 'a.txt'), '-output', path.join(tmp, 'a.docx')]);
  if (fs.existsSync(path.join(tmp, 'a.docx'))) {
    const d = saveAttachment(s.db, { conversation_id: c.id, name: 'plan.docx', bytes: fs.readFileSync(path.join(tmp, 'a.docx')) });
    const copy = s.db.prepare("SELECT id FROM artifacts WHERE job_id = ? AND kind = 'note'").get(d.job_id) as { id: string };
    const turn = s.chat.send(c.id, 'read it', s.defs).job; const rd = readArtifact(s.db, turn.id, copy.id); assert.equal(rd.ok, true); assert.match((rd as { content: string }).content, /partner revenue up 40%/);
  }
});

test('Export chat writes every message in order (authors, times, files named) as one Markdown file, without a model', () => {
  const s = setup(); const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] });
  for (let i = 0; i < 60; i++) s.chat.add({ conversation_id: c.id, role: i % 2 ? 'assistant' : 'owner', sender: i % 2 ? 'coordinator' : 'owner', content: `line ${i} ${'x'.repeat(i * 50)}` });
  const r = exportConversation(s.db, c.id); const md = fs.readFileSync(r.path, 'utf8');
  assert.equal(r.messages, 60); for (let i = 0; i < 60; i++) assert.ok(md.includes(`line ${i} ${'x'.repeat(i * 50)}`), `message ${i} complete`);
  assert.ok(md.indexOf('line 10 ') < md.indexOf('line 11 ')); assert.match(md, /\*\*You\*\*/);
});
