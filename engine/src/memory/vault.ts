/**
 * Assistant memory in a plain Markdown vault the owner can open in Obsidian (or any editor):
 *   Team.md               team rules (written by the lead on the owner's word, or by the owner)
 *   Owner.md              the owner's preferences and profile facts
 *   Assistants/<Name>.md  one note per assistant: Preferences, Lessons, Facts (frontmatter: assistant id, updated)
 *   Lessons/YYYY-MM-DD.md what assistants learned that day (a log with [[links]])
 * The files are the truth: an edit made in Obsidian takes effect on the next turn. Every turn reads Team + Owner + its own note
 * in full. Secrets never go in: text that looks like a password, token or key is refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SECTIONS = ['Preferences', 'Lessons', 'Facts'] as const;
export type Section = typeof SECTIONS[number];
const MAX_PER_SECTION = 40;
const today = () => new Date().toISOString().slice(0, 10);

export function vaultDir(env: NodeJS.ProcessEnv = process.env): string { if (!env.CLAUDEBOT_MEMORY_DIR && env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `claudebot-test-memory-${process.pid}`); return env.CLAUDEBOT_MEMORY_DIR ?? path.join(os.homedir(), 'Documents', 'ClaudeBot Memory'); }

/** Text that must never be written to memory: credentials, tokens, keys, card numbers. */
export function looksSecret(text: string): string | null {
  const t = String(text);
  if (/\b(pass(word|code|phrase)?|pwd|pin|otp|2fa|mfa|verification code|security code|cvv|cvc)\b\s*(is|=|:)\s*\S+/i.test(t)) return 'it contains a password or code';
  if (/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\b\d{8,10}:[A-Za-z0-9_-]{30,}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return 'it contains what looks like a token or key';
  if (/\b(?:\d[ -]?){13,19}\b/.test(t) && /\b(card|visa|mastercard|amex)\b/i.test(t)) return 'it contains what looks like a card number';
  if (/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/.test(t)) return 'it contains a long secret-looking string';
  return null;
}

const fileName = (name: string) => `${name.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Assistant'}.md`;

export class Vault {
  readonly dir: string;
  constructor(dir: string = vaultDir()) { this.dir = dir; }
  ensure(): void {
    fs.mkdirSync(path.join(this.dir, 'Assistants'), { recursive: true }); fs.mkdirSync(path.join(this.dir, 'Lessons'), { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.obsidian'))) fs.mkdirSync(path.join(this.dir, '.obsidian'));   // makes the folder an Obsidian vault; never touches other vaults
    const base = (title: string, intro: string) => `---\nupdated: ${today()}\n---\n# ${title}\n\n${intro}\n\n${SECTIONS.map((s) => `## ${s}\n`).join('\n')}`;
    if (!fs.existsSync(path.join(this.dir, 'Team.md'))) fs.writeFileSync(path.join(this.dir, 'Team.md'), base('Team', 'Rules every assistant follows. Edit freely; changes apply on the next turn.'));
    if (!fs.existsSync(path.join(this.dir, 'Owner.md'))) fs.writeFileSync(path.join(this.dir, 'Owner.md'), base('Owner', 'What the team knows about you and how you like things done.'));
  }
  /** The note of one assistant, found by its frontmatter id (so a rename in Obsidian or the app never loses it). Created when missing. */
  notePath(agent: { id: string; name: string }): string {
    this.ensure(); const dir = path.join(this.dir, 'Assistants');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) { const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 400); if (new RegExp(`^assistant:\\s*${agent.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(head)) return this.renameIfNeeded(path.join(dir, f), agent.name); }
    const p = path.join(dir, fileName(agent.name));
    fs.writeFileSync(p, `---\nassistant: ${agent.id}\nupdated: ${today()}\n---\n# ${agent.name}\n\nWhat ${agent.name} has learned. Team rules: [[Team]] · About the owner: [[Owner]]\n\n${SECTIONS.map((s) => `## ${s}\n`).join('\n')}`, { flag: 'wx' });
    return p;
  }
  /** Keep the note's file name equal to the assistant's name, and fix [[links]] across the vault. */
  private renameIfNeeded(p: string, name: string): string {
    const want = path.join(path.dirname(p), fileName(name)); if (want === p || fs.existsSync(want)) return p;
    const oldBase = path.basename(p, '.md'); const newBase = path.basename(want, '.md'); fs.renameSync(p, want);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []);
    for (const f of walk(this.dir)) { const t = fs.readFileSync(f, 'utf8'); const n = t.split(`[[${oldBase}]]`).join(`[[${newBase}]]`).split(`[[${oldBase}|`).join(`[[${newBase}|`); if (n !== t) fs.writeFileSync(f, n); }
    return want;
  }
  file(scope: 'team' | 'owner' | 'self', agent?: { id: string; name: string }): string { this.ensure(); return scope === 'team' ? path.join(this.dir, 'Team.md') : scope === 'owner' ? path.join(this.dir, 'Owner.md') : this.notePath(agent!); }

  /** Add one line under a section (deduplicated; at most 40 lines per section, oldest dropped). Refuses secrets. */
  remember(input: { scope: 'team' | 'owner' | 'self'; section?: Section; text: string; agent: { id: string; name: string }; source?: string }): { ok: true; file: string; added: boolean } | { ok: false; reason: string } {
    const text = String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400); if (!text) return { ok: false, reason: 'nothing to remember' };
    const secret = looksSecret(text); if (secret) return { ok: false, reason: `not saved: ${secret}. Memory never holds secrets.` };
    const section: Section = SECTIONS.includes(input.section as Section) ? input.section as Section : 'Lessons';
    const file = this.file(input.scope, input.agent); let t = fs.readFileSync(file, 'utf8');
    if (!new RegExp(`^## ${section}\\s*$`, 'm').test(t)) t = `${t.trimEnd()}\n\n## ${section}\n`;
    const lines = t.split('\n'); const start = lines.findIndex((l) => l.trim() === `## ${section}`); let end = lines.findIndex((l, i) => i > start && /^## /.test(l)); if (end < 0) end = lines.length;
    const items = lines.slice(start + 1, end).filter((l) => l.trim().startsWith('- '));
    const norm = (s: string) => s.replace(/^- /, '').replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (items.some((l) => norm(l) === norm(`- ${text}`))) return { ok: true, file, added: false };
    const kept = [...items, `- ${text} (${today()}${input.source ? `, ${input.source}` : ''})`].slice(-MAX_PER_SECTION);
    const next = [...lines.slice(0, start + 1), ...kept, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').replace(/^updated: .*$/m, `updated: ${today()}`);
    fs.writeFileSync(file, next);
    const log = path.join(this.dir, 'Lessons', `${today()}.md`); const who = input.scope === 'self' ? `[[${path.basename(file, '.md')}]]` : `[[${path.basename(file, '.md')}]]`;
    fs.appendFileSync(log, `${fs.existsSync(log) ? '' : `# Lessons ${today()}\n\n`}- ${who} · ${section}: ${text}\n`);
    return { ok: true, file, added: true };
  }

  /** Remove lines containing the given text from a section file (the lead acting on the owner's word, or the owner). */
  forget(input: { scope: 'team' | 'owner' | 'self'; agent: { id: string; name: string }; contains: string }): number {
    const needle = String(input.contains ?? '').trim().toLowerCase(); if (needle.length < 4) return 0;
    const file = this.file(input.scope, input.agent); const lines = fs.readFileSync(file, 'utf8').split('\n'); const kept = lines.filter((l) => !(l.trim().startsWith('- ') && l.toLowerCase().includes(needle)));
    if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n')); return lines.length - kept.length;
  }
  readNote(agent: { id: string; name: string }): { path: string; text: string } { const p = this.notePath(agent); return { path: p, text: fs.readFileSync(p, 'utf8') }; }
  writeNote(agent: { id: string; name: string }, text: string): { ok: true } | { ok: false; reason: string } {
    const s = looksSecret(text); if (s) return { ok: false, reason: `not saved: ${s}. Memory never holds secrets.` };
    let body = String(text); if (!/^---\n[\s\S]*?assistant:/.test(body)) body = `---\nassistant: ${agent.id}\nupdated: ${today()}\n---\n${body.replace(/^---\n[\s\S]*?\n---\n/, '')}`;
    fs.writeFileSync(this.notePath(agent), body); return { ok: true };
  }

  /** Everything a turn should know, in full: Team, Owner and the assistant's own note (frontmatter stripped). */
  context(agent: { id: string; name: string }): string {
    const strip = (p: string) => { try { return fs.readFileSync(p, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim(); } catch { return ''; } };
    const parts = [['Team rules', this.file('team')], ['About the owner', this.file('owner')], [`Your own memory (${agent.name})`, this.notePath(agent)]].map(([h, p]) => { const body = strip(p).split('\n').filter((l) => !/^# /.test(l)).join('\n').trim(); return /- /.test(body) ? `${h}:\n${body}` : ''; }).filter(Boolean);
    return parts.length ? `Memory (from the owner's memory vault; follow it, it is what you have learned):\n${parts.join('\n\n')}` : '';
  }
}
