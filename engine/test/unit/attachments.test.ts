// Phase 4: owner attachments (type, size, text, hash, provenance, access through the existing rules).
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
import { saveAttachment, conversationAttachments } from '../../src/chat/attachments.ts';
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
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'run.sh', bytes: Buffer.from('echo hi') }), /only text files/);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'a.txt', bytes: Buffer.alloc(0) }), /empty/);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'a.txt', bytes: Buffer.alloc(1024 * 1024 + 1, 97) }), /1 MB/);
  assert.throws(() => saveAttachment(s.db, { conversation_id: c.id, name: 'a.txt', bytes: Buffer.from([0xff, 0xfe, 0x00, 0x41]) }), /not readable text/);
  assert.equal(conversationAttachments(s.db, c.id).length, 0);
});
