/**
 * CI watch (Abdul builder plan, step 7). While a build's pull request is open, its checks are read with gh every 5 minutes. Red: the
 * change is re-queued on its branch with the failing checks' logs as input (requeueBuild: five fix rounds, then a blocker line). Green:
 * one team line per head commit. Merged or closed: the watch ends. Read-only on GitHub: it never pushes, merges or comments; pushing the
 * fixed branch is the push step's job.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import { teamLine } from '../cos/alerts.ts';
import { requeueBuild } from './pipeline.ts';

const run = promisify(execFile);
export const CI_EVERY_MS = 5 * 60_000;
export type CheckState = 'success' | 'failure' | 'pending';
export interface PrStatus { state: 'OPEN' | 'MERGED' | 'CLOSED'; head: string; checks: Array<{ name: string; state: CheckState; run_id?: string | null }> }
export interface GhReader { prStatus(repo: string, pr: number): Promise<PrStatus>; failedLog(repo: string, runId: string): Promise<string> }
export interface PrWatch { repo: string; pr: number; branch: string; build_job: string; build_root: string; status: 'open' | 'done' | 'stopped'; checked_at?: string; green_sha?: string; red_sha?: string; since: string }

const key = (repo: string, pr: number) => `ci.watch.${repo}#${pr}`;
const save = (db: DB, w: PrWatch, why: string) => db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(key(w.repo, w.pr), JSON.stringify(w), why, new Date().toISOString());
export function watches(db: DB): PrWatch[] { return (db.prepare("SELECT value FROM runtime_state WHERE key LIKE 'ci.watch.%'").all() as Array<{ value: string }>).map((r) => JSON.parse(r.value) as PrWatch); }

/** Start watching a build's pull request (the push step calls this when it opens or updates the PR). */
export function watchPr(db: DB, store: JobStore, w: { repo: string; pr: number; branch: string; build_job: string }): PrWatch {
  if (!/^[\w.-]+\/[\w.-]+$/.test(w.repo) || !Number.isInteger(w.pr) || w.pr <= 0) throw new Error('repo must be owner/name and pr a number');
  const build = store.get(w.build_job); if (!build) throw new Error(`no build task ${w.build_job}`);
  const root = String((JSON.parse(build.inputs || '{}') as { build_root?: string }).build_root ?? build.id);
  const prev = watches(db).find((x) => x.repo === w.repo && x.pr === w.pr);
  const next: PrWatch = { ...(prev ?? {}), repo: w.repo, pr: w.pr, branch: w.branch, build_job: w.build_job, build_root: root, status: 'open', since: prev?.since ?? new Date().toISOString() };
  save(db, next, 'watch started'); store.event(w.build_job, 'engine', 'ci.watch', { repo: w.repo, pr: w.pr, branch: w.branch });
  return next;
}

/** The newest build of the change (fix rounds included): the one a red run sends back. */
function latestBuild(db: DB, root: string): string {
  return (db.prepare("SELECT id FROM jobs WHERE kind = 'build.task' AND (id = ? OR json_extract(inputs, '$.build_root') = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1").get(root, root) as { id: string } | undefined)?.id ?? root;
}

/** One pass over the open watches (each read at most every 5 minutes). Returns what happened per PR, for the log and tests. */
export async function ciTick(db: DB, store: JobStore, gh: GhReader = ghCli, nowMs = Date.now()): Promise<Array<{ pr: string; result: string }>> {
  const out: Array<{ pr: string; result: string }> = [];
  for (const w of watches(db).filter((x) => x.status === 'open')) {
    if (w.checked_at && nowMs - Date.parse(w.checked_at) < CI_EVERY_MS) continue;
    const name = `${w.repo}#${w.pr}`; w.checked_at = new Date(nowMs).toISOString();
    let s: PrStatus; try { s = await gh.prStatus(w.repo, w.pr); } catch (e) { save(db, w, 'gh failed'); out.push({ pr: name, result: `gh: ${(e as Error).message.slice(0, 120)}` }); continue; }
    if (s.state !== 'OPEN') { w.status = 'done'; save(db, w, `pr ${s.state.toLowerCase()}`); store.event(w.build_root, 'engine', 'ci.done', { repo: w.repo, pr: w.pr, state: s.state }); out.push({ pr: name, result: s.state.toLowerCase() }); continue; }
    const red = s.checks.filter((c) => c.state === 'failure'); const pending = s.checks.some((c) => c.state === 'pending');
    if (red.length && w.red_sha !== s.head) {
      const logs: string[] = [];
      for (const c of red.slice(0, 3)) { let log = ''; if (c.run_id) { try { log = await gh.failedLog(w.repo, c.run_id); } catch (e) { log = `(log unavailable: ${(e as Error).message.slice(0, 100)})`; } } logs.push(`## ${c.name}\n${log.split('\n').slice(-80).join('\n').slice(-3000)}`); }
      w.red_sha = s.head; const target = latestBuild(db, w.build_root);
      store.event(target, 'engine', 'ci.red', { repo: w.repo, pr: w.pr, head: s.head, failing: red.map((c) => c.name) });
      const fix = requeueBuild(db, store, target, { source: 'ci', feedback: `Failing checks on ${name} at ${s.head.slice(0, 7)}: ${red.map((c) => c.name).join(', ')}\n\n${logs.join('\n\n')}`, ref: s.head });
      if (!fix) w.status = 'stopped';
      save(db, w, 'ci red'); out.push({ pr: name, result: fix ? `red: fix ${fix.id}` : 'red: fix rounds exhausted' }); continue;
    }
    if (!red.length && !pending && s.checks.length && w.green_sha !== s.head) {
      w.green_sha = s.head; save(db, w, 'ci green'); store.event(w.build_root, 'engine', 'ci.green', { repo: w.repo, pr: w.pr, head: s.head });
      teamLine(db, store, { key: `ci-green:${name}:${s.head}`, jobId: w.build_root, text: `CI is green on ${name} (${w.branch}) at ${s.head.slice(0, 7)}.` });
      out.push({ pr: name, result: 'green' }); continue;
    }
    save(db, w, 'checked'); out.push({ pr: name, result: pending ? 'pending' : 'unchanged' });
  }
  return out;
}

/** gh on this machine (the owner's own sign-in), read-only calls only. */
export const ghCli: GhReader = {
  async prStatus(repo, pr) {
    const { stdout } = await run('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'state,headRefOid,statusCheckRollup'], { timeout: 60_000, maxBuffer: 8 << 20 });
    const j = JSON.parse(stdout) as { state: PrStatus['state']; headRefOid: string; statusCheckRollup: Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }> };
    return { state: j.state, head: j.headRefOid, checks: (j.statusCheckRollup ?? []).map((c) => {
      const raw = String(c.conclusion || c.state || c.status || '').toUpperCase();
      const state: CheckState = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(raw) ? 'success' : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(raw) ? 'failure' : 'pending';
      return { name: String(c.name ?? c.context ?? 'check'), state, run_id: /\/actions\/runs\/(\d+)/.exec(String(c.detailsUrl ?? c.targetUrl ?? ''))?.[1] ?? null };
    }) };
  },
  async failedLog(repo, runId) { const { stdout } = await run('gh', ['run', 'view', runId, '--repo', repo, '--log-failed'], { timeout: 120_000, maxBuffer: 32 << 20 }); return stdout; },
};
