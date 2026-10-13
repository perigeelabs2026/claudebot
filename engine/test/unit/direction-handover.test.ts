import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { dependencyInputs } from '../../src/worker/run.ts';

// Found in installed acceptance on 7 Oct: the owner's direction to the Writer reached the Writer, but the Reviewer
// (which depends on the Writer) never saw it and failed the note for following it, and the lead asked whether the
// owner had really written it. Direction must travel with the task it was given to.
test("a dependent task receives the owner's direction given to the task it depends on; without direction nothing is added", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-')); const db = openDatabase(':memory:'); const store = new JobStore(db);
  const defs = new Definitions(db); defs.seedSystemDefaults(); const w = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'P' }, 't');
  const mk = (kind: string, extra: Record<string, unknown> = {}) => { const wf = defs.getWorkflow(kind)!; return store.create({ idempotency_key: Math.random() + kind, kind, objective: 'o', success_contract: wf.contract, agent_role: wf.default_agent, workspace_id: w.id, ...extra } as never).job; };
  const writer = mk('document.create'); const plain = mk('document.create');
  store.event(writer.id, 'owner', 'owner.direction', { note: 'Title it "Owner Title" and end with "Checked."', via: 'office' });
  store.event(plain.id, 'owner', 'owner.direction', { note: 'Scripted note.', via: 'api' });
  const reviewer = mk('document.review', { depends_on: [writer.id] });
  const control = mk('document.review', { depends_on: [plain.id] });
  const withDir = dependencyInputs(db, store.get(reviewer.id)!); const without = dependencyInputs(db, store.get(control.id)!);
  assert.match(withDir, /Direction the owner gave that task/); assert.match(withDir, /Title it "Owner Title" and end with "Checked\."/);
  assert.doesNotMatch(without, /Direction the owner gave/, 'control: a scripted direction is never presented as the owner\'s');
  assert.match(without, /through the API \(by a script/); assert.match(without, /Scripted note\./);
  // the lead's update names the direction as the owner's own
  const chat = new ChatStore(db, store); const conv = chat.create({ workspace_id: w.id }); chat.send(conv.id, 'write it', defs);
  db.prepare('UPDATE jobs SET conversation_id = ?, parent_id = (SELECT id FROM jobs WHERE kind = ? LIMIT 1) WHERE id = ?').run(conv.id, 'chat.turn', writer.id);
  const upd = chat.updatesSince(conv.id, defs); assert.match(upd, /the owner gave this task themselves/);
  db.close(); fs.rmSync(tmp, { recursive: true, force: true });
});
