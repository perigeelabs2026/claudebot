// Owner presence for consequential decisions (approve, run once, settle an uncertain outcome). The UI token proves only that a
// caller runs as the owner's macOS user; it can be replayed by any local process that has it. A decision therefore also needs a
// fresh, single-use signature made by the native shell after the owner clicked Confirm in a native sheet:
//   proof = HMAC-SHA256(owner.key, "<action>|<id>|<content hash>|<ts ms>"), accepted for 120 s, once.
// The sheet's text comes from the engine (confirmSubject, fetched by the shell itself, shown in full), never from the page, and
// the signature covers the stored content hash, so a page cannot show one thing and get another approved.
// owner.key lives in ~/.claudebot/secrets (0600); assistants are denied reads there (Claude settings) and sandboxed checks too.
// Limit (recorded, not hidden): any process running as the owner's user can read owner.key; the boundary is assistants and
// untrusted content, not the owner's own software. Simulated-runtime test engines are exempt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';

export function ensureOwnerKey(secretsDir: string): void {
  const f = path.join(secretsDir, 'owner.key'); if (fs.existsSync(f)) return;
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
}

const ACTIONS = ['approve', 'execute', 'resolve_performed', 'resolve_not_performed', 'permit'];
export type Subject = { action: string; id: string; kind: string; target: string; content: string; binding: string; note: string };
/** What the native sheet shows and what the signature is bound to, read from the database. approve/execute: the approval (whole
 *  content, its stored hash). resolve_*: the uncertain action (its stored hash; the approved content when there is one). */
export function confirmSubject(db: DB, action: string, id: string): Subject | null {
  if (!ACTIONS.includes(action) || !id) return null;
  if (action === 'permit') {   // a standing permission: the owner confirms its exact scope text (hash-bound)
    const p = db.prepare("SELECT action_kind, target, scope_text, scope_hash FROM standing_permissions WHERE id = ? AND status = 'proposed'").get(id) as { action_kind: string; target: string; scope_text: string; scope_hash: string } | undefined;
    return p ? { action, id, kind: `always allow ${p.action_kind}`, target: p.target, content: p.scope_text, binding: p.scope_hash, note: '' } : null;
  }
  if (action === 'approve' || action === 'execute') {
    const a = db.prepare('SELECT action_kind, target, content, content_hash FROM approvals WHERE id = ?').get(id) as { action_kind: string; target: string; content: string; content_hash: string } | undefined;
    return a ? { action, id, kind: a.action_kind, target: a.target, content: a.content, binding: a.content_hash, note: '' } : null;
  }
  const r = db.prepare('SELECT kind, target, content_hash, approval_id, receipt FROM actions WHERE id = ?').get(id) as { kind: string; target: string; content_hash: string; approval_id: string | null; receipt: string | null } | undefined;
  if (!r) return null;
  const content = r.approval_id ? ((db.prepare('SELECT content FROM approvals WHERE id = ?').get(r.approval_id) as { content: string } | undefined)?.content ?? '') : '';
  return { action, id, kind: r.kind, target: r.target, content, binding: r.content_hash, note: r.receipt ? `Receipt: ${r.receipt}` : 'No receipt was recorded.' };
}

export type Presence = { ok: true } | { ok: false; error: string };
export function verifyOwnerPresence(db: DB, secretsDir: string, action: string, id: string, binding: string, headers: Record<string, string | string[] | undefined>, now = Date.now()): Presence {
  if (process.env.CLAUDEBOT_RUNTIME === 'simulated') return { ok: true };
  if (!/^[0-9a-f]{64}$/.test(binding)) return { ok: false, error: 'Nothing to confirm: this decision was not found.' };
  const proof = String(headers['x-claudebot-owner-proof'] ?? ''); const ts = String(headers['x-claudebot-owner-ts'] ?? '');
  if (!proof || !ts) return { ok: false, error: 'This decision needs your confirmation in the ClaudeBot app (a native Confirm).' };
  const t = Number(ts); if (!Number.isFinite(t) || Math.abs(now - t) > 120_000) return { ok: false, error: 'The confirmation expired; confirm again.' };
  let key: Buffer; try { key = fs.readFileSync(path.join(secretsDir, 'owner.key')); } catch { return { ok: false, error: 'owner key missing' }; }
  const want = crypto.createHmac('sha256', key).update(`${action}|${id}|${binding}|${ts}`).digest('hex');
  if (proof.length !== want.length || !crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(want))) return { ok: false, error: 'The confirmation did not match this decision.' };
  const used = crypto.createHash('sha256').update(proof).digest('hex');
  if (db.prepare("SELECT 1 FROM job_events WHERE type = 'owner.presence' AND json_extract(detail, '$.proof') = ?").get(used)) return { ok: false, error: 'This confirmation was already used.' };
  db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(new Date(now).toISOString(), 'owner', 'owner.presence', JSON.stringify({ action, id, proof: used }));
  return { ok: true };
}
