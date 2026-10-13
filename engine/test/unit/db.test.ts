import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, tableNames, integrityCheck, migrate } from '../../src/db/open.ts';

test('fresh database has the ledger tables and is idempotent to migrate', () => {
  const db = openDatabase(':memory:');
  const names = tableNames(db);
  for (const t of ['jobs','job_events','checkpoints','approvals','actions','schedules','runtime_state','incidents','artifacts','browser_sites','memory_rules','memory_evidence','memory_proposals','records','workspaces','agent_definitions','workflow_definitions','template_packs','settings','objectives']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  assert.deepEqual(migrate(db), []);
  for (const gone of ['agents','opportunities','experiments','outcomes','costs']) assert.ok(!names.includes(gone), `${gone} should be gone`);
  assert.equal(integrityCheck(db).ok, true);
});

test('job_events is append-only: update and delete are rejected, insert is allowed (control)', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO job_events(job_id, at, actor, type, detail) VALUES ('j1', '2026-10-06T00:00:00Z', 'system', 'job.created', '{}')").run();
  assert.throws(() => db.prepare("UPDATE job_events SET type='x' WHERE job_id='j1'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM job_events WHERE job_id='j1'").run(), /append-only/);
  const n = (db.prepare('SELECT COUNT(*) AS n FROM job_events').get() as { n: number }).n;
  assert.equal(n, 1);
});
