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
export type Exec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;
const run: Exec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15_000 }, (err, out) => resolve({ ok: !err, stdout: String(out ?? '') })));

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
  private readFile(): Record<string, string> { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>; } catch { return {}; } }

  async set(account: string, value: string): Promise<boolean> {
    const key = accountKey(account); if (!key || !value) return false;
    if (this.mac) return (await (this.o.exec ?? run)('/usr/bin/security', ['add-generic-password', '-U', '-a', key, '-s', SERVICE, '-w', value])).ok;
    fs.mkdirSync(this.o.secretsDir, { recursive: true, mode: 0o700 });
    const all = this.readFile(); all[key] = value;
    const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 }); fs.renameSync(tmp, this.file); fs.chmodSync(this.file, 0o600);
    return true;
  }

  async get(account: string): Promise<string | null> {
    const key = accountKey(account); if (!key) return null;
    if (this.mac) { const r = await (this.o.exec ?? run)('/usr/bin/security', ['find-generic-password', '-a', key, '-s', SERVICE, '-w']); return r.ok ? r.stdout.replace(/\n$/, '') || null : null; }
    return this.readFile()[key] ?? null;
  }

  async has(account: string): Promise<boolean> { return (await this.get(account)) !== null; }
}
