/**
 * The approval allowlist: the only kinds of action that wait for the owner's approval card.
 *
 *   send     a message to a person (Send, Connect, InMail, Reply, an email)
 *   purchase spending money (Buy, Pay, Place order, Checkout, Donate)
 *   publish  a public post (Post, Publish, Tweet, Repost, Comment)
 *   delete   deleting something (Delete, Erase, Deactivate, Close account)
 *
 * Everything else an assistant does on any site (Apply, Submit, Next, Accept, Agree, Sign up, Register, Upload, Continue,
 * Create account, …) runs without a card and is recorded as an audit event. Anything unknown defaults to no card.
 * browser/act-policy.ts, request_approval, the Telegram cards and cos/owner-needs.ts all read this one table.
 */

export type ApprovalKind = 'send' | 'purchase' | 'publish' | 'delete';

export interface AllowlistEntry {
  kind: ApprovalKind;
  /** Card label, as the owner reads it. */
  label: string;
  /** "<assistant> wants to …" on a card that has no richer text. */
  verb: string;
  /** Names of buttons/links/keys that perform this kind of action. */
  controls: RegExp;
  /** Text fields where Enter performs it (a message box, a post composer). */
  composers?: RegExp;
}

export const APPROVAL_ALLOWLIST: readonly AllowlistEntry[] = [
  { kind: 'delete', label: 'Delete', verb: 'delete',
    controls: /\b(delete|erase|deactivate|permanently remove|close (my |your |the |this )?account|remove (my |your |this |the )?(account|connection|contact|post|message|conversation|profile|comment))\b/i },
  { kind: 'purchase', label: 'Buy', verb: 'spend money on',
    controls: /\b(buy( now| it)?|purchase|pay( now| \$?\d[\d,.]*)?|payment|place (your |my )?order|submit (your |my |the )?order|order now|checkout|check out|complete (purchase|order|payment)|donate|transfer (funds|money)|upgrade (now|plan|to (pro|premium|plus))|start (paid )?(plan|membership)|confirm (purchase|payment|order))\b/i },
  { kind: 'publish', label: 'Publish', verb: 'post publicly',
    controls: /\b(post|publish|tweet|repost|retweet|comment|share (post|now|publicly|update|to feed)|go live)\b/i,
    composers: /\b(start a post|write a post|what do you want to talk about|what'?s on your mind|what'?s happening|add a comment|write a comment|share your thoughts)\b/i },
  { kind: 'send', label: 'Send a message', verb: 'send a message',
    controls: /\b(send( (a |the |your |my )?(message|email|e-?mail|inmail|invitation|invite|note|reply|dm|now))?|connect(?=\s*$)|connect with|connection request|reply( all)?|inmail|message (him|her|them))\b/i,
    composers: /\b(write a (message|note|reply)|type a message|message|reply|inmail|direct message|dm|compose|email body)\b/i },
];

/** A "Send …" control that is part of a form, not a message to a person (an application, a sign-in code, a file). */
const NOT_A_MESSAGE = /\b(application|apply|resume|résumé|cv|cover letter|code|verification|otp|link|form|file|documents?|answers?|assessment|test|feedback survey)\b/i;

/** Which approval kind a control performs, or null when it needs no card. Links only navigate, except to buy or delete. */
export function classifyControl(name: string, role = 'button'): ApprovalKind | null {
  const n = String(name ?? '').trim(); if (!n) return null;
  for (const e of APPROVAL_ALLOWLIST) {
    if (!e.controls.test(n)) continue;
    if (e.kind === 'send' && NOT_A_MESSAGE.test(n)) continue;
    if (role === 'link' && (e.kind === 'send' || e.kind === 'publish')) continue;   // "Message", "Reply", "Post a job" links open a page or a composer
    return e.kind;
  }
  return null;
}

/** Which approval kind pressing Enter in this field performs, or null (Enter in an ordinary form field submits the form: no card). */
export function classifyComposer(name: string): ApprovalKind | null {
  const n = String(name ?? '').trim(); if (!n) return null;
  for (const e of APPROVAL_ALLOWLIST) if (e.composers?.test(n) && !(e.kind === 'send' && NOT_A_MESSAGE.test(n))) return e.kind;
  return null;
}

export const APPROVAL_KINDS: readonly ApprovalKind[] = APPROVAL_ALLOWLIST.map((e) => e.kind);
export const isAllowlisted = (kind: string): kind is ApprovalKind => (APPROVAL_KINDS as readonly string[]).includes(kind);
export const allowlistEntry = (kind: string): AllowlistEntry | undefined => APPROVAL_ALLOWLIST.find((e) => e.kind === kind);

/** Words in a blocker or question that mean an allowlisted action is waiting on the owner (for cos/owner-needs.ts): spending money,
 *  or the owner's OK to send a message, post publicly or delete. Finding an address or drafting a message is team work. */
export const OWNER_ACTION = /\b(purchase|buy|buying|spend|spending|payment|pay for|credit card|card details|invoice|upgrade (the |your )?plan)\b|\b(approv(e|al)|ok|okay|permission|go[- ]ahead) (to|for) (send|email|message|post|publish|tweet|delete|deactivate|buy|pay)\b/i;
