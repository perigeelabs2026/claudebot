export type JobState =
  | 'drafted' | 'queued' | 'leased' | 'running' | 'waiting_for_reset' | 'waiting_for_auth'
  | 'waiting_for_approval' | 'retry_scheduled' | 'completed' | 'failed_terminal' | 'cancelled';

export const JOB_STATES: JobState[] = ['drafted','queued','leased','running','waiting_for_reset','waiting_for_auth','waiting_for_approval','retry_scheduled','completed','failed_terminal','cancelled'];

/** Legal transitions. Terminal states have no exits except cancelled→(none). */
export const TRANSITIONS: Record<JobState, JobState[]> = {
  drafted: ['queued', 'cancelled'],
  queued: ['leased', 'cancelled'],
  leased: ['running', 'queued', 'cancelled'],
  running: ['completed', 'failed_terminal', 'retry_scheduled', 'waiting_for_reset', 'waiting_for_auth', 'waiting_for_approval', 'queued', 'cancelled'],
  waiting_for_reset: ['queued', 'cancelled'],
  waiting_for_auth: ['queued', 'cancelled'],
  waiting_for_approval: ['queued', 'cancelled', 'failed_terminal'],
  retry_scheduled: ['queued', 'failed_terminal', 'cancelled'],
  completed: [],
  failed_terminal: [],
  cancelled: [],
};

export interface SuccessContract {
  /** every listed artifact kind must exist for the job */
  requires_artifacts?: string[];
  /** every listed checkpoint key must be present in the final 'after' payload */
  requires_keys?: string[];
  /** minimum number of evidence records attached */
  min_evidence?: number;
  /** a named deterministic validator (see contracts.ts) */
  validator?: string;
  /** the assistant must have reported an outcome (complete / partial / blocked) through report_outcome */
  requires_outcome?: boolean;
}

export interface Job {
  id: string;
  parent_id: string | null;
  idempotency_key: string;
  kind: string;
  objective: string;
  success_contract: string;
  agent_role: string;
  runtime_id: string;
  state: JobState;
  stage_index: number;
  stage_name: string | null;
  stage_attempt: number;
  lease_owner: string | null;
  lease_heartbeat_at: string | null;
  lease_expires_at: string | null;
  session_ref: string | null;
  runtime_session_id: string | null;
  last_good_checkpoint_id: number | null;
  input_refs: string;
  artifact_refs: string;
  next_action: string | null;
  retry_count: number;
  retry_at: string | null;
  backoff_reason: string | null;
  reset_at: string | null;
  limit_info: string | null;
  blocker_code: string | null;
  operator_action: string | null;
  failure_kind: 'retryable' | 'terminal' | null;
  failure_detail: string | null;
  waiting_on: string | null;
  priority: number;
  schedule_id: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  workspace_id: string | null;
  objective_id: string | null;
  depends_on: string;
  inputs: string;
  conversation_id: string | null;
  message_id: string | null;
  outcome: 'success' | 'partial' | 'blocked' | null;
  outcome_detail: string;
}

export interface Checkpoint {
  id: number;
  job_id: string;
  stage_index: number;
  stage_name: string;
  attempt: number;
  phase: 'before' | 'after';
  payload: string;
  sha256: string;
  session_ref: string | null;
  created_at: string;
}

export interface NewJob {
  idempotency_key: string;
  kind: string;
  objective: string;
  success_contract: SuccessContract;
  agent_role: string;
  runtime_id?: string;
  parent_id?: string | null;
  input_refs?: string[];
  priority?: number;
  schedule_id?: string | null;
  state?: 'drafted' | 'queued';
  workspace_id?: string | null;
  objective_id?: string | null;
  depends_on?: string[];
  inputs?: Record<string, unknown>;
}

export class IllegalTransition extends Error {
  from: JobState; to: JobState; jobId: string;
  constructor(from: JobState, to: JobState, jobId: string) {
    super(`illegal transition ${from} → ${to} for job ${jobId}`);
    this.from = from; this.to = to; this.jobId = jobId;
  }
}
