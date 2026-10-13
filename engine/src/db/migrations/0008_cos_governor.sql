-- Chief of Staff and usage governor (Phase 2, gate 2): real usage readings from Claude's /usage, owner overrides,
-- Chief of Staff priority ranks, morning reports, and timezone-aware schedules.

-- Every /usage reading taken through the route. windows: JSON [{ name, utilization, resets_at }]; NULL utilization never stored.
CREATE TABLE IF NOT EXISTS usage_readings (
  id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,                 -- e.g. 'claude /usage via ACP'
  session_ref TEXT,
  job_id TEXT,
  subscription TEXT,                    -- e.g. 'max' (as reported)
  has_limits INTEGER NOT NULL,          -- 0 = the answer carried no limits (fresh session): no number recorded
  governing_pct REAL,                   -- max utilization across windows, NULL when has_limits = 0
  windows TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS usage_readings_time_idx ON usage_readings(observed_at);

-- Owner overrides of the governor (in-app now; the Telegram bridge will use the same API). Expire by themselves.
CREATE TABLE IF NOT EXISTS usage_overrides (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('normal','low_power')),
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('app','telegram','api')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);

-- The Chief of Staff's ranking of open work: 1 = most important ... 5 = least. One current rank per job.
CREATE TABLE IF NOT EXISTS task_priorities (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
  rationale TEXT NOT NULL,
  ranked_by TEXT NOT NULL,              -- agent id (the Chief of Staff)
  ranked_in_job TEXT,                   -- the turn that ranked it
  ranked_at TEXT NOT NULL
);

-- Morning reports: the deterministic snapshot of the ledger plus the Chief of Staff's headline and lede.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'morning',
  job_id TEXT REFERENCES jobs(id),
  workspace_id TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  data TEXT NOT NULL,                   -- JSON snapshot of ledger rows used (counts and lists)
  headline TEXT,
  lede TEXT,
  status TEXT NOT NULL DEFAULT 'collected' CHECK (status IN ('collected','written','failed')),
  created_at TEXT NOT NULL,
  written_at TEXT
);
CREATE INDEX IF NOT EXISTS reports_time_idx ON reports(kind, created_at);

-- Schedules can run in a named timezone (IANA, e.g. America/Phoenix); NULL = the Mac's local time.
ALTER TABLE schedules ADD COLUMN tz TEXT;
