/**
 * Owner attachments in a conversation. A file is checked (type, size, valid text), saved under the project's
 * conversation folder, hashed, and registered as a result owned by a completed "owner upload" ledger record in that
 * conversation, so the existing access rules apply unchanged: the conversation's lead reads it with read_artifact, and a
 * specialist receives it only when the lead passes the upload as a dependency. Nothing is executed or rendered as HTML.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DB } from '../db/open.ts';
import { newId, now } from '../jobs/store.ts';

export const ATTACH_TYPES: Record<string, string> = { '.txt': 'text', '.md': 'markdown', '.csv': 'csv', '.json': 'json', '.tsv': 'tsv', '.log': 'text', '.pdf': 'pdf', '.docx': 'docx', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image' };
export const ATTACH_MAX = 1024 * 1024;
/** Documents and images may be larger; each is checked by its real leading bytes, not only its name. */
export const BINARY_MAX = 10 * 1024 * 1024;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  '.pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  '.docx': (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** A readable text copy of a PDF or Word document (so assistants can read it), or null when the local tools cannot extract one. */
function textCopy(file: string, ext: string): string | null {
  try {
    if (ext === '.docx') return execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }).toString('utf8');
    for (const bin of ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext']) if (fs.existsSync(bin)) return execFileSync(bin, ['-layout', file, '-'], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }).toString('utf8');
  } catch { /* no copy */ }
  return null;
}
export class AttachmentError extends Error {}

export function saveAttachment(db: DB, input: { conversation_id: string; name: string; bytes: Buffer }): { job_id: string; artifact_id: string; path: string; sha256: string; bytes: number } {
  const conv = db.prepare('SELECT id, workspace_id, status FROM conversations WHERE id = ?').get(input.conversation_id) as { id: string; workspace_id: string | null; status: string } | undefined;
  if (!conv || conv.status !== 'active') throw new AttachmentError('conversation not found or archived');
  const ws = conv.workspace_id ? db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(conv.workspace_id) as { root_path: string } | undefined : undefined;
  if (!ws) throw new AttachmentError('this conversation has no project folder');
  const base = path.basename(String(input.name || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 120); const ext = path.extname(base).toLowerCase();
  if (!base || !(ext in ATTACH_TYPES)) throw new AttachmentError(`this kind of file cannot be attached (allowed: ${Object.keys(ATTACH_TYPES).join(', ')})`);
  if (!input.bytes.length) throw new AttachmentError('the file is empty');
  const binary = ext in MAGIC;
  if (binary) { if (input.bytes.length > BINARY_MAX) throw new AttachmentError('keep documents and images under 10 MB'); if (!MAGIC[ext](input.bytes)) throw new AttachmentError(`the file is not a real ${ext.slice(1).toUpperCase()} (its contents do not match its name)`); }
  else { if (input.bytes.length > ATTACH_MAX) throw new AttachmentError('keep text attachments under 1 MB'); const text = input.bytes.toString('utf8'); if (text.includes('�') || /\u0000/.test(text)) throw new AttachmentError('the file is not readable text (UTF-8)'); }
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
    // PDFs and Word documents also get a text copy next to them, registered as a second result of the same upload.
    if (ext === '.pdf' || ext === '.docx') { const txt = textCopy(file, ext); if (txt && txt.trim()) { const tf = `${file}.txt`; fs.writeFileSync(tf, txt, { mode: 0o644 }); db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at, workspace_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(newId('art'), jobId, 'upload', 'note', tf, crypto.createHash('sha256').update(txt).digest('hex'), `${base} (text copy)`, JSON.stringify({ source: 'text copy of owner upload', of: artId }), t, conv.workspace_id); } }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { job_id: jobId, artifact_id: artId, path: file, sha256: sha, bytes: input.bytes.length };
}
export function conversationAttachments(db: DB, conversationId: string): Array<{ job_id: string; artifact_id: string; title: string; sha256: string; created_at: string }> {
  return db.prepare("SELECT j.id AS job_id, a.id AS artifact_id, a.title, a.sha256, a.created_at FROM jobs j JOIN artifacts a ON a.job_id = j.id WHERE j.conversation_id = ? AND j.kind = 'owner.upload' ORDER BY a.created_at").all(conversationId) as never;
}

/** The whole conversation as a Markdown file (owner export): every message in order with its author and time, files named. No model. */
export function exportConversation(db: DB, conversationId: string): { job_id: string; artifact_id: string; path: string; sha256: string; bytes: number; messages: number } {
  const conv = db.prepare('SELECT id, workspace_id, title, status FROM conversations WHERE id = ?').get(conversationId) as { id: string; workspace_id: string | null; title: string | null; status: string } | undefined;
  if (!conv) throw new AttachmentError('conversation not found');
  const ws = conv.workspace_id ? db.prepare('SELECT root_path FROM workspaces WHERE id = ?').get(conv.workspace_id) as { root_path: string } | undefined : undefined; if (!ws) throw new AttachmentError('this conversation has no project folder');
  const names = new Map((db.prepare('SELECT id, name FROM agent_definitions').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  const rows = db.prepare('SELECT m.role, m.sender, m.kind, m.content, m.created_at, m.artifact_id, a.title AS file FROM messages m LEFT JOIN artifacts a ON a.id = m.artifact_id WHERE m.conversation_id = ? ORDER BY m.seq').all(conv.id) as Array<{ role: string; sender: string | null; kind: string; content: string; created_at: string; artifact_id: string | null; file: string | null }>;
  const who = (r: { role: string; sender: string | null }) => r.role === 'owner' ? 'You' : r.role === 'system' ? 'ClaudeBot' : names.get(String(r.sender)) ?? String(r.sender);
  const lines = [`# ${conv.title || 'Conversation'}`, '', `Exported ${new Date().toISOString()} · ${rows.length} messages`, ''];
  for (const r of rows) lines.push(`**${who(r)}** · ${r.created_at}${r.kind !== 'text' ? ` · ${r.kind}` : ''}`, '', r.file ? `[file: ${r.file}]${r.content && r.content !== r.file ? ` ${r.content}` : ''}` : r.content, '');
  const text = lines.join('\n'); const sha = crypto.createHash('sha256').update(text).digest('hex');
  const dir = path.join(ws.root_path, 'conversations', conv.id, 'exports'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); const file = path.join(dir, `chat-export-${stamp}.md`); fs.writeFileSync(file, text, { mode: 0o644 });
  const t = now(); const jobId = newId('job'); const artId = newId('art');
  db.prepare("INSERT INTO jobs(id, idempotency_key, kind, objective, success_contract, state, agent_role, priority, created_at, updated_at, completed_at, inputs, depends_on, input_refs, workspace_id, conversation_id, outcome) VALUES (?,?,?,?,?, 'completed', 'coordinator', 5, ?,?,?,?, '[]', '[]', ?,?, 'success')")
    .run(jobId, `export:${conv.id}:${sha}`, 'owner.upload', 'Owner exported this chat', '{}', t, t, t, JSON.stringify({ export: true, messages: rows.length }), conv.workspace_id, conv.id);
  db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at, workspace_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(artId, jobId, 'export', 'file', file, sha, `Chat export (${rows.length} messages)`, JSON.stringify({ source: 'owner export', messages: rows.length }), t, conv.workspace_id);
  return { job_id: jobId, artifact_id: artId, path: file, sha256: sha, bytes: Buffer.byteLength(text), messages: rows.length };
}
