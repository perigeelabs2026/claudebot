-- ClaudeBot job ledger (schema v1). All timestamps are ISO-8601 UTC strings.
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES jobs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                 -- workflow id
  objective TEXT NOT NULL,
  success_contract TEXT NOT NULL,     -- JSON predicate
  agent_role TEXT NOT NULL,
  runtime_id TEXT NOT NULL DEFAULT 'claude-acp',
  state TEXT NOT NULL CHECK (state IN ('drafted','queued','leased','running','waiting_for_reset','waiting_for_auth','waiting_for_approval','retry_scheduled','completed','failed_terminal','cancelled')),
  stage_index INTEGER NOT NULL DEFAULT 0,
  stage_name TEXT,
  stage_attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_heartbeat_at TEXT,
  lease_expires_at TEXT,
  session_ref TEXT,                   -- OpenClaw session key for the bound ACP session
  runtime_session_id TEXT,            -- harness-level session id when reported
  last_good_checkpoint_id INTEGER,
  input_refs TEXT NOT NULL DEFAULT '[]',
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  next_action TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  backoff_reason TEXT,
  reset_at TEXT,
  limit_info TEXT,
  blocker_code TEXT,
  operator_action TEXT,
  failure_kind TEXT CHECK (failure_kind IN (NULL,'retryable','terminal')),
  failure_detail TEXT,
  waiting_on TEXT,                    -- identity the job waits for: 'claude' | 'browser:<site>' | 'approval:<id>'
  priority INTEGER NOT NULL DEFAULT 5,
  schedule_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(lease_expires_at);

CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                -- 'supervisor' | 'worker:<pid>' | 'owner' | 'agent:<role>' | 'system'
  type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, seq);
CREATE TRIGGER IF NOT EXISTS job_events_no_update BEFORE UPDATE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS job_events_no_delete BEFORE DELETE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  stage_index INTEGER NOT NULL,
  stage_name TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('before','after')),
  payload TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  session_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_job_idx ON checkpoints(job_id, id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  action_kind TEXT NOT NULL,          -- send|publish|purchase|delete|production_change|new_scope|new_audience|budget_increase|policy_change
  target TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  budget TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','stale','expired','consumed')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  consequential INTEGER NOT NULL DEFAULT 0,
  target TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  approval_id TEXT REFERENCES approvals(id),
  status TEXT NOT NULL CHECK (status IN ('pending','performed','refused','failed')),
  refusal_reason TEXT,
  performed_at TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  objective TEXT NOT NULL,
  success_contract TEXT NOT NULL,
  cron TEXT,                           -- 5-field cron, or NULL for event-only
  every_seconds INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_enqueued_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  role TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  allowed_inputs TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
  prohibited_actions TEXT NOT NULL,
  measurable_outputs TEXT NOT NULL,
  escalation_rules TEXT NOT NULL,
  memory_scope TEXT NOT NULL,
  concurrency_limit INTEGER NOT NULL,
  acceptance_tests TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY,                -- e.g. claude.auth, claude.capacity, gateway.health, browser.health
  value TEXT NOT NULL,                 -- JSON
  evidence TEXT,                       -- how it was observed
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  code TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  stage_name TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- file|note|screenshot|record
  path TEXT,
  sha256 TEXT,
  title TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_sites (
  site TEXT PRIMARY KEY,               -- hostname
  profile TEXT NOT NULL DEFAULT 'claudebot',
  signed_in INTEGER,                   -- NULL unknown, 0 no, 1 yes
  check_method TEXT,
  last_checked_at TEXT,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS memory_rules (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_evidence (
  id TEXT PRIMARY KEY, job_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, source_url TEXT, source_hash TEXT, grade TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id TEXT PRIMARY KEY, job_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY, job_id TEXT, title TEXT NOT NULL, summary TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]', stage TEXT NOT NULL, value_estimate TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY, opportunity_id TEXT, hypothesis TEXT NOT NULL, metric TEXT NOT NULL, status TEXT NOT NULL, result TEXT, approval_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY, experiment_id TEXT, kind TEXT NOT NULL, amount_cents INTEGER, currency TEXT, attribution TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS costs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, note TEXT, approval_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL, job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_type_idx ON records(type);
