/**
 * Follow-up emails after a verified application (jobs.follow_up_email). One task per application record, under the key
 * followup:<record>. The task finds a contact, sends one email through the team's webmail and proves it from the Sent folder
 * (record_followup), or records that no address could be found and what was tried. verify_followup checks that proof.
 * Never twice: a send is refused once a follow-up for the record is recorded as sent, and a requeue checks the same record first.
 */
import type { DB } from '../db/open.ts';
import type { JobStore } from './store.ts';
import type { Job } from './types.ts';
import { Definitions } from '../model/definitions.ts';
import { EMAILS, teamPermissionState, webmailName } from '../approvals/permissions.ts';

export const FOLLOWUP_KIND = 'jobs.follow_up_email';
export const followupKey = (record: string) => `followup:${record}`;

type AppRecord = { id: string; company: string; role: string; url: string; workspace_id: string | null };
function appRecord(db: DB, record: string): AppRecord | null {
  const r = db.prepare("SELECT r.id, r.data, j.workspace_id FROM records r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = ? AND r.type = 'application'").get(record) as { id: string; data: string; workspace_id: string | null } | undefined;
  if (!r) return null; let d: Record<string, unknown> = {}; try { d = JSON.parse(r.data); } catch { /* empty */ }
  return { id: r.id, company: String(d.company ?? ''), role: String(d.role ?? ''), url: String(d.url ?? ''), workspace_id: r.workspace_id };
}

/** The follow-up recorded as sent for this application record (by any task) that has not bounced since: a followup.bounced for the
 *  same recipient after it supersedes it, so the next candidate can be written to. */
export function sentFollowUp(db: DB, record: string): { job_id: string; at: string; recipient: string } | null {
  const r = db.prepare(`SELECT s.job_id, s.at, json_extract(s.detail, '$.recipient') AS recipient FROM job_events s WHERE s.type = 'followup.sent' AND json_extract(s.detail, '$.record') = ?
    AND NOT EXISTS (SELECT 1 FROM job_events b WHERE b.type = 'followup.bounced' AND json_extract(b.detail, '$.record') = ? AND json_extract(b.detail, '$.recipient') = json_extract(s.detail, '$.recipient') AND b.seq > s.seq)
    ORDER BY s.seq DESC LIMIT 1`).get(record, record) as { job_id: string; at: string; recipient: string } | undefined;
  return r ?? null;
}

/** Addresses that bounced for this record (the mailer-daemon message was seen): never written to again, and part of what was tried. */
export function bouncedAddresses(db: DB, record: string): string[] {
  return (db.prepare("SELECT DISTINCT json_extract(detail, '$.recipient') AS r FROM job_events WHERE type = 'followup.bounced' AND json_extract(detail, '$.record') = ?").all(record) as Array<{ r: string }>).map((x) => x.r);
}

/** A bounce notice for this recipient on the page: the mailer-daemon / delivery-failure message naming the address. */
export function isBounceFor(pageText: string, recipient: string): boolean {
  const t = pageText.toLowerCase();
  return /mailer-daemon|mail delivery (subsystem|failed)|delivery status notification|address not found|undeliverable|couldn'?t be delivered|wasn'?t delivered|delivery has failed|message not delivered/.test(t) && t.includes(recipient.toLowerCase());
}

/** The Sent search shows the email to this recipient: the address on the page, or (Gmail shows names, not addresses) a search URL that
 *  names to:<address> with at least one result row and no "no messages" notice. */
export function sentSearchShows(url: string, pageText: string, rows: number, recipient: string): boolean {
  const to = recipient.toLowerCase(); if (pageText.toLowerCase().includes(to)) return true;
  let u = url; try { u = decodeURIComponent(url.replace(/\+/g, ' ')); } catch { /* as is */ }
  return u.toLowerCase().includes(`to:${to}`) && rows > 0 && !/no (messages|results|conversations|emails?) (matched|found)|nothing (here|to show)/i.test(pageText);
}

/** A Sent-folder search in the team's webmail: Gmail #search/…in:sent… or #sent, Outlook sentitems, Yahoo Sent. */
export function isSentSearchUrl(url: string): boolean {
  if (!webmailName(url)) return false; const u = decodeURIComponent(url).toLowerCase();
  return /#sent\b|in:sent|label:sent|\/sentitems|\/folders\/2\b|\/sent\b/.test(u);
}

function create(db: DB, store: JobStore, rec: AppRecord, extra: Record<string, unknown>, actor: string): Job {
  const wf = new Definitions(db).getWorkflow(FOLLOWUP_KIND); if (!wf) throw new Error(`workflow ${FOLLOWUP_KIND} is missing`);
  const what = `${rec.company || 'the company'}${rec.role ? `, ${rec.role}` : ''}`;
  return store.create({ idempotency_key: followupKey(rec.id), kind: FOLLOWUP_KIND, agent_role: wf.default_agent, success_contract: wf.contract, workspace_id: rec.workspace_id,
    objective: `Send a follow-up email about the application to ${what}`, inputs: { record: rec.id, company: rec.company, role: rec.role, url: rec.url, ...extra } }, actor).job;
}

/** After application.verified: the follow-up task for that record (in a real project, while the team may send emails), or why not. */
export function followUpFor(db: DB, store: JobStore, record: string, actor = 'engine'): { job: Job } | { skipped: string } {
  const rec = appRecord(db, record); if (!rec) return { skipped: `no application record ${record}` };
  if (rec.workspace_id) { const p = db.prepare('SELECT policies FROM workspaces WHERE id = ?').get(rec.workspace_id) as { policies: string } | undefined; let pol: { test?: unknown; dry_run?: unknown } = {}; try { pol = JSON.parse(p?.policies || '{}'); } catch { /* none */ } if (pol.test || pol.dry_run) return { skipped: 'test or dry-run project' }; }
  if (!teamPermissionState(db, EMAILS).live) return { skipped: '"Send emails without asking" is off' };
  const sent = sentFollowUp(db, record); if (sent) return { skipped: `a follow-up was already sent to ${sent.recipient}` };
  const existing = db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(followupKey(record)) as { id: string } | undefined; if (existing) return { skipped: `a follow-up task already exists (${existing.id})` };
  return { job: create(db, store, rec, {}, actor) };
}
export function createFollowUp(db: DB, store: JobStore, record: string, actor = 'engine'): Job | null { const r = followUpFor(db, store, record, actor); return 'job' in r ? r.job : null; }

/** Backfill: every verified application record with no follow-up task (no followup:<record> key, old or replaced) and nothing sent. */
export function missingFollowUps(db: DB): string[] {
  return (db.prepare(`SELECT r.id FROM records r WHERE r.type = 'application' AND COALESCE(json_extract(r.data, '$.verified'), 0) <> 0
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'followup:' || r.id OR j.idempotency_key LIKE 'followup:' || r.id || ':replaced:%') ORDER BY r.created_at`).all() as Array<{ id: string }>).map((x) => x.id).filter((id) => !sentFollowUp(db, id));
}

/** A failed follow-up (for example one created on the old browser task) re-created on jobs.follow_up_email under the same key.
 *  Refused while one is open, once one completed (unless its email bounced), or when a follow-up for the record is recorded as sent and
 *  has not bounced. The old task keeps
 *  its history under key followup:<record>:replaced:<old job>. The new task checks the Sent folder before it writes anything. */
export function requeueFollowUp(db: DB, store: JobStore, record: string, actor = 'owner'): { ok: true; job: Job; replaced: string } | { ok: false; reason: string } {
  const rec = appRecord(db, record); if (!rec) return { ok: false, reason: `no application record ${record}` };
  const sent = sentFollowUp(db, record); if (sent) return { ok: false, reason: `a follow-up for ${record} was already sent to ${sent.recipient} (${sent.at.slice(0, 16)}); nothing re-created` };
  const old = db.prepare('SELECT id, state, kind FROM jobs WHERE idempotency_key = ?').get(followupKey(record)) as { id: string; state: string; kind: string } | undefined;
  if (!old) return { ok: false, reason: `no follow-up task for ${record}` };
  const bounced = bouncedAddresses(db, record);
  // A failed task, or a finished one whose email bounced (the next candidate gets written to).
  if (old.state !== 'failed_terminal' && !(old.state === 'completed' && bounced.length)) return { ok: false, reason: `the follow-up task ${old.id} is ${old.state}, not failed${old.state === 'completed' ? ' (and nothing bounced)' : ''}` };
  // Did the old task press Send in webmail? Then the new one must find that email in Sent rather than write another.
  const pressed = !!db.prepare("SELECT 1 FROM job_events e JOIN approvals a ON a.id = json_extract(e.detail, '$.approval_id') WHERE e.job_id = ? AND e.type = 'action.performed' AND a.action_kind = 'send'").get(old.id);
  const replacedKey = `${followupKey(record)}:replaced:${old.id}`;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE jobs SET idempotency_key = ? WHERE id = ?').run(replacedKey, old.id);
    store.event(old.id, actor, 'followup.requeued', { record, from_kind: old.kind, to_kind: FOLLOWUP_KIND, old_key_now: replacedKey, send_pressed: pressed });
    const job = create(db, store, rec, { previous_task: old.id, ...(pressed ? { previous_send_pressed: true, previous_send_note: ' (an earlier task for this application pressed Send: expect the email in Sent)' } : {}), ...(bounced.length ? { bounced, bounced_note: ` These addresses bounced; never write to them again: ${bounced.join(', ')}.` } : {}) }, actor);
    db.exec('COMMIT'); return { ok: true, job, replaced: old.id };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Every failed follow-up task with nothing recorded as sent. */
export function failedFollowUps(db: DB): string[] {
  return (db.prepare("SELECT substr(idempotency_key, 10) AS record FROM jobs WHERE idempotency_key LIKE 'followup:%' AND idempotency_key NOT LIKE 'followup:%:replaced:%' AND state = 'failed_terminal'").all() as Array<{ record: string }>).map((r) => r.record).filter((r) => !sentFollowUp(db, r));
}
