import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/open.ts';
import { JobStore, now } from '../../src/jobs/store.ts';
import { certify, formatCertify } from '../../src/ops/certify.ts';

function base() {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const t = now();
  db.prepare("INSERT INTO agent_definitions(id,name,purpose,created_at,updated_at) VALUES ('coordinator','Coordinator','p',?,?)").run(t, t);
  db.prepare("INSERT INTO agent_definitions(id,name,purpose,enabled,created_at,updated_at) VALUES ('retired','Retired','p',0,?,?)").run(t, t);
  return { db, store };
}
function workspace(db: DB, id: string, policies: Record<string, unknown>) {
  const t = now();
  db.prepare('INSERT INTO workspaces(id,name,root_path,policies,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, id === 'rehearsal' ? 'Launch rehearsal 3' : 'Job search', '/tmp/' + id, JSON.stringify(policies), t, t);
  db.prepare("INSERT INTO conversations(id,workspace_id,created_at,updated_at) VALUES (?,?,?,?)").run('c-' + id, id, t, t);
}
/** A completed lead turn, a verified application and a delivered Telegram message, all in workspace `ws`. */
function evidence(db: DB, store: JobStore, ws: string, n = 1) {
  const { job } = store.create({ idempotency_key: `turn-${ws}-${n}`, kind: 'chat.turn', objective: 'reply', success_contract: {}, agent_role: 'coordinator', workspace_id: ws });
  db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(job.id);
  const { job: app } = store.create({ idempotency_key: `app-${ws}-${n}`, kind: 'job.apply', objective: 'apply', success_contract: {}, agent_role: 'coordinator', workspace_id: ws });
  store.event(app.id, 'agent:coordinator', 'application.verified', { record: 'r1', company: 'Acme' });
  const mid = `m-${ws}-${n}`;
  db.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES (?,?,'assistant','done',?)").run(mid, 'c-' + ws, now());
  db.prepare("INSERT INTO telegram_outbox(message_id,chat_id,tg_message_id,kind,sent_at) VALUES (?,?,?,?,?)").run(mid, 'chat', 100 + n, 'message', now());
}
const byName = (r: ReturnType<typeof certify>, name: string) => r.checks.find((c) => c.name === name)!;

test('only rehearsal (telegram:false / dry_run) evidence is a NO-GO, and a still-active rehearsal job is called out', () => {
  const { db, store } = base();
  workspace(db, 'rehearsal', { telegram: false, dry_run: true });
  evidence(db, store, 'rehearsal');
  store.create({ idempotency_key: 'left-over', kind: 'research.report', objective: 'x', success_contract: {}, agent_role: 'coordinator', workspace_id: 'rehearsal' });   // queued
  const r = certify(db);
  assert.equal(r.go, false, formatCertify(r));
  assert.equal(byName(r, 'assistants ran real turns').ok, false);
  assert.equal(byName(r, 'application verified').ok, false);
  assert.equal(byName(r, 'telegram delivered').ok, false);
  assert.equal(byName(r, 'no active test-project jobs').ok, false);
  assert.match(byName(r, 'no active test-project jobs').evidence, /Launch rehearsal 3/);
  assert.equal(byName(r, 'engine alive').ok, true);   // control: the engine itself is active
});

test('dry_run alone also marks a test project', () => {
  const { db, store } = base();
  workspace(db, 'dry', { dry_run: true });
  evidence(db, store, 'dry');
  const r = certify(db);
  assert.equal(r.go, false);
  assert.equal(byName(r, 'application verified').ok, false);
});

test('a real verified application, a delivered Telegram message and completed turns are a GO (finished rehearsals do not block it)', () => {
  const { db, store } = base();
  workspace(db, 'main', {});
  workspace(db, 'rehearsal', { telegram: false });
  evidence(db, store, 'main');
  evidence(db, store, 'rehearsal');   // finished rehearsal work: ignored, not active
  db.prepare("UPDATE jobs SET state = 'completed' WHERE workspace_id = 'rehearsal'").run();
  db.prepare("INSERT INTO telegram_outbox(message_id,chat_id,tg_message_id,kind,sent_at) VALUES ('owner-in','chat',5,'inbound',?)").run(now());
  const r = certify(db);
  assert.equal(r.go, true, formatCertify(r));
  for (const c of r.checks) assert.equal(c.ok, true, `${c.name}: ${c.evidence}`);
  assert.match(formatCertify(r), /^GO/);
});

test('an assistant with work but no completed turn, stale activity, or evidence older than the window is a NO-GO', () => {
  const { db, store } = base();
  workspace(db, 'main', {});
  evidence(db, store, 'main');
  const t = now();
  db.prepare("INSERT INTO agent_definitions(id,name,purpose,created_at,updated_at) VALUES ('oscar','Oscar','p',?,?)").run(t, t);
  store.create({ idempotency_key: 'oscar-1', kind: 'chat.turn', objective: 'x', success_contract: {}, agent_role: 'oscar', workspace_id: 'main' });   // queued, never completed
  const r = certify(db);
  assert.equal(r.go, false);
  assert.match(byName(r, 'assistants ran real turns').evidence, /oscar/);
  // two hours later: nothing in the last 30 minutes
  const later = certify(db, { now: new Date(Date.now() + 2 * 3600_000) });
  assert.equal(byName(later, 'engine alive').ok, false);
  // a day later with a 6h window: all evidence has aged out
  const day = certify(db, { now: new Date(Date.now() + 24 * 3600_000), hours: 6 });
  assert.equal(byName(day, 'application verified').ok, false);
  assert.equal(byName(day, 'telegram delivered').ok, false);
});
