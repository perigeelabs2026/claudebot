-- Phase 2 gate 3: standing permissions ("Always allow … like this"). Owner-created only, scoped, limited, expiring, revocable.
CREATE TABLE IF NOT EXISTS standing_permissions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  max_per_day INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  scope_text TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','revoked','expired')),
  from_approval TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS standing_permissions_match ON standing_permissions(agent_id, action_kind, target, status);
