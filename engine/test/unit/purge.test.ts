import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, integrityCheck } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { purgeSyntheticData, businessCounts, markerHits, encodeProjectDir } from '../../src/maintenance/purge.ts';

function seeded() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-')); const dbPath = path.join(tmp, 'db.sqlite'); const db = openDatabase(dbPath); const store = new JobStore(db);
  db.prepare("INSERT INTO objectives(id,title,description,status,created_at) VALUES ('o1','Book 3 discovery calls with HVAC compliance buyers','x','active','t')").run();
  const { job } = store.create({ idempotency_key: 'k1', kind: 'research.report', objective: 'Which Arizona HVAC contractors advertise SMS reminders?', success_contract: {}, agent_role: 'researcher' });
  store.lease({ owner: 'w', leaseSeconds: 60 }); store.transition(job.id, 'running', 'w');
  store.checkpoint(job.id, { stage_index: 0, stage_name: 'a', attempt: 1, phase: 'after', payload: { note: 'MARIGOLD' } });
  db.prepare("INSERT INTO memory_evidence(id,job_id,title,body,source_url,grade,created_at) VALUES ('e1',?,'t','HVAC body','https://x','A','t')").run(job.id);
  db.prepare("INSERT INTO agent_definitions(id,name,purpose,is_system,created_at,updated_at) VALUES ('coordinator','Coordinator','p',1,'t','t')").run();
  db.prepare("INSERT INTO runtime_state(key,value,evidence,observed_at) VALUES ('claude.auth','{\"loggedIn\":true}','e','t')").run();
  const ws = path.join(tmp, 'ws', 'research', 'tasks', job.id); fs.mkdirSync(ws, { recursive: true }); fs.writeFileSync(path.join(ws, 'research.md'), 'HVAC');
  const claude = path.join(tmp, 'claude'); fs.mkdirSync(path.join(claude, 'projects', encodeProjectDir(ws)), { recursive: true }); fs.mkdirSync(path.join(claude, 'projects', '-private-var-folders-T-ros-real-abc-workspaces-x'), { recursive: true }); fs.mkdirSync(path.join(claude, 'projects', '-Users-me-code-unrelated'), { recursive: true });
  fs.writeFileSync(path.join(claude, '.credentials.json'), '{"keep":true}', { mode: 0o600 });
  const backups = path.join(tmp, 'backups'); fs.mkdirSync(backups); fs.writeFileSync(path.join(backups, 'claudebot-old-auto.sqlite'), 'blob HVAC blob'); fs.writeFileSync(path.join(backups, 'claudebot-clean-auto.sqlite'), 'blob clean');
  return { tmp, db, dbPath, store, job, ws, claude, backups };
}

test('purge removes synthetic business data transactionally, keeps auth/agents/settings, cleans files, and leaves zero markers (control: counts non-zero before)', async () => {
  const s = seeded();
  const before = businessCounts(s.db); assert.ok(before.jobs === 1 && before.objectives === 1 && before.memory_evidence === 1); assert.ok(markerHits(s.db).length > 0);
  const r = await purgeSyntheticData({ db: s.db, dbPath: s.dbPath, backupsDir: s.backups, workspacesDir: path.join(s.tmp, 'ws'), claudeConfigDir: s.claude, runDir: path.join(s.tmp, 'run'), mode: 'all' });
  assert.deepEqual(r.activeCancelled, [s.job.id]);
  const after = businessCounts(s.db); for (const [k, v] of Object.entries(after)) assert.equal(v, k === 'job_events' ? 1 : 0, `${k} not zero`);   // the one remaining event is the purge record itself
  assert.equal(markerHits(s.db).length, 0);
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM agent_definitions').get() as { n: number }).n, 1);
  assert.equal(JSON.parse((s.db.prepare("SELECT value FROM runtime_state WHERE key='claude.auth'").get() as { value: string }).value).loggedIn, true);
  assert.ok(fs.existsSync(path.join(s.claude, '.credentials.json')), 'credentials untouched');
  assert.ok(!fs.existsSync(s.ws)); assert.ok(!fs.existsSync(path.join(s.claude, 'projects', encodeProjectDir(s.ws)))); assert.ok(!fs.existsSync(path.join(s.claude, 'projects', '-private-var-folders-T-ros-real-abc-workspaces-x')));
  assert.ok(fs.existsSync(path.join(s.claude, 'projects', '-Users-me-code-unrelated')), 'unrelated transcripts kept');
  assert.ok(!fs.existsSync(path.join(s.backups, 'claudebot-old-auto.sqlite'))); assert.ok(fs.existsSync(path.join(s.backups, 'claudebot-clean-auto.sqlite')));
  assert.ok(fs.existsSync(r.preBackup) && fs.existsSync(r.postBackup));
  assert.equal(integrityCheck(s.db).ok, true);
  // ledger is append-only again after the purge
  assert.throws(() => s.db.prepare('DELETE FROM job_events').run(), /append-only/);
  assert.ok(s.db.prepare("SELECT 1 FROM job_events WHERE type='maintenance.purge'").get());
});

test('purge rolls back on failure (nothing deleted, triggers restored)', async () => {
  const s = seeded();
  // a real database-level failure late in the transaction (objectives are deleted last)
  s.db.exec("CREATE TRIGGER fail_objectives BEFORE DELETE ON objectives BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  await assert.rejects(() => purgeSyntheticData({ db: s.db, dbPath: s.dbPath, backupsDir: s.backups, workspacesDir: path.join(s.tmp, 'ws'), claudeConfigDir: s.claude, runDir: path.join(s.tmp, 'run'), mode: 'all' }), /boom/);
  const c = businessCounts(s.db); assert.equal(c.jobs, 1); assert.equal(c.checkpoints, 1); assert.equal(c.memory_evidence, 1); assert.ok(c.job_events > 1);
  assert.throws(() => s.db.prepare('DELETE FROM job_events').run(), /append-only/);
  assert.ok(fs.existsSync(s.ws), 'files untouched when the transaction fails');
});
