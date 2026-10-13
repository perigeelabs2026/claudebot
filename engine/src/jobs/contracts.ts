import type { DB } from '../db/open.ts';
import type { SuccessContract } from './types.ts';

export interface ContractResult { ok: boolean; reasons: string[] }

const VALIDATORS: Record<string, (ctx: { db: DB; jobId: string; payload: Record<string, unknown> }) => string | null> = {
  // A research artifact must cite at least one source URL for every claim list it produces.
  evidence_has_sources: ({ db, jobId }) => {
    const rows = db.prepare('SELECT source_url FROM memory_evidence WHERE job_id = ?').all(jobId) as Array<{ source_url: string | null }>;
    if (rows.length === 0) return 'no evidence rows';
    return rows.every((r) => r.source_url && /^https?:\/\//.test(r.source_url)) ? null : 'evidence without source URL';
  },
  // A review verdict must be explicit.
  review_verdict_present: ({ payload }) => (payload.verdict === 'pass' || payload.verdict === 'fail' ? null : 'review verdict missing'),
  // Nothing to validate beyond keys/artifacts.
  none: () => null,
};

export function evaluateContract(db: DB, jobId: string, contract: SuccessContract, finalPayload: Record<string, unknown>): ContractResult {
  const reasons: string[] = [];
  for (const kind of contract.requires_artifacts ?? []) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE job_id = ? AND kind = ?').get(jobId, kind) as { n: number }).n;
    if (n === 0) reasons.push(`missing artifact of kind ${kind}`);
  }
  for (const key of contract.requires_keys ?? []) {
    if (!(key in finalPayload) || finalPayload[key] === null || finalPayload[key] === '') reasons.push(`missing key ${key} in final checkpoint`);
  }
  if (contract.min_evidence !== undefined) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM memory_evidence WHERE job_id = ?').get(jobId) as { n: number }).n;
    if (n < contract.min_evidence) reasons.push(`evidence ${n} < required ${contract.min_evidence}`);
  }
  if (contract.requires_outcome) {
    const j = db.prepare('SELECT outcome FROM jobs WHERE id = ?').get(jobId) as { outcome: string | null } | undefined;
    if (!j?.outcome) reasons.push('the assistant did not report whether the requested work succeeded (report_outcome was not called)');
    else if (j.outcome === 'blocked') reasons.push('the work was reported as blocked');
  }
  if (contract.validator) {
    const v = VALIDATORS[contract.validator];
    if (!v) reasons.push(`unknown validator ${contract.validator}`);
    else { const r = v({ db, jobId, payload: finalPayload }); if (r) reasons.push(r); }
  }
  return { ok: reasons.length === 0, reasons };
}
