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
  const notice = f.calls.filter((c) => c.method === 'sendMessage').pop()!; assert.match(String(notice.body.text), /Chief of Staff[\s\S]*Two things need you\./);
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
