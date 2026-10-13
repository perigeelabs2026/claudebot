import type { DB } from '../db/open.ts';
import { newId, now, sha256 } from '../jobs/store.ts';

export const CONSEQUENTIAL_KINDS = ['send','publish','purchase','delete','production_change','new_scope','new_audience','budget_increase','policy_change'] as const;
export type ActionKind = typeof CONSEQUENTIAL_KINDS[number];
export const OWNER_PRESENCE_KINDS = ['login','mfa','captcha','device_auth'] as const;

export interface Approval {
  id: string; job_id: string | null; action_kind: string; target: string; content: string; content_hash: string;
  evidence: string; budget: string | null; status: 'pending'|'approved'|'rejected'|'stale'|'expired'|'consumed';
  decided_by: string | null; decided_at: string | null; decision_note: string | null; expires_at: string; created_at: string;
}

export type ApprovalVerdict = { ok: true; approval: Approval } | { ok: false; reason: 'missing'|'pending'|'rejected'|'stale'|'expired'|'consumed'|'kind_mismatch'|'target_mismatch'; approval?: Approval };

export function hashContent(content: string): string { return sha256(content); }

export class ApprovalStore {
  readonly db: DB; private clock: () => string;
  constructor(db: DB, clock: () => string = now) { this.db = db; this.clock = clock; }

  request(input: { job_id?: string | null; action_kind: string; target: string; content: string; evidence?: unknown[]; budget?: Record<string, unknown> | null; ttlSeconds?: number }): Approval {
    const id = newId('apr'); const t = this.clock();
    const expires = new Date(Date.parse(t) + (input.ttlSeconds ?? 7 * 24 * 3600) * 1000).toISOString();
    this.db.prepare(`INSERT INTO approvals(id, job_id, action_kind, target, content, content_hash, evidence, budget, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(id, input.job_id ?? null, input.action_kind, input.target, input.content, hashContent(input.content), JSON.stringify(input.evidence ?? []), input.budget ? JSON.stringify(input.budget) : null, expires, t);
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(input.job_id ?? null, t, 'system', 'approval.requested', JSON.stringify({ approval_id: id, action_kind: input.action_kind, target: input.target, content_hash: hashContent(input.content) }));
    return this.get(id)!;
  }

  get(id: string): Approval | undefined { return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined; }
  list(status?: Approval['status']): Approval[] {
    return (status ? this.db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC').all(status) : this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all()) as unknown as Approval[];
  }

  decide(id: string, decision: 'approved' | 'rejected', by: string, note?: string): Approval {
    const a = this.get(id); if (!a) throw new Error(`approval ${id} not found`);
    if (a.status !== 'pending') throw new Error(`approval ${id} is ${a.status}, not pending`);
    const t = this.clock();
    this.db.prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(decision, by, t, note ?? null, id);
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(a.job_id, t, by, `approval.${decision}`, JSON.stringify({ approval_id: id, note: note ?? null }));
    return this.get(id)!;
  }

  /** Verify an approval covers exactly this action (kind, target, content). Marks stale/expired as a side effect. */
  verify(id: string | null | undefined, action: { kind: string; target: string; content: string }): ApprovalVerdict {
    if (!id) return { ok: false, reason: 'missing' };
    const a = this.get(id); if (!a) return { ok: false, reason: 'missing' };
    const t = this.clock();
    if (a.status === 'pending') return { ok: false, reason: 'pending', approval: a };
    if (a.status === 'rejected' || a.status === 'consumed' || a.status === 'stale' || a.status === 'expired') return { ok: false, reason: a.status, approval: a };
    if (a.expires_at < t) { this.mark(a, 'expired'); return { ok: false, reason: 'expired', approval: this.get(id) }; }
    if (a.action_kind !== action.kind) return { ok: false, reason: 'kind_mismatch', approval: a };
    if (a.target !== action.target) return { ok: false, reason: 'target_mismatch', approval: a };
    if (a.content_hash !== hashContent(action.content)) { this.mark(a, 'stale'); return { ok: false, reason: 'stale', approval: this.get(id) }; }
    return { ok: true, approval: a };
  }

  /** Pending approvals whose time ran out become expired (nothing was done); returns the ones that changed. */
  expireDue(): Approval[] {
    const due = this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?").all(this.clock()) as unknown as Approval[];
    for (const a of due) this.mark(a, 'expired');
    return due;
  }
  /** Ask again with the same action, target and content after an approval expired. The old record stays as it was. */
  retry(id: string, by: string, ttlSeconds?: number): Approval {
    const a = this.get(id); if (!a) throw new Error(`approval ${id} not found`);
    if (a.status !== 'expired') throw new Error(`only an expired request can be asked again (this one is ${a.status})`);
    const n = this.request({ job_id: a.job_id, action_kind: a.action_kind, target: a.target, content: a.content, evidence: JSON.parse(a.evidence || '[]'), budget: a.budget ? JSON.parse(a.budget) : null, ttlSeconds });
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(a.job_id, this.clock(), by, 'approval.retried', JSON.stringify({ from: a.id, to: n.id }));
    return n;
  }
  /** The owner edits the exact content before deciding: the old request is superseded (stale) and a new one binds to the new text. */
  revise(id: string, content: string, by: string, ttlSeconds?: number): Approval {
    const a = this.get(id); if (!a) throw new Error(`approval ${id} not found`);
    if (a.status !== 'pending') throw new Error(`approval ${id} is ${a.status}, not pending`);
    const text = String(content ?? ''); if (!text.trim()) throw new Error('the draft cannot be empty'); if (text.length > 20000) throw new Error('keep the draft under 20,000 characters');
    if (hashContent(text) === a.content_hash) return a;
    this.mark(a, 'stale');
    const n = this.request({ job_id: a.job_id, action_kind: a.action_kind, target: a.target, content: text, evidence: JSON.parse(a.evidence || '[]'), budget: a.budget ? JSON.parse(a.budget) : null, ttlSeconds });
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(a.job_id, this.clock(), by, 'approval.revised', JSON.stringify({ from: a.id, to: n.id, content_hash: n.content_hash }));
    return n;
  }

  consume(id: string): void { const a = this.get(id); if (a) this.mark(a, 'consumed'); }

  private mark(a: Approval, status: Approval['status']) {
    const t = this.clock();
    this.db.prepare('UPDATE approvals SET status = ? WHERE id = ?').run(status, a.id);
    this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?,?,?,?,?)').run(a.job_id, t, 'system', `approval.${status}`, JSON.stringify({ approval_id: a.id }));
  }
}
