import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { now } from '../jobs/store.ts';

export interface Workspace { id: string; name: string; description: string; root_path: string; status: 'active' | 'archived'; agent_team: string[]; enabled_skills: string[]; connectors: string[]; policies: Record<string, unknown>; memory_scope: string[]; worker_limit: number; created_at: string; updated_at: string; archived_at: string | null }
const P = <T>(s: unknown, f: T): T => { try { return JSON.parse(String(s)) as T; } catch { return f; } };
const row = (r: Record<string, unknown>): Workspace => ({ id: String(r.id), name: String(r.name), description: String(r.description ?? ''), root_path: String(r.root_path), status: r.status as Workspace['status'], agent_team: P(r.agent_team, []), enabled_skills: P(r.enabled_skills, []), connectors: P(r.connectors, []), policies: P(r.policies, {}), memory_scope: P(r.memory_scope, []), worker_limit: Number(r.worker_limit), created_at: String(r.created_at), updated_at: String(r.updated_at), archived_at: (r.archived_at as string) ?? null });

export function slugify(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace'; }

export class Workspaces {
  private db: DB; private workspacesDir: string;
  constructor(db: DB, workspacesDir: string) { this.db = db; this.workspacesDir = workspacesDir; }
  private audit(actor: string, type: string, detail: Record<string, unknown>) { this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(now(), actor, type, JSON.stringify(detail)); }
  list(opts: { includeArchived?: boolean } = {}): Workspace[] { return (this.db.prepare(`SELECT * FROM workspaces ${opts.includeArchived ? '' : "WHERE status = 'active'"} ORDER BY created_at`).all() as Record<string, unknown>[]).map(row); }
  get(id: string): Workspace | undefined { const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? row(r) : undefined; }
  create(input: { name: string; description?: string; root_path?: string; agent_team?: string[]; policies?: Record<string, unknown>; worker_limit?: number; memory_scope?: string[]; connectors?: string[]; enabled_skills?: string[] }, actor: string): Workspace {
    const base = slugify(input.name); let id = base; let n = 1; while (this.get(id)) id = `${base}-${++n}`;
    const root = path.resolve(input.root_path ?? path.join(this.workspacesDir, id));
    if (!root.startsWith(path.resolve(this.workspacesDir) + path.sep) && !(input.root_path && fs.existsSync(path.dirname(root)))) throw new Error('root_path must be inside the workspaces directory or an existing parent directory');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const t = now();
    this.db.prepare('INSERT INTO workspaces(id, name, description, root_path, status, agent_team, enabled_skills, connectors, policies, memory_scope, worker_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.name, input.description ?? '', root, 'active', JSON.stringify(input.agent_team ?? []), JSON.stringify(input.enabled_skills ?? []), JSON.stringify(input.connectors ?? []), JSON.stringify(input.policies ?? {}), JSON.stringify(input.memory_scope ?? []), input.worker_limit ?? 4, t, t);
    this.audit(actor, 'workspace.created', { id, name: input.name, root }); return this.get(id)!;
  }
  update(id: string, patch: Partial<Omit<Workspace, 'id' | 'created_at' | 'root_path'>>, actor: string): Workspace | undefined {
    const w = this.get(id); if (!w) return undefined;
    const next = { ...w, ...patch, updated_at: now() };
    this.db.prepare('UPDATE workspaces SET name=?, description=?, agent_team=?, enabled_skills=?, connectors=?, policies=?, memory_scope=?, worker_limit=?, updated_at=? WHERE id=?')
      .run(next.name, next.description, JSON.stringify(next.agent_team), JSON.stringify(next.enabled_skills), JSON.stringify(next.connectors), JSON.stringify(next.policies), JSON.stringify(next.memory_scope), next.worker_limit, next.updated_at, id);
    this.audit(actor, 'workspace.updated', { id, fields: Object.keys(patch) }); return this.get(id);
  }
  archive(id: string, actor: string): Workspace | undefined { const t = now(); this.db.prepare("UPDATE workspaces SET status='archived', archived_at=?, updated_at=? WHERE id=?").run(t, t, id); this.audit(actor, 'workspace.archived', { id }); return this.get(id); }
  restore(id: string, actor: string): Workspace | undefined { this.db.prepare("UPDATE workspaces SET status='active', archived_at=NULL, updated_at=? WHERE id=?").run(now(), id); this.audit(actor, 'workspace.restored', { id }); return this.get(id); }
  /** Duplicate configuration only (never history) unless includeHistory is explicitly set, which copies objectives but still no jobs. */
  duplicate(id: string, name: string, actor: string, opts: { includeObjectives?: boolean } = {}): Workspace | undefined {
    const w = this.get(id); if (!w) return undefined;
    const c = this.create({ name, description: w.description, agent_team: w.agent_team, policies: w.policies, worker_limit: w.worker_limit, memory_scope: w.memory_scope, connectors: w.connectors, enabled_skills: w.enabled_skills }, actor);
    if (opts.includeObjectives) for (const o of this.db.prepare('SELECT * FROM objectives WHERE workspace_id = ?').all(id) as Array<Record<string, unknown>>) this.db.prepare('INSERT INTO objectives(id, title, description, status, created_at, workspace_id, priority, success_criteria, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(`obj-${crypto.randomBytes(4).toString('hex')}`, String(o.title), String(o.description ?? ''), 'active', now(), c.id, Number(o.priority ?? 5), String(o.success_criteria ?? ''), now());
    this.audit(actor, 'workspace.duplicated', { from: id, to: c.id, includeObjectives: !!opts.includeObjectives }); return c;
  }
  /** Export configuration without secrets or history. */
  exportConfig(id: string): Record<string, unknown> | undefined {
    const w = this.get(id); if (!w) return undefined;
    const objectives = this.db.prepare('SELECT title, description, priority, success_criteria, status FROM objectives WHERE workspace_id = ?').all(id);
    const schedules = this.db.prepare('SELECT name, kind, agent_role, objective, cron, every_seconds, enabled, inputs FROM schedules WHERE workspace_id = ?').all(id);
    return { format: 'claudebot.workspace/1', exported_at: now(), workspace: { name: w.name, description: w.description, agent_team: w.agent_team, enabled_skills: w.enabled_skills, connectors: w.connectors, policies: w.policies, memory_scope: w.memory_scope, worker_limit: w.worker_limit }, objectives, schedules };
  }
  importConfig(doc: Record<string, unknown>, actor: string): Workspace {
    if (doc.format !== 'claudebot.workspace/1') throw new Error('unsupported format');
    const w = doc.workspace as Record<string, unknown>; const c = this.create({ name: String(w.name), description: String(w.description ?? ''), agent_team: (w.agent_team as string[]) ?? [], policies: (w.policies as Record<string, unknown>) ?? {}, worker_limit: Number(w.worker_limit ?? 4), memory_scope: (w.memory_scope as string[]) ?? [], connectors: (w.connectors as string[]) ?? [], enabled_skills: (w.enabled_skills as string[]) ?? [] }, actor);
    for (const o of (doc.objectives as Array<Record<string, unknown>>) ?? []) this.db.prepare('INSERT INTO objectives(id, title, description, status, created_at, workspace_id, priority, success_criteria, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(`obj-${crypto.randomBytes(4).toString('hex')}`, String(o.title), String(o.description ?? ''), 'active', now(), c.id, Number(o.priority ?? 5), String(o.success_criteria ?? ''), now());
    this.audit(actor, 'workspace.imported', { id: c.id, objectives: ((doc.objectives as unknown[]) ?? []).length }); return c;
  }
  /** Effective policy for a task before it runs: workspace policy + agent prohibitions/approval rules + global gates. */
  effectivePolicy(id: string, agent: { id: string; allowed_tools: string[]; prohibited_actions: string[]; approval_rules: string[]; concurrency_limit: number } | undefined, globalLimit: number): Record<string, unknown> {
    const w = this.get(id);
    return { workspace: w ? { id: w.id, worker_limit: w.worker_limit, policies: w.policies, agent_team: w.agent_team } : null, agent: agent ? { id: agent.id, allowed_tools: agent.allowed_tools, prohibited_actions: agent.prohibited_actions, approval_rules: agent.approval_rules, concurrency_limit: agent.concurrency_limit } : null, global: { worker_limit: globalLimit, owner_approval_required_for: ['send', 'publish', 'purchase', 'delete', 'production_change', 'new_scope', 'new_audience', 'budget_increase', 'policy_change'], owner_presence_required_for: ['login', 'mfa', 'captcha', 'device_auth'], executors_enabled: (this.db.prepare("SELECT key FROM runtime_state WHERE key LIKE 'executor.since.%'").all() as Array<{ key: string }>).map((r) => ({ kind: r.key.slice('executor.since.'.length), executor: 'local outbox (nothing leaves this Mac)' })) } };
  }
}
