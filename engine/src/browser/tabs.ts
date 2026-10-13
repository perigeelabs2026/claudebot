/**
 * Bounded browser lifecycle: every tab the assistants open is recorded against its task, reused for further reads in
 * the same task, and closed when the task ends, unless the owner is following that tab or has taken over. Owner-opened
 * tabs are never touched: only tab ids recorded here are ever closed.
 */
import type { DB } from '../db/open.ts';

export interface TaskTabs { [jobId: string]: string[] }
const KEY = 'browser.task_tabs';

export function readTaskTabs(db: DB): TaskTabs { const r = db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(KEY) as { value: string } | undefined; try { return r ? (JSON.parse(r.value) as TaskTabs) : {}; } catch { return {}; } }
function write(db: DB, v: TaskTabs) { db.prepare('INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at').run(KEY, JSON.stringify(v), 'browser lifecycle', new Date().toISOString()); }
export function recordTaskTab(db: DB, jobId: string, tabId: string): void { const v = readTaskTabs(db); const list = v[jobId] ?? []; if (!list.includes(tabId)) list.push(tabId); v[jobId] = list; write(db, v); }
export function taskTab(db: DB, jobId: string): string | null { const list = readTaskTabs(db)[jobId] ?? []; return list[list.length - 1] ?? null; }

/**
 * Close the tabs a finished task opened. Skips a tab the owner chose to follow (`browser.follow` by owner) and does
 * nothing while a takeover is active. Returns what was closed and what was kept, for the audit trail.
 */
export async function releaseTaskTabs(db: DB, jobId: string, closer: (tabId: string) => Promise<boolean>): Promise<{ closed: string[]; kept: string[]; reason?: string }> {
  const v = readTaskTabs(db); const list = v[jobId] ?? []; if (!list.length) return { closed: [], kept: [] };
  const takeover = db.prepare("SELECT value FROM runtime_state WHERE key = 'browser.takeover'").get() as { value: string } | undefined;
  if (takeover && (JSON.parse(takeover.value) as { active?: boolean }).active) return { closed: [], kept: list, reason: 'owner takeover active' };
  const follow = db.prepare("SELECT value FROM runtime_state WHERE key = 'browser.follow'").get() as { value: string } | undefined;
  const ownerTab = follow ? (JSON.parse(follow.value) as { id?: string; by?: string }) : null;
  const closed: string[] = []; const kept: string[] = [];
  for (const id of list) { if (ownerTab?.by === 'owner' && ownerTab.id === id) { kept.push(id); continue; } if (await closer(id)) closed.push(id); else kept.push(id); }
  delete v[jobId]; write(db, v);
  return { closed, kept };
}

/** Pick the one new page target after an `open`, by diffing the DevTools target list. */
export function newTabId(before: Array<{ id: string }>, after: Array<{ id: string }>): string | null { const seen = new Set(before.map((t) => t.id)); const fresh = after.filter((t) => !seen.has(t.id)); return fresh.length ? fresh[fresh.length - 1].id : null; }

/** Supervisor sweep: tabs still recorded for tasks that are over (completed, failed, cancelled) are released; waiting tasks keep theirs so the owner can take over on them. */
export async function releaseTabsOfFinishedTasks(db: DB, closer: (tabId: string) => Promise<boolean>): Promise<Array<{ job_id: string; closed: string[]; kept: string[] }>> {
  const out: Array<{ job_id: string; closed: string[]; kept: string[] }> = [];
  for (const jobId of Object.keys(readTaskTabs(db))) {
    const j = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: string } | undefined;
    if (!j || ['completed', 'failed_terminal', 'cancelled'].includes(j.state)) { const r = await releaseTaskTabs(db, jobId, closer); if (r.closed.length || r.kept.length) out.push({ job_id: jobId, ...r }); }
  }
  return out;
}
export function cdpCloser(port: number): (tabId: string) => Promise<boolean> { return async (id) => { try { const r = await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; } }; }
