import { runCheck, checksFor } from './project-check.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { JobStore, newId, now } from '../jobs/store.ts';
import type { Job } from '../jobs/types.ts';
import { ActionStore } from '../actions/store.ts';
import { ApprovalStore } from '../approvals/store.ts';
import { runProbe } from '../infra/probe.ts';
import { collectReport, openWork } from '../cos/report.ts';

export interface DetCtx { db: DB; store: JobStore; job: Job; workspace: string; previous: Record<string, unknown>; actor: string; approvals: ApprovalStore; actions: ActionStore }
export type DetResult = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string; terminal?: boolean; operatorAction?: string };
export type DetFn = (ctx: DetCtx) => Promise<DetResult>;

function recordArtifact(ctx: DetCtx, stage: string, kind: string, title: string, filePath: string | null, extra: Record<string, unknown> = {}): string {
  const id = newId('art');
  const sha = filePath && fs.existsSync(filePath) ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : null;
  ctx.db.prepare('INSERT INTO artifacts(id, job_id, stage_name, kind, path, sha256, title, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, ctx.job.id, stage, kind, filePath, sha, title, JSON.stringify({ actor: ctx.actor, ...extra }), now());
  return id;
}

export const DETERMINISTIC: Record<string, DetFn> = {
  /** Morning report, step 1: snapshot the ledger (counts and lists of real rows) for the Chief of Staff to write from. */
  collect_report: async (ctx) => { const r = collectReport(ctx.db, ctx.job.id, ctx.job.workspace_id ?? null); return { ok: true, payload: r }; },
  /** Morning report, last step: the Chief of Staff must have written the headline and lede (save_report); otherwise the report failed. */
  verify_report: async (ctx) => { const r = ctx.db.prepare("SELECT id, status FROM reports WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(ctx.job.id) as { id: string; status: string } | undefined; if (!r) return { ok: false, reason: 'no report was collected', terminal: true }; if (r.status !== 'written') { ctx.db.prepare("UPDATE reports SET status = 'failed' WHERE id = ?").run(r.id); return { ok: false, reason: 'the Chief of Staff did not write the report (save_report was not called)', terminal: true, operatorAction: 'Generate the report again.' }; } return { ok: true, payload: { report_id: r.id, written: true } }; },
  /** Ranking, step 1: the open work to rank, as plain text. */
  collect_open_work: async (ctx) => { const open = openWork(ctx.db); return { ok: true, payload: { open_count: open.length, open_text: open.length ? open.map((o) => `- task ${o.id}: ${o.title} (${o.agent}, ${o.state}${o.rank ? `, currently rank ${o.rank}` : ', unranked'})`).join('\n') : '- none' } }; },
  /** Wait a bounded number of seconds (task input `seconds`, max 300): pacing between external reads, or a deterministic slot-holder in tests. */
  async wait_seconds(ctx) {
    const secs = Math.min(300, Math.max(0, Number((JSON.parse(ctx.job.inputs || '{}') as { seconds?: number }).seconds ?? 1)));
    await new Promise((r) => setTimeout(r, secs * 1000));
    return { ok: true, payload: { waited_seconds: secs, summary: `waited ${secs}s` } };
  },
  async prepare_repo_workspace(ctx) {
    const inputs = JSON.parse(ctx.job.inputs || '{}') as { repository?: string };
    const repo = inputs.repository ? path.resolve(inputs.repository) : null;
    if (!repo || !fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return { ok: false, reason: `repository path ${inputs.repository ?? '(none)'} does not exist`, terminal: true, operatorAction: 'Set the task input "repository" to an existing directory and re-queue.' };
    fs.mkdirSync(ctx.workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ctx.workspace, 'JOB.md'), `# Task ${ctx.job.id}\n\nObjective: ${ctx.job.objective}\nRepository: ${repo}\n`);
    return { ok: true, payload: { workspace: ctx.workspace, repository: repo } };
  },
  /** The engine runs the project's checks itself (Claude never gets a shell): fixed profiles, sandboxed, output saved as a file artifact. */
  async run_project_tests(ctx) {
    const inputs = JSON.parse(ctx.job.inputs || '{}') as { repository?: string; test_command?: string; checks?: unknown };
    const repo = String(ctx.previous.repository ?? (inputs.repository ? path.resolve(inputs.repository) : ''));
    if (!repo || !fs.existsSync(repo)) return { ok: false, reason: 'repository path missing', terminal: true, operatorAction: 'Set the task input "repository" to an existing directory.' };
    const { profiles, note } = checksFor(repo, inputs);
    fs.mkdirSync(ctx.workspace, { recursive: true, mode: 0o700 });
    const results: Array<{ profile: string; label: string; ok: boolean; exit: number | null; artifact: string | null; notRun: boolean }> = [];
    for (const profile of profiles) {
      const r = await runCheck(repo, profile, { timeoutMs: 180_000 });
      if (r.notRun) { results.push({ profile, label: profile, ok: false, exit: null, artifact: null, notRun: true }); continue; }
      const file = path.join(ctx.workspace, `final-${profile}-output.txt`); fs.writeFileSync(file, r.output);
      const artifactId = recordArtifact(ctx, 'run_tests', 'file', `Final ${r.label} (${r.ok ? 'passed' : 'failed'})`, file, { command: r.label, exit: r.exit, timed_out: r.timedOut });
      ctx.store.event(ctx.job.id, ctx.actor, 'command.ran', { command: r.label, cwd: repo, exit: r.exit, timed_out: r.timedOut, final: true });
      results.push({ profile, label: r.label, ok: r.ok, exit: r.exit, artifact: artifactId, notRun: false });
    }
    const ran = results.filter((x) => !x.notRun); const passed = ran.length > 0 && ran.every((x) => x.ok);
    const summaryLine = ran.map((x) => `${x.label} ${x.ok ? 'passed' : 'FAILED'}`).join(', ') || 'no checks could run';
    ctx.db.prepare('UPDATE jobs SET outcome = ?, outcome_detail = ?, updated_at = ? WHERE id = ?').run(passed ? 'success' : 'partial', JSON.stringify({ reason: `final checks: ${summaryLine}${note ? ` (${note})` : ''}`, remaining: passed ? null : 'failing or missing checks; see the saved outputs', reported_by: 'engine', at: now() }), now(), ctx.job.id);
    return { ok: true, payload: { test_result: passed ? 'pass' : 'fail', checks: results, test_output_artifact: results.find((x) => x.artifact)?.artifact ?? null, summary: String(ctx.previous.summary ?? '') + ` · ${summaryLine}` } };
  },
  async verify_artifacts(ctx) {
    const rows = ctx.db.prepare("SELECT id, path, sha256 FROM artifacts WHERE job_id = ? AND kind = 'file'").all(ctx.job.id) as Array<{ id: string; path: string | null; sha256: string | null }>;
    if (!rows.length) return { ok: false, reason: 'no file artifact was registered', terminal: false };
    const bad = rows.filter((r) => !r.path || !fs.existsSync(r.path) || crypto.createHash('sha256').update(fs.readFileSync(r.path)).digest('hex') !== r.sha256);
    if (bad.length) return { ok: false, reason: `${bad.length} artifact(s) missing or changed since registration`, terminal: true, operatorAction: 'An artifact file no longer matches its registered hash. Re-run the task.' };
    return { ok: true, payload: { artifacts_verified: rows.length, summary: String(ctx.previous.summary ?? `${rows.length} artifact(s) verified`) } };
  },
  async prepare_workspace(ctx) {
    fs.mkdirSync(ctx.workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ctx.workspace, 'JOB.md'), `# Task ${ctx.job.id}\n\nObjective: ${ctx.job.objective}\n\nWorkflow: ${ctx.job.kind}\nAgent: ${ctx.job.agent_role}\nCreated: ${ctx.job.created_at}\n`);
    return { ok: true, payload: { workspace: ctx.workspace, prepared_at: now() } };
  },
  async collect_state(ctx) {
    const ws = ctx.job.workspace_id;
    const objectives = ctx.db.prepare("SELECT id, title, status FROM objectives WHERE status = 'active' AND (? IS NULL OR workspace_id = ?)").all(ws, ws);
    const open = ctx.db.prepare("SELECT id, kind, agent_role, state, blocker_code FROM jobs WHERE state NOT IN ('completed','failed_terminal','cancelled') AND id != ? AND (? IS NULL OR workspace_id = ?)").all(ctx.job.id, ws, ws);
    const blockers = ctx.db.prepare("SELECT id, blocker_code, operator_action FROM jobs WHERE blocker_code IS NOT NULL AND state NOT IN ('completed','cancelled')").all();
    const pending = ctx.db.prepare("SELECT id, action_kind, target FROM approvals WHERE status = 'pending'").all();
    return { ok: true, payload: { objectives, open_jobs: open, blockers, pending_approvals: pending, collected_at: now() } };
  },
  async write_brief(ctx) {
    fs.mkdirSync(ctx.workspace, { recursive: true, mode: 0o700 });
    const p = ctx.previous as { objectives?: unknown[]; open_jobs?: unknown[]; blockers?: Array<{ id: string; blocker_code: string; operator_action: string }>; pending_approvals?: unknown[] };
    const file = path.join(ctx.workspace, 'brief.md');
    const lines = [`# Daily brief — ${now()}`, '', `Active objectives: ${p.objectives?.length ?? 0}`, `Open jobs: ${p.open_jobs?.length ?? 0}`, `Pending approvals: ${p.pending_approvals?.length ?? 0}`, '', '## Blockers'];
    for (const b of p.blockers ?? []) lines.push(`- ${b.id}: ${b.blocker_code} — ${b.operator_action ?? ''}`);
    if (!(p.blockers?.length)) lines.push('- none');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const artifactId = recordArtifact(ctx, 'write_brief', 'note', 'Daily brief', file);
    return { ok: true, payload: { brief_path: file, artifact_id: artifactId, summary: `brief with ${p.blockers?.length ?? 0} blockers` } };
  },
  async verify_evidence(ctx) {
    const rows = ctx.db.prepare('SELECT id, source_url FROM memory_evidence WHERE job_id = ?').all(ctx.job.id) as Array<{ id: string; source_url: string | null }>;
    const bad = rows.filter((r) => !r.source_url || !/^https?:\/\//.test(r.source_url));
    if (rows.length === 0) return { ok: false, reason: 'no evidence recorded by the research stage', terminal: false };
    if (bad.length) return { ok: false, reason: `${bad.length} evidence rows lack a source URL`, terminal: true, operatorAction: 'Evidence without sources is not accepted. Re-run the job or ask the agent to cite sources.' };
    const summary = typeof ctx.previous.summary === 'string' ? ctx.previous.summary : `${rows.length} evidence rows verified`;
    return { ok: true, payload: { evidence_count: rows.length, summary } };
  },
  async prepare_audience(ctx) {
    return { ok: true, payload: { audience: 'owner-approved audience only; none defined yet', summary: String(ctx.previous.summary ?? 'assets prepared') } };
  },
  /** Only runs actions that carry a verified approval and an unused idempotency key; everything else is refused and audited. */
  async execute_within_bounds(ctx) {
    const approved = ctx.db.prepare("SELECT * FROM approvals WHERE job_id = ? AND status = 'approved'").all(ctx.job.id) as Array<{ id: string; action_kind: string; target: string; content: string }>;
    const results: unknown[] = [];
    for (const a of approved) {
      const r = await ctx.actions.perform({ job_id: ctx.job.id, idempotency_key: `${ctx.job.id}:${a.id}`, kind: a.action_kind, target: a.target, content: a.content, approval_id: a.id, actor: ctx.actor });
      results.push({ approval_id: a.id, status: r.status, reason: (r as { reason?: string }).reason ?? null });
    }
    return { ok: true, payload: { executed: results, summary: `${results.filter((r) => (r as { status: string }).status === 'performed').length} performed, ${results.filter((r) => (r as { status: string }).status === 'refused').length} refused` } };
  },
  async measure(ctx) {
    const n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM records WHERE type LIKE '%outcome%' AND (? IS NULL OR workspace_id = ?)").get(ctx.job.workspace_id, ctx.job.workspace_id) as { n: number }).n;
    return { ok: true, payload: { outcomes_total: n, summary: String(ctx.previous.summary ?? '') } };
  },
  async propose_next(ctx) {
    const id = newId('prop');
    ctx.db.prepare('INSERT INTO memory_proposals(id, job_id, title, body, rationale, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, ctx.job.id, `Next action after ${ctx.job.kind}`, `Review the artifacts of job ${ctx.job.id} and decide whether to approve the pending actions.`, 'Learning proposes; it never changes policy.', 'proposed', now());
    return { ok: true, payload: { proposal_id: id, summary: String(ctx.previous.summary ?? 'proposal recorded') } };
  },
};
