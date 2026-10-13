// Scoped full-text search with provenance over conversation messages, evidence and saved results (FTS5, migration 0005).
// Scope never exceeds what the requester could already read:
//  - results (artifact files): only tasks the requester may read in full (broker/artifact-access readableJobs);
//  - evidence: the requester's project;
//  - conversation messages: the lead assistant searches its project's conversations (the owner's own history); a
//    specialist only its own conversation.
import fs from 'node:fs';
import type { DB } from '../db/open.ts';
import { readableJobs } from '../broker/artifact-access.ts';
import { now } from '../jobs/store.ts';

const MAX_INDEX_BYTES = 1024 * 1024;

/** Index saved results whose file is text and whose hash was not indexed yet (re-index on change). Returns how many were added. */
export function indexArtifacts(db: DB, limit = 200): number {
  const rows = db.prepare(`SELECT a.id, a.job_id, a.path, a.sha256, a.title, a.created_at, j.workspace_id, j.conversation_id FROM artifacts a LEFT JOIN jobs j ON j.id = a.job_id
    LEFT JOIN search_indexed s ON s.artifact_id = a.id WHERE a.path IS NOT NULL AND a.kind IN ('file','note') AND (s.artifact_id IS NULL OR s.sha256 != a.sha256) LIMIT ?`).all(limit) as Array<{ id: string; job_id: string; path: string; sha256: string; title: string; created_at: string; workspace_id: string | null; conversation_id: string | null }>;
  let n = 0;
  for (const r of rows) {
    let text = '';
    try { const st = fs.statSync(r.path); if (st.isFile() && st.size <= MAX_INDEX_BYTES) { const b = fs.readFileSync(r.path); if (!b.subarray(0, 4096).includes(0)) text = b.toString('utf8'); } } catch { /* missing file: index the title only */ }
    db.prepare("DELETE FROM search_index WHERE kind = 'result' AND ref = ?").run(r.id);
    db.prepare("INSERT INTO search_index(kind, ref, workspace_id, conversation_id, job_id, title, body, source, created_at) VALUES ('result',?,?,?,?,?,?,?,?)").run(r.id, r.workspace_id, r.conversation_id, r.job_id, r.title ?? '', text, r.path, r.created_at);
    db.prepare('INSERT INTO search_indexed(artifact_id, sha256, indexed_at) VALUES (?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET sha256 = excluded.sha256, indexed_at = excluded.indexed_at').run(r.id, r.sha256, now());
    n++;
  }
  return n;
}

/** Words → an FTS5 query of quoted prefix terms (no operators from the caller reach FTS5). */
export function ftsQuery(q: string, mode: 'all' | 'any' = 'all'): string | null {
  const toks = (q.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1).slice(0, 8);
  if (!toks.length) return null;
  return toks.map((t) => `"${t.replace(/"/g, '')}"*`).join(mode === 'all' ? ' AND ' : ' OR ');
}

export interface SearchHit { kind: 'message' | 'evidence' | 'result'; ref: string; title: string; snippet: string; conversation_id: string | null; job_id: string | null; source: string | null; created_at: string; rank: number }

export function searchScoped(db: DB, requesterJobId: string | null, query: string, opts: { kinds?: string[]; limit?: number; owner?: { workspace_id?: string | null } } = {}): { hits: SearchHit[]; scope: string; query: string | null } {
  indexArtifacts(db);
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const kinds = (opts.kinds?.length ? opts.kinds : ['message', 'evidence', 'result']).filter((k) => ['message', 'evidence', 'result'].includes(k));
  let where = ''; const params: Array<string | number | null> = []; let scope = '';
  if (opts.owner) {
    // The owner searches everything, optionally narrowed to one project.
    if (opts.owner.workspace_id) { where = 'AND workspace_id = ?'; params.push(opts.owner.workspace_id); scope = 'this project'; } else scope = 'all projects';
  } else {
    const req = requesterJobId ? db.prepare('SELECT id, kind, workspace_id, conversation_id FROM jobs WHERE id = ?').get(requesterJobId) as { id: string; kind: string; workspace_id: string | null; conversation_id: string | null } | undefined : undefined;
    if (!req) return { hits: [], scope: 'none (unknown task)', query: null };
    const readable = [...readableJobs(db, req.id)];
    const lead = req.kind === 'chat.turn';
    const parts: string[] = [];
    parts.push(`(kind = 'evidence' AND workspace_id IS ?)`); params.push(req.workspace_id);
    parts.push(`(kind = 'result' AND job_id IN (${readable.map(() => '?').join(',') || "''"}))`); params.push(...readable);
    if (lead) { parts.push(`(kind = 'message' AND workspace_id IS ?)`); params.push(req.workspace_id); }
    else if (req.conversation_id) { parts.push(`(kind = 'message' AND conversation_id = ?)`); params.push(req.conversation_id); }
    where = `AND (${parts.join(' OR ')})`;
    scope = lead ? 'this project\'s conversations, its evidence, and results this conversation can read' : 'this conversation, this project\'s evidence, and results this task can read';
  }
  const run = (fq: string) => db.prepare(`SELECT kind, ref, title, snippet(search_index, 6, '«', '»', '…', 14) AS snippet, conversation_id, job_id, source, created_at, bm25(search_index, 0, 0, 0, 0, 0, 2.0, 1.0) AS rank
    FROM search_index WHERE search_index MATCH ? AND kind IN (${kinds.map(() => '?').join(',')}) ${where} ORDER BY rank LIMIT ?`).all(fq, ...kinds, ...params, limit) as unknown as SearchHit[];
  const all = ftsQuery(query, 'all'); if (!all) return { hits: [], scope, query: null };
  let hits = run(all); let used = all;
  if (!hits.length) { const any = ftsQuery(query, 'any')!; hits = run(any); used = any; }
  return { hits: hits.map((h) => ({ ...h, title: String(h.title ?? '').slice(0, 200), snippet: String(h.snippet ?? '').slice(0, 400) })), scope, query: used };
}

/** Rebuild the index from current data (after a purge): removes every indexed copy of deleted text, then merges segments. */
export function rebuildSearchIndex(db: DB): void {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_index'").get(); if (!has) return;
  db.exec(`DELETE FROM search_index; DELETE FROM search_indexed;
    INSERT INTO search_index(kind, ref, workspace_id, conversation_id, job_id, title, body, source, created_at)
      SELECT 'message', m.id, c.workspace_id, m.conversation_id, m.job_id, m.role || ' ' || m.kind, m.content, NULL, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id;
    INSERT INTO search_index(kind, ref, workspace_id, conversation_id, job_id, title, body, source, created_at)
      SELECT 'evidence', e.id, j.workspace_id, j.conversation_id, e.job_id, e.title, e.body, e.source_url, e.created_at FROM memory_evidence e LEFT JOIN jobs j ON j.id = e.job_id;
    INSERT INTO search_index(search_index) VALUES('optimize');`);
}
