import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { Settings, defaultWorkerLimit } from '../../src/model/settings.ts';
import { businessCounts } from '../../src/maintenance/purge.ts';

function fresh() { const db = openDatabase(':memory:'); const defs = new Definitions(db); defs.seedSystemDefaults(); return { db, defs }; }

test('a clean database has the neutral system set, no business data, and no revenue pack', () => {
  const { db, defs } = fresh();
  assert.deepEqual(defs.listAgents().map((a) => a.id).sort(), ['browser_operator', 'builder', 'coordinator', 'researcher', 'reviewer']);
  assert.ok(defs.listWorkflows().every((w) => w.is_system && !w.template_pack));
  assert.ok(!defs.listWorkflows().some((w) => /rev\.|campaign|sales|gtm|funnel/i.test(w.id)));
  const counts = businessCounts(db); for (const v of Object.values(counts)) assert.equal(v, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n, 0);
  assert.equal(defs.listPacks().find((p) => p.id === 'revenue_ops')!.installed_at, null);
  assert.deepEqual(defs.seedSystemDefaults(), { agents: 5, workflows: defs.listWorkflows().length }); // idempotent upsert, no duplicates
  assert.equal(defs.listAgents().length, 5);
});

test('installing the revenue pack adds definitions only, creates zero records, and uninstalls cleanly; every agent forbids consequential actions', () => {
  const { db, defs } = fresh();
  const r = defs.installPack('revenue_ops', 'owner'); assert.ok(r.ok); assert.equal(r.agents, 4); assert.equal(r.workflows, 4);
  for (const [k, v] of Object.entries(businessCounts(db))) assert.equal(v, k === 'job_events' ? 1 : 0, k);   // only the audit event of the install itself
  assert.ok(defs.getWorkflow('rev.market_scan')!.template_pack === 'revenue_ops');
  for (const a of defs.listAgents()) assert.ok(a.prohibited_actions.some((p) => /send email/.test(p)), a.id);
  const u = defs.uninstallPack('revenue_ops', 'owner'); assert.ok(u.ok); assert.equal(defs.getWorkflow('rev.market_scan'), undefined); assert.equal(defs.listAgents().length, 5);
  assert.ok(db.prepare("SELECT 1 FROM job_events WHERE type='template.installed'").get()); assert.ok(db.prepare("SELECT 1 FROM job_events WHERE type='template.uninstalled'").get());
});

test('system definitions are protected; owner definitions are editable, duplicable, removable; stages are validated', () => {
  const { defs } = fresh();
  assert.equal(defs.deleteAgent('researcher', 'owner').ok, false);
  const w = defs.upsertWorkflow({ id: 'research.report', name: 'x', default_agent: 'researcher', stages: [] }, 'owner'); assert.equal(w.ok, false);
  const bad = defs.upsertWorkflow({ id: 'mine', name: 'Mine', default_agent: 'nobody', stages: [{ name: 'a', kind: 'claude' }, { name: 'a', kind: 'bogus' as never }] }, 'owner');
  assert.equal(bad.ok, false); assert.ok((bad as { errors: string[] }).errors.length >= 3);
  const good = defs.upsertWorkflow({ id: 'mine', name: 'Mine', default_agent: 'builder', stages: [{ name: 'prep', kind: 'deterministic', fn: 'prepare_workspace' }, { name: 'do', kind: 'claude', prompt: 'x', agent: 'researcher' }] }, 'owner'); assert.ok(good.ok);
  const dup = defs.duplicateWorkflow('research.report', 'research.report.copy', 'owner'); assert.ok(dup.ok); assert.equal(defs.getWorkflow('research.report.copy')!.is_system, false);
  const a = defs.upsertAgent({ id: 'analyst', name: 'Analyst', purpose: 'p', allowed_tools: ['read_records'] }, 'owner'); assert.equal(a.is_system, false);
  defs.setAgentEnabled('analyst', false, 'owner'); assert.equal(defs.listAgents().some((x) => x.id === 'analyst'), false); assert.equal(defs.listAgents({ includeDisabled: true }).some((x) => x.id === 'analyst'), true);
  assert.ok(defs.deleteAgent('analyst', 'owner').ok);
});

test('workspaces: create, export without secrets, import, duplicate without history, effective policy', () => {
  const { db, defs } = fresh(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsx-')); const ws = new Workspaces(db, tmp);
  const w = ws.create({ name: 'Client Research', description: 'd', worker_limit: 3 }, 'owner');
  assert.equal(w.id, 'client-research'); assert.ok(fs.existsSync(w.root_path)); assert.equal((fs.statSync(w.root_path).mode & 0o777), 0o700);
  db.prepare("INSERT INTO objectives(id,title,description,status,created_at,workspace_id) VALUES ('o1','Goal','',  'active','t',?)").run(w.id);
  const exp = ws.exportConfig(w.id)!; assert.equal(JSON.stringify(exp).includes('token'), false); assert.equal((exp.objectives as unknown[]).length, 1);
  const imp = ws.importConfig(exp, 'owner'); assert.equal(imp.id, 'client-research-2'); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM objectives WHERE workspace_id = ?').get(imp.id) as { n: number }).n, 1);
  const dup = ws.duplicate(w.id, 'Copy', 'owner')!; assert.equal((db.prepare('SELECT COUNT(*) AS n FROM objectives WHERE workspace_id = ?').get(dup.id) as { n: number }).n, 0);
  const pol = ws.effectivePolicy(w.id, defs.getAgent('researcher'), 10) as { global: { executors_enabled: unknown[] }; agent: { allowed_tools: string[] } };
  assert.deepEqual(pol.global.executors_enabled, []); assert.ok(pol.agent.allowed_tools.includes('browser_read'));
  ws.archive(w.id, 'owner'); assert.equal(ws.list().some((x) => x.id === w.id), false); assert.equal(ws.list({ includeArchived: true }).some((x) => x.id === w.id), true);
});

test('settings: safe default worker limit and validated writes', () => {
  const { db } = fresh(); const s = new Settings(db);
  assert.equal(defaultWorkerLimit(14, 24), 10); assert.equal(defaultWorkerLimit(4, 8), 4); assert.ok(defaultWorkerLimit(2, 4) >= 2);
  assert.throws(() => s.set('worker_limit', 0, 'owner')); s.set('worker_limit', 12, 'owner'); assert.equal(s.get('worker_limit'), 12);
  assert.ok(db.prepare("SELECT 1 FROM job_events WHERE type='setting.changed'").get());
});

test('memory governor reads a real pressure level on this platform (never the misleading os.freemem fallback on macOS)', async () => {
  const { memoryLevelPct, freeMemoryMb } = await import('../../src/supervisor/dispatcher.ts');
  const lvl = memoryLevelPct(); assert.ok(lvl >= 0 && lvl <= 100);
  if (process.platform === 'darwin') { const { execFileSync } = await import('node:child_process'); const sys = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' }).trim()); assert.ok(Math.abs(sys - lvl) <= 15, `level ${lvl} vs sysctl ${sys}`); assert.ok(freeMemoryMb() > 256); }
});

test('seed refreshes a system agent\'s tools until the owner edits it; an owner edit is then preserved', () => {
  const db = openDatabase(':memory:'); const defs = new Definitions(db); defs.seedSystemDefaults();
  db.prepare("UPDATE agent_definitions SET allowed_tools = '[\"read_records\"]' WHERE id = 'coordinator'").run();   // an older install
  defs.seedSystemDefaults(); assert.ok(defs.getAgent('coordinator')!.allowed_tools.includes('request_approval'), 'never-edited system agent picks up new seed tools');
  defs.upsertAgent({ ...defs.getAgent('coordinator')!, allowed_tools: ['read_records'] }, 'owner');
  defs.seedSystemDefaults(); assert.deepEqual(defs.getAgent('coordinator')!.allowed_tools, ['read_records'], 'owner edit wins afterwards');
});
