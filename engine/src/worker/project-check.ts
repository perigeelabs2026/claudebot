// Bounded build/test/typecheck/lint runs for coding tasks (Gate 3). The engine runs them, never Claude's shell:
// fixed profiles mapped to the project's own scripts; only inside a disposable repository root (CLAUDEBOT_REPOS_ROOT,
// default ~/ClaudeBot-Repos) or the task workspace; process-group kill on timeout; secrets stripped from the environment;
// output capped and saved as a result. Every run is wrapped in a macOS sandbox profile: no outbound network at all (not even
// localhost: the engine, gateway and the unauthenticated browser DevTools port listen there), no reads of ClaudeBot / OpenClaw /
// Claude / SSH / keychain files, and no file writes outside the repository and temporary folders — the code under test is written by an
// assistant, so a "test" or "build" must not become an unapproved external action or a write elsewhere on the Mac.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProbe } from '../infra/probe.ts';

export type CheckProfile = 'test' | 'build' | 'typecheck' | 'lint';
export function reposRoot(): string { return path.resolve(process.env.CLAUDEBOT_REPOS_ROOT ?? path.join(os.homedir(), 'ClaudeBot-Repos')); }

/** Resolve the command for a profile from the repository's own files; null with a reason when not available. */
export function commandFor(repo: string, profile: CheckProfile): { bin: string; args: string[]; label: string } | { error: string } {
  const pkgPath = path.join(repo, 'package.json'); let scripts: Record<string, string> = {};
  if (fs.existsSync(pkgPath)) { try { scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { return { error: 'package.json is not valid JSON' }; } }
  const npmRun = (s: string) => ({ bin: 'npm', args: ['run', s, '--silent'], label: `npm run ${s}` });
  switch (profile) {
    case 'test': if (scripts.test) return { bin: 'npm', args: ['test', '--silent'], label: 'npm test' }; if (fs.existsSync(pkgPath) || fs.readdirSync(repo).some((f) => /\.test\.(m?js|ts)$/.test(f)) || fs.existsSync(path.join(repo, 'test'))) return { bin: process.execPath, args: ['--test'], label: 'node --test' }; if (fs.existsSync(path.join(repo, 'tests')) || fs.readdirSync(repo).some((f) => /^test_.*\.py$/.test(f))) return { bin: 'python3', args: ['-m', 'unittest', 'discover', '-v'], label: 'python3 -m unittest discover' }; return { error: 'no tests found (no test script, test files or tests folder)' };
    case 'build': return scripts.build ? npmRun('build') : { error: 'the project has no "build" script' };
    case 'lint': return scripts.lint ? npmRun('lint') : { error: 'the project has no "lint" script' };
    case 'typecheck': if (scripts.typecheck) return npmRun('typecheck'); { const tsc = path.join(repo, 'node_modules', '.bin', 'tsc'); if (fs.existsSync(tsc) && fs.existsSync(path.join(repo, 'tsconfig.json'))) return { bin: tsc, args: ['--noEmit', '-p', '.'], label: 'tsc --noEmit' }; } return { error: 'no "typecheck" script and no local TypeScript with tsconfig.json' };
  }
}

/** The repository must be a real directory under the disposable repos root or the task workspace (symlinks resolved). */
export function allowedRepo(repo: string, workspace: string): string | null {
  let real: string; try { real = fs.realpathSync(repo); } catch { return null; }
  const roots = [reposRoot(), path.resolve(workspace)].map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  return roots.some((r) => real === r || real.startsWith(r + path.sep)) && fs.statSync(real).isDirectory() ? real : null;
}

const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|SESSION|COOKIE|^AWS_|^GH_|^GITHUB_|^NPM_TOKEN|^CLAUDEBOT_|^CLAUDEBOT_|^CLAUDE|^ANTHROPIC|^OPENAI|^OPENCLAW/i;
export function scrubbedEnv(): NodeJS.ProcessEnv { const e: NodeJS.ProcessEnv = {}; for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) e[k] = v; delete e.NODE_TEST_CONTEXT; delete e.NODE_OPTIONS; e.CI = '1'; e.NO_COLOR = '1'; return e; }

export const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(deny network-outbound (remote unix-socket))
(deny file-read* (subpath (param "CB_HOME")) (subpath (param "OPENCLAW_HOME")) (subpath (param "CLAUDE_HOME")) (subpath (param "SSH_HOME")) (subpath (param "KEYCHAINS")) (subpath (param "CLAUDE_JSON")))
(deny file-write*)
(allow file-write* (subpath (param "REPO")) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath (param "NPM_CACHE")) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))`;
/** Wrap a command in the check sandbox (macOS sandbox-exec). */
export function sandboxed(repo: string, bin: string, args: string[]): { bin: string; args: string[] } {
  // The sandbox matches real paths: resolve symlinks (e.g. /var → /private/var) or a protected folder could be read through its alias.
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const h = real(os.homedir()); const aos = real(process.env.CLAUDEBOT_HOME ?? path.join(h, '.claudebot'));
  // Code under test must not read ClaudeBot / OpenClaw / Claude credentials or reach the engine (48311), gateway (48310) or browser control (48323).
  return { bin: '/usr/bin/sandbox-exec', args: ['-p', SANDBOX_PROFILE, '-D', `REPO=${fs.realpathSync(repo)}`, '-D', `NPM_CACHE=${path.join(h, '.npm')}`, '-D', `AOS_HOME=${aos}`, '-D', `OPENCLAW_HOME=${real(path.join(h, '.openclaw-claudebot'))}`, '-D', `CLAUDE_HOME=${real(path.join(h, '.claude'))}`, '-D', `SSH_HOME=${real(path.join(h, '.ssh'))}`, '-D', `KEYCHAINS=${real(path.join(h, 'Library', 'Keychains'))}`, '-D', `CLAUDE_JSON=${real(path.join(h, '.claude.json'))}`, bin, ...args] };
}

export async function runCheck(repo: string, profile: CheckProfile, opts: { timeoutMs?: number; registryDir?: string } = {}) {
  const c = commandFor(repo, profile); if ('error' in c) return { ok: false as const, label: profile, output: c.error, exit: null, timedOut: false, notRun: true };
  const w = sandboxed(repo, c.bin, c.args);
  const r = await runProbe(w.bin, w.args, { cwd: repo, timeoutMs: Math.min(opts.timeoutMs ?? 300_000, 600_000), label: `project_${profile}`, maxBuffer: 4 * 1024 * 1024, env: scrubbedEnv(), registryDir: opts.registryDir });
  return { ok: r.ok, label: c.label, output: `$ ${c.label}\n(in ${repo}; sandboxed: no network, no writes outside the repository)\n\n${r.stdout}${r.stderr ? '\n--- stderr ---\n' + r.stderr : ''}\n\nexit ${r.code ?? r.signal}${r.timedOut ? ' (timed out; process group killed)' : ''}\n`.slice(0, 200_000), exit: r.code, timedOut: r.timedOut, notRun: false };
}

/** Which final checks to run: the `checks` input (test/build/typecheck/lint); a legacy test_command is mapped to profiles;
 *  anything unrecognised falls back to the default (tests, plus build when the project has a build script) with a note. */
export function checksFor(repo: string, inputs: { test_command?: string; checks?: unknown }): { profiles: CheckProfile[]; note: string | null } {
  const valid = (x: unknown): x is CheckProfile => ['test', 'build', 'typecheck', 'lint'].includes(String(x));
  let hasBuild = false; try { hasBuild = !!(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts?.build; } catch { /* no package.json */ }
  const def: CheckProfile[] = hasBuild ? ['test', 'build'] : ['test'];
  if (Array.isArray(inputs.checks)) { const ps = [...new Set(inputs.checks.map(String).filter(valid))]; if (ps.length) return { profiles: ps, note: null }; return { profiles: def, note: `unknown checks ${JSON.stringify(inputs.checks)}; ran the default` }; }
  if (typeof inputs.test_command === 'string' && inputs.test_command.trim()) {
    const t = inputs.test_command.toLowerCase(); const ps: CheckProfile[] = [];
    if (/\b(test|node --test|unittest|pytest)\b/.test(t)) ps.push('test'); if (/\bbuild\b/.test(t)) ps.push('build'); if (/\b(typecheck|tsc)\b/.test(t)) ps.push('typecheck'); if (/\blint\b/.test(t)) ps.push('lint');
    if (ps.length) return { profiles: ps, note: ps.join('+') !== 'test' || !/^(node --test|npm test)$/.test(inputs.test_command.trim()) ? `"${inputs.test_command}" was run as the ${ps.join(' and ')} check${ps.length > 1 ? 's' : ''}, not as a shell command` : null };
    return { profiles: def, note: `"${inputs.test_command}" is not a known check; ran the default` };
  }
  return { profiles: def, note: null };
}
