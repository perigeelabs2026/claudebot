/**
 * Scoped result access for read_artifact. A task may read a saved result when the result belongs to the same project AND
 * to its own work graph: the task itself, a task it depends on (transitively), a task it delegated (transitively), or —
 * for a conversation's lead — any task of the same conversation. The file must still resolve (after symlinks) inside the
 * owning project's folder and match its recorded SHA-256. Anything else is an explicit error, never empty success.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';

interface JobRow { id: string; workspace_id: string | null; conversation_id: string | null; parent_id: string | null; depends_on: string }
export type ArtifactAccess = { ok: true; content: string; total_chars: number; offset: number; next_offset: number | null; sha256: string | null; file: string; title: string; job_id: string } | { ok: false; reason: string };

function job(db: DB, id: string): JobRow | undefined { return db.prepare('SELECT id, workspace_id, conversation_id, parent_id, depends_on FROM jobs WHERE id = ?').get(id) as JobRow | undefined; }
function deps(j: JobRow): string[] { try { return (JSON.parse(j.depends_on || '[]') as unknown[]).map(String); } catch { return []; } }

/** Every task id the requester may read results from. */
export function readableJobs(db: DB, requesterId: string): Set<string> {
  const me = job(db, requesterId); const out = new Set<string>(); if (!me) return out;
  out.add(me.id);
  const sameScope = (d: JobRow) => d.workspace_id === me.workspace_id && (me.conversation_id === null || d.conversation_id === me.conversation_id);
  const queue = [...deps(me)]; while (queue.length) { const id = queue.shift()!; if (out.has(id)) continue; const d = job(db, id); if (!d || !sameScope(d)) continue; out.add(id); queue.push(...deps(d)); }
  const kids = [me.id]; while (kids.length) { const id = kids.shift()!; for (const c of db.prepare('SELECT id FROM jobs WHERE parent_id = ? AND workspace_id IS ?').all(id, me.workspace_id) as Array<{ id: string }>) if (!out.has(c.id)) { out.add(c.id); kids.push(c.id); } }
  // Only the conversation's lead (its chat turns) may read every result of the conversation; specialists read their own work and what they depend on.
  const isLead = (db.prepare('SELECT kind FROM jobs WHERE id = ?').get(me.id) as { kind: string } | undefined)?.kind === 'chat.turn';
  if (me.conversation_id && isLead) for (const c of db.prepare('SELECT id FROM jobs WHERE conversation_id = ? AND workspace_id IS ?').all(me.conversation_id, me.workspace_id) as Array<{ id: string }>) out.add(c.id);
  return out;
}

/** The verified file behind a result this task may use (same scope and hash checks as readArtifact), for uploads and conversions. */
export function artifactFile(db: DB, requesterId: string, artifactId: string): { ok: true; path: string; sha256: string; title: string; job_id: string; buf: Buffer } | { ok: false; reason: string } {
  const r = locate(db, requesterId, artifactId); if (!r.ok) return r;
  const buf = fs.readFileSync(r.real); const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (r.row.sha256 && sha !== r.row.sha256) return { ok: false, reason: `the file for result ${artifactId} changed after it was saved (hash mismatch); it was not used` };
  return { ok: true, path: r.real, sha256: sha, title: r.row.title, job_id: r.row.job_id, buf };
}

function locate(db: DB, requesterId: string, artifactId: string): { ok: true; real: string; row: { id: string; job_id: string; path: string | null; sha256: string | null; title: string } } | { ok: false; reason: string } {
  const row = db.prepare('SELECT id, job_id, path, sha256, title FROM artifacts WHERE id = ?').get(artifactId) as { id: string; job_id: string; path: string | null; sha256: string | null; title: string } | undefined;
  if (!row) return { ok: false, reason: `no result with id ${artifactId}` };
  if (!readableJobs(db, requesterId).has(row.job_id)) return { ok: false, reason: `result ${artifactId} belongs to a task outside this conversation and its dependencies; access refused` };
  if (!row.path) return { ok: false, reason: `result ${artifactId} is a record without a file` };
  const owner = job(db, row.job_id)!; const ws = owner.workspace_id ? (db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(owner.workspace_id) as { root_path: string } | undefined) : undefined;
  if (!ws) return { ok: false, reason: 'the project that owns this result no longer exists' };
  let real: string; let root: string;
  try { real = fs.realpathSync(row.path); root = fs.realpathSync(ws.root_path); } catch { return { ok: false, reason: `the file for result ${artifactId} is missing (${path.basename(row.path)})` }; }
  if (!(real === root || real.startsWith(root + path.sep))) return { ok: false, reason: `the file for result ${artifactId} resolves outside its project folder; access refused` };
  return { ok: true, real, row };
}

export function readArtifact(db: DB, requesterId: string, artifactId: string, opts: { offset?: number; maxChars?: number } = {}): ArtifactAccess {
  const f = artifactFile(db, requesterId, artifactId); if (!f.ok) return f; const buf = f.buf; const sha = f.sha256; const real = f.path; const row = { title: f.title, job_id: f.job_id };
  const text = buf.toString('utf8'); const offset = Math.max(0, Math.min(text.length, Math.floor(opts.offset ?? 0))); const max = Math.max(1000, Math.min(200_000, Math.floor(opts.maxChars ?? 60_000)));
  const content = text.slice(offset, offset + max); const next = offset + content.length < text.length ? offset + content.length : null;
  return { ok: true, content, total_chars: text.length, offset, next_offset: next, sha256: sha, file: path.basename(real), title: row.title, job_id: row.job_id };
}
