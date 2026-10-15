/**
 * port.public (Abdul builder plan, step 8): ship a range of private commits to the public repository, renamed and scrubbed. The diff
 * from..to of the private repo is renamed with the owner's map, applied on a branch port/<job> in a worktree of the public clone, scanned
 * for anything private (the owner's deny list, personal emails, home paths, tokens and keys, .local hostnames) and tested; a single hit
 * fails the job and names file:line (the value masked). Nothing is pushed here: the push step and the CI watch take the branch on.
 *
 * settings port_public = { source, target, rename: [[from, to], ...], deny: [...], exclude: [paths], allow_emails: [...], last_synced }
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/open.ts';

const run = promisify(execFile);
export interface PortSettings { source: string; target: string; rename: Array<[string, string]>; deny: string[]; exclude: string[]; allow_emails: string[]; last_synced?: string }
export const NO_PORT_SETTINGS = 'port.public needs settings port_public with source (the private repository) and target (the public clone)';

export function portSettings(db: DB): PortSettings | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'port_public'").get() as { value: string } | undefined; if (!r) return null;
  let v: Partial<PortSettings> = {}; try { v = JSON.parse(r.value); } catch { return null; }
  if (!v.source || !v.target || !path.isAbsolute(v.source) || !path.isAbsolute(v.target)) return null;
  const rename = (Array.isArray(v.rename) ? v.rename : []).filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && p[0].length > 0 && typeof p[1] === 'string');
  return { source: v.source, target: v.target, rename, deny: (v.deny ?? []).map(String).filter(Boolean), exclude: (v.exclude ?? []).map(String).filter(Boolean), allow_emails: (v.allow_emails ?? []).map((x) => String(x).toLowerCase()), last_synced: v.last_synced };
}

/** Longest first, so "Agent OS" is renamed before "Agent". */
export function applyRename(text: string, rename: Array<[string, string]>): string {
  let out = text; for (const [from, to] of [...rename].sort((a, b) => b[0].length - a[0].length)) out = out.split(from).join(to); return out;
}

export interface ScrubHit { file: string; line: number; kind: string; masked: string }
const mask = (v: string) => `${v.slice(0, 2)}${'•'.repeat(Math.min(8, Math.max(3, v.length - 2)))}`;
const SAFE_EMAIL = /@(example\.(com|org|net)|[\w.-]+\.(test|invalid|example)|users\.noreply\.github\.com|noreply\.github\.com)$|^noreply@anthropic\.com$/i;
const SAFE_HOME = new Set(['runner', 'shared', 'you', 'user', 'username', 'me', 'example', 'name', '<you>', '<user>', '$user']);
const DETECTORS: Array<{ kind: string; re: RegExp; ok?: (m: string, s: PortSettings) => boolean }> = [
  { kind: 'token', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})\b/g },
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ok: (m, s) => SAFE_EMAIL.test(m) || s.allow_emails.includes(m.toLowerCase()) },
  { kind: 'home path', re: /\/(Users|home)\/([A-Za-z0-9._$<>-]+)/g, ok: (m) => SAFE_HOME.has(m.split('/')[2].toLowerCase()) },
  { kind: '.local hostname', re: /(?<![.\w-])[A-Za-z0-9-]+\.local\b(?![.\w-])/g, ok: (m) => /^(host|localhost|example|your-mac|mac)\.local$/i.test(m) },
];

/** Scan the added lines (and new file names) of a unified diff. */
export function scrubDiff(diff: string, s: PortSettings): ScrubHit[] {
  const hits: ScrubHit[] = []; let file = ''; let line = 0;
  const deny = s.deny.map((d) => d.toLowerCase());
  const check = (text: string, f: string, n: number) => {
    const low = text.toLowerCase();
    for (const d of deny) { const i = low.indexOf(d); if (i >= 0) hits.push({ file: f, line: n, kind: 'deny list', masked: mask(text.slice(i, i + d.length)) }); }
    for (const det of DETECTORS) for (const m of text.matchAll(det.re)) if (!det.ok?.(m[0], s)) hits.push({ file: f, line: n, kind: det.kind, masked: mask(m[0]) });
  };
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); check(file, file, 0); continue; }
    if (l.startsWith('@@')) { line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0) - 1; continue; }
    if (l.startsWith('+')) { line++; check(l.slice(1), file, line); } else if (!l.startsWith('-')) line++;
  }
  return hits;
}

const git = async (cwd: string, args: string[], input?: string) => {
  const p = run('git', args, { cwd, maxBuffer: 64 << 20, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (input !== undefined) p.child.stdin?.end(input);
  return (await p).stdout;
};

/** The renamed private diff applied on port/<job> in a worktree of the public clone (<target>-worktrees/port-<job>). */
export async function preparePort(s: PortSettings, jobId: string, from: string, to: string): Promise<{ ok: true; dir: string; branch: string; from: string; to: string; files: string[] } | { ok: false; error: string }> {
  try {
    const fromSha = (await git(s.source, ['rev-parse', '--verify', `${from}^{commit}`])).trim(); const toSha = (await git(s.source, ['rev-parse', '--verify', `${to}^{commit}`])).trim();
    if (fromSha === toSha) return { ok: false, error: `nothing to port: ${from} and ${to} are the same commit` };
    const excludes = s.exclude.map((e) => `:(exclude)${e}`);
    const raw = await git(s.source, ['diff', '--binary', '--no-color', '--no-ext-diff', fromSha, toSha, '--', '.', ...excludes]);
    if (!raw.trim()) return { ok: false, error: 'the range changes nothing outside the excluded paths' };
    const patch = applyRename(raw, s.rename);
    const name = `port-${jobId}`; const dir = path.join(`${s.target}-worktrees`, name); const branch = `port/${jobId}`;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (!fs.existsSync(dir)) { await git(s.target, ['worktree', 'prune']); await git(s.target, ['worktree', 'add', '--quiet', '-B', branch, dir, 'main']); }
    else { await git(dir, ['reset', '--quiet', '--hard', 'main']); await git(dir, ['clean', '-fdq']); }
    const p = path.join(dir, '..', `${name}.patch`); fs.writeFileSync(p, patch, { mode: 0o600 });
    try { await git(dir, ['apply', '--index', '--whitespace=nowarn', p]); }
    catch (e) { const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message); return { ok: false, error: `the renamed diff does not apply to the public main: ${msg.split('\n').filter((l) => /error|patch failed|does not exist/.test(l)).slice(0, 8).join('; ').slice(0, 600)}` }; }
    finally { fs.rmSync(p, { force: true }); }
    const files = (await git(dir, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
    return { ok: true, dir, branch, from: fromSha, to: toSha, files };
  } catch (e) { return { ok: false, error: String((e as { stderr?: string }).stderr || (e as Error).message).slice(0, 600) }; }
}

export async function stagedDiff(dir: string): Promise<string> { return git(dir, ['diff', '--cached', '--no-color', '--no-ext-diff', '-U0']); }
