import os from 'node:os';
import type { DB } from '../db/open.ts';
import { now } from '../jobs/store.ts';

/** Safe default: at least 10 slots when the machine can carry them (≥16 GB and ≥8 cores), otherwise scaled down, never below 2. */
export function defaultWorkerLimit(cpus = os.cpus().length, memGb = os.totalmem() / 2 ** 30): number {
  if (memGb >= 16 && cpus >= 8) return 10;
  return Math.max(2, Math.min(10, Math.floor(Math.min(cpus, memGb / 1.5))));
}

/** Delegation budgets are owner settings, enforced by the engine; no assistant tool can change them.
 *  depth: the owner's message is depth 0, the lead's tasks depth 1, a specialist's child depth 2. */
export const SETTING_DEFAULTS: Record<string, unknown> = { worker_limit: defaultWorkerLimit(), memory_pressure_floor_pct: 10, default_workspace_worker_limit: 4, product_name: 'ClaudeBot', review_max_rounds: 2, delegation_max_depth: 2, delegation_max_children: 3, delegation_max_auto_turns: 2, chat_max_turns_per_message: 4, usage_low_power_pct: 90, usage_stop_pct: 95, approval_ttl_minutes: 720 };

export class Settings {
  private db: DB;
  constructor(db: DB) { this.db = db; }
  get<T = unknown>(key: string): T { const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined; return (r ? JSON.parse(r.value) : SETTING_DEFAULTS[key]) as T; }
  all(): Record<string, unknown> { const out = { ...SETTING_DEFAULTS }; for (const r of this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>) out[r.key] = JSON.parse(r.value); return out; }
  set(key: string, value: unknown, actor: string): void {
    if (['delegation_max_depth', 'delegation_max_children', 'delegation_max_auto_turns'].includes(key)) { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error(`${key} must be an integer between 0 and 5`); }
    if (key === 'review_max_rounds') { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error('review_max_rounds must be an integer between 0 and 5'); }
    if (key === 'chat_max_turns_per_message') { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 12) throw new Error('chat_max_turns_per_message must be an integer between 0 and 12'); }
    if (key === 'approval_ttl_minutes') { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 10080) throw new Error('approval_ttl_minutes must be an integer between 1 and 10080 (7 days)'); }
    if (key === 'usage_low_power_pct' || key === 'usage_stop_pct') { const n = Number(value); if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error(`${key} must be a number between 1 and 100`); const other = Number(this.get(key === 'usage_low_power_pct' ? 'usage_stop_pct' : 'usage_low_power_pct')); if (key === 'usage_low_power_pct' ? n >= other : n <= other) throw new Error('the stop threshold must be above the low-power threshold'); }
    if (key === 'worker_limit') { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error('worker_limit must be an integer between 1 and 64'); }
    this.db.prepare('INSERT INTO settings(key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by').run(key, JSON.stringify(value), now(), actor);
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(now(), actor, 'setting.changed', JSON.stringify({ key, value }));
  }
}
