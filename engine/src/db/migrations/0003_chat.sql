-- Chat-first interaction: durable conversations with the lead assistant, linked to the work they cause.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  title TEXT NOT NULL DEFAULT '',
  session_ref TEXT,                              -- persistent ACP session key of the lead assistant (NULL = not spawned / closed)
  session_closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('owner','assistant','system')),
  kind TEXT NOT NULL DEFAULT 'text',             -- text | delegation | result | decision | status
  content TEXT NOT NULL,
  job_id TEXT,                                   -- the task this message is about (turn job, delegated job)
  artifact_id TEXT,
  approval_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS messages_job_idx ON messages(job_id, kind);

ALTER TABLE jobs ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
ALTER TABLE jobs ADD COLUMN message_id TEXT;
CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs(conversation_id, state);
