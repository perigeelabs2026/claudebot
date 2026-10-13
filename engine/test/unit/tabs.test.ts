import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/db/open.ts';
import { recordTaskTab, taskTab, releaseTaskTabs, newTabId, readTaskTabs } from '../../src/browser/tabs.ts';

test('task tabs are recorded, reused, and closed when the task ends; owner-followed tabs and takeover are respected; owner tabs are never touched', async () => {
  const db = openDatabase(':memory:');
  assert.equal(newTabId([{ id: 'owner1' }], [{ id: 'owner1' }, { id: 't1' }]), 't1'); assert.equal(newTabId([{ id: 'a' }], [{ id: 'a' }]), null);
  recordTaskTab(db, 'job-1', 't1'); recordTaskTab(db, 'job-1', 't1'); recordTaskTab(db, 'job-1', 't2'); recordTaskTab(db, 'job-2', 't3');
  assert.deepEqual(readTaskTabs(db)['job-1'], ['t1', 't2']); assert.equal(taskTab(db, 'job-1'), 't2');
  const closed: string[] = []; const closer = async (id: string) => { closed.push(id); return id !== 't2'; };
  const r = await releaseTaskTabs(db, 'job-1', closer); assert.deepEqual(r.closed, ['t1']); assert.deepEqual(r.kept, ['t2']); assert.equal(readTaskTabs(db)['job-1'], undefined); assert.deepEqual(readTaskTabs(db)['job-2'], ['t3'], 'other tasks untouched');
  assert.ok(!closed.includes('owner1'), 'only recorded task tabs are ever closed');
  // owner follows the task's tab → kept
  db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('browser.follow', ?, 'x', ?)").run(JSON.stringify({ id: 't3', url: 'u', by: 'owner' }), new Date().toISOString());
  const r2 = await releaseTaskTabs(db, 'job-2', closer); assert.deepEqual(r2.kept, ['t3']); assert.deepEqual(r2.closed, []);
  // takeover active → nothing closed, bookkeeping kept
  recordTaskTab(db, 'job-3', 't9'); db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('browser.takeover', ?, 'x', ?)").run(JSON.stringify({ active: true }), new Date().toISOString());
  const r3 = await releaseTaskTabs(db, 'job-3', closer); assert.equal(r3.reason, 'owner takeover active'); assert.deepEqual(readTaskTabs(db)['job-3'], ['t9']);
});
