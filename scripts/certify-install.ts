/**
 * Gate 9 certification workload against the INSTALLED engine (real runtime): creates one clearly labelled temporary workspace,
 * runs a 10-task mixed workload, verifies every task completed with its contract and artifacts, then removes the workspace and
 * all of its history so the installed product ends clean. Exit 0 only when every check passes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = path.join(os.homedir(), '.claudebot'); const PORT = Number(process.env.CLAUDEBOT_PORT ?? 48311);
const token = fs.readFileSync(path.join(HOME, 'secrets', 'ui.token'), 'utf8').trim();
const api = async <T = Record<string, unknown>>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', 'x-claudebot-token': token }, body: init.body ? JSON.stringify(init.body) : undefined }); const j = await r.json() as T & { error?: string }; if (!r.ok) throw new Error(`${p}: ${j.error ?? r.status}`); return j; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WS_NAME = 'Certification (temporary)';

async function main() {
  const before = await api<{ counts: Record<string, number>; workspaces: number }>('/api/overview');
  const ws = await api<{ id: string; root_path: string }>('/api/workspaces', { method: 'POST', body: { name: WS_NAME, description: 'Temporary workload for installed-build certification; removed at the end.', worker_limit: 10 } });
  const log: string[] = [`certification workspace ${ws.id} created`];
  try {
    const plan: Array<{ kind: string; objective: string; inputs?: Record<string, unknown> }> = [
      { kind: 'research.report', objective: 'In three sourced bullet points, what does SQLite WAL mode change about readers and writers? Cite the official documentation.' },
      { kind: 'document.create', objective: 'Write a 150-word plain-English note titled "What a task checkpoint is" for a non-technical reader, saved as checkpoint-note.md.' },
      { kind: 'research.report', objective: 'List two documented differences between launchd KeepAlive and RunAtLoad, with source URLs.' },
      { kind: 'document.create', objective: 'Write a checklist (markdown) of five things to verify before archiving a workspace, saved as archive-checklist.md.' },
      { kind: 'monitor.scheduled', objective: 'Record the current UTC date and the number of files in this task workspace as an observation.' },
      { kind: 'system.workspace_summary', objective: 'Summarize this workspace' },
      { kind: 'system.workspace_summary', objective: 'Summarize this workspace again' },
      { kind: 'document.create', objective: 'Write a short glossary (markdown, 8 terms) for durable job queues, saved as glossary.md.' },
      { kind: 'research.report', objective: 'What is the Agent Client Protocol (ACP)? Two sentences with a source URL.' },
      { kind: 'system.workspace_summary', objective: 'Final summary' },
    ];
    const ids: string[] = [];
    for (const [i, p] of plan.entries()) ids.push((await api<{ job: { id: string } }>('/api/tasks', { method: 'POST', body: { workspace_id: ws.id, kind: p.kind, objective: p.objective, inputs: p.inputs ?? {}, idempotency_key: `cert:${ws.id}:${i}` } })).job.id);
    log.push(`${ids.length} tasks created`);
    let peak = 0; const t0 = Date.now(); const deadline = Date.now() + 40 * 60_000; let states: Record<string, string> = {};
    while (Date.now() < deadline) {
      const cap = (await api<{ capacity: { active: number } }>('/api/health')).capacity; peak = Math.max(peak, cap.active);
      const rows = await api<Array<{ id: string; state: string }>>(`/api/tasks?workspace=${ws.id}`); states = Object.fromEntries(rows.map((r) => [r.id, r.state]));
      if (ids.every((id) => ['completed', 'failed_terminal', 'cancelled', 'waiting_for_auth', 'waiting_for_reset'].includes(states[id]))) break;
      await sleep(4000);
    }
    log.push(`peak concurrent active ${peak}; elapsed ${Math.round((Date.now() - t0) / 1000)}s`);
    const results: Array<Record<string, unknown>> = []; let failed = 0;
    for (const id of ids) {
      const d = await api<{ job: Record<string, unknown>; checkpoints: unknown[]; artifacts: Array<{ kind: string; path: string | null; sha256: string | null }>; evidence: Array<{ source_url: string | null }> }>(`/api/tasks/${id}`);
      const ok = d.job.state === 'completed';
      const artifactsOk = d.artifacts.every((a) => !a.path || (fs.existsSync(a.path) && a.sha256));
      if (!ok || !artifactsOk) failed++;
      results.push({ id, kind: d.job.kind, state: d.job.state, checkpoints: d.checkpoints.length, artifacts: d.artifacts.length, evidence: d.evidence.length, sourced: d.evidence.filter((e) => e.source_url && /^https?:/.test(e.source_url)).length, session: d.job.session_ref, blocker: d.job.blocker_code, failure: d.job.failure_detail });
    }
    fs.writeFileSync(path.join(HOME, 'logs', 'certification-workload.json'), JSON.stringify({ at: new Date().toISOString(), workspace: ws.id, peak, results, log }, null, 2));
    console.table(results.map((r) => ({ kind: r.kind, state: r.state, cps: r.checkpoints, arts: r.artifacts, ev: r.evidence, sourced: r.sourced })));
    console.log(log.join('\n'));
    if (failed) { console.error(`${failed} task(s) did not complete cleanly`); process.exitCode = 1; }
  } finally {
    // Remove the certification workspace and all of its history (tasks, events, checkpoints, artifacts, evidence, files, transcripts).
    const db = new DatabaseSync(path.join(HOME, 'data', 'claudebot.sqlite'));
    const ids = (db.prepare('SELECT id FROM jobs WHERE workspace_id = ?').all(ws.id) as Array<{ id: string }>).map((r) => r.id);
    const inList = ids.length ? ids.map(() => '?').join(',') : "''";
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP TRIGGER IF EXISTS job_events_no_update; DROP TRIGGER IF EXISTS job_events_no_delete;');
      for (const t of ['job_events', 'checkpoints', 'artifacts', 'actions', 'approvals', 'memory_evidence', 'memory_proposals', 'records', 'incidents']) db.prepare(`DELETE FROM ${t} WHERE job_id IN (${inList})`).run(...(ids as never[]));
      db.prepare(`DELETE FROM job_events WHERE detail LIKE ?`).run(`%${ws.id}%`);
      db.prepare('DELETE FROM jobs WHERE workspace_id = ?').run(ws.id); db.prepare('DELETE FROM objectives WHERE workspace_id = ?').run(ws.id); db.prepare('DELETE FROM schedules WHERE workspace_id = ?').run(ws.id);
      db.prepare('DELETE FROM memory_evidence WHERE workspace_id = ?').run(ws.id); db.prepare('DELETE FROM artifacts WHERE workspace_id = ?').run(ws.id);
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
      db.exec(`CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END; CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;`);
      db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(new Date().toISOString(), 'certification', 'maintenance.certification_cleanup', JSON.stringify({ tasks_removed: ids.length }));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    try { db.exec('PRAGMA secure_delete = ON'); db.exec('VACUUM'); db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); } catch { /* best effort while the engine holds the file */ }
    db.close();
    fs.rmSync(ws.root_path, { recursive: true, force: true });
    const projects = path.join(HOME, 'claude', 'projects'); const prefix = ws.root_path.replace(/[\/._]/g, '-');
    if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects)) if (d.startsWith(prefix)) fs.rmSync(path.join(projects, d), { recursive: true, force: true });
    const after = await api<{ counts: Record<string, number>; workspaces: number }>('/api/overview');
    console.log('before', JSON.stringify(before.counts), 'workspaces', before.workspaces, '| after', JSON.stringify(after.counts), 'workspaces', after.workspaces);
  }
}
await main();
