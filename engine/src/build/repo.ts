/**
 * Build jobs work on the app's own repository inside the assistants' computer (the Linux VM), never on the Mac and never through a
 * host mount (Abdul builder plan, step 1). The clone lives at <repos>/<app> in the VM; each build.task works in its own git worktree
 * on the branch <lead>/<job-id>, cut from origin's default branch. The clone has no push URL (step 1 never pushes).
 * Fetching uses a read-only token from the VM secret store, read inside the VM through GIT_ASKPASS: it never reaches the Mac, argv,
 * the transcript or the logs. A public repository needs no token. At every prepare the token is tried with a dry-run push: a token
 * that could push is refused, so a leaked token can never write to the repository.
 * The checks (npm ci, the test script, typecheck) run as a separate builder uid with no sudo that cannot read the secret store, the
 * clone's .git (owned by the engine's user, so the builder can never move refs/heads/main), or any other worktree. While a check
 * runs, only that worktree belongs to the builder (minus its .git pointer and .claudebot/); afterwards it is handed back.
 * The hooks (no commit on main, no update of refs/heads/main) guard the engine's own mistakes only; the uid split is the real guard.
 * Tests (and Linux CI) run the same shell scripts locally under CLAUDEBOT_BUILD_LOCAL_ROOT.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '../db/open.ts';
import { VM_DATA, VM_REPOS } from '../runtime/computer.ts';
export { VM_REPOS };

/** builder: how to run a script as the builder uid (null: no separate uid, as on a developer machine); sudo: how the engine's user
 *  runs chown (empty when it is root). */
export interface RepoShell { where: 'vm' | 'local'; root: string; tokenFile: string; builder: string | null; sudo: string; run(script: string, opts?: { timeoutMs?: number }): Promise<{ code: number; out: string }> }
export interface BuildRepo { app: string; url: string }
export type BuildCheck = 'test' | 'typecheck';

const NAME = process.env.CLAUDEBOT_COMPUTER_NAME ?? 'claudebot-computer';
export const BUILDER = 'claudebot-builder';
/** The VM secret store holds the repository token (read-only scope); only the VM reads it. */
export const VM_REPO_TOKEN = `${VM_DATA}/secrets/repo-token`;
export const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function exec(bin: string, args: string[], input: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' }, (e, stdout, stderr) => {
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 124) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}` });
    });
    c.stdin?.end(input);
  });
}
/** The assistants' computer: every script runs there over ssh (stdin), never on the Mac. */
export function vmShell(): RepoShell {
  const cfg = path.join(os.homedir(), '.lima', NAME, 'ssh.config');
  return { where: 'vm', root: VM_REPOS, tokenFile: VM_REPO_TOKEN, builder: `sudo -n -u ${BUILDER} -H env PATH=/opt/node/bin:/usr/bin:/bin`, sudo: 'sudo -n ', run: (script, o = {}) => exec('ssh', ['-F', cfg, '-o', 'BatchMode=yes', `lima-${NAME}`, 'bash -s'], script, o.timeoutMs ?? 10 * 60_000) };
}
/** Tests and Linux CI: the same scripts in a local folder. CLAUDEBOT_BUILD_BUILDER (tests) is the command that runs a script as
 *  another uid, standing in for the builder. */
export function localShell(root: string, env: NodeJS.ProcessEnv = process.env): RepoShell {
  return { where: 'local', root: path.resolve(root), tokenFile: path.join(path.resolve(root), '.secrets', 'repo-token'), builder: env.CLAUDEBOT_BUILD_BUILDER || null, sudo: process.getuid?.() === 0 ? '' : 'sudo -n ', run: (script, o = {}) => exec('bash', ['-s'], script, o.timeoutMs ?? 10 * 60_000) };
}
/** Where build jobs run: the local root when CLAUDEBOT_BUILD_LOCAL_ROOT is set (tests), else the VM when the assistants' computer is on. */
export function buildShell(vmOn: boolean, env: NodeJS.ProcessEnv = process.env): RepoShell | null {
  if (env.CLAUDEBOT_BUILD_LOCAL_ROOT) return localShell(env.CLAUDEBOT_BUILD_LOCAL_ROOT);
  return vmOn ? vmShell() : null;
}
export function shellFor(where: unknown, env: NodeJS.ProcessEnv = process.env): RepoShell | null {
  if (where === 'local') return env.CLAUDEBOT_BUILD_LOCAL_ROOT ? localShell(env.CLAUDEBOT_BUILD_LOCAL_ROOT) : null;
  return where === 'vm' ? vmShell() : null;
}

/** The app's own repository: settings key build_repo ({"app","url"}), else CLAUDEBOT_BUILD_REPO_URL, else the public ClaudeBot repo. */
export function buildRepo(db: DB, env: NodeJS.ProcessEnv = process.env): BuildRepo {
  let s: Partial<BuildRepo> = {}; try { s = JSON.parse(String((db.prepare("SELECT value FROM settings WHERE key = 'build_repo'").get() as { value: string } | undefined)?.value ?? '{}')) as Partial<BuildRepo>; } catch { s = {}; }
  const url = String(s.url ?? env.CLAUDEBOT_BUILD_REPO_URL ?? 'https://github.com/perigeelabs2026/claudebot.git');
  const app = String(s.app ?? path.basename(url).replace(/\.git$/, '')).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'app';
  return { app, url };
}

const PROTECTED = 'main|master';
const HOOKS = `#!/bin/sh
# ClaudeBot: main is never writable from a build job.
b=$(git symbolic-ref --short -q HEAD)
case "$b" in ${PROTECTED}) echo "ClaudeBot: commits on $b are not allowed; build jobs work on their own branch" >&2; exit 1;; esac
exit 0
`;
const REFTX = `#!/bin/sh
# ClaudeBot: refs/heads/main and refs/heads/master are never updated by a build job.
[ "$1" = prepared ] || exit 0
while read -r old new ref; do case "$ref" in refs/heads/main|refs/heads/master) echo "ClaudeBot: $ref is read-only here" >&2; exit 1;; esac; done
exit 0
`;
/** git with the read-only token from the secret store when there is one (read inside the shell's machine via GIT_ASKPASS). */
function authGit(sh: RepoShell): string {
  return `ask=; if [ -s ${q(sh.tokenFile)} ]; then ask=$(mktemp); printf '#!/bin/sh\\ncase "$1" in Username*) echo x-access-token;; *) cat %s;; esac\\n' ${q(q(sh.tokenFile))} > "$ask"; chmod 700 "$ask"; fi
g() { if [ -n "$ask" ]; then GIT_ASKPASS="$ask" GIT_TERMINAL_PROMPT=0 git -c credential.helper= "$@"; else GIT_TERMINAL_PROMPT=0 git "$@"; fi; }
trap '[ -n "$ask" ] && rm -f "$ask"' EXIT`;
}

/** Clone the app's repository once (no push URL, main protected by hooks), and fetch. */
export async function ensureClone(sh: RepoShell, repo: BuildRepo): Promise<{ ok: true; dir: string } | { ok: false; error: string; terminal?: boolean }> {
  const dir = `${sh.root}/${repo.app}`;
  const r = await sh.run(`set -e
umask 022
${authGit(sh)}
mkdir -p ${q(sh.root)} ${q(`${dir}-worktrees`)}
chmod 711 ${q(sh.root)} ${q(`${dir}-worktrees`)}
if [ ! -d ${q(dir)}/.git ]; then g clone --quiet ${q(repo.url)} ${q(dir)}; fi
chmod 700 ${q(dir)}
cd ${q(dir)}
git remote set-url --push origin no-push-from-build-jobs
mkdir -p .git/hooks
cat > .git/hooks/pre-commit <<'HOOK'
${HOOKS}HOOK
cat > .git/hooks/reference-transaction <<'HOOK'
${REFTX}HOOK
chmod 755 .git/hooks/pre-commit .git/hooks/reference-transaction
g fetch --quiet origin
if [ -n "$ask" ] && g push --dry-run --quiet "$(git remote get-url origin)" HEAD:refs/heads/claudebot-push-probe >/dev/null 2>&1; then echo TOKEN_CAN_PUSH; exit 5; fi
echo CLONE_OK`, { timeoutMs: 10 * 60_000 });
  if (r.out.includes('TOKEN_CAN_PUSH')) return { ok: false, terminal: true, error: `the repository token can push to ${repo.url}. Build tasks only accept a read-only token: replace it with one that has read access only (contents: read).` };
  return r.code === 0 && r.out.includes('CLONE_OK') ? { ok: true, dir } : { ok: false, error: redactToken(r.out).slice(-600) };
}

/** A worktree for one build job on its own branch, cut from origin's default branch. Idempotent (a resumed job reuses it). */
export async function prepareWorktree(sh: RepoShell, repo: BuildRepo, jobId: string, lead: string): Promise<{ ok: true; dir: string; branch: string; base: string } | { ok: false; error: string }> {
  const clone = `${sh.root}/${repo.app}`; const dir = `${sh.root}/${repo.app}-worktrees/${jobId}`;
  const branch = `${lead.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}/${jobId}`;
  const r = await sh.run(`set -e
cd ${q(clone)}
base=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
if [ ! -d ${q(dir)} ]; then
  mkdir -p ${q(path.posix.dirname(dir))}; git worktree prune
  # A resumed job whose folder was removed (cleanup, a reset computer) gets its folder back on the branch it already has.
  if git show-ref --verify --quiet ${q(`refs/heads/${branch}`)}; then git worktree add --quiet ${q(dir)} ${q(branch)}; else git worktree add --quiet -b ${q(branch)} ${q(dir)} "$base"; fi
fi
chmod 700 ${q(dir)}
cd ${q(dir)}
for p in .mcp.json .claudebot/ shared CHANGES.md; do grep -qxF "$p" "$(git rev-parse --git-common-dir)/info/exclude" 2>/dev/null || echo "$p" >> "$(git rev-parse --git-common-dir)/info/exclude"; done
echo "BASE=$base"; echo "BRANCH=$(git symbolic-ref --short HEAD)"`, { timeoutMs: 120_000 });
  const got = /BRANCH=(\S+)/.exec(r.out)?.[1];
  if (r.code !== 0 || got !== branch) return { ok: false, error: r.out.slice(-600) };
  return { ok: true, dir, branch, base: /BASE=(\S+)/.exec(r.out)?.[1] ?? 'origin/main' };
}

/** Run one check in a worktree: the project's own scripts (npm test; npm run typecheck, else tsc --noEmit). engine/ is used when the
 *  repository keeps its package there. Dependencies are installed once from the lockfile. */
export async function runBuildCheck(sh: RepoShell, dir: string, check: BuildCheck, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; notRun: boolean; label: string; output: string; failing: string[] }> {
  const cmd = check === 'test' ? `if node -e 'process.exit(require("./package.json").scripts?.test?0:1)'; then echo '$ npm test'; npm test --silent; elif [ -d test ]; then echo '$ node --test'; node --test; else echo 'NOT_RUN: no test script'; exit 3; fi`
    : `if node -e 'process.exit(require("./package.json").scripts?.typecheck?0:1)'; then echo '$ npm run typecheck'; npm run typecheck --silent; elif [ -f tsconfig.json ] && [ -x node_modules/.bin/tsc ]; then echo '$ tsc --noEmit'; node_modules/.bin/tsc --noEmit -p .; else echo 'NOT_RUN: no typecheck script or TypeScript config'; exit 3; fi`;
  const inner = `cd ${q(dir)} || exit 2
[ -f package.json ] || { [ -f engine/package.json ] && cd engine; }
[ -f package.json ] || { echo 'NOT_RUN: no package.json'; exit 3; }
if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci --silent --no-audit --no-fund >/dev/null 2>&1 || echo 'npm ci failed; checks run without a fresh install'; fi
export CI=1 NO_COLOR=1
unset NODE_OPTIONS NODE_TEST_CONTEXT
${cmd}`;
  // As the builder: the worktree is the builder's for the length of the check (not its .git pointer or .claudebot/), then handed back.
  const script = sh.builder ? `me=$(id -un)
own() { ${sh.sudo}find ${q(dir)} -mindepth 1 \\( -path ${q(`${dir}/.git`)} -o -path ${q(`${dir}/.claudebot`)} \\) -prune -o -exec chown -h "$1" {} + ; ${sh.sudo}chown "$1" ${q(dir)}; }   # find runs privileged: the folder is 0700 and belongs to the builder while it is handed over
own ${q(sh.builder.match(/-u (\S+)/)?.[1] ?? BUILDER)}
${sh.builder} bash -s <<'CLAUDEBOT_CHECK'
${inner}
CLAUDEBOT_CHECK
rc=$?
own "$me"
exit $rc` : inner;
  const r = await sh.run(script, { timeoutMs });
  const notRun = r.code === 3 && /NOT_RUN:/.test(r.out);
  const label = /^\$ (.+)$/m.exec(r.out)?.[1] ?? check;
  return { ok: r.code === 0, notRun, label, output: r.out, failing: r.code === 0 ? [] : failingTests(r.out) };
}

/** Names of failing tests from node --test (spec or TAP) output. */
export function failingTests(out: string): string[] {
  const names = new Set<string>(); let inSummary = false;
  for (const line of out.split('\n')) {
    if (/^\s*✖ failing tests:/.test(line)) { inSummary = true; continue; }
    let m = /^\s*✖\s+(.+?)\s+\(\d+(?:\.\d+)?m?s\)\s*$/.exec(line) ?? /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
    if (!m && inSummary) m = null;
    if (m) { const n = m[1].trim(); if (!/\.(m?[jt]s)$/.test(n) && !/^test at /.test(n)) names.add(n); }
  }
  return [...names].slice(0, 20);
}

/** Commit the worktree's changes on its branch (never main; the hooks refuse it anyway). No push. */
export async function commitBuild(sh: RepoShell, dir: string, branch: string, message: string, author = { name: 'ClaudeBot build', email: 'build@claudebot.invalid' }): Promise<{ ok: true; commit: string | null; files: string[] } | { ok: false; error: string }> {
  if (/^(main|master)$/.test(branch)) return { ok: false, error: 'refusing to commit on main' };
  const r = await sh.run(`set -e
cd ${q(dir)}
[ "$(git symbolic-ref --short HEAD)" = ${q(branch)} ] || { echo "WRONG_BRANCH $(git symbolic-ref --short HEAD)"; exit 4; }
git add -A
if git diff --cached --quiet; then echo NO_CHANGES; exit 0; fi
git diff --cached --name-only | sed 's/^/FILE /'
git -c user.name=${q(author.name)} -c user.email=${q(author.email)} commit --quiet -m ${q(message)}
echo "COMMIT=$(git rev-parse HEAD)"`, { timeoutMs: 120_000 });
  if (r.code !== 0) return { ok: false, error: r.out.slice(-600) };
  return { ok: true, commit: /COMMIT=([0-9a-f]{40})/.exec(r.out)?.[1] ?? null, files: [...r.out.matchAll(/^FILE (.+)$/gm)].map((m) => m[1]) };
}

export function redactToken(s: string): string { return s.replace(/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|x-access-token:[^@\s]+)/g, '[redacted]'); }
