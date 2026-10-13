// Agent coordination on the Claude-first route (ACP coordination, not native OpenClaw sub-agents): budgets, waiting for
// children, stop cascade and automatic completion delivery to the lead. All limits come from owner settings.
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import { Settings } from '../model/settings.ts';

const TERMINAL = ['completed', 'failed_terminal', 'cancelled'];

/** 0 for a job without a parent (an owner message / owner-created task), +1 per ancestor. */
export function depthOf(db: DB, jobId: string): number {
  let d = 0; let cur: string | null = jobId; const seen = new Set<string>();
  while (cur && !seen.has(cur)) { seen.add(cur); const r = db.prepare('SELECT parent_id FROM jobs WHERE id = ?').get(cur) as { parent_id: string | null } | undefined; if (!r?.parent_id) break; d++; cur = r.parent_id; }
  return d;
}

export interface Budget { ok: boolean; reason?: string; depth: number; maxDepth: number; children: number; maxChildren: number }
/** May this job create one more child? The lead's turn (depth 0) has no per-turn child cap beyond the workflow; specialists do. */
export function delegationBudget(db: DB, requesterId: string): Budget {
  const st = new Settings(db); const maxDepth = Number(st.get('delegation_max_depth')); const maxChildren = Number(st.get('delegation_max_children'));
  const depth = depthOf(db, requesterId); const children = (db.prepare('SELECT count(*) AS n FROM jobs WHERE parent_id = ?').get(requesterId) as { n: number }).n;
  const kind = (db.prepare('SELECT kind FROM jobs WHERE id = ?').get(requesterId) as { kind: string } | undefined)?.kind;
  if (kind === 'chat.turn' && children >= 8) return { ok: false, reason: 'one reply may assign at most 8 tasks; ask the owner which to do first', depth, maxDepth, children, maxChildren };
  if (depth + 1 > maxDepth) return { ok: false, reason: `delegation depth limit reached (${maxDepth}); do this part yourself or report what remains`, depth, maxDepth, children, maxChildren };
  if (kind !== 'chat.turn' && children >= maxChildren) return { ok: false, reason: `this task already created ${children} child task(s), the owner's limit is ${maxChildren}`, depth, maxDepth, children, maxChildren };
  // A parent that waits occupies a worker; keep at least one worker free for children so waiting can never deadlock.
  if (kind !== 'chat.turn') {
    const workers = Number(st.get('worker_limit')); const waiting = (db.prepare("SELECT count(DISTINCT parent_id) AS n FROM jobs WHERE parent_id IN (SELECT id FROM jobs WHERE kind != 'chat.turn' AND state IN ('leased','running')) AND state NOT IN ('completed','failed_terminal','cancelled')").get() as { n: number }).n;
    if (waiting >= Math.max(1, workers - 1)) return { ok: false, reason: 'too many tasks are already waiting on child tasks right now; do this part yourself', depth, maxDepth, children, maxChildren };
  }
  return { ok: true, depth, maxDepth, children, maxChildren };
}

export interface ChildStatus { id: string; agent: string; state: string; outcome: string | null; reason: string | null; remaining: string | null; artifacts: Array<{ id: string; title: string }> }
export function childStatus(db: DB, ids: string[]): ChildStatus[] {
  return ids.map((id) => {
    const j = db.prepare('SELECT id, agent_role, state, outcome, outcome_detail, failure_detail FROM jobs WHERE id = ?').get(id) as { id: string; agent_role: string; state: string; outcome: string | null; outcome_detail: string; failure_detail: string | null } | undefined;
    if (!j) return { id, agent: '?', state: 'missing', outcome: null, reason: null, remaining: null, artifacts: [] };
    let od: { reason?: string; remaining?: string } = {}; try { od = JSON.parse(j.outcome_detail || '{}'); } catch { /* */ }
    const arts = db.prepare("SELECT id, title FROM artifacts WHERE job_id = ? AND kind IN ('file','note') ORDER BY created_at").all(id) as Array<{ id: string; title: string }>;
    return { id, agent: j.agent_role, state: j.state, outcome: j.outcome, reason: od.reason ?? j.failure_detail ?? null, remaining: od.remaining ?? null, artifacts: arts };
  });
}

/** Wait (bounded) until the given children of `parentId` are finished. While waiting the parent is marked children:<ids> and does
 *  not count against its project's slots. Returns early when time is up; the caller may wait again. */
export async function waitForChildren(db: DB, store: JobStore, parentId: string, ids: string[], maxMs: number): Promise<{ done: boolean; children: ChildStatus[] }> {
  const own = ids.filter((id) => (db.prepare('SELECT parent_id FROM jobs WHERE id = ?').get(id) as { parent_id: string | null } | undefined)?.parent_id === parentId);
  if (!own.length) return { done: true, children: [] };
  db.prepare("UPDATE jobs SET waiting_on = ?, updated_at = ? WHERE id = ? AND state IN ('leased','running')").run(`children:${own.join(',')}`, new Date().toISOString(), parentId);
  store.event(parentId, 'engine', 'children.waiting', { children: own });
  const deadline = Date.now() + Math.min(Math.max(maxMs, 1000), 55_000);
  try {
    for (;;) {
      const st = childStatus(db, own);
      const parent = db.prepare('SELECT state FROM jobs WHERE id = ?').get(parentId) as { state: string } | undefined;
      if (st.every((c) => TERMINAL.includes(c.state)) || !parent || TERMINAL.includes(parent.state) || Date.now() > deadline) return { done: st.every((c) => TERMINAL.includes(c.state)), children: st };
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    db.prepare("UPDATE jobs SET waiting_on = NULL WHERE id = ? AND waiting_on LIKE 'children:%'").run(parentId);
  }
}

/** Stop cascades: cancel every unfinished descendant of a stopped task (they cannot report to anyone any more). */
export function cancelDescendants(db: DB, store: JobStore, rootId: string, actor: string, why: string): string[] {
  const out: string[] = []; const queue = [rootId]; const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id);
    const kids = db.prepare('SELECT id, state FROM jobs WHERE parent_id = ?').all(id) as Array<{ id: string; state: string }>;
    for (const k of kids) { queue.push(k.id); if (!TERMINAL.includes(k.state)) { try { store.transition(k.id, 'cancelled', actor, { next_action: null }, { by: actor, cascade_from: rootId, why }); out.push(k.id); } catch { /* raced to terminal */ } } }
  }
  return out;
}
