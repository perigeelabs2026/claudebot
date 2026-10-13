/**
 * Release test: no fixture/demo markers in production surfaces (source, UI bundle, installers, migrations, first-run seed)
 * nor in the installed production database. Fails the release when any marker is found.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FIXTURE_MARKERS, allTextColumns } from '../../src/maintenance/purge.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PRODUCTION_SURFACES = ['engine/src', 'engine/ui', 'install', 'bin', 'shell/Sources', 'shell/Resources'];
const SOURCE_MARKERS = [...FIXTURE_MARKERS, 'Acme', 'lorem ipsum', 'sample objective', 'demo company', 'fake count', 'placeholder data'];

function walk(dir: string, out: string[] = []): string[] { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p, out); } else out.push(p); } return out; }

test('production surfaces contain no fixture markers', () => {
  const hits: string[] = [];
  for (const s of PRODUCTION_SURFACES) { const d = path.join(ROOT, s); if (!fs.existsSync(d)) continue; for (const f of walk(d)) { const text = fs.readFileSync(f, 'utf8'); for (const m of SOURCE_MARKERS) { const idx = text.indexOf(m); if (idx >= 0 && !isAllowed(f, text, idx, m)) hits.push(`${path.relative(ROOT, f)}: "${m}"`); } } }
  assert.deepEqual(hits, []);
});
/** The marker list itself (in purge.ts and this test) is allowed; nothing else is. */
function isAllowed(file: string, _text: string, _idx: number, _m: string): boolean { return file.endsWith('src/maintenance/purge.ts'); }

test('installed production database, when present, contains no fixture markers and no demo rows', () => {
  const dbPath = path.join(process.env.CLAUDEBOT_HOME ?? path.join(os.homedir(), '.claudebot'), 'data', 'claudebot.sqlite');
  if (!fs.existsSync(dbPath)) { assert.ok(true, 'no installed database (fresh checkout)'); return; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const hits: string[] = [];
  for (const [t, c] of allTextColumns(db as never)) for (const m of FIXTURE_MARKERS) { const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE instr(lower("${c}"), lower(?)) > 0`).get(m) as { n: number }).n; if (n) hits.push(`${t}.${c} has ${n} rows matching "${m}"`); }
  db.close();
  assert.deepEqual(hits, []);
  // the isolated Claude profile must hold no session metadata for product tasks that carries a marker, and the workspaces tree must be clean
  const home = process.env.CLAUDEBOT_HOME ?? path.join(os.homedir(), '.claudebot');
  const extra: string[] = [];
  for (const root of [path.join(home, 'claude', 'projects'), path.join(home, 'workspaces')]) if (fs.existsSync(root)) for (const f of walk(root)) { if (/\.(jsonl|json|md|txt)$/.test(f)) { const t = fs.readFileSync(f, 'utf8'); for (const m of FIXTURE_MARKERS) if (t.toLowerCase().includes(m.toLowerCase())) extra.push(`${path.relative(home, f)}: "${m}"`); } }
  assert.deepEqual(extra, []);
  // byte level: the main file must not carry purged bytes in free pages either
  const raw = fs.readFileSync(dbPath); const byteHits = FIXTURE_MARKERS.filter((m) => raw.includes(m)); assert.deepEqual(byteHits, [], 'fixture bytes linger in free pages (run claudebot maintenance compact)');
});
