-- Groups have an owner-written purpose that every member's turn reads.
ALTER TABLE conversations ADD COLUMN purpose TEXT NOT NULL DEFAULT '';
