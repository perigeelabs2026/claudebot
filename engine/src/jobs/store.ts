import { eligibilityClause, type Level } from '../usage/governor.ts';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { TRANSITIONS, IllegalTransition, type Job, type JobState, type NewJob, type Checkpoint, type SuccessContract } from './types.ts';
import { evaluateContract } from './contracts.ts';
import { retryDelaySeconds, retryBudgetExhausted, resetProbeDelaySeconds } from './backoff.ts';

export const now = () => new Date().toISOString();
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (prefix: string) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

export interface LeaseOptions { owner: string; leaseSeconds: number; roles?: string[]; /** enforce workspace.worker_limit and agent.concurrency_limit, pick the least-loaded workspace first */ fair?: boolean; /** skip when the resource governor is paused */ respectGovernor?: boolean }

export class JobStore {
  readonly db: DB;
  private clock: () => string;
  constructor(db: DB, clock: () => string = now) { this.db = db; this.clock = clock; }

  // ---------- events ----------
  event(jobId: string | null, actor: string, type: string, detail: Record<string, unknown> = {}): void {
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(jobId, this.clock(), actor, type, JSON.stringify(detail));
  }

  events(jobId: string): Array<{ seq: number; at: string; actor: string; type: string; detail: Record<string, unknown> }> {
    return (this.db.prepare('SELECT seq, at, actor, type, detail FROM job_events WHERE job_id = ? ORDER BY seq').all(jobId) as Array<{ seq: number; at: string; actor: string; type: string; detail: string }>)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  // ---------- create / read ----------
  create(input: NewJob, actor = 'system'): { job: Job; created: boolean } {
    const existing = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(input.idempotency_key) as Job | undefined;
    if (existing) return { job: existing, created: false };
    const id = newId('job');
    const t = this.clock();
    this.db.prepare(`INSERT INTO jobs(id, parent_id, idempotency_key, kind, objective, success_contract, agent_role, runtime_id, state, input_refs, priority, schedule_id, created_at, updated_at, workspace_id, objective_id, depends_on, inputs)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.parent_id ?? null, input.idempotency_key, input.kind, input.objective, JSON.stringify(input.success_contract), input.agent_role,
      input.runtime_id ?? 'claude-acp', input.state ?? 'queued', JSON.stringify(input.input_refs ?? []), input.priority ?? 5, input.schedule_id ?? null, t, t,
      input.workspace_id ?? null, input.objective_id ?? null, JSON.stringify(input.depends_on ?? []), JSON.stringify(input.inputs ?? {}));
    this.event(id, actor, 'job.created', { kind: input.kind, agent_role: input.agent_role, workspace_id: input.workspace_id ?? null, idempotency_key: input.idempotency_key });
    return { job: this.get(id)!, created: true };
  }

  get(id: string): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
  }

  list(filter: { state?: JobState | JobState[]; role?: string; limit?: number; workspace?: string } = {}): Job[] {
    const where: string[] = []; const args: unknown[] = [];
    if (filter.state) { const s = Array.isArray(filter.state) ? filter.state : [filter.state]; where.push(`state IN (${s.map(() => '?').join(',')})`); args.push(...s); }
    if (filter.role) { where.push('agent_role = ?'); args.push(filter.role); }
    if (filter.workspace) { where.push('workspace_id = ?'); args.push(filter.workspace); }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority ASC, created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...(args as never[]), filter.limit ?? 200) as unknown as Job[];
  }

  // ---------- transitions ----------
  transition(id: string, to: JobState, actor: string, patch: Partial<Job> = {}, detail: Record<string, unknown> = {}): Job {
    const job = this.get(id);
    if (!job) throw new Error(`job ${id} not found`);
    if (!TRANSITIONS[job.state].includes(to)) throw new IllegalTransition(job.state, to, id);
    const t = this.clock();
    const fields: Record<string, unknown> = { ...patch, state: to, updated_at: t };
    if (to === 'completed' || to === 'failed_terminal' || to === 'cancelled') fields.completed_at = t;
    if (to === 'running' && !job.started_at) fields.started_at = t;
    if (to === 'queued') { fields.lease_owner = null; fields.lease_expires_at = null; fields.lease_heartbeat_at = null; }
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] as never), id);
    this.event(id, actor, 'job.transition', { from: job.state, to, ...detail });
    return this.get(id)!;
  }

  // ---------- leases ----------
  /** Atomically lease the next runnable job. Returns undefined when none. */
  lease(opts: LeaseOptions): Job | undefined {
    const t = this.clock();
    const expires = new Date(Date.parse(t) + opts.leaseSeconds * 1000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (opts.respectGovernor) { const g = this.db.prepare("SELECT value FROM runtime_state WHERE key = 'governor'").get() as { value: string } | undefined; if (g && (JSON.parse(g.value) as { paused?: boolean }).paused) { this.db.exec('COMMIT'); return undefined; } }
      const roleClause = opts.roles && opts.roles.length ? `AND j.agent_role IN (${opts.roles.map(() => '?').join(',')})` : '';
      // Usage governor (low power / stopped), decided centrally from the stored state; deferred work simply stays queued.
      const gv = (() => { const g = this.db.prepare("SELECT value FROM runtime_state WHERE key = 'usage.governor'").get() as { value: string } | undefined; try { const v = g ? JSON.parse(g.value) as { level?: Level; measured_level?: Level; override_expires_at?: string | null; claude_kinds?: string[] } : {}; const lvl = v.override_expires_at && v.override_expires_at <= new Date().toISOString() ? (v.measured_level ?? v.level) : v.level; return eligibilityClause(lvl ?? 'normal', v.claude_kinds ?? []); /* an expired override stops applying at once, not at the next tick */ } catch { return { sql: '', params: [] as string[] }; } })();
      // Dependencies: every job in depends_on must be completed.
      const depClause = `AND NOT EXISTS (SELECT 1 FROM json_each(j.depends_on) d LEFT JOIN jobs p ON p.id = d.value WHERE p.id IS NULL OR p.state != 'completed')`
        // An assistant that is turned off keeps its work queued (a note sent while it was paused is delivered when it is turned back on).
        + ` AND NOT EXISTS (SELECT 1 FROM agent_definitions ad WHERE ad.id = j.agent_role AND ad.enabled = 0)`
        // One persistent session per assistant per conversation: its turns run strictly one after another, oldest first.
        + ` AND NOT (j.kind = 'chat.turn' AND j.conversation_id IS NOT NULL AND EXISTS (SELECT 1 FROM jobs x WHERE x.kind = 'chat.turn' AND x.conversation_id = j.conversation_id AND x.agent_role = j.agent_role AND x.id != j.id AND (x.state IN ('leased','running') OR (x.state IN ('queued','retry_scheduled') AND (x.created_at < j.created_at OR (x.created_at = j.created_at AND x.rowid < j.rowid))))))`;   /* an older turn waiting to retry (e.g. interrupted by an engine restart) keeps its place: a later message never jumps ahead of it */
      const sql = opts.fair
        ? `SELECT j.id FROM jobs j
             LEFT JOIN workspaces w ON w.id = j.workspace_id
             LEFT JOIN agent_definitions a ON a.id = j.agent_role
             LEFT JOIN (SELECT workspace_id, COUNT(*) AS n FROM jobs WHERE state IN ('leased','running') AND COALESCE(waiting_on, '') NOT LIKE 'children:%' GROUP BY workspace_id) wa ON wa.workspace_id IS j.workspace_id
             LEFT JOIN (SELECT agent_role, COUNT(*) AS n FROM jobs WHERE state IN ('leased','running') AND COALESCE(waiting_on, '') NOT LIKE 'children:%' GROUP BY agent_role) aa ON aa.agent_role = j.agent_role
           WHERE j.state = 'queued' ${roleClause} ${depClause} ${gv.sql}
             AND (w.id IS NULL OR w.status = 'active')
             AND COALESCE(wa.n, 0) < COALESCE(w.worker_limit, 1000000)
             AND COALESCE(aa.n, 0) < COALESCE(a.concurrency_limit, 1000000)
           ORDER BY COALESCE(wa.n, 0) ASC, j.priority ASC, j.created_at ASC LIMIT 1`
        : `SELECT j.id FROM jobs j WHERE j.state = 'queued' ${roleClause} ${depClause} ${gv.sql} ORDER BY j.priority ASC, j.created_at ASC LIMIT 1`;
      const candidate = this.db.prepare(sql).get(...([...(opts.roles ?? []), ...gv.params] as never[])) as { id: string } | undefined;
      if (!candidate) { this.db.exec('COMMIT'); return undefined; }
      const r = this.db.prepare(`UPDATE jobs SET state = 'leased', lease_owner = ?, lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, waiting_on = CASE WHEN waiting_on LIKE 'children:%' THEN NULL ELSE waiting_on END WHERE id = ? AND state = 'queued'`).run(opts.owner, t, expires, t, candidate.id);
      if (r.changes !== 1) { this.db.exec('COMMIT'); return undefined; }
      this.event(candidate.id, opts.owner, 'lease.acquired', { expires_at: expires });
      this.db.exec('COMMIT');
      return this.get(candidate.id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Compare-and-set heartbeat: only the current owner may extend. */
  heartbeat(id: string, owner: string, leaseSeconds: number): boolean {
    const t = this.clock();
    const expires = new Date(Date.parse(t) + leaseSeconds * 1000).toISOString();
    const r = this.db.prepare(`UPDATE jobs SET lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND state IN ('leased','running')`).run(t, expires, t, id, owner);
    return r.changes === 1;
  }

  /** Return expired leases to the queue. Stage attempt is preserved; the next worker resumes from the last verified checkpoint. */
  reclaimExpired(actor = 'supervisor'): Job[] {
    const t = this.clock();
    const rows = this.db.prepare(`SELECT id, lease_owner, lease_expires_at FROM jobs WHERE state IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`).all(t) as Array<{ id: string; lease_owner: string; lease_expires_at: string }>;
    const out: Job[] = [];
    for (const r of rows) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const u = this.db.prepare(`UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, lease_heartbeat_at = NULL, next_action = 'resume from last verified checkpoint', updated_at = ? WHERE id = ? AND lease_expires_at = ? AND state IN ('leased','running')`).run(t, r.id, r.lease_expires_at);
        if (u.changes === 1) { this.event(r.id, actor, 'lease.reclaimed', { previous_owner: r.lease_owner, expired_at: r.lease_expires_at }); out.push(this.get(r.id)!); }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    return out;
  }

  // ---------- checkpoints ----------
  checkpoint(jobId: string, c: { stage_index: number; stage_name: string; attempt: number; phase: 'before' | 'after'; payload: Record<string, unknown>; session_ref?: string | null }): Checkpoint {
    const payload = JSON.stringify(c.payload);
    const hash = sha256(payload);
    const t = this.clock();
    const r = this.db.prepare('INSERT INTO checkpoints(job_id, stage_index, stage_name, attempt, phase, payload, sha256, session_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(jobId, c.stage_index, c.stage_name, c.attempt, c.phase, payload, hash, c.session_ref ?? null, t);
    const id = Number(r.lastInsertRowid);
    this.db.prepare('UPDATE jobs SET last_good_checkpoint_id = ?, updated_at = ? WHERE id = ?').run(id, t, jobId);
    this.event(jobId, 'worker', 'checkpoint.written', { checkpoint_id: id, stage: c.stage_name, phase: c.phase, attempt: c.attempt, sha256: hash });
    return this.getCheckpoint(id)!;
  }

  getCheckpoint(id: number): Checkpoint | undefined {
    return this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Checkpoint | undefined;
  }

  /** Newest checkpoint whose stored hash matches its payload. Corrupt rows raise an incident and are skipped. */
  latestVerified(jobId: string): Checkpoint | undefined {
    const rows = this.db.prepare('SELECT * FROM checkpoints WHERE job_id = ? ORDER BY id DESC').all(jobId) as unknown as Checkpoint[];
    for (const row of rows) {
      if (sha256(row.payload) === row.sha256) return row;
      const already = this.db.prepare("SELECT 1 FROM incidents WHERE code = 'CHECKPOINT_CORRUPT' AND detail LIKE ? ").get(`%"checkpoint_id":${row.id}%`);
      if (!already) {
        this.db.prepare('INSERT INTO incidents(job_id, code, summary, detail, created_at) VALUES (?,?,?,?,?)')
          .run(jobId, 'CHECKPOINT_CORRUPT', `Checkpoint ${row.id} (${row.stage_name}/${row.phase}) failed hash verification; recovery used an earlier checkpoint`, JSON.stringify({ checkpoint_id: row.id, stored: row.sha256, actual: sha256(row.payload) }), this.clock());
        this.event(jobId, 'supervisor', 'checkpoint.corrupt', { checkpoint_id: row.id });
      }
    }
    return undefined;
  }

  // ---------- completion / failure ----------
  complete(id: string, actor: string, finalPayload: Record<string, unknown>): { ok: boolean; reasons: string[]; job: Job } {
    const job = this.get(id)!;
    const contract = JSON.parse(job.success_contract) as SuccessContract;
    const res = evaluateContract(this.db, id, contract, finalPayload);
    if (!res.ok) { this.event(id, actor, 'contract.unmet', { reasons: res.reasons }); return { ...res, job }; }
    // Workflows whose contract does not ask the assistant for an outcome are verified by the engine's own contract checks; record that, so "outcome not recorded" is reserved for legacy work.
    if (!contract.requires_outcome && !(this.db.prepare('SELECT outcome FROM jobs WHERE id = ?').get(id) as { outcome: string | null }).outcome) this.db.prepare('UPDATE jobs SET outcome = ?, outcome_detail = ? WHERE id = ?').run('success', JSON.stringify({ reason: 'all contract checks passed', reported_by: 'engine', at: this.clock() }), id);
    const updated = this.transition(id, 'completed', actor, { next_action: null, blocker_code: null, operator_action: null, waiting_on: null }, { contract: 'met' });
    return { ok: true, reasons: [], job: updated };
  }

  failRetryable(id: string, actor: string, reason: string, budget?: number): Job {
    const job = this.get(id)!;
    const count = job.retry_count + 1;
    if (retryBudgetExhausted(count, budget)) {
      return this.transition(id, 'failed_terminal', actor, {
        retry_count: count, failure_kind: 'terminal', failure_detail: reason, blocker_code: 'RETRY_BUDGET_EXHAUSTED',
        operator_action: `This job failed ${count} times (last: ${reason}). Fix the cause, then re-queue it from the Work screen; the last verified checkpoint is kept.`,
        next_action: 'owner decision',
      }, { reason, retries: count });
    }
    const delay = retryDelaySeconds(count - 1);
    const retryAt = new Date(Date.parse(this.clock()) + delay * 1000).toISOString();
    return this.transition(id, 'retry_scheduled', actor, { retry_count: count, retry_at: retryAt, backoff_reason: reason, failure_kind: 'retryable', failure_detail: reason, next_action: `retry at ${retryAt}` }, { reason, delay_seconds: delay });
  }

  failTerminal(id: string, actor: string, reason: string, operatorAction: string, blockerCode = 'TERMINAL_FAILURE'): Job {
    return this.transition(id, 'failed_terminal', actor, { failure_kind: 'terminal', failure_detail: reason, blocker_code: blockerCode, operator_action: operatorAction, next_action: 'owner decision' }, { reason });
  }

  waitForReset(id: string, actor: string, resetAt: string | null, limitInfo: Record<string, unknown>, probeCount = 0): Job {
    const probeAt = resetAt ?? new Date(Date.parse(this.clock()) + resetProbeDelaySeconds(probeCount) * 1000).toISOString();
    return this.transition(id, 'waiting_for_reset', actor, {
      reset_at: resetAt, retry_at: probeAt, limit_info: JSON.stringify({ ...limitInfo, probe_count: probeCount }), waiting_on: 'claude',
      blocker_code: 'CLAUDE_PLAN_LIMIT', next_action: resetAt ? `resume automatically at ${resetAt}` : `probe capacity at ${probeAt}`,
      operator_action: resetAt ? null : 'No reset time was reported. The system probes with backoff; no action needed unless this persists past 60 minutes.',
    }, { reset_at: resetAt, probe_at: probeAt });
  }

  waitForAuth(id: string, actor: string, identity: string, operatorAction: string): Job {
    return this.transition(id, 'waiting_for_auth', actor, { waiting_on: identity, blocker_code: identity === 'claude' ? 'CLAUDE_LOGIN_REQUIRED' : 'BROWSER_LOGIN_REQUIRED', operator_action: operatorAction, next_action: `resume when ${identity} is connected` }, { identity });
  }

  /** Jobs whose retry/probe time has passed go back to queued. */
  promoteDue(actor = 'supervisor'): Job[] {
    const t = this.clock();
    const rows = this.db.prepare(`SELECT id, state FROM jobs WHERE state IN ('retry_scheduled','waiting_for_reset') AND retry_at IS NOT NULL AND retry_at <= ?`).all(t) as Array<{ id: string; state: JobState }>;
    return rows.map((r) => this.transition(r.id, 'queued', actor, { retry_at: null, next_action: 'resume from last verified checkpoint' }, { due: true, from: r.state }));
  }

  /** Resume every job waiting on an identity (e.g. 'claude' or 'browser:linkedin.com'). */
  resumeWaitingOn(identity: string, actor = 'supervisor'): Job[] {
    const rows = this.db.prepare(`SELECT id FROM jobs WHERE state = 'waiting_for_auth' AND waiting_on = ?`).all(identity) as Array<{ id: string }>;
    return rows.map((r) => this.transition(r.id, 'queued', actor, { waiting_on: null, blocker_code: null, operator_action: null, next_action: 'resume from last verified checkpoint' }, { identity }));
  }

  setStage(id: string, stageIndex: number, stageName: string, attempt: number): void {
    this.db.prepare('UPDATE jobs SET stage_index = ?, stage_name = ?, stage_attempt = ?, updated_at = ? WHERE id = ?').run(stageIndex, stageName, attempt, this.clock(), id);
  }

  patch(id: string, fields: Partial<Job>): void {
    const keys = Object.keys(fields); if (!keys.length) return;
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (fields as Record<string, unknown>)[k] as never), this.clock(), id);
  }
}
