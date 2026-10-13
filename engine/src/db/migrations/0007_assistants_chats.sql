-- Assistants and chats (Phase 2, gate 1): assistant identity, direct and group conversations with members, message
-- sender / replies / mentions / delivery state, and reactions. Existing history migrates losslessly: every conversation
-- becomes a direct chat with the lead (coordinator), keeping its session; every message gets a sender.

-- Assistants: identity, role, responsibilities, model, routines placeholder and provenance.
ALTER TABLE agent_definitions ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_definitions ADD COLUMN responsibilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_definitions ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-5-5';
ALTER TABLE agent_definitions ADD COLUMN routines_ref TEXT;
ALTER TABLE agent_definitions ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system';
ALTER TABLE agent_definitions ADD COLUMN color_index INTEGER;
ALTER TABLE agent_definitions ADD COLUMN station TEXT;
UPDATE agent_definitions SET created_by = CASE WHEN is_system = 1 THEN 'system' WHEN template_pack IS NOT NULL THEN 'template:' || template_pack ELSE 'owner' END;

-- Conversations: direct (one assistant) or group (2-6 assistants), owned by the owner.
ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'direct' CHECK (type IN ('direct','group'));
ALTER TABLE conversations ADD COLUMN owner TEXT NOT NULL DEFAULT 'owner';

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id TEXT NOT NULL REFERENCES agent_definitions(id),
  session_ref TEXT,                    -- this assistant's persistent ACP session in this conversation (NULL = not spawned / closed)
  session_closed_at TEXT,
  joined_at TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT 'owner',
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_agent_idx ON conversation_members(agent_id);
CREATE TRIGGER IF NOT EXISTS conversation_members_group_cap BEFORE INSERT ON conversation_members
  WHEN (SELECT count(*) FROM conversation_members WHERE conversation_id = NEW.conversation_id) >= 6
  BEGIN SELECT RAISE(ABORT, 'a conversation has at most 6 assistants'); END;
CREATE TRIGGER IF NOT EXISTS conversation_members_direct_cap BEFORE INSERT ON conversation_members
  WHEN (SELECT type FROM conversations WHERE id = NEW.conversation_id) = 'direct'
   AND (SELECT count(*) FROM conversation_members WHERE conversation_id = NEW.conversation_id) >= 1
  BEGIN SELECT RAISE(ABORT, 'a direct chat has exactly one assistant'); END;

INSERT OR IGNORE INTO conversation_members(conversation_id, agent_id, session_ref, session_closed_at, joined_at, added_by)
  SELECT id, 'coordinator', session_ref, session_closed_at, created_at, 'migration' FROM conversations
  WHERE EXISTS (SELECT 1 FROM agent_definitions WHERE id = 'coordinator');

-- Messages: who sent it, what it replies to, whom it mentions, and whether it has been delivered.
ALTER TABLE messages ADD COLUMN sender TEXT NOT NULL DEFAULT 'system';
ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN delivery TEXT NOT NULL DEFAULT 'delivered' CHECK (delivery IN ('queued','delivering','delivered','failed'));
UPDATE messages SET sender = 'owner' WHERE role = 'owner';
UPDATE messages SET sender = COALESCE((SELECT j.agent_role FROM jobs j WHERE j.id = messages.job_id), 'coordinator') WHERE role = 'assistant';
CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages(reply_to);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  reactor TEXT NOT NULL,               -- 'owner' or an assistant id
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, reactor, emoji)
);

-- Assistant drafts: the Chief of Staff drafts an assistant from the owner's plain words; nothing is created until the owner
-- names and confirms it.
CREATE TABLE IF NOT EXISTS assistant_drafts (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),            -- the turn or draft task that produced it
  conversation_id TEXT REFERENCES conversations(id),
  description TEXT NOT NULL,                  -- the owner's own words
  draft TEXT NOT NULL,                        -- JSON: name, role, purpose, responsibilities, instructions, tools
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','discarded')),
  agent_id TEXT,                              -- set when confirmed
  created_at TEXT NOT NULL,
  decided_at TEXT
);
