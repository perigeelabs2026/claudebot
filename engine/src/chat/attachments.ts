/**
 * Owner attachments in a conversation. A file is checked (type, size, valid text), saved under the project's
 * conversation folder, hashed, and registered as a result owned by a completed "owner upload" ledger record in that
 * conversation, so the existing access rules apply unchanged: the conversation's lead reads it with read_artifact, and a
 * specialist receives it only when the lead passes the upload as a dependency. Nothing is executed or rendered as HTML.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { newId, now } from '../jobs/store.ts';

export const ATTACH_TYPES: Record<string, string> = { '.txt': 'text', '.md': 'markdown', '.csv': 'csv', '.json': 'json', '.tsv': 'tsv', '.log': 'text' };
export const ATTACH_MAX = 1024 * 1024;
export class AttachmentError extends Error {}

export function saveAttachment(db: DB, input: { conversation_id: string; name: string; bytes: Buffer }): { job_id: string; artifact_id: string; path: string; sha256: string; bytes: number } {
  const conv = db.prepare('SELECT id, workspace_id, status FROM conversations WHERE id = ?').get(input.conversation_id) as { id: string; workspace_id: string | null; status: string } | undefined;
  if (!conv || conv.status !== 'active') throw new AttachmentError('conversation not found or archived');
  const ws = conv.workspace_id ? db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(conv.workspace_id) as { root_path: string } | undefined : undefined;
  if (!ws) throw new AttachmentError('this conversation has no project folder');
  const base = path.basename(String(input.name || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 120); const ext = path.extname(base).toLowerCase();
  if (!base || !(ext in ATTACH_TYPES)) throw new AttachmentError(`only text files can be attached for now (${Object.keys(ATTACH_TYPES).join(', ')})`);
  if (!input.bytes.length) throw new AttachmentError('the file is empty');
  if (input.bytes.length > ATTACH_MAX) throw new AttachmentError('keep attachments under 1 MB');
  const text = input.bytes.toString('utf8'); if (text.includes('�') || /\u0000/.test(text)) throw new AttachmentError('the file is not readable text (UTF-8)');
  const sha = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const dir = path.join(ws.root_path, 'conversations', conv.id, 'attachments'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha.slice(0, 8)}-${base}`); fs.writeFileSync(file, input.bytes, { mode: 0o644 });
  const t = now(); const jobId = newId('job'); const artId = newId('art');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO jobs(id, idempotency_key, kind, objective, success_contract, state, agent_role, priority, created_at, updated_at, completed_at, inputs, depends_on, input_refs, workspace_id, conversation_id, outcome) VALUES (?,?,?,?,?, 'completed', 'coordinator', 3, ?,?,?, ?, '[]', '[]', ?, ?, 'success')")
      .run(jobId, `upload:${conv.id}:${sha}`, 'owner.upload', `Owner attached ${base}`, '{}', t, t, t, JSON.stringify({ name: base, sha256: sha, bytes: input.bytes.length }), conv.workspace_id, conv.id);
    db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at, workspace_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(artId, jobId, 'upload', 'file', file, sha, base, JSON.stringify({ source: 'owner upload', type: ATTACH_TYPES[ext], bytes: input.bytes.length }), t, conv.workspace_id);
    db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(jobId, t, 'owner', 'upload.saved', JSON.stringify({ name: base, sha256: sha, bytes: input.bytes.length }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { job_id: jobId, artifact_id: artId, path: file, sha256: sha, bytes: input.bytes.length };
}
export function conversationAttachments(db: DB, conversationId: string): Array<{ job_id: string; artifact_id: string; title: string; sha256: string; created_at: string }> {
  return db.prepare("SELECT j.id AS job_id, a.id AS artifact_id, a.title, a.sha256, a.created_at FROM jobs j JOIN artifacts a ON a.job_id = j.id WHERE j.conversation_id = ? AND j.kind = 'owner.upload' ORDER BY a.created_at").all(conversationId) as never;
}
