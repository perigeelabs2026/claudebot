-- Truthful completion: a task records whether the requested work succeeded, succeeded partially, or was blocked.
ALTER TABLE jobs ADD COLUMN outcome TEXT CHECK (outcome IN (NULL,'success','partial','blocked'));
ALTER TABLE jobs ADD COLUMN outcome_detail TEXT NOT NULL DEFAULT '{}';   -- JSON: reason, remaining, next_action, block_kind, site, reported_by
