// Phase 2 gate 6: Telegram bridge, tested against a LOCAL FAKE Telegram Bot API server (test-only; no real bot or network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/open.ts';
import { JobStore } from '../../src/jobs/store.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';
import { Definitions } from '../../src/model/definitions.ts';
import { Workspaces } from '../../src/model/workspaces.ts';
import { ChatStore } from '../../src/chat/store.ts';
import { TelegramBridge, saveToken, newPairingCode, binding, hasToken } from '../../src/telegram/bridge.ts';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
/** A fake Bot API: queues updates for getUpdates and records every call. */
async function fakeTelegram() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []; let queue: Array<Record<string, unknown>> = []; let nextMsg = 1000;
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? ''); const body = raw ? JSON.parse(raw) : {}; const send = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!m || m[1] !== TOKEN) return send({ ok: false, description: 'Unauthorized' });
    calls.push({ method: m[2], body });
    if (m[2] === 'getUpdates') { const off = Number(body.offset ?? 0); const out = queue.filter((u) => Number(u.update_id) >= off); return send({ ok: true, result: out }); }
    if (m[2] === 'sendMessage') return send({ ok: true, result: { message_id: nextMsg++ } });
    return send({ ok: true, result: true });
  }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, calls, push: (u: Record<string, unknown>) => queue.push(u), clear: () => { queue = []; }, close: () => server.close() };
}
function setup(base: string) {
  const db = openDatabase(':memory:'); const store = new JobStore(db); const approvals = new ApprovalStore(db); const defs = new Definitions(db); defs.seedSystemDefaults();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')); const ws = new Workspaces(db, path.join(tmp, 'ws')).create({ name: 'Test project' }, 'test');
  const chat = new ChatStore(db, store); const secrets = path.join(tmp, 'secrets');
  const bridge = new TelegramBridge({ db, secretsDir: secrets, apiBase: base, chat, approvals, defs, store, defaultWorkspace: () => ws.id });
  return { db, store, approvals, defs, chat, ws, secrets, bridge };
}
const msg = (id: number, chatId: number, text: string, extra: Record<string, unknown> = {}) => ({ update_id: id, message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: chatId, username: 'owner' }, text, ...extra } });


/** Make a conversation the owner's Telegram chat with the lead (as if he had written there from Telegram). */
function linkTelegram(s: { db: import('node:sqlite').DatabaseSync; chat: ChatStore; store: import('../../src/jobs/store.ts').JobStore }, convId: string): string { const m = s.chat.add({ conversation_id: convId, role: 'owner', sender: 'owner', content: 'hi from Telegram' }); s.db.prepare("INSERT INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?, 777, 1, 'inbound', ?)").run(m.id, new Date().toISOString()); return s.store.create({ idempotency_key: `tg-turn-${m.id}`, kind: 'chat.turn', objective: 'reply', success_contract: {}, agent_role: 'coordinator', workspace_id: null, inputs: { conversation_id: convId, message_id: m.id } } as never, 'owner').job.id; }

test('T1: no token, nothing happens; a malformed token is refused and the token file is private', async () => {
  const f = await fakeTelegram(); const s = setup(f.base);
  assert.deepEqual(await s.bridge.cycle(0), { updates: 0, sent: 0 }); assert.equal(f.calls.length, 0);
  assert.throws(() => saveToken(s.secrets, 'not a token'), /isn't a bot token.*characters with no colon/);
  saveToken(s.secrets, TOKEN); assert.equal(hasToken(s.secrets), true); assert.equal(fs.statSync(path.join(s.secrets, 'telegram.token')).mode & 0o777, 0o600);
  f.close();
});

test('T2: only the chat that sends a valid, unexpired pairing code is bound; other chats are ignored', async () => {
  const f = await fakeTelegram(); const s = setup(f.base); saveToken(s.secrets, TOKEN);
  f.push(msg(1, 555, '/start 000000')); await s.bridge.cycle(0); assert.equal(binding(s.db), null, 'a wrong code binds nothing');
  const { code } = newPairingCode(s.db); f.push(msg(2, 777, `/start ${code}`)); await s.bridge.cycle(0);
  assert.equal(binding(s.db)?.chat_id, '777');
  f.push(msg(3, 555, `/start ${code}`)); await s.bridge.cycle(0); assert.equal(binding(s.db)?.chat_id, '777', 'a used code cannot rebind');
  f.push(msg(4, 555, 'hello from a stranger')); await s.bridge.cycle(0);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM messages WHERE role = 'owner'").get() as { n: number }).n, 0, 'strangers never reach a conversation');
  f.close();
});

test('T3: owner text reaches the Chief of Staff once (no duplicates on re-delivery); replies route back to their conversation', async () => {
  const f = await fakeTelegram(); const s = setup(f.base); saveToken(s.secrets, TOKEN); const { code } = newPairingCode(s.db);
  f.push(msg(10, 777, `/start ${code}`)); await s.bridge.cycle(0);
  f.push(msg(11, 777, 'What is on my plate today?')); await s.bridge.cycle(0);
  f.push(msg(11, 777, 'What is on my plate today?')); s.db.prepare("DELETE FROM runtime_state WHERE key = 'telegram.offset'").run(); await s.bridge.cycle(0);   // Telegram re-delivers the same update
  const owners = s.db.prepare("SELECT conversation_id, content, meta FROM messages WHERE role = 'owner'").all() as Array<{ conversation_id: string; content: string; meta: string }>;
  assert.equal(owners.length, 1); assert.equal(JSON.parse(owners[0].meta).source, 'telegram');
  const conv = owners[0].conversation_id; const turn = s.db.prepare("SELECT id FROM jobs WHERE conversation_id = ? AND kind = 'chat.turn'").get(conv) as { id: string };
  s.chat.add({ conversation_id: conv, role: 'assistant', kind: 'text', sender: 'coordinator', content: 'Two things need you.', job_id: turn.id });
  const sent = await s.bridge.flush(); assert.equal(sent, 1); assert.equal(await s.bridge.flush(), 0, 'each notice is sent once');
  const notice = f.calls.filter((c) => c.method === 'sendMessage').pop()!; assert.equal(String(notice.body.text), 'Two things need you.', 'plain text from the lead: no name or chat-title header'); assert.deepEqual(notice.body.link_preview_options, { is_disabled: true });
  f.close();
});

test('T4: approval buttons decide the same approval record, bound to its content hash; a changed draft or a stranger is refused', async () => {
  const f = await fakeTelegram(); const s = setup(f.base); saveToken(s.secrets, TOKEN); const { code } = newPairingCode(s.db);
  f.push(msg(20, 777, `/start ${code}`)); await s.bridge.cycle(0);
  const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] }); const sent = s.chat.send(c.id, 'Email me the report', s.defs);
  const ap = s.approvals.request({ job_id: sent.job.id, action_kind: 'send', target: 'email to owner@example.org', content: 'Subject: Report\n\nHere it is.' });
  s.chat.add({ conversation_id: c.id, role: 'system', kind: 'decision', content: 'decision', job_id: sent.job.id, approval_id: ap.id, meta: {} });
  await s.bridge.flush(); const card = f.calls.filter((x) => x.method === 'sendMessage').pop()!;
  assert.match(String(card.body.text), /Here it is\./, 'the full content is shown'); const kb = (card.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0];
  f.push({ update_id: 21, callback_query: { id: 'q1', data: kb[0].callback_data, from: { id: 999 }, message: { chat: { id: 999 } } } }); await s.bridge.cycle(0);
  assert.equal(s.approvals.get(ap.id)!.status, 'pending', 'a stranger cannot press it');
  const forged = kb[0].callback_data.replace(/:[0-9a-f]{12}:/, ':000000000000:');
  f.push({ update_id: 22, callback_query: { id: 'q2', data: forged, from: { id: 777 }, message: { chat: { id: 777 } } } }); await s.bridge.cycle(0);
  assert.equal(s.approvals.get(ap.id)!.status, 'pending', 'a button for different content is refused');
  f.push({ update_id: 23, callback_query: { id: 'q3', data: kb[0].callback_data, from: { id: 777 }, message: { chat: { id: 777 } } } }); await s.bridge.cycle(0);
  assert.equal(s.approvals.get(ap.id)!.status, 'approved'); assert.match(String(s.approvals.get(ap.id)!.decision_note), /Telegram/);
  f.push({ update_id: 24, callback_query: { id: 'q4', data: kb[1].callback_data, from: { id: 777 }, message: { chat: { id: 777 } } } }); await s.bridge.cycle(0);
  assert.equal(s.approvals.get(ap.id)!.status, 'approved', 'a second press changes nothing');
  f.close();
});

test('T1b: a real-looking token with underscores is accepted even when pasted with invisible characters, a trailing period or the BotFather message around it', async () => {
  const fsm = await import('node:fs'); const os = await import('node:os'); const pathm = await import('node:path');
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'tg-')); const tok = '1234567890:AAH' + 'x_Y-z'.repeat(6) + 'Ab';   // 35 characters after the colon, like a real token
  for (const pasted of [tok, ` ${tok}\n`, `\u200B${tok}\u00A0`, `Use this token to access the HTTP API:\n${tok}\nKeep your token secure`, `${tok}.`]) {
    saveToken(dir, pasted); assert.equal(fsm.readFileSync(pathm.join(dir, 'telegram.token'), 'utf8').trim(), tok, JSON.stringify(pasted.slice(0, 12)));
  }
  assert.throws(() => saveToken(dir, '12345:short'), /isn't a bot token/);
});

test('T1c: the token field is a one-line textarea (AutoFill cannot swap in a saved password; the paste keeps its line breaks)', async () => {
  const fsm = await import('node:fs'); const pathm = await import('node:path');
  const app = fsm.readFileSync(pathm.join(import.meta.dirname, '../../ui/app.js'), 'utf8');
  assert.match(app, /const tok = h\('textarea', \{ rows: '1', class: 'input2 token-field', placeholder: 'Paste the bot token from @BotFather', autocomplete: 'off'/);
});

test('T1d: a paste that wraps mid-token (newline inside it) and the full BotFather message both give the exact token', async () => {
  const fsm = await import('node:fs'); const os = await import('node:os'); const pathm = await import('node:path');
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'tgw-')); const head = '1234567890:AAHvABCDEFGHIJKLMNO'; const tail = 'PQRSTUVWXYZab_cd';   // 19 + 16 = 35
  const tok = head + tail; assert.equal(tok.split(':')[1].length, 35);
  for (const pasted of [`${head}\n${tail}`, `${head}\r\n${tail}\n`, `Done! Congratulations on your new bot.\n\nUse this token to access the HTTP API:\n${head}\n${tail}\nKeep your token secure and store it safely.`]) {
    saveToken(dir, pasted); assert.equal(fsm.readFileSync(pathm.join(dir, 'telegram.token'), 'utf8').trim(), tok);
  }
});

test('T5: saving a token checks it with getMe at once: a rejected token gives a plain reason, an accepted one names the bot and clears the old error', async () => {
  const fsm = await import('node:fs'); const os = await import('node:os'); const pathm = await import('node:path');
  const { openDatabase } = await import('../../src/db/open.ts'); const { checkToken } = await import('../../src/telegram/bridge.ts');
  const db = openDatabase(':memory:'); const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'tgc-')); saveToken(dir, '1234567890:AAH' + 'x_Y-z'.repeat(6) + 'Ab');
  const reply = (ok: boolean) => (async () => new Response(JSON.stringify(ok ? { ok: true, result: { username: 'claudebot_test_bot' } } : { ok: false, description: 'Unauthorized' }), { status: ok ? 200 : 401 })) as unknown as typeof fetch;
  const bad = await checkToken(db, dir, reply(false)); assert.equal(bad.ok, false); assert.match((bad as { error: string }).error, /not a current token for any bot.*\/token/);
  const good = await checkToken(db, dir, reply(true)); assert.deepEqual(good, { ok: true, bot: '@claudebot_test_bot' });
  assert.equal(JSON.parse((db.prepare("SELECT value FROM runtime_state WHERE key = 'telegram.error'").get() as { value: string }).value).error, null, 'the stale error is cleared');
});

test('T6: Telegram is a command channel through the lead: plain decision cards that close on both sides, lead-only notices, /status, /stop, /approvals; a foreign chat can do nothing', async () => {
  const f = await fakeTelegram(); const s = setup(f.base); saveToken(s.secrets, TOKEN);
  const { code } = newPairingCode(s.db); f.push(msg(1, 777, `/start ${code}`)); await s.bridge.cycle(0);
  const c = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const turn = s.chat.send(c.id, '@researcher email the hiring manager', s.defs).job;
  s.chat.add({ conversation_id: c.id, role: 'assistant', sender: 'researcher', content: 'specialist chatter' });
  s.chat.add({ conversation_id: c.id, role: 'assistant', sender: 'coordinator', content: 'group lead chatter' });
  const tgc = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] }); const tj = linkTelegram(s, tgc.id); s.chat.add({ conversation_id: tgc.id, role: 'assistant', sender: 'coordinator', job_id: tj, content: 'lead summary' });
  const ap = s.approvals.request({ job_id: turn.id, action_kind: 'send', target: 'email to hm@example.test', content: 'To: hm@example.test\nSubject: Channel role\n\nHi Sam,\nThe full body.' });
  s.chat.add({ conversation_id: c.id, role: 'system', kind: 'decision', content: 'decision', approval_id: ap.id, job_id: turn.id });
  f.calls.length = 0; await s.bridge.cycle(0);
  const texts = f.calls.filter((x) => x.method === 'sendMessage').map((x) => String(x.body.text));
  assert.ok(texts.some((t) => t.includes('lead summary'))); assert.ok(!texts.some((t) => t.includes('specialist chatter')), 'only the lead talks on Telegram'); assert.ok(!texts.some((t) => t.includes('group lead chatter')), 'group work shows in the group, not on Telegram');
  const card = f.calls.find((x) => x.method === 'sendMessage' && x.body.reply_markup)!;
  assert.match(String(card.body.text), /wants to send this email\. Allow it\?/); assert.ok(!/fingerprint|Expires|https?:\/\/|conv-|job-|apr-/.test(String(card.body.text)), 'no ids, fingerprint, expiry or links'); assert.match(String(card.body.text), /Subject: Channel role\n\nHi Sam,\nThe full body\./, 'the full email copy');
  // decided in the app: the Telegram card loses its buttons and says so
  s.approvals.decide(ap.id, 'rejected', 'owner'); f.calls.length = 0; await s.bridge.cycle(0);
  assert.ok(f.calls.some((x) => x.method === 'editMessageReplyMarkup')); assert.ok(f.calls.some((x) => x.method === 'sendMessage' && /^Denied/.test(String(x.body.text))));
  // commands: /status lists open tasks; /stop 1 cancels; a foreign chat is refused
  const job = s.store.create({ idempotency_key: 'k1', kind: 'research.report', objective: 'Find remote roles', success_contract: {}, agent_role: 'researcher', workspace_id: s.ws.id }, 'owner').job;
  f.calls.length = 0; f.push(msg(2, 999, '/stop 1')); f.push(msg(3, 777, '/status')); await s.bridge.cycle(0);
  assert.equal(s.store.get(job.id)!.state, 'queued', 'a stranger cannot stop work');
  assert.ok(f.calls.some((x) => x.method === 'sendMessage' && /1\. .*Find remote roles/.test(String(x.body.text))));
  f.push(msg(4, 777, '/stop 1')); await s.bridge.cycle(0); assert.equal(s.store.get(job.id)!.state, 'cancelled');
  // /approvals resends a pending decision with fresh buttons
  const ap2 = s.approvals.request({ job_id: turn.id, action_kind: 'send', target: 'email to a@example.test', content: 'To: a@example.test\nSubject: x\n\nbody' });
  s.chat.add({ conversation_id: c.id, role: 'system', kind: 'decision', content: 'decision', approval_id: ap2.id, job_id: turn.id }); await s.bridge.cycle(0);
  f.calls.length = 0; f.push(msg(5, 777, '/approvals')); await s.bridge.cycle(0);
  assert.equal(f.calls.filter((x) => x.method === 'sendMessage' && x.body.reply_markup).length, 1);
  f.close();
});

test('T7: quiet hours send nothing (held, never sent later) and test projects never reach Telegram', async () => {
  const f = await fakeTelegram(); const s = setup(f.base); saveToken(s.secrets, TOKEN);
  const { code } = newPairingCode(s.db); f.push(msg(1, 777, `/start ${code}`)); await s.bridge.cycle(0);
  const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] }); const tj = linkTelegram(s, c.id);
  s.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('telegram.quiet_until', ?, '{}', ?)").run(JSON.stringify({ until: new Date(Date.now() + 3600_000).toISOString() }), new Date().toISOString());
  s.chat.add({ conversation_id: c.id, role: 'assistant', sender: 'coordinator', job_id: tj, content: 'night news' }); f.calls.length = 0; await s.bridge.cycle(0);
  assert.ok(!f.calls.some((x) => x.method === 'sendMessage' && String(x.body.text).includes('night news')), 'nothing during quiet hours');
  s.db.prepare("DELETE FROM runtime_state WHERE key = 'telegram.quiet_until'").run(); await s.bridge.cycle(0);
  assert.ok(!f.calls.some((x) => x.method === 'sendMessage' && String(x.body.text).includes('night news')), 'held notices are not sent later');
  const ws2 = new Workspaces(s.db, path.join(os.tmpdir(), `tg-ws-${Date.now()}`)).create({ name: 'Test project', policies: { telegram: false } }, 'test');
  const c2 = s.chat.create({ workspace_id: ws2.id, type: 'direct', members: ['coordinator'] }); s.chat.add({ conversation_id: c2.id, role: 'assistant', sender: 'coordinator', content: 'rehearsal chatter' });
  s.chat.add({ conversation_id: c.id, role: 'assistant', sender: 'coordinator', job_id: tj, content: 'real morning news' }); f.calls.length = 0; await s.bridge.cycle(0);
  const texts = f.calls.filter((x) => x.method === 'sendMessage').map((x) => String(x.body.text)); assert.ok(texts.some((x) => x.includes('real morning news'))); assert.ok(!texts.some((x) => x.includes('rehearsal chatter')));
  f.close();
});

test('T8: when quiet hours end, one good-morning summary goes out and decisions still waiting arrive as cards; held chatter stays in the app; /status answers', async () => {
  const f = await fakeTelegram(); const s = setup(f.base); saveToken(s.secrets, TOKEN);
  const { code } = newPairingCode(s.db); f.push(msg(1, 777, `/start ${code}`)); await s.bridge.cycle(0);
  const c = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] }); const tj8 = linkTelegram(s, c.id);
  const turn = s.chat.send(c.id, 'apply to the Dragos role', s.defs).job;
  const setQuiet = (ms: number) => s.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES ('telegram.quiet_until', ?, '{}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ until: new Date(Date.now() + ms).toISOString() }), new Date().toISOString());
  setQuiet(3600_000);
  s.chat.add({ conversation_id: c.id, role: 'assistant', sender: 'coordinator', job_id: tj8, content: 'night news' });
  const open = s.approvals.request({ job_id: turn.id, action_kind: 'send', target: 'email to hm@example.test', content: 'To: hm@example.test\nSubject: Follow-up\n\nHi.' });
  s.chat.add({ conversation_id: c.id, role: 'system', kind: 'decision', content: 'decision', approval_id: open.id, job_id: turn.id });
  const gone = s.approvals.request({ job_id: turn.id, action_kind: 'send', target: 'email to other@example.test', content: 'To: other@example.test\nSubject: Old\n\nHi.' });
  s.chat.add({ conversation_id: c.id, role: 'system', kind: 'decision', content: 'decision', approval_id: gone.id, job_id: turn.id });
  f.calls.length = 0; await s.bridge.cycle(0);
  assert.equal(f.calls.filter((x) => x.method === 'sendMessage').length, 0, 'nothing during quiet hours');
  s.approvals.decide(gone.id, 'rejected', 'owner');   // decided in the app overnight
  setQuiet(-1000); f.calls.length = 0; await s.bridge.cycle(0);
  const texts = f.calls.filter((x) => x.method === 'sendMessage').map((x) => String(x.body.text));
  assert.equal(texts.filter((t) => t.startsWith('Good morning. Quiet hours are over.')).length, 1);
  assert.match(texts.find((t) => t.startsWith('Good morning'))!, /held 3 updates.*1 decision waits on you/);
  assert.equal(f.calls.filter((x) => x.method === 'sendMessage' && x.body.reply_markup).length, 1); assert.ok(texts.some((t) => t.includes('Subject: Follow-up')), 'the waiting card');
  assert.ok(!texts.some((t) => t.includes('night news') || t.includes('Subject: Old')), 'held chatter and settled decisions stay in the app');
  f.calls.length = 0; await s.bridge.cycle(0); assert.ok(!f.calls.some((x) => x.method === 'sendMessage' && String(x.body.text).startsWith('Good morning')), 'the summary goes once');
  s.store.create({ idempotency_key: 'k8', kind: 'research.report', objective: 'Apply to Dragos', success_contract: {}, agent_role: 'researcher', workspace_id: s.ws.id }, 'owner');
  // a quiet night: the summary still says ClaudeBot is live, once
  setQuiet(60_000); await s.bridge.cycle(0); setQuiet(-500); f.calls.length = 0; await s.bridge.cycle(0); await s.bridge.cycle(0);
  assert.deepEqual(f.calls.filter((x) => x.method === 'sendMessage').map((x) => String(x.body.text)).filter((t) => t.startsWith('Good morning')), ['Good morning. Quiet hours are over. Nothing came in overnight. Nothing needs you. Send /status for what is running.']);
  f.push(msg(2, 777, '/status')); f.calls.length = 0; await s.bridge.cycle(0);
  assert.ok(f.calls.some((x) => x.method === 'sendMessage' && /Apply to Dragos/.test(String(x.body.text))));
  f.close();
});

test('T9: a browser decision card is one plain sentence (no page address, fingerprint or expiry)', async () => {
  const { describeApproval } = await import('../../src/approvals/describe.ts');
  const v = describeApproval({ action_kind: 'send', target: 'x', content: JSON.stringify({ url: 'https://magnitudesoftware.wd1.myworkdayjobs.com/en-US/External/job/apply/applyManually', action: 'press', key: 'Enter', element: { role: 'textbox', name: 'How Did You Hear About Us?' } }) });
  assert.equal(v.text, 'press Enter in "How Did You Hear About Us?" on magnitudesoftware.wd1.myworkdayjobs.com');
});

test('T10: routine progress never goes to Telegram: assistants\' updates, group replies and team-record lines stay in the app', async () => {
  const f = await fakeTelegram(); const s = setup(f.base); saveToken(s.secrets, TOKEN);
  const { code } = newPairingCode(s.db); f.push(msg(1, 777, `/start ${code}`)); await s.bridge.cycle(0);
  const g = s.chat.create({ workspace_id: s.ws.id, type: 'group', members: ['coordinator', 'researcher'] });
  const tgc = s.chat.create({ workspace_id: s.ws.id, type: 'direct', members: ['coordinator'] }); const tj = linkTelegram(s, tgc.id);
  s.chat.add({ conversation_id: tgc.id, role: 'assistant', sender: 'coordinator', job_id: tj, content: 'progress line', meta: { update: true } });
  s.chat.add({ conversation_id: g.id, role: 'assistant', sender: 'coordinator', content: 'group reply' });
  s.chat.add({ conversation_id: g.id, role: 'system', kind: 'activity', content: 'From Telegram · You: start' });
  s.chat.add({ conversation_id: tgc.id, role: 'assistant', sender: 'coordinator', job_id: tj, content: 'Two applications are in.' });
  const auto = s.store.create({ idempotency_key: 'auto-r', kind: 'chat.turn', objective: 'Automatic report', success_contract: {}, agent_role: 'coordinator', workspace_id: null, inputs: { conversation_id: tgc.id, automatic: true } } as never, 'engine').job;
  s.chat.add({ conversation_id: tgc.id, role: 'assistant', sender: 'coordinator', job_id: auto.id, content: 'Routine automatic report.' });
  const rj = s.store.create({ idempotency_key: 'apply-1', kind: 'chat.turn', objective: 'apply', success_contract: {}, agent_role: 'researcher', workspace_id: s.ws.id } as never, 'owner').job; s.store.event(rj.id, 'agent:researcher', 'application.verified', { company: 'Dragos', role: 'Senior CSM' });
  f.calls.length = 0; await s.bridge.cycle(0);
  const texts = f.calls.filter((x) => x.method === 'sendMessage').map((x) => String(x.body.text));
  assert.deepEqual(texts.sort(), ['Applied: Dragos, Senior CSM. Confirmation page seen and receipt saved.', 'Two applications are in.'], 'only the reply to their Telegram message and the verified receipt; never a routine automatic report');
  f.close();
});
