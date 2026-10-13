-- Scoped full-text search with provenance (Gate 3). One FTS5 index over conversation messages, evidence and saved results.
-- Scope columns are stored with every row so queries filter by project / conversation / task before ranking.
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED, ref UNINDEXED, workspace_id UNINDEXED, conversation_id UNINDEXED, job_id UNINDEXED,
  title, body, source UNINDEXED, created_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- Results (artifact files) are indexed by the engine (it reads the file and records the hash it indexed).
CREATE TABLE IF NOT EXISTS search_indexed (artifact_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, indexed_at TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS search_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO search_index(kind, ref, workspace_id, conversation_id, job_id, title, body, source, created_at)
  VALUES ('message', NEW.id, (SELECT workspace_id FROM conversations WHERE id = NEW.conversation_id), NEW.conversation_id, NEW.job_id,
          NEW.role || ' ' || NEW.kind, NEW.content, NULL, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS search_evidence_ai AFTER INSERT ON memory_evidence BEGIN
  INSERT INTO search_index(kind, ref, workspace_id, conversation_id, job_id, title, body, source, created_at)
  VALUES ('evidence', NEW.id, (SELECT workspace_id FROM jobs WHERE id = NEW.job_id), (SELECT conversation_id FROM jobs WHERE id = NEW.job_id), NEW.job_id,
          NEW.title, NEW.body, NEW.source_url, NEW.created_at);
END;

INSERT INTO search_index(kind, ref, workspace_id, conversation_id, job_id, title, body, source, created_at)
  SELECT 'message', m.id, c.workspace_id, m.conversation_id, m.job_id, m.role || ' ' || m.kind, m.content, NULL, m.created_at
  FROM messages m JOIN conversations c ON c.id = m.conversation_id;
INSERT INTO search_index(kind, ref, workspace_id, conversation_id, job_id, title, body, source, created_at)
  SELECT 'evidence', e.id, j.workspace_id, j.conversation_id, e.job_id, e.title, e.body, e.source_url, e.created_at
  FROM memory_evidence e LEFT JOIN jobs j ON j.id = e.job_id;
