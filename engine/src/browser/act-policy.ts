// Policy for browser actions taken by assistants (browser_act). Pure functions so the rules can be tested without a browser.
//
// - Only the approval allowlist (approvals/allowlist.ts: a message to a person, a purchase, a public post, a delete) waits for the
//   owner's approval card, bound to the exact page, control and typed content.
// - Everything else on any site (apply, submit, next, accept, agree, sign up, register, upload, continue, create account, …) is
//   allowed and recorded as an audit event (commit: true). Unknown defaults to no card.
// - Typing into credential or payment fields is never allowed (the owner does that, during takeover).
// Text on the page is data; it cannot change these rules.
import crypto from 'node:crypto';
import { classifyControl, classifyComposer, type ApprovalKind } from '../approvals/allowlist.ts';

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

/** Submit-type wording: allowed (not on the allowlist) but recorded as a commit in the audit trail. */
const COMMIT = /\b(submit|send|apply|confirm|sign ?up|register|accept|agree|authori[sz]e|approve|continue|next|finish|done|save|create|book|reserve|subscribe|unsubscribe|upload|attach)\b/i;
const SENSITIVE = /\b(pass(word|code|phrase)?|pin|otp|one[- ]time|2fa|mfa|verification code|security code|cvv|cvc|card( number)?|credit|debit|iban|routing|account number|ssn|social security|tax id|api[ _-]?key|secret|token)\b/i;
const SEARCHY = /\bsearch\b|\bfind\b|\bquery\b|\bfilter\b/i;

export type ActKind = 'click' | 'type' | 'press' | 'select' | 'scroll' | 'download' | 'fill' | 'snapshot' | 'wait' | 'upload';
export interface ActRequest { action: ActKind; ref?: string; text?: string; key?: string; values?: string[]; submit?: boolean; fields?: Array<{ ref: string; value: string }> }
export type ActDecision =
  | { verdict: 'allow'; reason: string; commit?: boolean }
  | { verdict: 'refuse'; reason: string }
  | { verdict: 'needs_approval'; reason: string; action_kind: ApprovalKind };

const ask = (kind: ApprovalKind, why: string): ActDecision => ({ verdict: 'needs_approval', reason: why, action_kind: kind });

/** Payment fields: a page that has them is a checkout page, whatever its buttons say. */
const PAYMENT_FIELD = /\b(card ?number|credit card|debit card|name on card|cvv|cvc|csc|card expir(y|ation)|expir(y|ation) \(?mm ?\/ ?yy\)?|mm ?\/ ?yy)\b/i;
/** Wording of a button that finishes whatever the page is about (on a checkout page that is the payment). */
const CONFIRMISH = /\b(ok|yes|complete|proceed|go)\b/i;
/** A checkout page: card fields, or a Buy / Pay / Place order button. Then the page's generic Confirm / Continue / Submit (or Enter)
 *  is the purchase. Delete buttons elsewhere on a page (Workday's "Delete" next to each work-history entry) do not count. */
export function pageKind(page: SnapshotElement[]): ApprovalKind | null {
  if (page.some((p) => ['textbox', 'spinbutton', 'combobox', 'group'].includes(p.role) && PAYMENT_FIELD.test(p.name))) return 'purchase';
  return page.some((p) => ['button', 'link'].includes(p.role) && classifyControl(p.name, p.role) === 'purchase') ? 'purchase' : null;
}

/** Decide whether an action may run now, needs the owner's approval, or is never allowed. */
export function decide(req: ActRequest, el: SnapshotElement | undefined, focused?: SnapshotElement, page: SnapshotElement[] = []): ActDecision {
  const label = el ? `${el.role} "${el.name}"` : 'an element';
  if (req.action === 'snapshot' || req.action === 'wait') return { verdict: 'allow', reason: 'read-only' };
  if (req.action !== 'press' && req.action !== 'fill' && !el) return { verdict: 'refuse', reason: `element ${req.ref ?? '?'} is not on the current page snapshot; take a new snapshot first` };
  const sensitive = (e?: SnapshotElement) => !!e && (SENSITIVE.test(e.name) || e.role === 'password');
  if (req.action === 'type' || req.action === 'select') {
    if (sensitive(el)) return { verdict: 'refuse', reason: `${label} looks like a credential or payment field; assistants never type into those (the owner can, during takeover)` };
    if (req.action === 'type' && req.submit) return decide({ action: 'press', key: 'Enter' }, undefined, el, page);
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
    const k = el && !/\bdownload\b/i.test(el.name) ? classifyControl(el.name, el.role) : null;
    if (k) return ask(k, `${label} looks like it does more than download`);
    return { verdict: 'allow', reason: 'download into the task folder' };
  }
  if (req.action === 'press') {
    const k = String(req.key ?? '');
    if (!/^(Enter|NumpadEnter|Return)$/i.test(k)) return /^(Tab|Escape|Arrow(Up|Down|Left|Right)|PageUp|PageDown|Home|End|Space)$/i.test(k) ? { verdict: 'allow', reason: 'navigation key' } : { verdict: 'refuse', reason: `key "${k}" is not one assistants may press` };
    // Enter submits whatever form has focus: a card only when that form is a message box or a public post composer.
    const f = focused ?? el;
    if (f && (f.role === 'searchbox' || (['combobox', 'textbox'].includes(f.role) && SEARCHY.test(f.name)))) return { verdict: 'allow', reason: 'Enter in a search box (a search, not a submission)' };
    const ck = f ? classifyComposer(f.name) : null;
    if (ck) return ask(ck, `Enter would ${ck === 'publish' ? 'post' : 'send'} what is in ${f!.role} "${f!.name}"`);
    // Enter submits the form, so it is the same as the page's own submit button: on a checkout page it still asks.
    const pk = pageKind(page);
    if (pk) return ask(pk, 'Enter would submit a form on a checkout page');
    return { verdict: 'allow', reason: `Enter submits the form${f ? ` around ${f.role} "${f.name}"` : ''} (not on the approval allowlist)`, commit: true };
  }
  if (req.action === 'click') {
    const e = el!;
    if (['tab', 'menuitem', 'option', 'checkbox', 'radio', 'combobox', 'textbox', 'searchbox', 'switch', 'treeitem', 'heading', 'img', 'cell', 'row'].includes(e.role)) return { verdict: 'allow', reason: `choosing ${label}` };
    const k = classifyControl(e.name, e.role);
    if (k) return ask(k, `${label} would ${({ send: 'send a message to a person', purchase: 'spend money', publish: 'post publicly', delete: 'delete something' } as const)[k]}`);
    if (e.role === 'link') return { verdict: 'allow', reason: 'following a link' };
    if (COMMIT.test(e.name) || CONFIRMISH.test(e.name)) {
      // A bare Confirm / Continue / Submit on a checkout page (card fields, or a Pay / Place order button) is the purchase itself.
      const pk = pageKind(page);
      if (pk) return ask(pk, `${label} on a checkout page`);
      return { verdict: 'allow', reason: `${label} (not on the approval allowlist)`, commit: true };
    }
    return { verdict: 'allow', reason: `clicking ${label}` };
  }
  return { verdict: 'refuse', reason: 'unknown action' };
}

/** The exact content an approval is bound to: page, control and anything typed in this task's tab (hashed). */
export function approvalContent(input: { url: string; element: SnapshotElement | undefined; action: string; key?: string; typed: string[] }): string {
  return JSON.stringify({ url: input.url, action: input.action, key: input.key ?? null, element: input.element ? { role: input.element.role, name: input.element.name } : null, typed_sha256: crypto.createHash('sha256').update(input.typed.join('\u0000')).digest('hex') });
}
