import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, integrityCheck } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { purgeSyntheticData, businessCounts, markerHits, encodeProjectDir, FIXTURE_SENTINEL as F } from '../../src/maintenance/purge.ts';

function seeded() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-')); const dbPath = path.join(tmp, 'db.sqlite'); const db = openDatabase(dbPath); const store = new JobStore(db);
  db.prepare("INSERT INTO objectives(id,title,description,status,created_at) VALUES ('o1',?,'x','active','t')").run(`Book 3 discovery calls ${F}`);
  const { job } = store.create({ idempotency_key: 'k1', kind: 'research.report', objective: `Which contractors advertise SMS reminders? ${F}`, success_contract: {}, agent_role: 'researcher' });
  store.lease({ owner: 'w', leaseSeconds: 60 }); store.transition(job.id, 'running', 'w');
  store.checkpoint(job.id, { stage_index: 0, stage_name: 'a', attempt: 1, phase: 'after', payload: { note: F } });
  db.prepare("INSERT INTO memory_evidence(id,job_id,title,body,source_url,grade,created_at) VALUES ('e1',?,'t',?,'https://x','A','t')").run(job.id, `body ${F}`);
  db.prepare("INSERT INTO agent_definitions(id,name,purpose,is_system,created_at,updated_at) VALUES ('coordinator','Coordinator','p',1,'t','t')").run();
  db.prepare("INSERT INTO runtime_state(key,value,evidence,observed_at) VALUES ('claude.auth','{\"loggedIn\":true}','e','t')").run();
  const ws = path.join(tmp, 'ws', 'research', 'tasks', job.id); fs.mkdirSync(ws, { recursive: true }); fs.writeFileSync(path.join(ws, 'research.md'), F);
  const claude = path.join(tmp, 'claude'); fs.mkdirSync(path.join(claude, 'projects', encodeProjectDir(ws)), { recursive: true }); fs.mkdirSync(path.join(claude, 'projects', '-private-var-folders-T-ros-real-abc-workspaces-x'), { recursive: true }); fs.mkdirSync(path.join(claude, 'projects', '-Users-me-code-unrelated'), { recursive: true });
  fs.writeFileSync(path.join(claude, '.credentials.json'), '{"keep":true}', { mode: 0o600 });
  const backups = path.join(tmp, 'backups'); fs.mkdirSync(backups); fs.writeFileSync(path.join(backups, 'claudebot-old-auto.sqlite'), `blob ${F} blob`); fs.writeFileSync(path.join(backups, 'claudebot-clean-auto.sqlite'), 'blob clean');
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
  assert.ok(!fs.existsSync(s.ws)); assert.ok(!fs.existsSync(path.join(s.claude, 'projects', encodeProjectDir(s.ws)))); assert.ok(fs.existsSync(path.join(s.claude, 'projects', '-private-var-folders-T-ros-real-abc-workspaces-x')), 'a folder is never removed for its name alone');
  assert.ok(fs.existsSync(path.join(s.claude, 'projects', '-Users-me-code-unrelated')), 'unrelated transcripts kept');
  assert.ok(!fs.existsSync(path.join(s.backups, 'claudebot-old-auto.sqlite'))); assert.ok(fs.existsSync(path.join(s.backups, 'quarantine', 'claudebot-old-auto.sqlite')), 'quarantined, not deleted'); assert.deepEqual(r.quarantinedBackups, ['claudebot-old-auto.sqlite']);
  assert.equal(fs.statSync(path.join(s.backups, 'quarantine', 'claudebot-old-auto.sqlite')).mode & 0o777, 0o600); assert.ok(fs.existsSync(path.join(s.backups, 'claudebot-clean-auto.sqlite')));
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

test('purge by markers never touches real work: an answer that says "discovery calls" survives; only rows carrying the fixture token go', async () => {
  const s = seeded();
  const real = s.store.create({ idempotency_key: 'real-1', kind: 'research.report', objective: 'Answer the application: I run discovery calls and virtual demos daily for HVAC and install day teams', success_contract: {}, agent_role: 'researcher' }).job;
  s.db.prepare("INSERT INTO objectives(id,title,description,status,created_at) VALUES ('o2','Book discovery calls with HVAC buyers','install day prep','active','t')").run();
  s.db.prepare("INSERT INTO memory_evidence(id,job_id,title,body,source_url,grade,created_at) VALUES ('e2',?,'t','I run discovery calls and virtual demos daily','https://x','A','t')").run(real.id);
  const r = await purgeSyntheticData({ db: s.db, dbPath: s.dbPath, backupsDir: s.backups, workspacesDir: path.join(s.tmp, 'ws'), claudeConfigDir: s.claude, runDir: path.join(s.tmp, 'run'), mode: 'markers' });
  assert.ok(s.store.get(real.id), 'the real job survives'); assert.ok(!s.store.get(s.job.id), 'the fixture job is gone');
  assert.ok(s.db.prepare("SELECT 1 FROM objectives WHERE id = 'o2'").get(), 'the real objective survives'); assert.equal(s.db.prepare("SELECT 1 FROM objectives WHERE id = 'o1'").get(), undefined);
  assert.ok(s.db.prepare("SELECT 1 FROM memory_evidence WHERE id = 'e2'").get(), 'the real answer survives'); assert.equal(markerHits(s.db).length, 0);
  assert.ok(!r.removedBackups.includes('claudebot-clean-auto.sqlite'));
});

test('purge by markers refuses when a fixture-token task sits in a real project, prints which, and changes nothing; a test project is fine', async () => {
  const s = seeded(); const { Workspaces } = await import('../../src/model/workspaces.ts'); const wss = new Workspaces(s.db, path.join(s.tmp, 'wsx'));
  const real = wss.create({ name: 'Job hunt' }, 't'); const rehearsal = wss.create({ name: 'Rehearsal', policies: { test: true } }, 't');
  s.db.prepare('UPDATE jobs SET workspace_id = ? WHERE id = ?').run(real.id, s.job.id);
  const before = businessCounts(s.db);
  await assert.rejects(() => purgeSyntheticData({ db: s.db, dbPath: s.dbPath, backupsDir: s.backups, workspacesDir: path.join(s.tmp, 'ws'), claudeConfigDir: s.claude, runDir: path.join(s.tmp, 'run'), mode: 'markers' }), /refusing to purge: 1 task.*Job hunt/);
  assert.deepEqual(businessCounts(s.db), before, 'nothing changed');
  s.db.prepare('UPDATE jobs SET workspace_id = ? WHERE id = ?').run(rehearsal.id, s.job.id);
  await purgeSyntheticData({ db: s.db, dbPath: s.dbPath, backupsDir: s.backups, workspacesDir: path.join(s.tmp, 'ws'), claudeConfigDir: s.claude, runDir: path.join(s.tmp, 'run'), mode: 'markers' });
  assert.ok(!s.store.get(s.job.id));
});

test('backup rotation keeps the newest of the same label only: rollback points survive any number of automatic snapshots', async () => {
  const s = seeded(); const { snapshot } = await import('../../src/supervisor/backup.ts'); const dir = path.join(s.tmp, 'rot');
  const pre = await snapshot(s.db, dir, 50, 'pre-purge'); fs.writeFileSync(path.join(dir, 'claudebot-2026-01-01T00-00-00-000Z-pre-migration.sqlite'), 'x');
  for (let i = 0; i < 5; i++) { await snapshot(s.db, dir, 2, 'auto'); await new Promise((r) => setTimeout(r, 5)); }
  const files = fs.readdirSync(dir); assert.equal(files.filter((f) => f.endsWith('-auto.sqlite')).length, 2);
  assert.ok(fs.existsSync(pre)); assert.ok(files.some((f) => f.endsWith('-pre-migration.sqlite')));
});

test('test projects are marked by policies.test, not by Telegram being off: a real project with Telegram off still counts; old Telegram-off projects become test projects once', async () => {
  const { Workspaces } = await import('../../src/model/workspaces.ts'); const { liveTasks } = await import('../../src/cos/report.ts');
  const s = seeded(); const wss = new Workspaces(s.db, path.join(s.tmp, 'wsy'));
  const quiet = wss.create({ name: 'Real, Telegram off', policies: { telegram: false } }, 't'); const rehearsal = wss.create({ name: 'Rehearsal', policies: { test: true } }, 't');
  const a = s.store.create({ idempotency_key: 'q1', kind: 'research.report', objective: 'real work', success_contract: {}, agent_role: 'researcher', workspace_id: quiet.id }).job;
  const b = s.store.create({ idempotency_key: 'q2', kind: 'research.report', objective: 'rehearsal work', success_contract: {}, agent_role: 'researcher', workspace_id: rehearsal.id }).job;
  const ids = liveTasks(s.db, { realOnly: true, limit: 50 }).map((t) => t.id); assert.ok(ids.includes(a.id), 'Telegram off is still real work'); assert.ok(!ids.includes(b.id));
  // The migration: a project that was a test project by the old rule (Telegram off) keeps that status.
  const old = wss.create({ name: 'Old rehearsal', policies: { telegram: false } }, 't');
  s.db.exec(fs.readFileSync(path.join(import.meta.dirname, '../../src/db/migrations/0013_test_projects.sql'), 'utf8'));
  assert.equal(JSON.parse((s.db.prepare('SELECT policies FROM workspaces WHERE id = ?').get(old.id) as { policies: string }).policies).test, true);
});
