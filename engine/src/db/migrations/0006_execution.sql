-- Gate 5: approved execution, one-shot schedules, event triggers.
-- 1. actions: add the explicit 'uncertain' outcome (an external result that cannot be known; never retried blindly) and a
--    durable receipt. SQLite cannot alter a CHECK constraint, so the table is rebuilt with every row kept.
CREATE TABLE actions_new (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  consequential INTEGER NOT NULL DEFAULT 0,
  target TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  approval_id TEXT REFERENCES approvals(id),
  status TEXT NOT NULL CHECK (status IN ('pending','performed','refused','failed','uncertain')),
  refusal_reason TEXT,
  performed_at TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  receipt TEXT,                      -- JSON: executor, where, sha256 of what was delivered, provider id if any
  resolved_by TEXT, resolved_at TEXT -- an uncertain action settled by the owner
);
INSERT INTO actions_new(id, job_id, idempotency_key, kind, consequential, target, content_hash, approval_id, status, refusal_reason, performed_at, result, created_at)
  SELECT id, job_id, idempotency_key, kind, consequential, target, content_hash, approval_id, status, refusal_reason, performed_at, result, created_at FROM actions;
DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

-- 2. one-shot schedules ("at"): run once at next_run_at, then disable.
ALTER TABLE schedules ADD COLUMN once INTEGER NOT NULL DEFAULT 0;

-- 3. event triggers: an authenticated local endpoint creates a task per event, exactly once per event id.
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id),
  kind TEXT NOT NULL,                -- workflow id
  objective TEXT NOT NULL,           -- what to do with each event; the event payload is attached as untrusted data
  token_sha256 TEXT NOT NULL,        -- the caller's secret is shown once and stored only as a hash
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trigger_events (
  trigger_id TEXT NOT NULL REFERENCES triggers(id),
  event_id TEXT NOT NULL,
  job_id TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, event_id)
);
