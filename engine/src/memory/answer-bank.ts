/**
 * The owner's answer bank: facts an assistant must use before treating any question as one only the owner can answer.
 * Deterministic (no model): every "- Key: value" line and bullet in the vault's Owner.md and Owner/*.md (application answers,
 * work history, facts saved with remember) is scored against the question by shared words, with a few synonyms.
 */
import fs from 'node:fs'; import path from 'node:path';
import { vaultDir } from './vault.ts';

export interface Answer { text: string; source: string; score: number }

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'be', 'you', 'your', 'yours', 'do', 'does', 'did', 'have', 'has', 'what', 'which', 'how', 'many', 'much', 'with', 'this', 'that', 'it', 'any', 'please', 'will', 'would', 'can', 'if', 'our', 'we', 'us', 'me', 'my', 'i', 'as', 'by', 'from', 'each', 'last', 'now', 'future', 'require', 'per']);
// Different words forms use for the same fact.
const SYN: Record<string, string> = { quota: 'attainment', attained: 'attainment', attain: 'attainment', ranking: 'rank', ranked: 'rank', sponsor: 'sponsorship', visa: 'sponsorship', authorised: 'authorized', authorization: 'authorized', authorisation: 'authorized', eligible: 'authorized', city: 'location', state: 'location', address: 'location', located: 'location', live: 'location', reside: 'location', mobile: 'phone', telephone: 'phone', cell: 'phone', 'e-mail': 'email', profile: 'linkedin', renewal: 'renewals', tool: 'tools', software: 'tools', crm: 'tools', buyers: 'buyer', exec: 'executive', executives: 'executive', team: 'team' };
const words = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9%+\-' ]+/g, ' ').split(/\s+/).map((w) => w.replace(/^'+|'+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => SYN[w] ?? w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1'));

function facts(dir: string): Array<{ text: string; key: string; source: string }> {
  const files: string[] = []; const own = path.join(dir, 'Owner.md'); if (fs.existsSync(own)) files.push(own);
  const sub = path.join(dir, 'Owner'); if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.md') && f !== 'Accounts.md' && f !== 'Rules.md') files.push(path.join(sub, f));   // Accounts.md lists sign-ins the team created, not answers
  const out: Array<{ text: string; key: string; source: string }> = [];
  for (const f of files) for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
    const line = raw.trim(); if (!/^[-*]\s+/.test(line)) continue; const text = line.replace(/^[-*]\s+/, '').trim(); if (text.length < 4) continue;
    if (text.includes(':') && !text.slice(text.indexOf(':') + 1).trim()) continue;   // a blank template line ("- Desired salary:") is not an answer
    // Only a labelled fact ("Quota attainment: …") has a key.
    const key = text.includes(':') ? text.slice(0, text.indexOf(':')) : ''; out.push({ text, key, source: path.relative(dir, f) });
  }
  return out;
}

/** The best matching facts for a form question, strongest first; empty means the bank does not know. */
// Labels so generic they would match almost any question; they never count as a key hit for the strict check.
const GENERIC_KEYS = new Set(['company', 'role', 'title', 'date', 'dates', 'name', 'email', 'phone', 'location', 'first', 'last', 'com', 'net', 'org', 'io', 'www', 'http', 'https']);

export function lookupAnswer(question: string, dir: string = vaultDir(), limit = 3, opts: { keyMatch?: boolean } = {}): Answer[] {
  const q = new Set(words(question)); if (!q.size) return [];
  const scored = facts(dir).map((f) => { const k = new Set(words(f.key).filter((w) => !opts.keyMatch || !GENERIC_KEYS.has(w))); const all = new Set(words(f.text)); let s = 0; let keyHit = false; for (const w of q) { if (k.has(w)) { s += 2; keyHit = true; } else if (all.has(w)) s += 1; } return { text: f.text, source: f.source, score: s, keyHit }; });
  return scored.filter((a) => a.score >= 2 && (!opts.keyMatch || a.keyHit)).map(({ keyHit: _k, ...a }) => a).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** True when the bank holds an answer for this question (so it is not the owner's to answer). Strict: the matched fact's own label must share a word with the question ("Quota attainment" for a quota question), so
 *  a work-history line that merely names the same company never counts as an answer. */
export const bankKnows = (question: string, dir?: string) => lookupAnswer(question, dir, 1, { keyMatch: true }).length > 0;
