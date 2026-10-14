/**
 * Who has to act on a blocked item: the owner, or the team. Only things that truly need the owner go to "Needs the owner":
 * a password or sign-in, an MFA / verification code they must type, a CAPTCHA, a personal fact the answer bank does not hold
 * (salary, quota, work authorization), a spend or purchase, or an approval decision. Essays and free-text answers are team work,
 * drafted from the resume and memory. Anything an assistant could unblock with a
 * product capability ("allow unzip", "extract the zips", "export the chat log", "give access to records", re-run a task) is the
 * team's to fix and is reported under "Being fixed by the team". Deterministic: the report and Home use this, not the model.
 */

import { OWNER_ACTION } from '../approvals/allowlist.ts';
import { bankKnows } from '../memory/answer-bank.ts';

export type NeedOwner = 'owner' | 'team';

/** Hard owner signals: only the owner can do these, whatever else the text says. */
const OWNER_HARD: RegExp[] = [
  /\bpass(word|code|phrase)s?\b/i,
  /\b(mfa|2fa|two[- ]factor|multi[- ]factor|one[- ]time (code|password)|otp|authenticator|security key|passkey)\b/i,
  /\b(verification|security|confirmation|sms|text(ed)?|email(ed)?|login|sign[- ]in|access) code\b/i,
  /\bcaptcha\b|\bverify (that )?you('| a)re (a )?human\b|\bbot (check|detection)\b|\bi'?m not a robot\b/i,
  /\b(sign|log)[- ]?(in|on)\b|\bsigned out\b|\blogged out\b|\bre-?authenticat/i,
  /\b(social security|ssn|date of birth|passport)\b/i,
  OWNER_ACTION,   // the approval allowlist: spending money, or the OK to send a message, post publicly or delete
];

/** Personal facts: the owner's only when the answer bank (memory/answer-bank.ts, strict) does not hold them. */
const PERSONAL: RegExp[] = [
  /\b(salary|compensation|pay|wage|rate) (expectation|requirement|range)s?\b|\bdesired (salary|pay|compensation)\b|\bexpected (salary|pay|compensation)\b/i,
  /\bquota\b|\battainment\b|\bstack rank\b|\bon[- ]target earnings\b|\bote\b/i,
  /\b(work authori[sz]ation|visa|sponsorship)\b/i,
  /\bonly (you|the owner) (know|can answer)/i,
];
/** Essays and free-text answers: drafted by the team from the resume and memory, never put to the owner. */
export const ESSAY = /\bessays?\b|\babout (your|him|her|them)sel(f|ves)\b|\bpersonal (statement|story)\b|\bcover letter\b|\bwhy (do you want|are you interested|this (company|role))\b|\bfree[- ]text\b|\bshort answer\b|\bopen[- ]ended\b|\btell us\b|\bdescribe (a time|your)\b/i;

/** Things an assistant (or the team building ClaudeBot) can fix with a product capability: never put to the owner. */
const TEAM: RegExp[] = [
  /\b(un)?zip(ped|s)?\b|\bextract(ing|ion)?\b|\barchive\b|\btar\b/i,
  /\bexport(ing)? (the |a |this )?(chat|conversation|log|transcript|history|messages?)\b|\bchat log\b|\btranscript\b/i,
  /\b(allow|enable|grant|give|add|turn on|unlock)\b[^.]{0,40}\b(access|permission|tool|command|capability|shell|terminal|read|write|records?|folder|files?|unzip|download|upload|install)\b/i,
  /\b(access|permission) to (the |his |her |your )?(records?|files?|folder|chat|tool|shell|terminal|database|logs?)\b/i,
  /\b(re-?run|rerun|re-?try|retry|re-?start|restart|re-?queue|requeue|run (it|this|the task) again|try again)\b/i,
  /\b(install|missing (tool|package|dependency|command)|not installed|command not found|tool (is )?(missing|unavailable|not available)|no tool)\b/i,
  /\b(timed? ?out|timeout|crash(ed)?|error|exception|bug|broken|failed to (read|load|open|parse|write))\b/i,
  /\b(manually|by hand)\b/i,
];

/** Decision signals: an owner choice, unless the thing to decide is only a product capability (TEAM above). */
const DECISION: RegExp[] = [/\b(approve|approval|decide|decision|choose|choice|prefer|which (one|of)|go ahead|confirm whether|ok to|okay to|sign off)\b/i];

/** Classify one blocked item from its title and detail. `kind` is the item's kind on Home (approval, sign_in, blocker, question, draft). */
export function classifyBlocked(item: { kind: string; title?: string; detail?: string }, opts: { bankDir?: string } = {}): NeedOwner {
  const text = `${item.title ?? ''}\n${item.detail ?? ''}`;
  if (item.kind === 'approval' || item.kind === 'sign_in' || item.kind === 'draft') return 'owner';   // a real approval card, a sign-in wall, a new assistant to confirm
  if (OWNER_HARD.some((r) => r.test(text))) return 'owner';
  if (ESSAY.test(text)) return 'team';   // drafted from the resume and memory
  if (PERSONAL.some((r) => r.test(text))) return bankKnows(text, opts.bankDir) ? 'team' : 'owner';
  if (TEAM.some((r) => r.test(text))) return 'team';
  if (DECISION.some((r) => r.test(text))) return 'owner';
  // A question card with options is a choice put to the owner; a blocked task with no owner signal is the team's to unblock.
  return item.kind === 'question' ? 'owner' : 'team';
}

/** Split items into what needs the owner and what the team is fixing. Routine and finished rows are neither: they stay with the owner list's caller. */
export function partitionOwnerNeeds<T extends { kind: string; title?: string; detail?: string }>(items: T[]): { owner: T[]; team: T[] } {
  const owner: T[] = []; const team: T[] = [];
  for (const x of items) (['approval', 'sign_in', 'blocker', 'question', 'draft'].includes(x.kind) && classifyBlocked(x) === 'team' ? team : owner).push(x);
  return { owner, team };
}
