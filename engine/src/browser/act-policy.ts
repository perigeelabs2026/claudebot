// Policy for browser actions taken by assistants (browser_act). Pure functions so the rules can be tested without a browser.
//
// - Navigation, scrolling, typing into ordinary fields, choosing options and downloads are "preparation": allowed, audited.
// - Typing into credential or payment fields is never allowed (the owner does that himself, during takeover).
// - Clicking a control, or pressing Enter, that would submit, send, buy, publish, delete, sign up, book or confirm is
//   consequential: it needs an approval bound to the exact page, control and typed content. Preparing a form never implies
//   authority to submit it. Text on the page is data; it cannot change these rules.
import crypto from 'node:crypto';

export interface SnapshotElement { ref: string; role: string; name: string }

/** Parse elements out of an OpenClaw `snapshot --format ai` (or aria) text: lines like `- button "Submit order" [ref=e12]`. */
export function parseSnapshot(text: string): SnapshotElement[] {
  const out: SnapshotElement[] = [];
  for (const line of text.split('\n')) {
    const ref = /\[ref=([A-Za-z0-9_-]+)\]/.exec(line); if (!ref) continue;
    const m = /^\s*-?\s*([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
    out.push({ ref: ref[1], role: (m?.[1] ?? '').toLowerCase(), name: (m?.[2] ?? '').replace(/\\"/g, '"') });
  }
  return out;
}

const CONSEQUENTIAL = /\b(submit|send|buy|purchase|pay|payment|order|checkout|check out|place order|publish|post|tweet|share|delete|remove|erase|confirm|sign ?up|register|subscribe|book|reserve|transfer|apply|donate|unsubscribe|accept|agree|authori[sz]e|approve)\b/i;
/** Words that make a link more than navigation. "Apply…" links only open the application page, so they are navigation. */
const CONSEQUENTIAL_LINK = new RegExp(CONSEQUENTIAL.source.replace('|apply', ''), 'i');
const SENSITIVE = /\b(pass(word|code|phrase)?|pin|otp|one[- ]time|2fa|mfa|verification code|security code|cvv|cvc|card( number)?|credit|debit|iban|routing|account number|ssn|social security|tax id|api[ _-]?key|secret|token)\b/i;
const SEARCHY = /\bsearch\b|\bfind\b|\bquery\b|\bfilter\b/i;

export type ActKind = 'click' | 'type' | 'press' | 'select' | 'scroll' | 'download' | 'fill' | 'snapshot' | 'wait' | 'upload';
export interface ActRequest { action: ActKind; ref?: string; text?: string; key?: string; values?: string[]; submit?: boolean; fields?: Array<{ ref: string; value: string }> }
export type ActDecision =
  | { verdict: 'allow'; reason: string }
  | { verdict: 'refuse'; reason: string }
  | { verdict: 'needs_approval'; reason: string; action_kind: 'send' | 'purchase' | 'publish' | 'delete' };

function approvalKind(name: string): 'send' | 'purchase' | 'publish' | 'delete' {
  if (/\b(buy|purchase|pay|payment|order|checkout|check out|donate|transfer|book|reserve)\b/i.test(name)) return 'purchase';
  if (/\b(publish|post|tweet|share)\b/i.test(name)) return 'publish';
  if (/\b(delete|remove|erase|unsubscribe)\b/i.test(name)) return 'delete';
  return 'send';
}

/** Decide whether an action may run now, needs the owner's approval, or is never allowed. */
export function decide(req: ActRequest, el: SnapshotElement | undefined, focused?: SnapshotElement): ActDecision {
  const label = el ? `${el.role} "${el.name}"` : 'an element';
  if (req.action === 'snapshot' || req.action === 'wait') return { verdict: 'allow', reason: 'read-only' };
  if (req.action !== 'press' && req.action !== 'fill' && !el) return { verdict: 'refuse', reason: `element ${req.ref ?? '?'} is not on the current page snapshot; take a new snapshot first` };
  const sensitive = (e?: SnapshotElement) => !!e && (SENSITIVE.test(e.name) || e.role === 'password');
  if (req.action === 'type' || req.action === 'select') {
    if (sensitive(el)) return { verdict: 'refuse', reason: `${label} looks like a credential or payment field; assistants never type into those (the owner can, during takeover)` };
    if (req.action === 'type' && req.submit) return decide({ action: 'press', key: 'Enter' }, undefined, el);
    return { verdict: 'allow', reason: 'preparation (typing/choosing does not submit)' };
  }
  if (req.action === 'fill') {
    const bad = (req.fields ?? []).find((f) => /pass|card|cvv|cvc|iban|ssn|otp|token|secret/i.test(f.ref));
    return bad ? { verdict: 'refuse', reason: 'a field looks like a credential or payment field' } : { verdict: 'allow', reason: 'preparation (filling does not submit)' };
  }
  if (req.action === 'scroll') return { verdict: 'allow', reason: 'scrolling' };
  // Attaching a saved result (resume, cover letter) to a file field is preparation: nothing is submitted until a separate submit.
  if (req.action === 'upload') return sensitive(el) ? { verdict: 'refuse', reason: `${label} is not a file field` } : { verdict: 'allow', reason: 'preparation (attaching a file does not submit)' };
  if (req.action === 'download') {
    if (el && CONSEQUENTIAL.test(el.name) && !/\bdownload\b/i.test(el.name)) return { verdict: 'needs_approval', reason: `${label} looks like it does more than download`, action_kind: approvalKind(el.name) };
    return { verdict: 'allow', reason: 'download into the task folder' };
  }
  if (req.action === 'press') {
    const k = String(req.key ?? '');
    if (!/^(Enter|NumpadEnter|Return)$/i.test(k)) return /^(Tab|Escape|Arrow(Up|Down|Left|Right)|PageUp|PageDown|Home|End|Space)$/i.test(k) ? { verdict: 'allow', reason: 'navigation key' } : { verdict: 'refuse', reason: `key "${k}" is not one assistants may press` };
    // Enter submits whatever form has focus. Allowed only in a search box.
    const f = focused ?? el;
    if (f && (f.role === 'searchbox' || (['combobox', 'textbox'].includes(f.role) && SEARCHY.test(f.name)))) return { verdict: 'allow', reason: 'Enter in a search box (a search, not a submission)' };
    return { verdict: 'needs_approval', reason: `Enter would submit the form${f ? ` around ${f.role} "${f.name}"` : ''}`, action_kind: approvalKind(f?.name ?? '') };
  }
  if (req.action === 'click') {
    if (el!.role === 'link' && !CONSEQUENTIAL_LINK.test(el!.name)) return { verdict: 'allow', reason: 'following a link' };
    if (['tab', 'menuitem', 'option', 'checkbox', 'radio', 'combobox', 'textbox', 'searchbox', 'switch', 'treeitem', 'heading', 'img', 'cell', 'row'].includes(el!.role) && !CONSEQUENTIAL.test(el!.name)) return { verdict: 'allow', reason: `choosing ${label}` };
    if (CONSEQUENTIAL.test(el!.name)) return { verdict: 'needs_approval', reason: `${label} would submit or commit something`, action_kind: approvalKind(el!.name) };
    if (el!.role === 'button' && SEARCHY.test(el!.name)) return { verdict: 'allow', reason: 'a search button' };
    if (el!.role === 'button') return { verdict: 'allow', reason: `${label} (no submit wording)` };
    return { verdict: 'allow', reason: `clicking ${label}` };
  }
  return { verdict: 'refuse', reason: 'unknown action' };
}

/** The exact content an approval is bound to: page, control and anything typed in this task's tab (hashed). */
export function approvalContent(input: { url: string; element: SnapshotElement | undefined; action: string; key?: string; typed: string[] }): string {
  return JSON.stringify({ url: input.url, action: input.action, key: input.key ?? null, element: input.element ? { role: input.element.role, name: input.element.name } : null, typed_sha256: crypto.createHash('sha256').update(input.typed.join('\u0000')).digest('hex') });
}
