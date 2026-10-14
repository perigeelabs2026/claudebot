/**
 * The honesty guard (owner: "submitted" without proof, "0 running" while nine tasks ran). A reply that claims something happened in
 * the world (an application submitted, a message sent, something verified, an account created, a sign-in) is checked against the
 * ledger; with no matching evidence, a plain ClaudeBot check note goes under it. A reply that states how many tasks are running,
 * live or submitted is checked against the same queries the report uses (cos/report.ts). Deterministic: no model call.
 */
import type { DB } from '../db/open.ts';
import { liveTasks, submittedApplications } from './report.ts';

export type Claim = 'submitted' | 'sent' | 'verified' | 'account' | 'signed_in';
const SUBJ = String.raw`\b(i|we|he|she|they|[A-Z][a-z]+)\s+(have\s+|has\s+|just\s+|successfully\s+|already\s+)?`;
const CLAIMS: Record<Claim, { says: RegExp; negated: RegExp; note: string }> = {
  submitted: {
    says: new RegExp(String.raw`${SUBJ}(submitted|applied|sent in)\b|\bsubmitted\s+(your|the|his|her|their|an?|\d+)\b[^.]{0,30}\bapplications?\b|\bapplications?\s+(was|were|has been|have been|is|are)\s+(submitted|sent|in)\b|\b(is|are)\s+(now\s+)?submitted\b`, 'i'),
    negated: /\b(not|n't|never|nothing|no|none|without|couldn't|didn't|isn't|wasn't|haven't|hasn't|won't)\b[^.]{0,40}\b(submitted|applied)\b|\b(submitted|applied)\b[^.]{0,20}\b(none|nothing|no one|zero)\b/i,
    note: 'ClaudeBot check: no application confirmation was verified in this reply, so treat any application mentioned above as not yet submitted.' },
  sent: {
    says: new RegExp(String.raw`${SUBJ}(sent|emailed|messaged|dm'?d|invited)\b(?!\s+in\b)|\b(message|email|e-mail|note|invite|invitation|connection request|inmail|reply|follow-?up)\s+(was|were|has been|have been|is|are)\s+(now\s+)?(sent|delivered)\b|\b(is|are)\s+(now\s+)?sent\b`, 'i'),
    negated: /\b(not|n't|never|nothing|no|none|without|couldn't|didn't|isn't|wasn't|haven't|hasn't|won't|unsent|draft(ed)?)\b[^.]{0,40}\b(sent|emailed|messaged|delivered)\b|\b(sent|emailed|messaged)\b[^.]{0,20}\b(none|nothing|no one|zero|yet)\b/i,
    note: 'ClaudeBot check: no sent message is recorded for this reply, so treat any message mentioned above as not yet sent.' },
  verified: {
    says: new RegExp(String.raw`${SUBJ}(verified|confirmed)\b|\b(is|are|was|were|has been|have been)\s+(now\s+)?(verified|confirmed)\b`, 'i'),
    negated: /\b(not|n't|never|nothing|no|none|without|couldn't|didn't|isn't|wasn't|haven't|hasn't|won't|unverified|can't|cannot)\b[^.]{0,40}\b(verified|confirmed)\b/i,
    note: 'ClaudeBot check: nothing was verified in the work record for this reply, so treat anything called verified above as unconfirmed.' },
  account: {
    says: new RegExp(String.raw`${SUBJ}(created|set up|made|registered|opened)\s+(an?|the|your|his|her|their|a new)\s+([\w.-]+\s+){0,2}(account|profile|login)\b|\b(account|profile|login)\s+(was|were|has been|have been|is|are)\s+(now\s+)?(created|set up|registered|ready)\b`, 'i'),
    negated: /\b(not|n't|never|no|none|without|couldn't|didn't|isn't|wasn't|haven't|hasn't|won't|can't|cannot)\b[^.]{0,40}\b(created|set up|registered)\b/i,
    note: 'ClaudeBot check: no account sign-up is recorded for this reply, so treat any account mentioned above as not yet created.' },
  signed_in: {
    says: new RegExp(String.raw`${SUBJ}(signed|logged)\s+(in|into|on)\b|\b(sign[- ]?in|log[- ]?in)\s+(worked|succeeded|went through|is done)\b|\b(is|are)\s+(now\s+)?(signed|logged)\s+in\b`, 'i'),
    negated: /\b(not|n't|never|no|without|couldn't|didn't|isn't|wasn't|haven't|hasn't|won't|can't|cannot|needs? to|must|should|please)\b[^.]{0,30}\b(signed|logged|sign|log)\s+(in|into|on)\b/i,
    note: 'ClaudeBot check: no successful sign-in is recorded for this reply, so treat any sign-in mentioned above as unconfirmed.' },
};

/** Which world-changing claims a reply makes (sentence by sentence, skipping negated and conditional sentences). */
export function claimsIn(reply: string): Claim[] {
  const sentences = String(reply ?? '').split(/(?<=[.!?])\s+|\n+/);
  const out = new Set<Claim>();
  for (const s of sentences) {
    if (/\?\s*$/.test(s) || /\b(if|once|when|after|before|will|should|could|would|can|going to|about to|ready to|plan to)\b[^.]{0,40}$/i.test(s.split(/\b(sent|submitted|applied|verified|confirmed|created|signed|logged|registered)\b/i)[0] ?? '')) continue;
    for (const [k, c] of Object.entries(CLAIMS) as Array<[Claim, (typeof CLAIMS)[Claim]]>) if (c.says.test(s) && !c.negated.test(s)) out.add(k);
  }
  return [...out];
}

/** Ledger evidence for a claim, from this task or any task of the same conversation in the last 3 hours. */
export function hasEvidence(db: DB, claim: Claim, jobId: string, conversationId: string | null): boolean {
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const ev = (where: string, ...args: unknown[]) => !!db.prepare(`SELECT 1 FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE (e.job_id = ? OR (j.conversation_id = ? AND e.at > ?)) AND (${where}) LIMIT 1`).get(jobId, conversationId ?? '', since, ...(args as never[]));
  switch (claim) {
    case 'submitted': return ev("e.type = 'application.verified'");
    case 'sent': return ev("e.type = 'action.performed' AND (json_extract(e.detail, '$.kind') IN ('send', 'external_message', 'email', 'message') OR e.detail LIKE '%send%')");
    case 'verified': return ev("e.type LIKE '%.verified' OR e.type = 'action.performed'");
    case 'account': return ev("e.type = 'account.password_set' OR (e.type = 'browser.act' AND json_extract(e.detail, '$.commit') = 1 AND lower(json_extract(e.detail, '$.name')) GLOB '*[cr][re][eg]*' AND (lower(json_extract(e.detail, '$.name')) LIKE '%create%' OR lower(json_extract(e.detail, '$.name')) LIKE '%register%' OR lower(json_extract(e.detail, '$.name')) LIKE '%sign up%'))");
    case 'signed_in': return ev("(e.type = 'browser.act' AND (lower(json_extract(e.detail, '$.name')) LIKE '%sign in%' OR lower(json_extract(e.detail, '$.name')) LIKE '%log in%' OR lower(json_extract(e.detail, '$.name')) LIKE '%signin%' OR lower(json_extract(e.detail, '$.name')) LIKE '%login%')) OR e.type IN ('browser.login_ok', 'auth.signed_in')");
  }
}

/** The check notes a reply needs: one per claim with no evidence. */
export function honestyNotes(db: DB, reply: string, jobId: string, conversationId: string | null): string[] {
  return claimsIn(reply).filter((c) => !hasEvidence(db, c, jobId, conversationId)).map((c) => CLAIMS[c].note);
}

const WORDS: Record<string, number> = { no: 0, zero: 0, none: 0, nothing: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
export interface LedgerStatus { live: number; running: number; waiting: number; applications: number; text: string }

/** What the team is doing, from the same queries as the morning report. `exclude` leaves out the turn asking. */
export function ledgerStatus(db: DB, opts: { exclude?: string; workspace?: string | null } = {}): LedgerStatus {
  const live = liveTasks(db, { workspace: opts.workspace ?? null, limit: 500 }).filter((t) => t.id !== opts.exclude);
  const running = live.filter((t) => t.state === 'leased' || t.state === 'running').length; const waiting = live.length - running;
  const apps = submittedApplications(db, new Date(Date.now() - 24 * 3600_000).toISOString());
  const text = `Team status from the work record (use these numbers exactly; never state a different count): ${live.length} live task${live.length === 1 ? '' : 's'} (${running} running, ${waiting} queued or waiting)${live.length ? `: ${live.slice(0, 12).map((t) => `${t.agent}: ${t.title}`).join('; ')}${live.length > 12 ? `; and ${live.length - 12} more` : ''}` : ''}. Job applications submitted and verified in the last 24 hours: ${apps.length}${apps.length ? ` (${apps.map((a) => a.company).join(', ')})` : ''}.`;
  return { live: live.length, running, waiting, applications: apps.length, text };
}

/** A count in the reply that contradicts the ledger ("0 running", "three tasks live", "submitted 5 applications"), as a check note. */
export function statusNote(reply: string, st: LedgerStatus): string | null {
  const n = (w: string) => (/^\d+$/.test(w) ? Number(w) : WORDS[w.toLowerCase()]);
  const NUM = String.raw`(\d+|no|zero|none|nothing|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
  const wrong: string[] = [];
  for (const m of reply.matchAll(new RegExp(String.raw`\b${NUM}\s+(?:\w+\s+){0,2}?(?:tasks?|jobs?|things?|assistants?)?\s*(?:are\s+|is\s+)?(running|in progress|underway|live|active)\b`, 'gi'))) {
    const said = n(m[1]); const word = m[2].toLowerCase(); const actual = word === 'running' || word === 'underway' || word === 'in progress' ? st.running : st.live;
    if (said !== undefined && said !== actual && !(word === 'running' && said === st.live)) wrong.push(`${actual} ${word === 'live' || word === 'active' ? 'live' : 'running'}`);
  }
  for (const m of reply.matchAll(new RegExp(String.raw`\b${NUM}\s+(?:\w+\s+){0,2}?applications?\s+(?:were\s+|have been\s+)?(?:submitted|sent|in)\b|\bsubmitted\s+${NUM}\s+(?:\w+\s+){0,2}?applications?\b`, 'gi'))) {
    const said = n(m[1] ?? m[2]); if (said !== undefined && said !== st.applications) wrong.push(`${st.applications} application${st.applications === 1 ? '' : 's'} submitted and verified in the last 24 hours`);
  }
  return wrong.length ? `ClaudeBot check: the work record shows ${[...new Set(wrong)].join(' and ')}.` : null;
}
