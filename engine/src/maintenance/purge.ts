/**
 * Explicit maintenance operation: remove synthetic/fixture business data from a production database and its
 * dependent files. Transactional, with a pre-clean backup. Structural configuration (agents, schedules definitions,
 * runtime_state auth/health keys, settings) is preserved. Called by `bin/claudebot maintenance purge`.
 */
import { rebuildSearchIndex } from '../search/index.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/open.ts';
import { snapshot } from '../supervisor/backup.ts';

/** The one marker a fixture carries: a fixed token that cannot occur in real work. Ordinary words ('HVAC', 'discovery calls', …) were
 *  markers once and matched real answers ("I run discovery calls and virtual demos daily"), so a purge could delete real work. A row is
 *  removed only when it (or the fixture job it belongs to) carries this token. */
export const FIXTURE_SENTINEL = 'FIXTURE-7c1e2a9d-4b3f-4e8a-9d61-claudebot';
export const FIXTURE_MARKERS: readonly string[] = [FIXTURE_SENTINEL];

export function allTextColumns(db: DB): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all() as Array<{ name: string }>)
    for (const c of db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string; type: string }>) if (!/INT|REAL|NUM/i.test(c.type)) out.push([t.name, c.name]);
  return out;
}

export interface PurgeCounts { objectives: number; jobs: number; job_events: number; checkpoints: number; artifacts: number; approvals: number; actions: number; memory_evidence: number; memory_proposals: number; records: number; incidents: number; browser_sites: number }
const BUSINESS_TABLES = ['objectives', 'jobs', 'job_events', 'checkpoints', 'artifacts', 'approvals', 'actions', 'memory_evidence', 'memory_proposals', 'records', 'incidents', 'browser_sites'] as const;

export function businessCounts(db: DB): PurgeCounts {
  const out: Record<string, number> = {};
  for (const t of BUSINESS_TABLES) out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return out as unknown as PurgeCounts;
}

/** Rows that match a fixture marker anywhere in their text columns. */
export function markerHits(db: DB, markers = FIXTURE_MARKERS): Array<{ table: string; column: string; marker: string; n: number }> {
  // Every text/blob column of every user table, so a new table cannot hide a marker.
  const hits: Array<{ table: string; column: string; marker: string; n: number }> = [];
  for (const [t, c] of allTextColumns(db)) for (const m of markers) { const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE instr(lower("${c}"), lower(?)) > 0`).get(m) as { n: number }).n; if (n) hits.push({ table: t, column: c, marker: m, n }); }
  return hits;
}

/** Jobs that carry the fixture token, with their project and whether it is a test project (policies test or dry_run). */
export function fixtureJobs(db: DB): Array<{ id: string; workspace: string | null; workspace_name: string | null; test: boolean }> {
  const rows = db.prepare(`SELECT DISTINCT j.id, j.workspace_id AS workspace, w.name AS workspace_name, w.policies FROM jobs j LEFT JOIN checkpoints c ON c.job_id = j.id LEFT JOIN workspaces w ON w.id = j.workspace_id WHERE ${FIXTURE_MARKERS.map(() => 'instr(j.objective, ?) > 0 OR instr(c.payload, ?) > 0').join(' OR ')}`).all(...FIXTURE_MARKERS.flatMap((m) => [m, m])) as Array<{ id: string; workspace: string | null; workspace_name: string | null; policies: string | null }>;
  return rows.map((r) => { let test = false; try { const p = JSON.parse(r.policies || '{}') as { test?: boolean; dry_run?: boolean }; test = p.test === true || !!p.dry_run; } catch { /* not a test project */ } return { id: r.id, workspace: r.workspace, workspace_name: r.workspace_name, test }; });
}

/** Claude Code names a project transcript directory after its cwd with `/`, `.` and `_` replaced by `-`. */
export function encodeProjectDir(absPath: string): string { let real = absPath; try { real = fs.realpathSync(absPath); } catch { /* not yet created: resolve the nearest existing parent */ let dir = absPath; const rest: string[] = []; while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { rest.unshift(path.basename(dir)); dir = path.dirname(dir); } try { real = path.join(fs.realpathSync(dir), ...rest); } catch { /* keep as is */ } } return real.replace(/[\/._]/g, '-'); }

/** Reclaim free pages and drop old WAL frames so purged bytes do not linger on disk; best effort when other connections hold the file. */
export function compact(db: DB): { vacuumed: boolean; wal: Record<string, unknown> | null; note: string } {
  let vacuumed = false; let note = '';
  try { db.exec('PRAGMA secure_delete = ON'); db.exec('VACUUM'); vacuumed = true; } catch (e) { note = `vacuum: ${(e as Error).message}`; }
  let wal: Record<string, unknown> | null = null;
  try { wal = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, unknown>; } catch (e) { note += ` checkpoint: ${(e as Error).message}`; }
  return { vacuumed, wal, note };
}

/** A compact, free-page-free copy of the database (VACUUM INTO), used for post-purge snapshots. */
export function cleanSnapshot(db: DB, backupsDir: string, label: string): string {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const file = path.join(backupsDir, `claudebot-${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); fs.chmodSync(file, 0o600); return file;
}

export interface PurgeOptions { db: DB; dbPath: string; backupsDir: string; workspacesDir: string; claudeConfigDir: string; runDir: string; mode: 'all' | 'markers'; actor?: string; allowRealProjects?: boolean }
export interface PurgeResult { before: PurgeCounts; after: PurgeCounts; preBackup: string; postBackup: string; removedWorkspaces: string[]; removedTranscripts: string[]; removedBackups: string[]; quarantinedBackups: string[]; activeCancelled: string[]; compaction: { vacuumed: boolean; wal: Record<string, unknown> | null; note: string } }

export async function purgeSyntheticData(o: PurgeOptions): Promise<PurgeResult> {
  const db = o.db; const actor = o.actor ?? 'maintenance';
  const before = businessCounts(db);
  // A fixture in a real project (not a test project) is refused unless the caller says so: the hits are in the error, nothing is touched.
  if (o.mode === 'markers' && !o.allowRealProjects) {
    const real = fixtureJobs(db).filter((j) => j.workspace && !j.test);
    if (real.length) throw new Error(`refusing to purge: ${real.length} task(s) carrying the fixture token are in real projects (${[...new Set(real.map((j) => j.workspace_name ?? j.workspace))].join(', ')}): ${real.slice(0, 10).map((j) => j.id).join(', ')}. Nothing was changed.`);
  }
  const preBackup = await snapshot(db, o.backupsDir, 50, 'pre-purge');
  // 1. Which jobs go: all business data (mode all) or marker-matching jobs and their trees (mode markers).
  const jobIds: string[] = o.mode === 'all'
    ? (db.prepare('SELECT id FROM jobs').all() as Array<{ id: string }>).map((r) => r.id)
    : fixtureJobs(db).map((r) => r.id);
  // include children
  const withChildren = new Set(jobIds);
  for (const id of jobIds) for (const c of db.prepare('SELECT id FROM jobs WHERE parent_id = ?').all(id) as Array<{ id: string }>) withChildren.add(c.id);
  const ids = [...withChildren];
  const active = (db.prepare(`SELECT id FROM jobs WHERE state IN ('leased','running') AND id IN (${ids.map(() => '?').join(',') || "''"})`).all(...ids) as Array<{ id: string }>).map((r) => r.id);
  const inList = ids.length ? ids.map(() => '?').join(',') : "''";
  db.exec('BEGIN IMMEDIATE');
  try {
    // 2. Cancel active synthetic jobs first (safe: workers lose the lease on next heartbeat CAS).
    db.prepare(`UPDATE jobs SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id IN (${inList}) AND state IN ('leased','running','queued','retry_scheduled','waiting_for_auth','waiting_for_reset','waiting_for_approval')`).run(new Date().toISOString(), new Date().toISOString(), ...ids);
    // 3. The event ledger is append-only by trigger; a maintenance purge is the one sanctioned exception, done inside the transaction.
    db.exec('DROP TRIGGER IF EXISTS job_events_no_update; DROP TRIGGER IF EXISTS job_events_no_delete;');
    const del = (sql: string, args: unknown[] = []) => db.prepare(sql).run(...(args as never[]));
    if (o.mode === 'all') {
      for (const t of ['job_events', 'checkpoints', 'artifacts', 'actions', 'approvals', 'memory_evidence', 'memory_proposals', 'records', 'incidents', 'browser_sites', 'jobs', 'objectives']) del(`DELETE FROM ${t}`);
    } else {
      for (const t of ['job_events', 'checkpoints', 'artifacts', 'actions', 'approvals', 'memory_evidence', 'memory_proposals', 'records', 'incidents']) del(`DELETE FROM ${t} WHERE job_id IN (${inList})`, ids);
      del(`DELETE FROM jobs WHERE id IN (${inList})`, ids);
      del(`DELETE FROM objectives WHERE ${FIXTURE_MARKERS.map(() => 'instr(title, ?) > 0 OR instr(description, ?) > 0').join(' OR ')}`, FIXTURE_MARKERS.flatMap((m) => [m, m]));
      for (const t of ['job_events', 'checkpoints', 'artifacts', 'memory_evidence', 'memory_proposals', 'records']) { const col = t === 'job_events' ? 'detail' : t === 'checkpoints' ? 'payload' : t === 'records' ? 'data' : t === 'artifacts' ? 'title' : 'body'; del(`DELETE FROM ${t} WHERE ${FIXTURE_MARKERS.map(() => `instr(${col}, ?) > 0`).join(' OR ')}`, [...FIXTURE_MARKERS]); }
    }
    del("DELETE FROM runtime_state WHERE key IN ('claude.capacity','health.report') OR key LIKE 'recovery.%'");
    rebuildSearchIndex(db);   // the search index holds copies of message/evidence/result text
    db.exec(`CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
             CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;`);
    db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(new Date().toISOString(), actor, 'maintenance.purge', JSON.stringify({ mode: o.mode, jobs_removed: ids.length, before, pre_backup: path.basename(preBackup) }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  // 4. Dependent files: job workspaces, capability files, Claude project transcripts whose path encodes a removed workspace, and automatic backups containing markers.
  const removedWorkspaces: string[] = []; const removedTranscripts: string[] = []; const removedBackups: string[] = []; const quarantinedBackups: string[] = [];
  // Task directories live at <workspace root>/tasks/<job id> (legacy builds used <workspacesDir>/<role>/<job id>).
  const roots = new Set<string>((db.prepare('SELECT root_path FROM workspaces').all() as Array<{ root_path: string }>).map((r) => r.root_path));
  if (fs.existsSync(o.workspacesDir)) for (const d of fs.readdirSync(o.workspacesDir)) { const p = path.join(o.workspacesDir, d); if (fs.statSync(p).isDirectory()) roots.add(p); }
  roots.add(path.join(o.workspacesDir, '_unscoped'));
  const sweep = (dir: string) => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir)) { const p = path.join(dir, entry); if (!entry.startsWith('job-')) continue; if (o.mode === 'all' || ids.includes(entry)) { fs.rmSync(p, { recursive: true, force: true }); removedWorkspaces.push(p); } } };
  for (const r of roots) { sweep(path.join(r, 'tasks')); sweep(r); }
  for (const id of ids) fs.rmSync(path.join(o.runDir, 'jobs', id), { recursive: true, force: true });
  const projects = path.join(o.claudeConfigDir, 'projects');
  const wsPrefix = encodeProjectDir(path.resolve(o.workspacesDir));
  if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects)) {
    // Only transcripts of this product's task folders that the purge removed (every one in mode all): never a folder matched by name alone.
    const isProductWorkspace = d.startsWith(wsPrefix);
    if (isProductWorkspace && (o.mode === 'all' || ids.some((id) => d.includes(encodeProjectDir(id))))) { fs.rmSync(path.join(projects, d), { recursive: true, force: true }); removedTranscripts.push(d); }
  }
  // 5. Reclaim free pages so purged bytes leave the main file and WAL, then take a compact post-purge snapshot (VACUUM INTO: no free pages).
  const compaction = compact(db);
  const after = businessCounts(db);
  const postBackup = cleanSnapshot(db, o.backupsDir, 'post-purge');
  // 6. Scan automatic backups AFTER the post-purge snapshot exists, so the purge's own output is covered too. A backup holding the fixture
  //    token may also be the only copy of real data from that time, so it is moved to backups/quarantine (0600), never deleted.
  const quarantine = path.join(o.backupsDir, 'quarantine');
  if (fs.existsSync(o.backupsDir)) for (const f of fs.readdirSync(o.backupsDir)) {
    const p = path.join(o.backupsDir, f); if (!f.endsWith('.sqlite') || /pre-purge|pre-migration|correction-/.test(f) || !fs.statSync(p).isFile()) continue;   // explicit rollback points are kept (0600)
    const buf = fs.readFileSync(p); if (FIXTURE_MARKERS.some((m) => buf.includes(m))) { fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 }); fs.renameSync(p, path.join(quarantine, f)); fs.chmodSync(path.join(quarantine, f), 0o600); quarantinedBackups.push(f); }
  }
  if (quarantinedBackups.includes(path.basename(postBackup))) throw new Error('post-purge snapshot still contained fixture bytes and was quarantined; compaction failed: ' + compaction.note);
  return { before, after, preBackup, postBackup, removedWorkspaces, removedTranscripts, removedBackups, quarantinedBackups, activeCancelled: active, compaction };
}
