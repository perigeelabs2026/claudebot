-- General-purpose model: workspaces, owner-configurable definitions, template packs, settings.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  root_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  agent_team TEXT NOT NULL DEFAULT '[]',        -- JSON array of agent ids; empty = every enabled agent
  enabled_skills TEXT NOT NULL DEFAULT '[]',
  connectors TEXT NOT NULL DEFAULT '[]',
  policies TEXT NOT NULL DEFAULT '{}',          -- JSON: approval rules, allowlists
  memory_scope TEXT NOT NULL DEFAULT '[]',
  worker_limit INTEGER NOT NULL DEFAULT 4,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  system_instructions TEXT NOT NULL DEFAULT '',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  data_scopes TEXT NOT NULL DEFAULT '[]',
  prohibited_actions TEXT NOT NULL DEFAULT '[]',
  approval_rules TEXT NOT NULL DEFAULT '[]',
  measurable_outputs TEXT NOT NULL DEFAULT '[]',
  acceptance_tests TEXT NOT NULL DEFAULT '[]',
  concurrency_limit INTEGER NOT NULL DEFAULT 2,
  memory_scope TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  template_pack TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_agent TEXT NOT NULL,
  stages TEXT NOT NULL,                          -- JSON array of StageDef
  contract TEXT NOT NULL DEFAULT '{}',
  inputs TEXT NOT NULL DEFAULT '[]',             -- JSON array of {name, description, required}
  is_system INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  template_pack TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  installed_at TEXT,
  installed_by TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

ALTER TABLE objectives ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE objectives ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;
ALTER TABLE objectives ADD COLUMN success_criteria TEXT NOT NULL DEFAULT '';
ALTER TABLE objectives ADD COLUMN updated_at TEXT;

ALTER TABLE jobs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE jobs ADD COLUMN objective_id TEXT REFERENCES objectives(id);
ALTER TABLE jobs ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN inputs TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS jobs_workspace_idx ON jobs(workspace_id, state);

ALTER TABLE artifacts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE artifacts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artifacts ADD COLUMN review_state TEXT NOT NULL DEFAULT 'unreviewed';
ALTER TABLE artifacts ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';

ALTER TABLE schedules ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE schedules ADD COLUMN inputs TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memory_evidence ADD COLUMN workspace_id TEXT;
ALTER TABLE memory_rules ADD COLUMN workspace_id TEXT;
ALTER TABLE memory_proposals ADD COLUMN workspace_id TEXT;
ALTER TABLE records ADD COLUMN workspace_id TEXT;
ALTER TABLE approvals ADD COLUMN workspace_id TEXT;

-- Revenue-only tables become optional module data in `records` (type prefixed by the pack id).
DROP TABLE IF EXISTS opportunities;
DROP TABLE IF EXISTS experiments;
DROP TABLE IF EXISTS outcomes;
DROP TABLE IF EXISTS costs;
-- The fixed role table is superseded by agent_definitions.
DROP TABLE IF EXISTS agents;
