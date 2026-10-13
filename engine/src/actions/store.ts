import type { DB } from '../db/open.ts';
import { newId, now } from '../jobs/store.ts';
import { ApprovalStore, CONSEQUENTIAL_KINDS, hashContent } from '../approvals/store.ts';

export interface ActionRow {
  id: string; job_id: string | null; idempotency_key: string; kind: string; consequential: number; target: string; content_hash: string;
  approval_id: string | null; receipt?: string | null; resolved_by?: string | null; resolved_at?: string | null; status: 'pending'|'performed'|'refused'|'failed'|'uncertain'; refusal_reason: string | null; performed_at: string | null; result: string | null; created_at: string;
}

export type Executor = (action: { id: string; kind: string; target: string; content: string; budget: Record<string, unknown> | null }) => Promise<{ ok: boolean; result?: unknown; error?: string; receipt?: unknown; uncertain?: boolean }>;

export type ActionOutcome =
  | { status: 'performed'; action: ActionRow; result: unknown }
  | { status: 'already_performed'; action: ActionRow }
  | { status: 'refused'; action: ActionRow; reason: string }
  | { status: 'failed'; action: ActionRow; error: string }
  | { status: 'uncertain'; action: ActionRow; reason: string };

export function isConsequential(kind: string): boolean { return (CONSEQUENTIAL_KINDS as readonly string[]).includes(kind); }

/**
 * Executes side effects exactly once per idempotency key. Consequential kinds require a
 * verified approval and an enabled executor; in this build no consequential executor is
 * registered, so every such action is refused and audited even when approved.
 */
export class ActionStore {
  readonly db: DB; private clock: () => string; private approvals: ApprovalStore;
  private executors = new Map<string, Executor>();
  constructor(db: DB, approvals: ApprovalStore, clock: () => string = now) { this.db = db; this.approvals = approvals; this.clock = clock; }

  /** Registering an executor records (once, durably) when this kind of action first became executable: approvals decided before
   *  that moment were consent to "record my approval", not to "run it", so they are refused and must be asked again. */
  registerExecutor(kind: string, ex: Executor): void {
    this.executors.set(kind, ex);
    this.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?, ?, 'executor registered', ?) ON CONFLICT(key) DO NOTHING").run(`executor.since.${kind}`, JSON.stringify(this.clock()), this.clock());
  }
  executableSince(kind: string): string | null { const r = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(`executor.since.${kind}`) as { value: string } | undefined; return r ? JSON.parse(r.value) as string : null; }
  /** At engine start: an action that started but never recorded a result was interrupted mid-execution — its outcome is unknown. */
  recoverInterrupted(): string[] {
    const rows = this.db.prepare("SELECT id, job_id, kind, target FROM actions WHERE status = 'pending' AND result LIKE '%\"started_at\"%'").all() as Array<{ id: string; job_id: string | null; kind: string; target: string }>;
    for (const r of rows) { this.db.prepare("UPDATE actions SET status = 'uncertain', refusal_reason = 'interrupted during execution (engine stopped); outcome unknown' WHERE id = ?").run(r.id); this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(r.job_id, this.clock(), 'engine', 'action.uncertain', JSON.stringify({ action_id: r.id, kind: r.kind, target: r.target, reason: 'interrupted' })); }
    return rows.map((r) => r.id);
  }
  executorFor(kind: string): Executor | undefined { return this.executors.get(kind); }

  get(id: string): ActionRow | undefined { return this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined; }
  byKey(key: string): ActionRow | undefined { return this.db.prepare('SELECT * FROM actions WHERE idempotency_key = ?').get(key) as ActionRow | undefined; }
  list(limit = 200): ActionRow[] { return this.db.prepare('SELECT * FROM actions ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ActionRow[]; }

  /** Budget/audience/expiry constraints bound to the approval, checked against the exact content before execution. */
  static constraintViolation(kind: string, content: string, budget: Record<string, unknown> | null): string | null {
    if (!budget) return null;
    let c: Record<string, unknown> = {}; try { c = JSON.parse(content) as Record<string, unknown>; } catch { return 'content is not the structured JSON this approval was given for'; }
    const to = Array.isArray(c.to) ? c.to.map(String) : typeof c.to === 'string' ? [c.to] : [];
    if (typeof budget.max_recipients === 'number' && to.length > budget.max_recipients) return `audience of ${to.length} exceeds the approved ${budget.max_recipients}`;
    if (Array.isArray(budget.allowed_domains)) { const allowed = budget.allowed_domains.map((d) => String(d).toLowerCase()); const bad = to.filter((r) => !allowed.includes(String(r.split('@')[1] ?? '').toLowerCase())); if (bad.length) return `recipient(s) outside the approved audience: ${bad.join(', ')}`; }
    if (typeof budget.max_amount_usd === 'number' && Number(c.amount_usd ?? 0) > budget.max_amount_usd) return `amount ${c.amount_usd} exceeds the approved ${budget.max_amount_usd} USD`;
    return null;
  }

  async perform(input: { job_id?: string | null; idempotency_key: string; kind: string; target: string; content: string; approval_id?: string | null; actor: string }): Promise<ActionOutcome> {
    const existing = this.byKey(input.idempotency_key);
    if (existing && existing.status === 'performed') return { status: 'already_performed', action: existing };
    if (existing && existing.status === 'uncertain') return { status: 'uncertain', action: existing, reason: 'the earlier attempt has an unknown outcome; the owner must check and resolve it before anything is tried again' };
    const t = this.clock(); const consequential = isConsequential(input.kind);
    const id = existing?.id ?? newId('act');
    const audit = (type: string, detail: Record<string, unknown>) => this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(input.job_id ?? null, this.clock(), input.actor, type, JSON.stringify({ action_id: id, kind: input.kind, target: input.target, ...detail }));
    // Already running in this process (a concurrent second call): never start it again. (A run interrupted by a crash is marked
    // uncertain at engine start by recoverInterrupted.)
    if (existing && existing.status === 'pending' && existing.result && /"started_at"/.test(existing.result)) return { status: 'refused', action: existing, reason: 'this action is already running' };
    if (!existing) {
      this.db.prepare(`INSERT INTO actions(id, job_id, idempotency_key, kind, consequential, target, content_hash, approval_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
        .run(id, input.job_id ?? null, input.idempotency_key, input.kind, consequential ? 1 : 0, input.target, hashContent(input.content), input.approval_id ?? null, t);
    }
    const refuse = (reason: string): ActionOutcome => {
      this.db.prepare("UPDATE actions SET status = 'refused', refusal_reason = ?, approval_id = ? WHERE id = ?").run(reason, input.approval_id ?? null, id);
      audit('action.refused', { reason, consequential });
      return { status: 'refused', action: this.get(id)!, reason };
    };
    let budget: Record<string, unknown> | null = null;
    if (consequential) {
      const v = this.approvals.verify(input.approval_id, { kind: input.kind, target: input.target, content: input.content });
      if (!v.ok) return refuse(`approval ${v.reason}`);
      try { budget = v.approval.budget ? JSON.parse(v.approval.budget) as Record<string, unknown> : null; } catch { budget = null; }
      const violation = ActionStore.constraintViolation(input.kind, input.content, budget); if (violation) return refuse(violation);
      const since = this.executableSince(input.kind);
      if (since && v.approval.decided_at && v.approval.decided_at < since) return refuse('approved before this kind of action could be executed; ask for a new approval');
    }
    const ex = this.executors.get(input.kind);
    if (!ex) return refuse(consequential ? `no enabled executor for consequential action '${input.kind}' (activation is an owner decision)` : `no executor for '${input.kind}'`);
    // Claim the approval atomically BEFORE running: two concurrent runs of one approval cannot both pass.
    if (consequential && input.approval_id) {
      const claim = this.db.prepare("UPDATE approvals SET status = 'consumed' WHERE id = ? AND status = 'approved'").run(input.approval_id);
      if (Number(claim.changes) !== 1) return refuse('approval already used or being used');
      this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(input.job_id ?? null, this.clock(), 'system', 'approval.consumed', JSON.stringify({ approval_id: input.approval_id, action_id: id }));
    }
    this.db.prepare('UPDATE actions SET result = ? WHERE id = ?').run(JSON.stringify({ started_at: this.clock() }), id);
    audit('action.started', { consequential });
    let r: Awaited<ReturnType<Executor>>;
    try { r = await ex({ id, kind: input.kind, target: input.target, content: input.content, budget }); }
    catch (e) {
      // An exception after the executor started (timeout, connection reset) leaves the external result unknown.
      const msg = e instanceof Error ? e.message : String(e);
      this.db.prepare("UPDATE actions SET status = 'uncertain', refusal_reason = ?, result = ? WHERE id = ?").run(`outcome unknown: ${msg}`, JSON.stringify({ error: msg }), id); audit('action.uncertain', { error: msg });
      return { status: 'uncertain', action: this.get(id)!, reason: `outcome unknown: ${msg}` };
    }
    if (r.uncertain) {
      this.db.prepare("UPDATE actions SET status = 'uncertain', refusal_reason = ?, result = ?, receipt = ? WHERE id = ?").run(r.error ?? 'outcome unknown', JSON.stringify(r.result ?? null), r.receipt ? JSON.stringify(r.receipt) : null, id); audit('action.uncertain', { error: r.error });
      return { status: 'uncertain', action: this.get(id)!, reason: r.error ?? 'outcome unknown' };
    }
    if (!r.ok) {
      // A definite failure (the executor knows nothing happened): the approval goes back to approved so a retry is legitimate.
      this.db.prepare("UPDATE actions SET status = 'failed', result = ? WHERE id = ?").run(r.error ?? 'failed', id); audit('action.failed', { error: r.error });
      if (consequential && input.approval_id) this.db.prepare("UPDATE approvals SET status = 'approved' WHERE id = ? AND status = 'consumed'").run(input.approval_id);
      return { status: 'failed', action: this.get(id)!, error: r.error ?? 'failed' };
    }
    this.db.prepare("UPDATE actions SET status = 'performed', performed_at = ?, result = ?, receipt = ? WHERE id = ?").run(this.clock(), JSON.stringify(r.result ?? null), r.receipt ? JSON.stringify(r.receipt) : null, id);
    audit('action.performed', { consequential, receipt: r.receipt ?? null });
    return { status: 'performed', action: this.get(id)!, result: r.result };
  }

  /** The owner settles an uncertain action after checking the outside world. Never re-executes. */
  resolve(id: string, outcome: 'performed' | 'not_performed', by: string): ActionRow {
    const a = this.get(id); if (!a) throw new Error('action not found'); if (a.status !== 'uncertain') throw new Error(`action is ${a.status}, not uncertain`);
    this.db.prepare('UPDATE actions SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(outcome === 'performed' ? 'performed' : 'failed', by, this.clock(), id);
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(a.job_id, this.clock(), by, 'action.resolved', JSON.stringify({ action_id: id, outcome }));
    return this.get(id)!;
  }
}
