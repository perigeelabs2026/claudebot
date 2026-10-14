/** Assistants remember yesterday: the nightly work-log rollup (ledger → vault, no model call) and elsewhere() per conversation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { Vault, localDay } from '../../src/memory/vault.ts';
import { rollupWorkLogs } from '../../src/memory/worklog.ts';

const COMPANIES = ['Northwind', 'Northwind Labs', 'Okta', 'Snyk', 'Vanta', 'Drata', 'Wiz', 'Tines', 'Abnormal'];

function setup() {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const defs = new Definitions(db); defs.seedSystemDefaults();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-'));
  const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Job search' }, 'test');
  const testWs = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Rehearsal (test)', policies: { telegram: false, dry_run: true } }, 'test');
  db.prepare("UPDATE agent_definitions SET name = 'Jude' WHERE id = 'researcher'").run();
  const vault = new Vault(path.join(tmp, 'vault'));
  return { db, store, defs, ws, testWs, vault, tmp };
}
type S = ReturnType<typeof setup>;
let n = 0;
function job(s: S, o: { agent?: string; objective: string; state?: string; at: string; ws?: string; failure?: string; outcome?: string; kind?: string }) {
  const id = `job-${++n}`;
  s.db.prepare("INSERT INTO jobs(id, idempotency_key, kind, objective, success_contract, state, agent_role, priority, created_at, updated_at, completed_at, inputs, depends_on, input_refs, workspace_id, failure_detail, outcome) VALUES (?,?,?,?,'{}',?,?,5,?,?,?,'{}','[]','[]',?,?,?)")
    .run(id, id, o.kind ?? 'research', o.objective, o.state ?? 'completed', o.agent ?? 'researcher', o.at, o.at, (o.state ?? 'completed') === 'completed' ? o.at : null, o.ws ?? s.ws.id, o.failure ?? null, o.outcome ?? null);
  return id;
}
function application(s: S, jobId: string, company: string, role: string, at: string) {
  const rec = `rec-${++n}`;
  s.db.prepare("INSERT INTO records(id, type, data, job_id, created_at, updated_at) VALUES (?, 'application', ?, ?, ?, ?)").run(rec, JSON.stringify({ title: `${company} – ${role}`, company, role, submitted_at: at, verified: true }), jobId, at, at);
  s.db.prepare("INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (?, ?, 'agent:researcher', 'application.verified', ?)").run(jobId, at, JSON.stringify({ record: rec, company, role }));
}

test('the nightly rollup writes all 9 verified applications from yesterday into Jude\'s note, and every turn\'s memory includes them', () => {
  const s = setup(); const now = new Date(); const y = new Date(now); y.setDate(y.getDate() - 1); y.setHours(11, 0, 0, 0);
  const at = (min: number) => new Date(y.getTime() + min * 60_000).toISOString();
  COMPANIES.forEach((c, i) => { const j = job(s, { objective: `Apply to ${c}`, at: at(i * 5) }); application(s, j, c, 'Channel Sales Manager', at(i * 5 + 1)); });
  const blocked = job(s, { objective: 'Apply to Ramp', state: 'failed_terminal', at: at(60), failure: 'CAPTCHA on the Ramp careers page' });
  s.db.prepare("INSERT INTO artifacts(id, job_id, stage_name, kind, path, title, created_at) VALUES ('a1', ?, 's', 'file', '/x/resume.pdf', 'Resume – Northwind.pdf', ?), ('a2', ?, 's', 'screenshot', '/x/r.png', 'receipt', ?)").run(blocked, at(61), blocked, at(61));
  // Test projects are not memory; other assistants' work is not Jude's.
  application(s, job(s, { objective: 'Rehearsal apply', at: at(70), ws: s.testWs.id }), 'RehearsalCo', 'Tester', at(71));
  application(s, job(s, { objective: 'Other apply', at: at(72), agent: 'builder' }), 'NotJudeCo', 'Builder role', at(73));
  // Sections already in the note are kept.
  const jude = { id: 'researcher', name: 'Jude' };
  s.vault.remember({ scope: 'self', text: 'Attach resumes as files, never paste them', agent: jude });

  const r = rollupWorkLogs(s.db, { vault: s.vault, now });
  assert.ok(r.written.some((w) => w.agent === 'researcher' && w.day === localDay(y)));
  const note = fs.readFileSync(path.join(s.vault.dir, 'Assistants', 'Jude.md'), 'utf8');
  assert.match(note, /## Lessons\n- Attach resumes as files/, 'other sections stay');
  assert.match(note, new RegExp(`## Work log\\n\\n### ${localDay(y)}\\n- Applications submitted and verified \\(9\\):`));
  for (const c of COMPANIES) assert.match(note, new RegExp(`  - ${c} — Channel Sales Manager`), c);
  assert.match(note, /Tasks blocked \(1\):\n  - Apply to Ramp — CAPTCHA on the Ramp careers page/);
  assert.match(note, /Files saved \(1\):\n  - Resume – Northwind\.pdf/); assert.ok(!note.includes('receipt'));
  assert.ok(!note.includes('RehearsalCo') && !note.includes('NotJudeCo'));
  assert.ok(!fs.existsSync(path.join(s.vault.dir, 'Assistants', 'Lead assistant.md')) || !fs.readFileSync(path.join(s.vault.dir, 'Assistants', 'Lead assistant.md'), 'utf8').includes('## Work log'), 'no empty logs for idle assistants');

  const ctx = s.vault.context(jude);
  assert.match(ctx, /Your work log, last 3 days/); for (const c of COMPANIES) assert.ok(ctx.includes(c), `context has ${c}`);
  assert.match(ctx, /Attach resumes as files/);

  // Idempotent: a second run changes nothing; the day's entry is replaced, not duplicated.
  assert.equal(rollupWorkLogs(s.db, { vault: s.vault, now }).written.length, 0);
  assert.equal(fs.readFileSync(path.join(s.vault.dir, 'Assistants', 'Jude.md'), 'utf8').split(`### ${localDay(y)}`).length, 2);
});

test('the work log keeps the last 14 days and the turn context shows only the last 3', () => {
  const s = setup(); const jude = { id: 'researcher', name: 'Jude' }; const now = new Date();
  for (let i = 20; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); s.vault.setWorkLog(jude, localDay(d), [`- did thing ${i}`]); }
  const note = fs.readFileSync(s.vault.notePath(jude), 'utf8'); assert.equal(note.match(/^### \d{4}-\d{2}-\d{2}$/gm)!.length, 14);
  assert.ok(note.includes('did thing 13') && !note.includes('did thing 14'));
  const ctx = s.vault.context(jude); assert.ok(ctx.includes('did thing 0') && ctx.includes('did thing 2')); assert.ok(!ctx.includes('did thing 3'));
});

test('elsewhere returns up to 10 messages per other conversation, grouped by title, oldest first within each', () => {
  const s = setup(); const chat = new ChatStore(s.db, s.store);
  const a = chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] }); s.db.prepare("UPDATE conversations SET title = 'Applications' WHERE id = ?").run(a.id);
  const b = chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['researcher'] }); s.db.prepare("UPDATE conversations SET title = 'Jude direct' WHERE id = ?").run(b.id);
  const here = chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['researcher'] });
  const t0 = Date.now() - 2 * 3600_000;
  for (let i = 0; i < 15; i++) s.db.prepare("INSERT INTO messages(id, conversation_id, role, kind, content, meta, created_at, sender) VALUES (?, ?, 'owner', 'text', ?, '{}', ?, 'owner')").run(`ma${i}`, a.id, `group note ${i}`, new Date(t0 + i * 60_000).toISOString());
  for (let i = 0; i < 12; i++) s.db.prepare("INSERT INTO messages(id, conversation_id, role, kind, content, meta, created_at, sender) VALUES (?, ?, 'assistant', 'text', ?, '{}', ?, 'researcher')").run(`mb${i}`, b.id, `direct reply ${i}`, new Date(t0 + 30 * 60_000 + i * 60_000).toISOString());
  s.db.prepare("INSERT INTO messages(id, conversation_id, role, kind, content, meta, created_at, sender) VALUES ('old', ?, 'owner', 'text', 'four days ago', '{}', ?, 'owner')").run(a.id, new Date(Date.now() - 96 * 3600_000).toISOString());
  const out = chat.elsewhere('researcher', here.id);
  const lines = out.split('\n').filter((l) => l.startsWith('['));
  assert.equal(lines.filter((l) => l.includes('group note')).length, 10); assert.equal(lines.filter((l) => l.includes('direct reply')).length, 10);
  assert.ok(!out.includes('group note 4 ') && !/group note 4$/m.test(out) && out.includes('group note 5') && out.includes('group note 14'), 'the last 10 of the group');
  assert.ok(!out.includes('four days ago'), 'older than 72 hours');
  assert.ok(out.indexOf('Applications:') < out.indexOf('Jude direct:'), 'grouped by title, least recently active first');
  const g = out.split('Jude direct:')[0]; assert.ok(g.indexOf('group note 5') < g.indexOf('group note 14'), 'oldest first within a group');
  assert.match(out, /Jude direct:\n\[[^\]]+\] You: direct reply 2/);
  assert.equal(chat.elsewhere('researcher', here.id, { limit: 3 }).split('\n').filter((l) => l.startsWith('[')).length, 6, 'limit is per conversation');
});
