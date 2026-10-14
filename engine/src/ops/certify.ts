/**
 * Go/no-go certification from live evidence. Read-only: it only SELECTs.
 * Rehearsal evidence never counts: workspaces whose policies say test or dry_run:true are test projects,
 * and their jobs, events and messages are excluded from every positive check.
 */
import type { DB } from '../db/open.ts';

export interface CertifyCheck { name: string; ok: boolean; evidence: string }
export interface CertifyResult { go: boolean; since: string; now: string; checks: CertifyCheck[] }

/** SQL predicate: the workspace alias `w` is a test project. A job with no workspace (or a missing one) is not a test project. */
const TEST_WS = (w: string) => `(${w}.id IS NOT NULL AND (COALESCE(json_extract(${w}.policies, '$.test'), 0) <> 0 OR COALESCE(json_extract(${w}.policies, '$.dry_run'), 0) <> 0))`;
const ACTIVE = `('queued','leased','running')`;

export function certify(db: DB, opts: { now?: Date | string; hours?: number } = {}): CertifyResult {
  const nowMs = opts.now === undefined ? Date.now() : (typeof opts.now === 'string' ? Date.parse(opts.now) : opts.now.getTime());
  const hours = opts.hours ?? 6;
  const now = new Date(nowMs).toISOString();
  const since = new Date(nowMs - hours * 3600_000).toISOString();
  const aliveSince = new Date(nowMs - 30 * 60_000).toISOString();
  const checks: CertifyCheck[] = [];

  // 1. Every enabled assistant that had real work in the window ran at least one completed chat turn.
  {
    const rows = db.prepare(`SELECT a.id, a.name,
        COUNT(j.id) AS jobs,
        SUM(CASE WHEN j.kind = 'chat.turn' AND j.state = 'completed' THEN 1 ELSE 0 END) AS turns
      FROM agent_definitions a
      JOIN jobs j ON j.agent_role = a.id
      LEFT JOIN workspaces w ON w.id = j.workspace_id
      WHERE a.enabled = 1 AND (j.created_at >= ? OR j.updated_at >= ?) AND NOT ${TEST_WS('w')}
      GROUP BY a.id ORDER BY a.id`).all(since, since) as Array<{ id: string; name: string; jobs: number; turns: number }>;
    const missing = rows.filter((r) => !r.turns);
    checks.push({
      name: 'assistants ran real turns',
      ok: rows.length > 0 && missing.length === 0,
      evidence: rows.length === 0 ? `no enabled assistant had a job outside test projects in the last ${hours}h`
        : missing.length ? `no completed chat turn for: ${missing.map((r) => `${r.id} (${r.jobs} jobs)`).join(', ')}`
        : rows.map((r) => `${r.id}: ${r.turns} completed turns / ${r.jobs} jobs`).join('; '),
    });
  }

  // 2. A real application was verified (receipt recorded) outside test projects.
  {
    const r = db.prepare(`SELECT COUNT(*) AS n, MAX(e.at) AS last FROM job_events e
      JOIN jobs j ON j.id = e.job_id LEFT JOIN workspaces w ON w.id = j.workspace_id
      WHERE e.type = 'application.verified' AND e.at >= ? AND NOT ${TEST_WS('w')}`).get(since) as { n: number; last: string | null };
    checks.push({ name: 'application verified', ok: r.n > 0, evidence: r.n > 0 ? `${r.n} application.verified events, last at ${r.last}` : `no application.verified event outside test projects in the last ${hours}h` });
  }

  // 3. Telegram actually delivered something outbound (a Telegram message id came back).
  {
    const r = db.prepare(`SELECT COUNT(*) AS n, MAX(o.sent_at) AS last FROM telegram_outbox o
      LEFT JOIN messages m ON m.id = o.message_id LEFT JOIN conversations c ON c.id = m.conversation_id LEFT JOIN workspaces w ON w.id = c.workspace_id
      WHERE o.tg_message_id IS NOT NULL AND o.kind <> 'inbound' AND o.sent_at >= ? AND NOT ${TEST_WS('w')}`).get(since) as { n: number; last: string | null };
    checks.push({ name: 'telegram delivered', ok: r.n > 0, evidence: r.n > 0 ? `${r.n} delivered outbound messages, last at ${r.last}` : `no delivered outbound Telegram message in the last ${hours}h` });
  }

  // 4. The engine is alive: something happened in the last 30 minutes.
  {
    const e = db.prepare('SELECT MAX(at) AS last FROM job_events').get() as { last: string | null };
    const m = db.prepare('SELECT MAX(created_at) AS last FROM messages').get() as { last: string | null };
    const last = [e.last, m.last].filter((x): x is string => !!x).sort().pop() ?? null;
    checks.push({ name: 'engine alive', ok: !!last && last >= aliveSince, evidence: last ? `last activity at ${last} (needs >= ${aliveSince})` : 'no job events or messages at all' });
  }

  // 5. No rehearsal work is still running or queued.
  {
    const rows = db.prepare(`SELECT j.id, j.state, w.name FROM jobs j JOIN workspaces w ON w.id = j.workspace_id
      WHERE j.state IN ${ACTIVE} AND ${TEST_WS('w')} ORDER BY j.created_at LIMIT 20`).all() as Array<{ id: string; state: string; name: string }>;
    checks.push({ name: 'no active test-project jobs', ok: rows.length === 0, evidence: rows.length ? `still active: ${rows.map((r) => `${r.id} ${r.state} in "${r.name}"`).join(', ')}` : 'no queued, leased or running jobs in test projects' });
  }

  return { go: checks.every((c) => c.ok), since, now, checks };
}

export function formatCertify(r: CertifyResult): string {
  return [`${r.go ? 'GO' : 'NO-GO'} (evidence window ${r.since} .. ${r.now})`, ...r.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.evidence}`)].join('\n');
}
