/**
 * Nightly work-log rollup: what each assistant actually did, per day, built from the ledger with no model call and written under
 * "## Work log" in the assistant's vault note (Assistants/<Name>.md). Each day lists applications submitted and verified (company,
 * role), tasks finished, tasks blocked with the reason, and files saved. Test projects (policies test or dry_run) are
 * left out. Re-running is idempotent: a day's entry is rebuilt from the ledger and replaced; the last 14 days are kept.
 */
import type { DB } from '../db/open.ts';
import { Vault, localDay } from './vault.ts';

const CHAT_TURN = 'chat.turn';
const NOT_TASKS = `('${CHAT_TURN}','owner.upload')`;
const REAL_PROJECT = `(j.workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = j.workspace_id AND (COALESCE(json_extract(w.policies, '$.test'), 0) <> 0 OR COALESCE(json_extract(w.policies, '$.dry_run'), 0) <> 0)))`;

const one = (s: unknown, max = 140) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const title = (objective: string) => { const goal = /^Continuing \(round/i.test(objective) ? (objective.match(/^Goal:\s*(.+)$/m)?.[1] ?? objective) : objective; return one(goal.split('\n')[0], 120); };
const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) as Record<string, unknown> : {}; } catch { return {}; } };

/** Local-day window [start, end) as ISO strings for a YYYY-MM-DD day. */
function dayWindow(day: string): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number); const start = new Date(y, m - 1, d); const end = new Date(y, m - 1, d + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** The work-log lines of one assistant for one local day (empty when nothing happened). */
export function workLogLines(db: DB, agentId: string, day: string): string[] {
  const { from, to } = dayWindow(day);
  // Applications: verified records of the assistant's jobs, plus 'application.verified' events whose record is missing.
  const apps = new Map<string, { company: string; role: string }>();
  for (const r of db.prepare(`SELECT r.id, r.data FROM records r JOIN jobs j ON j.id = r.job_id WHERE r.type = 'application' AND j.agent_role = ? AND r.created_at >= ? AND r.created_at < ? AND ${REAL_PROJECT} ORDER BY r.created_at, r.id`).all(agentId, from, to) as Array<{ id: string; data: string }>) {
    const d = parse(r.data); if (d.verified !== true || !d.company || !d.role) continue; apps.set(r.id, { company: one(d.company, 80), role: one(d.role, 100) });
  }
  for (const e of db.prepare(`SELECT e.seq, e.detail FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE e.type = 'application.verified' AND j.agent_role = ? AND e.at >= ? AND e.at < ? AND ${REAL_PROJECT} ORDER BY e.seq`).all(agentId, from, to) as Array<{ seq: number; detail: string }>) {
    const d = parse(e.detail); const key = String(d.record ?? `event:${e.seq}`); if (apps.has(key) || !d.company || !d.role) continue;
    if (d.record && db.prepare("SELECT 1 FROM records WHERE id = ? AND type = 'application'").get(String(d.record))) continue;   // its record is on another day or unverified
    apps.set(key, { company: one(d.company, 80), role: one(d.role, 100) });
  }
  const finished = db.prepare(`SELECT j.objective FROM jobs j WHERE j.agent_role = ? AND j.kind NOT IN ${NOT_TASKS} AND j.state = 'completed' AND COALESCE(j.outcome, 'success') <> 'blocked' AND COALESCE(j.completed_at, j.updated_at) >= ? AND COALESCE(j.completed_at, j.updated_at) < ? AND ${REAL_PROJECT} ORDER BY COALESCE(j.completed_at, j.updated_at), j.id`).all(agentId, from, to) as Array<{ objective: string }>;
  const blocked = db.prepare(`SELECT j.objective, j.state, j.failure_detail, j.outcome_detail, j.blocker_code, j.operator_action FROM jobs j WHERE j.agent_role = ? AND (j.state IN ('failed_terminal','waiting_for_auth') OR j.outcome = 'blocked') AND j.updated_at >= ? AND j.updated_at < ? AND ${REAL_PROJECT} ORDER BY j.updated_at, j.id`).all(agentId, from, to) as Array<{ objective: string; state: string; failure_detail: string | null; outcome_detail: string | null; blocker_code: string | null; operator_action: string | null }>;
  const files = db.prepare(`SELECT a.title FROM artifacts a JOIN jobs j ON j.id = a.job_id WHERE j.agent_role = ? AND a.kind NOT IN ('screenshot','record') AND a.created_at >= ? AND a.created_at < ? AND ${REAL_PROJECT} ORDER BY a.created_at, a.id`).all(agentId, from, to) as Array<{ title: string }>;

  const out: string[] = [];
  if (apps.size) { out.push(`- Applications submitted and verified (${apps.size}):`); for (const a of apps.values()) out.push(`  - ${a.company} — ${a.role}`); }
  if (finished.length) { out.push(`- Tasks finished (${finished.length}):`); for (const f of finished) out.push(`  - ${title(f.objective)}`); }
  if (blocked.length) {
    out.push(`- Tasks blocked (${blocked.length}):`);
    for (const b of blocked) { const od = parse(b.outcome_detail); const reason = one(od.reason ?? b.failure_detail ?? b.operator_action ?? b.blocker_code ?? (b.state === 'waiting_for_auth' ? 'waiting for a sign-in' : 'no reason recorded'), 200); out.push(`  - ${title(b.objective)} — ${reason}`); }
  }
  const names = [...new Set(files.map((f) => one(f.title, 100)).filter(Boolean))];
  if (names.length) { out.push(`- Files saved (${names.length}):`); for (const n of names) out.push(`  - ${n}`); }
  return out;
}

/** Rebuild the last `days` local days (today included) of every enabled assistant's work log. No model call. */
export function rollupWorkLogs(db: DB, opts: { vault?: Vault; now?: Date; days?: number; keep?: number } = {}): { written: Array<{ agent: string; day: string }> } {
  const vault = opts.vault ?? new Vault(); const now = opts.now ?? new Date(); const days = opts.days ?? 3;
  const agents = db.prepare('SELECT id, name FROM agent_definitions WHERE enabled = 1 ORDER BY id').all() as Array<{ id: string; name: string }>;
  const written: Array<{ agent: string; day: string }> = [];
  for (const a of agents) for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i); const day = localDay(d);
    const lines = workLogLines(db, a.id, day);
    // An assistant with nothing on a day gets no note created and no entry written.
    if (!lines.length && !vault.workLog(a, 14, now).some((e) => e.day === day)) continue;
    if (vault.setWorkLog(a, day, lines, opts.keep ?? 14)) written.push({ agent: a.id, day });
  }
  return { written };
}
