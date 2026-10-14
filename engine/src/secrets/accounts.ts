/**
 * Account passwords the assistants create (owner: "Jude can set the passwords too"). The broker generates a strong password,
 * keeps it in the macOS Keychain (service "claudebot.account") or, off macOS, in a 0600 file in the secrets folder, and types it
 * with browser_act fill_secret. The value is never returned to the model, never written to a log, event, chat or memory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SERVICE = 'claudebot.account';
export type Exec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; code?: number | null }>;
const run: Exec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15_000 }, (err, out) => resolve({ ok: !err, stdout: String(out ?? ''), code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : null) : 0 })));
/** `security` exit status for "the specified item could not be found in the keychain" (errSecItemNotFound). */
const NOT_FOUND = 44;

/** What the store holds for an account. A store error (a locked keychain, an unreadable file) is never read as "nothing stored". */
export type SecretRead = { status: 'found'; value: string } | { status: 'missing' } | { status: 'error'; reason: string };
export type SecretWrite = { ok: true } | { ok: false; reason: 'exists' | 'error' | 'invalid'; detail: string };

/** A 20-character password with upper, lower, digit and symbol (what account sign-up forms ask for). */
export function generatePassword(len = 20): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#$%*+-=?@_'];
  const all = sets.join(''); const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = [...sets.map(pick), ...Array.from({ length: len - sets.length }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/** "workday:jane@example.com" style key: site plus login, lower-cased; only safe characters. */
export function accountKey(account: string): string { return String(account ?? '').trim().toLowerCase().replace(/[^a-z0-9@._:+-]/g, '').slice(0, 200); }

export class AccountSecrets {
  private o: { secretsDir: string; platform?: NodeJS.Platform; exec?: Exec };
  constructor(o: { secretsDir: string; platform?: NodeJS.Platform; exec?: Exec }) { this.o = o; }
  private get mac() { return (this.o.platform ?? process.platform) === 'darwin'; }
  private get file() { return path.join(this.o.secretsDir, 'accounts.json'); }
  private readFile(): { ok: true; all: Record<string, string> } | { ok: false; reason: string } {
    let raw: string; try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, all: {} } : { ok: false, reason: `the password file could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` }; }
    try { const all = JSON.parse(raw) as unknown; if (all && typeof all === 'object' && !Array.isArray(all)) return { ok: true, all: all as Record<string, string> }; } catch { /* below */ }
    return { ok: false, reason: 'the password file is damaged' };
  }

  async read(account: string): Promise<SecretRead> {
    const key = accountKey(account); if (!key) return { status: 'missing' };
    if (this.mac) {
      const r = await (this.o.exec ?? run)('/usr/bin/security', ['find-generic-password', '-a', key, '-s', SERVICE, '-w']);
      if (r.ok) { const v = r.stdout.replace(/\n$/, ''); return v ? { status: 'found', value: v } : { status: 'error', reason: 'the Keychain returned an empty password' }; }
      return r.code === NOT_FOUND ? { status: 'missing' } : { status: 'error', reason: `the Keychain could not be read (security exit ${r.code ?? '?'}; it may be locked)` };
    }
    const f = this.readFile(); if (!f.ok) return { status: 'error', reason: f.reason };
    return f.all[key] ? { status: 'found', value: f.all[key] } : { status: 'missing' };
  }

  /** Store a password. An existing one is never overwritten unless replace is true, and nothing is written when the store cannot be read. */
  async set(account: string, value: string, opts: { replace?: boolean } = {}): Promise<SecretWrite> {
    const key = accountKey(account); if (!key || !value) return { ok: false, reason: 'invalid', detail: 'an account and a value are required' };
    const cur = await this.read(key);
    if (cur.status === 'error') return { ok: false, reason: 'error', detail: cur.reason };
    if (cur.status === 'found' && !opts.replace) return { ok: false, reason: 'exists', detail: `a password for ${key} is already stored` };
    if (this.mac) {
      const r = await (this.o.exec ?? run)('/usr/bin/security', ['add-generic-password', ...(opts.replace ? ['-U'] : []), '-a', key, '-s', SERVICE, '-w', value]);
      return r.ok ? { ok: true } : { ok: false, reason: 'error', detail: `the Keychain refused the write (security exit ${r.code ?? '?'})` };
    }
    const f = this.readFile(); if (!f.ok) return { ok: false, reason: 'error', detail: f.reason };
    fs.mkdirSync(this.o.secretsDir, { recursive: true, mode: 0o700 });
    const all = { ...f.all, [key]: value };
    const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 }); fs.renameSync(tmp, this.file); fs.chmodSync(this.file, 0o600);
    return { ok: true };
  }

  /** The stored value, or null when nothing is stored or the store cannot be read (use read() to tell those apart). */
  async get(account: string): Promise<string | null> { const r = await this.read(account); return r.status === 'found' ? r.value : null; }
}
