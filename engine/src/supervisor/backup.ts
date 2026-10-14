import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/open.ts';

export async function snapshot(db: DB, backupsDir: string, keep = 20, label = 'auto'): Promise<string> {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const file = path.join(backupsDir, `claudebot-${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.sqlite`);
  // VACUUM INTO writes a compact copy without free pages, so deleted bytes never travel into a backup.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
  // Rotation keeps the newest `keep` of this label only: rollback points (pre-purge, pre-migration, correction-…) are never rotated out
  // by the automatic snapshots.
  const files = fs.readdirSync(backupsDir).filter((f) => f.startsWith('claudebot-') && f.endsWith(`-${label}.sqlite`)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(backupsDir, old));
  return file;
}

export function listBackups(backupsDir: string): Array<{ file: string; bytes: number; at: string }> {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).filter((f) => f.endsWith('.sqlite')).sort().reverse().map((f) => { const st = fs.statSync(path.join(backupsDir, f)); return { file: f, bytes: st.size, at: st.mtime.toISOString() }; });
}
