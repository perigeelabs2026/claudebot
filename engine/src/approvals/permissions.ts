/**
 * Standing permissions ("Always allow … like this"). The owner creates one from a real approval; it covers one assistant, one
 * action kind and one exact target, at most N uses per day, until it expires or is revoked. A covered request is still recorded
 * with its exact content and hash, then approved by the permission, and runs once through the same executor. Assistants cannot
 * create or widen a permission on their own: the owner confirms in the app, or tells the Chief of Staff in their own words (the
 * quoted words are checked against the owner's message; see broker set_permission). Owner direction 2026-10-13.
 *
 * One named permission is broader by the owner's direction ("submit my job applications without asking"): it covers submitting
 * applications on job sites and applicant-tracking forms. Every use is still recorded (page, control, values hash, time).
 * Credentials, MFA, CAPTCHA and payment stay with the owner; emails to people, LinkedIn messages, purchases, publishing and
 * deletions are never covered by it.
 */
import type { DB } from '../db/open.ts';
import { newId, now, sha256 } from '../jobs/store.ts';

export const NEVER_STANDING = ['purchase', 'delete', 'production_change', 'new_scope', 'new_audience', 'budget_increase', 'policy_change'] as const;
/** Only these kinds can ever be allowed in advance (an allow-list: a new consequential kind never becomes allowable by default). */
export const STANDING_KINDS = ['send', 'publish'] as const;
const ADDR = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
/** The single recipient a target names ("email to Owner@Example.org" → "owner@example.org"), or null when it is not exactly one address. */
export function targetAddress(target: string): string | null { const a = String(target).trim().replace(/^email to\s+/i, '').trim().toLowerCase(); return ADDR.test(a) ? a : null; }
/** Every recipient the content itself names (To/Cc/Bcc headers, or JSON to/cc/bcc). Null when it cannot be read. */
export function contentRecipients(content: string): string[] | null {
  const text = String(content); const out: string[] = [];
  try { const j = JSON.parse(text) as Record<string, unknown>; for (const k of ['to', 'cc', 'bcc']) { const v = j[k]; for (const x of (Array.isArray(v) ? v : v ? [v] : [])) out.push(String(x)); } } catch {
    for (const m of text.matchAll(/^\s*(to|cc|bcc)\s*:\s*(.+)$/gim)) out.push(...m[2].split(/[,;]/));
  }
  const addrs = out.map((x) => (x.match(/<([^>]+)>/)?.[1] ?? x).trim().toLowerCase()).filter(Boolean);
  if (addrs.some((a) => !ADDR.test(a))) return null;
  return addrs;
}
export const JOB_APPLICATIONS = 'job_application';
export const JOB_APPLICATIONS_SCOPE = 'Submit job applications without asking: assistants may submit applications on job sites and application forms (Greenhouse, Lever, Ashby, Workday, iCIMS, LinkedIn Jobs and company career pages), using your resume, cover letter and form answers. Every submission is recorded with the page, the button and the time. Passwords, verification codes, CAPTCHAs and payments still need you; emails, LinkedIn messages, purchases, posts and deletions still ask you.';
const ATS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|smartrecruiters\.com|jobvite\.com|bamboohr\.com|workable\.com|recruitee\.com|breezy\.hr|applytojob\.com|jazzhr\.com|taleo\.net|successfactors\.com|ultipro\.com|ukg\.com|paylocity\.com|adp\.com|rippling\.com|teamtailor\.com|pinpointhq\.com|dover\.com|gem\.com|wellfound\.com|indeed\.com|ziprecruiter\.com|personio\.de|personio\.com)$/i;
/** Is this page part of a job application? An applicant-tracking site, LinkedIn Jobs (not messaging or profiles), or a careers/jobs/apply path. */
export function isJobSite(url: string): boolean {
  let u: URL; try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^www\./, ''); const p = u.pathname.toLowerCase();
  if (/(^|\.)linkedin\.com$/.test(host)) return /^\/jobs\//.test(p);
  if (ATS.test(host)) return true;
  return /(^|\/)(careers?|jobs?|job-openings|apply|application|positions|openings|join-us|work-with-us)(\/|$|-)/.test(p) || /^(careers|jobs|apply)\./.test(host);
}
/** A control that moves an application forward (apply, next, submit) and nothing else. */
export function isApplicationControl(name: string): boolean {
  const n = String(name);
  if (/\b(message|inmail|connect|follow|invite|email|share|post|pay|payment|buy|purchase|order|donate|delete|remove|withdraw|unsubscribe)\b/i.test(n)) return false;
  return /\b(apply|application|submit|next|continue|review|send application|easy apply|i'?m interested)\b/i.test(n);
}
/** The live "Submit job applications without asking" permission, if on and not expired or over today's limit. */
export function jobApplicationPermission(db: DB, at = now()): StandingPermission | null {
  const p = db.prepare("SELECT * FROM standing_permissions WHERE status = 'active' AND action_kind = ? ORDER BY created_at DESC LIMIT 1").get(JOB_APPLICATIONS) as unknown as StandingPermission | undefined;
  if (!p) return null;
  if (p.expires_at <= at) { db.prepare("UPDATE standing_permissions SET status = 'expired' WHERE id = ?").run(p.id); ev(db, 'system', 'permission.expired', { id: p.id }); return null; }
  return usesToday(db, p.id, at) < p.max_per_day ? p : null;
}
/** Switch "Submit job applications without asking" on (the owner in the app, or the owner's words via the Chief of Staff). */
export function grantJobApplications(db: DB, by: string, opts: { max_per_day?: number; days?: number; reason?: string } = {}): StandingPermission {
  const live = jobApplicationPermission(db); if (live) return live;
  const t = now(); const max = Math.max(1, Math.min(400, Math.round(Number(opts.max_per_day ?? 200)))); const days = Math.max(1, Math.min(365, Math.round(Number(opts.days ?? 90))));
  const id = newId('perm'); const expires = new Date(Date.parse(t) + days * 86400_000).toISOString();
  db.prepare("INSERT INTO standing_permissions(id, agent_id, action_kind, target, max_per_day, expires_at, reason, scope_text, scope_hash, status, from_approval, created_by, created_at, activated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',NULL,?,?,?)")
    .run(id, '*', JOB_APPLICATIONS, 'job sites and application forms', max, expires, String(opts.reason ?? '').slice(0, 300), JOB_APPLICATIONS_SCOPE, sha256(JOB_APPLICATIONS_SCOPE), by, t, t);
  ev(db, by, 'permission.created', { id, agent: '*', kind: JOB_APPLICATIONS, max_per_day: max, expires_at: expires, reason: opts.reason ?? null });
  return getPermission(db, id)!;
}

export interface StandingPermission { id: string; agent_id: string; action_kind: string; target: string; max_per_day: number; expires_at: string; reason: string; scope_text: string; scope_hash: string; status: 'proposed' | 'active' | 'revoked' | 'expired'; from_approval: string | null; created_by: string; created_at: string; activated_at: string | null; revoked_at: string | null; revoked_by: string | null }

const ev = (db: DB, actor: string, type: string, detail: unknown, jobId: string | null = null) => db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(jobId, now(), actor, type, JSON.stringify(detail));
export function getPermission(db: DB, id: string): StandingPermission | null { return (db.prepare('SELECT * FROM standing_permissions WHERE id = ?').get(id) as unknown as StandingPermission | undefined) ?? null; }

/** Step 1 (owner's app session): a proposed permission built from a real approval. It does nothing until the owner confirms it. */
export function proposePermission(db: DB, input: { approval_id: string; max_per_day?: number; days?: number; reason?: string; agent_name?: string }, by: string): StandingPermission {
  const a = db.prepare('SELECT ap.id, ap.action_kind, ap.target, ap.job_id, j.agent_role FROM approvals ap LEFT JOIN jobs j ON j.id = ap.job_id WHERE ap.id = ?').get(input.approval_id) as { id: string; action_kind: string; target: string; job_id: string | null; agent_role: string | null } | undefined;
  if (!a) throw new Error('approval not found');
  if (!a.agent_role) throw new Error('this request has no assistant to allow');
  if (!(STANDING_KINDS as readonly string[]).includes(a.action_kind)) throw new Error(`${a.action_kind} always asks you; it cannot be allowed in advance`);
  const ap = db.prepare('SELECT status, content FROM approvals WHERE id = ?').get(a.id) as { status: string; content: string };
  if (!['pending', 'approved', 'consumed'].includes(ap.status)) throw new Error(`that request is ${ap.status}; allow a current one instead`);
  if (a.action_kind === 'send' && !targetAddress(a.target)) throw new Error('a standing permission covers exactly one recipient address');
  const max = Math.round(Number(input.max_per_day ?? 3)); const days = Math.round(Number(input.days ?? 30));
  if (!(max >= 1 && max <= 20)) throw new Error('allow 1 to 20 a day'); if (!(days >= 1 && days <= 90)) throw new Error('allow for 1 to 90 days');
  const t = now(); const expires = new Date(Date.parse(t) + days * 86400_000).toISOString();
  const who = input.agent_name ?? a.agent_role; const verb = a.action_kind === 'send' ? 'send' : a.action_kind;
  const until = new Date(expires).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const scope = `${who} may ${verb} without asking, only to ${targetAddress(a.target) ?? a.target.replace(/^email to /, '')}, at most ${max} in any 24 hours, until ${until}. The exact text of each one is still recorded. Anything else still asks you.${ap.status === 'pending' ? `\n\nThis also allows the ${a.action_kind === 'send' ? 'email' : 'request'} waiting now, exactly as written:\n\n${ap.content}` : ''}`;
  const id = newId('perm');
  db.prepare("INSERT INTO standing_permissions(id, agent_id, action_kind, target, max_per_day, expires_at, reason, scope_text, scope_hash, status, from_approval, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,'proposed',?,?,?)")
    .run(id, a.agent_role, a.action_kind, a.target, max, expires, String(input.reason ?? '').slice(0, 300), scope, sha256(scope), a.id, by, t);
  return getPermission(db, id)!;
}
/** Step 2: the owner confirmed the exact scope natively (checked by the caller); the permission becomes active. */
export function activatePermission(db: DB, id: string, by: string): StandingPermission {
  const p = getPermission(db, id); if (!p) throw new Error('permission not found'); if (p.status !== 'proposed') throw new Error(`permission is ${p.status}`);
  db.prepare("UPDATE standing_permissions SET status = 'active', activated_at = ? WHERE id = ?").run(now(), id);
  ev(db, by, 'permission.created', { id, agent: p.agent_id, kind: p.action_kind, target: p.target, max_per_day: p.max_per_day, expires_at: p.expires_at });
  return getPermission(db, id)!;
}
export function revokePermission(db: DB, id: string, by: string): boolean {
  const r = db.prepare("UPDATE standing_permissions SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ? AND status = 'active'").run(now(), by, id);
  if (r.changes) ev(db, by, 'permission.revoked', { id }); return r.changes > 0;
}
export function usesToday(db: DB, id: string, at = now()): number {
  const since = new Date(Date.parse(at) - 24 * 3600_000).toISOString();   // a rolling 24 hours, whatever the owner's timezone
  return (db.prepare('SELECT count(*) AS n FROM approvals WHERE decided_by = ? AND decided_at > ?').get(`permission:${id}`, since) as { n: number }).n;
}
/** The live permission covering this exact request, if any (same assistant, kind and target; not expired; under today's limit). */
export function matchPermission(db: DB, req: { agent_id: string; action_kind: string; target: string; content?: string }, at = now()): StandingPermission | null {
  if (!(STANDING_KINDS as readonly string[]).includes(req.action_kind)) return null;
  // Emails: the recipients written in the content must be exactly the one allowed address (no extra To/Cc/Bcc); unreadable content asks.
  if (req.action_kind === 'send') { const addr = targetAddress(req.target); const rc = req.content === undefined ? [] : contentRecipients(req.content); if (!addr || rc === null || rc.some((r) => r !== addr)) return null; }
  for (const p of db.prepare("SELECT * FROM standing_permissions WHERE status = 'active' AND agent_id = ? AND action_kind = ? AND target = ?").all(req.agent_id, req.action_kind, req.target) as unknown as StandingPermission[]) {
    if (p.expires_at <= at) { db.prepare("UPDATE standing_permissions SET status = 'expired' WHERE id = ?").run(p.id); ev(db, 'system', 'permission.expired', { id: p.id }); continue; }
    if (usesToday(db, p.id, at) >= p.max_per_day) continue;
    return p;
  }
  return null;
}
export function expireDuePermissions(db: DB, at = now()): number { const due = db.prepare("SELECT id FROM standing_permissions WHERE status = 'active' AND expires_at <= ?").all(at) as Array<{ id: string }>; for (const p of due) { db.prepare("UPDATE standing_permissions SET status = 'expired' WHERE id = ?").run(p.id); ev(db, 'system', 'permission.expired', { id: p.id }); } db.prepare("DELETE FROM standing_permissions WHERE status = 'proposed' AND created_at < ?").run(new Date(Date.parse(at) - 15 * 60_000).toISOString()); return due.length; }
export function listPermissions(db: DB): Array<StandingPermission & { uses: number; last_used: string | null }> {
  expireDuePermissions(db);
  return (db.prepare("SELECT * FROM standing_permissions WHERE status != 'proposed' ORDER BY created_at DESC").all() as unknown as StandingPermission[]).map((p) => {
    const u = db.prepare("SELECT count(*) AS n, max(decided_at) AS last FROM approvals WHERE decided_by = ?").get(`permission:${p.id}`) as { n: number; last: string | null };
    return { ...p, uses: u.n, last_used: u.last };
  });
}
