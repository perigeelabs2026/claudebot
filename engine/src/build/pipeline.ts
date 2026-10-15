/**
 * The build chain after a commit (Abdul builder plan, steps 5 and 7): every committed build.task gets an independent code.review on its
 * own model (fable by default); a FAIL, or a red CI run on the change's pull request, re-queues the build on the same branch and
 * worktree with the gaps or the failing log as its input. Five fix rounds per change, then one blocker line and nothing more.
 * Deploy requires a PASS for the exact commit (reviewPassed).
 */
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import type { Job } from '../jobs/types.ts';
import { Definitions } from '../model/definitions.ts';
import { teamLine } from '../cos/alerts.ts';
import { taskTitle } from '../model/wording.ts';

export const MAX_FIX_ROUNDS = 5;
export const REVIEW_KIND = 'code.review';
const inputsOf = (j: { inputs: string }) => { try { return JSON.parse(j.inputs || '{}') as Record<string, unknown>; } catch { return {}; } };
const setting = (db: DB, key: string): unknown => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined; try { return r ? JSON.parse(r.value) : undefined; } catch { return r?.value; } };

/** The first build of a change (fix rounds point at it with build_root). */
export function buildRoot(job: Job): string { return String(inputsOf(job).build_root ?? job.id); }
export function fixRounds(db: DB, root: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'build.task' AND json_extract(inputs, '$.build_root') = ?").get(root) as { n: number }).n;
}

/** After a commit: the code review of that build (model: settings code_review_model, else fable). Off with settings code_review = false. */
export function createCodeReview(db: DB, store: JobStore, build: Job, commit: string, branch: string, actor = 'engine'): Job | null {
  if (setting(db, 'code_review') === false) return null;
  const wf = new Definitions(db).getWorkflow(REVIEW_KIND); if (!wf || !wf.enabled) return null;
  const root = buildRoot(build); const model = String(setting(db, 'code_review_model') ?? 'fable');
  return store.create({ idempotency_key: `review:${build.id}`, kind: REVIEW_KIND, agent_role: wf.default_agent, success_contract: wf.contract, workspace_id: build.workspace_id, depends_on: [build.id], parent_id: build.parent_id,
    objective: `Review the change "${taskTitle(store.get(root)?.objective ?? build.objective)}" (${commit.slice(0, 7)} on ${branch})`, inputs: { build_job: build.id, build_root: root, commit, branch, round: fixRounds(db, root), model } }, actor).job;
}

/** A FAIL or a red CI run: the same change again, on the same branch and worktree, with what to fix. Null (and one blocker line) once
 *  the change has had MAX_FIX_ROUNDS fix rounds. */
export function requeueBuild(db: DB, store: JobStore, buildId: string, fix: { source: 'review' | 'ci'; feedback: string; ref: string }, actor = 'engine'): Job | null {
  const build = store.get(buildId); if (!build) return null;
  const root = buildRoot(build); const rootJob = store.get(root) ?? build; const rounds = fixRounds(db, root);
  if (rounds >= MAX_FIX_ROUNDS) {
    store.event(build.id, actor, 'build.fix_cap', { root, rounds, source: fix.source, ref: fix.ref });
    teamLine(db, store, { key: `build-cap:${root}`, owner: true, jobId: root, text: `The change "${taskTitle(rootJob.objective)}" still fails ${fix.source === 'ci' ? 'CI' : 'its code review'} after ${rounds} fix rounds; it stops here. Last: ${fix.feedback.replace(/\s+/g, ' ').slice(0, 200)}` });
    return null;
  }
  const ri = inputsOf(rootJob); const n = rounds + 1;
  const keep = Object.fromEntries(Object.entries(ri).filter(([k]) => ['change', 'model', 'checks'].includes(k)));
  const wf = new Definitions(db).getWorkflow('build.task'); if (!wf) return null;
  const j = store.create({ idempotency_key: `build-fix:${root}:${fix.source}:${fix.ref}`, kind: 'build.task', agent_role: rootJob.agent_role, success_contract: wf.contract, workspace_id: rootJob.workspace_id, parent_id: rootJob.parent_id,
    objective: `Fix (round ${n}): ${rootJob.objective}`, inputs: { ...keep, build_root: root, fix_round: n, fix_source: fix.source, previous_build: build.id,
      feedback_note: `\nThis is fix round ${n} of ${MAX_FIX_ROUNDS} for this change. ${fix.source === 'ci' ? 'CI failed on the pushed branch' : 'The independent code review FAILED it'}; fix exactly this, keep everything that already works, and add a test for each gap:\n<feedback>\n${fix.feedback.slice(0, 6000)}\n</feedback>\n` } }, actor);
  if (j.created) store.event(build.id, actor, 'build.requeued', { root, round: n, source: fix.source, ref: fix.ref, job: j.job.id });
  return j.job;
}

/** Deploy gate: a code review PASSed this exact commit (and no later review of it failed). */
export function reviewPassed(db: DB, commit: string): boolean {
  const last = db.prepare("SELECT type FROM job_events WHERE type IN ('code_review.passed', 'code_review.failed') AND json_extract(detail, '$.commit') = ? ORDER BY seq DESC LIMIT 1").get(commit) as { type: string } | undefined;
  return last?.type === 'code_review.passed';
}
