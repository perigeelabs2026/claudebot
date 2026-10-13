import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
/**
 * A second connection to a running test engine's database. The engine and its workers write concurrently, so the
 * connection must wait for the write lock instead of failing at once (SQLite's default busy timeout is 0, which
 * produced "database is locked" in concurrency.test.ts). Fixture rows that stand in for a real Claude turn must
 * also carry the assistant's outcome report, which success contracts require since migration 0004.
 */
export function fixtureDb(home: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(path.join(home, 'data', 'claudebot.sqlite'), opts.readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 15000');
  return db;
}
export function markReported(db: DatabaseSync, jobId: string): void { db.prepare("UPDATE jobs SET outcome = 'success', outcome_detail = '{\"reason\":\"test fixture\",\"reported_by\":\"test\"}' WHERE id = ?").run(jobId); }
