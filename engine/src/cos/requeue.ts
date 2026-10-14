/**
 * Bank-known blockers go back to the team, not to the owner. When a task fails BLOCKED on a question the owner's answer bank
 * already answers (memory/answer-bank.ts, strict), or on an essay or free-text answer the team drafts from the resume and memory,
 * it is re-queued once with that answer (or the drafting instruction) in its inputs, and the re-queue is posted to the team group.
 * Passwords, codes, sign-ins, CAPTCHAs and payments are never re-queued: those stay the owner's. Deterministic: no model call.
 */
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import type { Job } from '../jobs/types.ts';
import { lookupAnswer } from '../memory/answer-bank.ts';
import { ESSAY } from './owner-needs.ts';
import { ChatStore } from '../chat/store.ts';

const OWNER_ONLY = /\b(pass(word|code|phrase)|verification code|one[- ]time|otp|mfa|2fa|captcha|sign[- ]?in|log[- ]?in|payment|purchase|credit card|spend)\b/i;
export const requeueKey = (jobId: string) => `requeue:${jobId}`;

export interface Requeued { from: string; to: string; how: 'bank' | 'draft' }

/** Re-queue each recently blocked task whose question the bank answers (or that is an essay), at most once per task. */
export function requeueBankKnownBlockers(db: DB, store: JobStore, opts: { bankDir?: string; sinceHours?: number } = {}): Requeued[] {
  const since = new Date(Date.now() - (opts.sinceHours ?? 24) * 3600_000).toISOString();
  const rows = db.prepare(`SELECT * FROM jobs WHERE state = 'failed_terminal' AND blocker_code = 'BLOCKED' AND kind <> 'chat.turn' AND updated_at >= ?
    AND idempotency_key NOT LIKE 'requeue:%' AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.idempotency_key = 'requeue:' || jobs.id) ORDER BY updated_at`).all(since) as unknown as Job[];
  const out: Requeued[] = [];
  for (const j of rows) {
    const detail = String(j.failure_detail ?? '').replace(/^blocked: /i, '');
    if (!detail || OWNER_ONLY.test(detail)) continue;
    const hits = lookupAnswer(detail, opts.bankDir, 3, { keyMatch: true }); const essay = ESSAY.test(detail);
    if (!hits.length && !essay) continue;
    const how: Requeued['how'] = hits.length ? 'bank' : 'draft';
    let inputs: Record<string, unknown> = {}; try { inputs = JSON.parse((j as unknown as { inputs?: string }).inputs || '{}'); } catch { /* */ }
    const note = how === 'bank'
      ? `The owner's answer bank already answers what blocked this: ${hits.map((h) => h.text).join('; ')}. Use it and finish; do not ask the owner.`
      : 'This was blocked on an essay or free-text answer. Draft it from the owner\'s resume and memory (lookup_answer, the team folder) and finish; do not ask the owner.';
    let contract: unknown = {}; try { contract = JSON.parse(j.success_contract || '{}'); } catch { /* */ }
    const { job, created } = store.create({ idempotency_key: requeueKey(j.id), parent_id: j.parent_id, kind: j.kind, objective: j.objective, success_contract: contract as never, agent_role: j.agent_role, workspace_id: j.workspace_id, objective_id: j.objective_id, inputs: { ...inputs, requeued_from: j.id, unblock: note, ...(hits.length ? { bank_answers: hits.map((h) => h.text) } : {}) } } as never, 'system:requeue');
    if (!created) continue;
    const conv = (j as unknown as { conversation_id?: string | null }).conversation_id ?? null; if (conv) store.patch(job.id, { conversation_id: conv } as never);
    store.event(j.id, 'system:requeue', 'task.requeued', { to: job.id, how, answers: hits.length });
    try {
      const chat = new ChatStore(db, store); const team = chat.teamConversation();
      const name = (db.prepare('SELECT name FROM agent_definitions WHERE id = ?').get(j.agent_role) as { name: string } | undefined)?.name ?? j.agent_role;
      if (team) chat.add({ conversation_id: team, role: 'system', kind: 'activity', content: `Back to ${name}: "${j.objective.replace(/\s+/g, ' ').slice(0, 120)}" was blocked on something the team can answer. ${how === 'bank' ? 'It now has the answer from the owner\'s saved answers.' : 'It will draft the answer from the resume and memory.'}`, job_id: job.id, meta: { requeued_from: j.id } });
    } catch { /* the re-queue stands without the team note */ }
    out.push({ from: j.id, to: job.id, how });
  }
  return out;
}
