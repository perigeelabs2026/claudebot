/**
 * Telegram bridge (long polling; no public webhook is needed on a Mac). Owner-only:
 * - the bot token lives in secrets/telegram.token (0600), set by the owner in the app, never logged or returned;
 * - exactly one Telegram chat is bound, by the owner sending `/start <code>` with a one-time pairing code shown in the app;
 *   every other chat is ignored and the refusal is logged;
 * - each update is processed once (update_id), each notice is sent once (message id), so restarts never duplicate.
 * Inbound owner text goes to the conversation the owner replied to, else the latest chat with the Chief of Staff.
 * Outbound: assistant replies, results and decisions from conversations. Decision notices carry Allow once / Deny buttons
 * bound to the same approval record and its content hash; a changed draft makes the button refuse.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../db/open.ts';
import { now } from '../jobs/store.ts';
import type { ApprovalStore } from '../approvals/store.ts';
import type { ChatStore } from '../chat/store.ts';
import type { Definitions } from '../model/definitions.ts';
import type { JobStore } from '../jobs/store.ts';

export interface TgDeps { db: DB; secretsDir: string; apiBase?: string; chat: ChatStore; approvals: ApprovalStore; defs: Definitions; store: JobStore; defaultWorkspace: () => string; fetchImpl?: typeof fetch; onChange?: (conversationId: string) => void; log?: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void } }
const KEY_BIND = 'telegram.binding'; const KEY_PAIR = 'telegram.pairing'; const KEY_OFFSET = 'telegram.offset'; const KEY_SINCE = 'telegram.notify_since';

const rs = (db: DB, key: string): Record<string, unknown> | null => { const r = db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as { value: string } | undefined; try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
const setRs = (db: DB, key: string, value: unknown, evidence = 'telegram bridge') => db.prepare('INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at').run(key, JSON.stringify(value), evidence, now());
const ev = (db: DB, type: string, detail: unknown) => db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(now(), 'telegram', type, JSON.stringify(detail));

export function tokenPath(secretsDir: string) { return path.join(secretsDir, 'telegram.token'); }
export function hasToken(secretsDir: string): boolean { try { return fs.readFileSync(tokenPath(secretsDir), 'utf8').trim().length > 0; } catch { return false; } }
/** Owner action in the app. The token is validated for shape only here; the bridge checks it with getMe. */
export function saveToken(secretsDir: string, token: string): void {
  // Pasting from Telegram often brings invisible characters (zero-width, no-break spaces, line breaks) or the surrounding message text:
  // remove those and take the one token-shaped run (digits:35 letters, digits, _ or -).
  const raw = String(token).replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  // Bot tokens never contain whitespace. From the full BotFather message take what follows "Use this token to access the HTTP API:" up to
  // "Keep your token"; otherwise the paste is just the token. Either way remove every space and line break (a paste can wrap mid-token).
  const m = /Use this token to access the HTTP API:?([\s\S]*?)(?:Keep your token|For a description|$)/i.exec(raw);
  const cleaned = (m ? m[1] : raw).replace(/[\u00A0\s]+/g, '');
  const found = cleaned.match(/(?:^|[^\d])(\d{5,}:[A-Za-z0-9_-]{30,})(?![A-Za-z0-9_-])/);
  if (!found) throw new Error(`That isn't a bot token. A token from @BotFather is digits, a colon, then about 35 letters and numbers; what arrived was ${cleaned.length} characters${cleaned.includes(':') ? '' : ' with no colon'}. Copy just the line under "Use this token to access the HTTP API".`);   /* says why, never echoes the value */
  const t = found[1];
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(tokenPath(secretsDir), t + '\n', { mode: 0o600 }); fs.chmodSync(tokenPath(secretsDir), 0o600);
}
/** Right after a save: ask Telegram who the bot is (getMe), and record the answer so Settings never shows a stale error. The token is never logged. */
export async function checkToken(db: DB, secretsDir: string, fetchImpl: typeof fetch = fetch, apiBase = 'https://api.telegram.org'): Promise<{ ok: true; bot: string } | { ok: false; error: string }> {
  let tok = ''; try { tok = fs.readFileSync(tokenPath(secretsDir), 'utf8').trim(); } catch { return { ok: false, error: 'No token saved.' }; }
  try {
    const res = await fetchImpl(`${apiBase}/bot${tok}/getMe`, { method: 'POST', signal: AbortSignal.timeout(8000) }); const j = await res.json() as { ok: boolean; result?: { username?: string }; description?: string };
    if (j.ok) { const bot = `@${j.result?.username ?? 'bot'}`; setRs(db, 'telegram.error', { error: null, at: now() }); setRs(db, 'telegram.bot', { bot, at: now() }); return { ok: true, bot }; }
    const error = /unauthorized/i.test(j.description ?? '') || res.status === 401 ? 'Telegram rejected this token: it is not a current token for any bot. Get a fresh one from @BotFather (send /token, pick your bot) and paste it here.' : `Telegram said: ${j.description ?? res.status}`;
    setRs(db, 'telegram.error', { error, at: now() }); db.prepare("DELETE FROM runtime_state WHERE key = 'telegram.bot'").run(); return { ok: false, error };
  } catch (e) { const error = `Telegram could not be reached (${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}). Check the internet connection and save again.`; setRs(db, 'telegram.error', { error, at: now() }); return { ok: false, error }; }
}
export function newPairingCode(db: DB): { code: string; expires_at: string } {
  const code = crypto.randomInt(100000, 999999).toString(); const expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
  setRs(db, KEY_PAIR, { hash: crypto.createHash('sha256').update(code).digest('hex'), expires_at }); return { code, expires_at };
}
export function binding(db: DB): { chat_id: string; user: string; bound_at: string } | null { return rs(db, KEY_BIND) as never; }
export function unbind(db: DB): void { db.prepare('DELETE FROM runtime_state WHERE key = ?').run(KEY_BIND); ev(db, 'telegram.unbound', {}); }

export class TelegramBridge {
  private d: TgDeps; private running = false;
  constructor(d: TgDeps) { this.d = d; }
  private token(): string | null { try { return fs.readFileSync(tokenPath(this.d.secretsDir), 'utf8').trim() || null; } catch { return null; } }
  private async api<T = unknown>(method: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<T> {
    const tok = this.token(); if (!tok) throw new Error('no bot token');
    const res = await (this.d.fetchImpl ?? fetch)(`${this.d.apiBase ?? 'https://api.telegram.org'}/bot${tok}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const j = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`); return j.result as T;
  }
  lastError: string | null = null;
  status(): { configured: boolean; bound: boolean; chat: string | null } { const b = binding(this.d.db); return { configured: !!this.token(), bound: !!b, chat: b ? b.user : null }; }

  /** One long-poll cycle: read updates after the stored offset, process each once, then send pending notices. */
  async cycle(pollSeconds = 25): Promise<{ updates: number; sent: number }> {
    if (!this.token()) return { updates: 0, sent: 0 };
    const offset = Number((rs(this.d.db, KEY_OFFSET) as { offset?: number } | null)?.offset ?? 0);
    const ups = await this.api<Array<Record<string, unknown>>>('getUpdates', { offset, timeout: pollSeconds, allowed_updates: ['message', 'callback_query'] }, (pollSeconds + 10) * 1000);
    for (const u of ups) {
      const id = Number(u.update_id);
      if (!this.d.db.prepare('SELECT 1 FROM telegram_updates WHERE update_id = ?').get(id)) {
        let outcome = 'ignored'; try { outcome = await this.handle(u); } catch (e) { outcome = `error: ${(e as Error).message.slice(0, 120)}`; }
        this.d.db.prepare('INSERT OR IGNORE INTO telegram_updates(update_id, processed_at, outcome) VALUES (?,?,?)').run(id, now(), outcome);
      }
      setRs(this.d.db, KEY_OFFSET, { offset: id + 1 });
    }
    const sent = await this.flush();
    return { updates: ups.length, sent };
  }

  private async handle(u: Record<string, unknown>): Promise<string> {
    const db = this.d.db; const b = binding(db);
    const cb = u.callback_query as { id: string; data?: string; from?: { id: number }; message?: { chat: { id: number } } } | undefined;
    if (cb) {
      const chatId = String(cb.message?.chat.id ?? cb.from?.id ?? '');
      if (!b || chatId !== b.chat_id) { ev(db, 'telegram.refused', { reason: 'button from an unbound chat' }); await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not allowed.' }).catch(() => {}); return 'refused:unbound'; }
      const m = /^ap:([A-Za-z0-9_-]+):([0-9a-f]{12}):(allow|deny)$/.exec(String(cb.data ?? ''));
      if (!m) { await this.api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unknown button.' }).catch(() => {}); return 'ignored:button'; }
      const ap = this.d.approvals.get(m[1]); let text: string;
      if (!ap || ap.status !== 'pending') text = ap ? `Already ${ap.status}.` : 'Not found.';
      else if (!ap.content_hash.startsWith(m[2])) text = 'The draft changed since this message; open it in the app.';
      else {
        this.d.approvals.decide(ap.id, m[3] === 'allow' ? 'approved' : 'rejected', 'owner', m[3] === 'allow' ? 'allowed from the bound Telegram chat' : 'denied from the bound Telegram chat');
        if (ap.job_id) { const j = this.d.store.get(ap.job_id); if (j && j.state === 'waiting_for_approval') this.d.store.transition(j.id, 'queued', 'owner', { waiting_on: null, blocker_code: null, operator_action: null, next_action: 'resume after owner decision' }, { approval: ap.id, via: 'telegram' }); }
        if (m[3] === 'allow') this.d.chat.resumeForApproval(ap.id, this.d.defs);
        ev(db, 'telegram.decided', { approval: ap.id, decision: m[3] }); text = m[3] === 'allow' ? 'Allowed once.' : 'Denied.';
        const conv = ap.job_id ? (db.prepare('SELECT conversation_id FROM jobs WHERE id = ?').get(ap.job_id) as { conversation_id: string | null } | undefined)?.conversation_id : null; if (conv) this.d.onChange?.(conv);
      }
      await this.api('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
      return `button:${text}`;
    }
    const msg = u.message as { message_id: number; chat: { id: number; type: string }; from?: { id: number; username?: string; first_name?: string }; text?: string; reply_to_message?: { message_id: number } } | undefined;
    if (!msg || typeof msg.text !== 'string') return 'ignored:not text';
    const chatId = String(msg.chat.id); const text = msg.text.trim();
    const start = /^\/start(?:@\w+)?\s+(\d{6})$/.exec(text);
    if (/^\/start(?:@\w+)?$/.test(text) && !(b && chatId === b.chat_id)) { await this.api('sendMessage', { chat_id: chatId, text: 'To connect, open ClaudeBot > Settings > Telegram, press Connect my chat, and send /start with the 6-digit code it shows.' }).catch(() => {}); return 'help:start'; }
    if (start) {
      const p = rs(db, KEY_PAIR) as { hash?: string; expires_at?: string } | null;
      const ok = msg.chat.type === 'private' && !!p?.hash && p.expires_at! > now() && crypto.timingSafeEqual(Buffer.from(p.hash!), Buffer.from(crypto.createHash('sha256').update(start[1]).digest('hex')));
      if (!ok) { ev(db, 'telegram.refused', { reason: 'bad or expired pairing code' }); await this.api('sendMessage', { chat_id: chatId, text: 'That pairing code is not valid. Make a new one in ClaudeBot Settings.' }).catch(() => {}); return 'refused:pairing'; }
      db.prepare('DELETE FROM runtime_state WHERE key = ?').run(KEY_PAIR);
      setRs(db, KEY_BIND, { chat_id: chatId, user: msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name ?? 'owner'), bound_at: now() }); setRs(db, KEY_SINCE, { since: now() });
      ev(db, 'telegram.bound', { user: msg.from?.username ?? null });
      await this.api('sendMessage', { chat_id: chatId, text: 'Connected to ClaudeBot. Messages you send here go to your Chief of Staff; replies and decisions come back here.' });
      return 'bound';
    }
    if (!b || chatId !== b.chat_id) { ev(db, 'telegram.refused', { reason: 'message from an unbound chat' }); return 'refused:unbound'; }
    if (text.startsWith('/')) return 'ignored:command';
    // Route: a reply to one of our notices goes to that conversation; otherwise the latest direct chat with the Chief of Staff.
    let conv: string | null = null;
    if (msg.reply_to_message) conv = (db.prepare('SELECT m.conversation_id FROM telegram_outbox o JOIN messages m ON m.id = o.message_id WHERE o.tg_message_id = ? AND o.chat_id = ?').get(msg.reply_to_message.message_id, chatId) as { conversation_id: string } | undefined)?.conversation_id ?? null;
    if (!conv) conv = (db.prepare("SELECT c.id FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.status = 'active' AND c.type = 'direct' AND cm.agent_id = 'coordinator' ORDER BY c.updated_at DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
    if (!conv) conv = this.d.chat.create({ workspace_id: this.d.defaultWorkspace(), type: 'direct', members: ['coordinator'] }).id;
    const r = this.d.chat.send(conv, text, this.d.defs, 'owner', { source: 'telegram', telegram_message_id: msg.message_id });
    this.d.db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.message.id, chatId, msg.message_id, 'inbound', now());
    this.d.onChange?.(conv); return 'routed';
  }

  /** Send each new assistant reply, result and decision once, to the bound chat. */
  async flush(limit = 20): Promise<number> {
    const db = this.d.db; const b = binding(db); if (!b) return 0;
    const since = String((rs(db, KEY_SINCE) as { since?: string } | null)?.since ?? now());
    const rows = db.prepare(`SELECT m.id, m.conversation_id, m.kind, m.role, m.sender, m.content, m.approval_id, c.title, c.type FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.created_at >= ? AND ((m.role = 'assistant' AND m.kind = 'text') OR m.kind IN ('result','decision')) AND NOT EXISTS (SELECT 1 FROM telegram_outbox o WHERE o.message_id = m.id) ORDER BY m.created_at LIMIT ?`).all(since, limit) as Array<{ id: string; conversation_id: string; kind: string; role: string; sender: string; content: string; approval_id: string | null; title: string; type: string }>;
    let n = 0;
    for (const r of rows) {
      const who = this.d.defs.getAgent(r.sender)?.name ?? (r.kind === 'result' ? 'Result' : 'ClaudeBot'); const where = r.title ? ` · ${r.title}` : '';
      let body: Record<string, unknown>;
      if (r.kind === 'decision' && r.approval_id) {
        const ap = this.d.approvals.get(r.approval_id); if (!ap || ap.status !== 'pending') { db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.id, b.chat_id, null, 'skipped', now()); continue; }
        const text = `Needs your decision${where}\n${ap.action_kind} → ${ap.target.replace(/^email to /, '')}\n\n${ap.content.slice(0, 3000)}\n\nfingerprint ${ap.content_hash.slice(0, 12)}`;
        body = { chat_id: b.chat_id, text, reply_markup: { inline_keyboard: [[{ text: 'Allow once', callback_data: `ap:${ap.id}:${ap.content_hash.slice(0, 12)}:allow` }, { text: 'Deny', callback_data: `ap:${ap.id}:${ap.content_hash.slice(0, 12)}:deny` }]] } };
      } else body = { chat_id: b.chat_id, text: `${who}${where}\n${r.content.slice(0, 3500)}` };
      // Approvals from a group are private by nature here: the bound chat is the owner's own.
      const sentMsg = await this.api<{ message_id: number }>('sendMessage', body);
      db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.id, b.chat_id, sentMsg.message_id, r.kind, now()); n++;
    }
    return n;
  }

  /** Run the long-poll loop until stopped; backs off on errors (never logs the token). */
  async run(isStopped: () => boolean): Promise<void> {
    if (this.running) return; this.running = true; let backoff = 2000;
    try { while (!isStopped()) { if (!this.token()) { await new Promise((r) => setTimeout(r, 10_000)); continue; } try { await this.cycle(); backoff = 2000; this.lastError = null; setRs(this.d.db, 'telegram.error', { error: null, at: now() }); } catch (e) { this.lastError = (e as Error).message.replace(/bot\d+:[\w-]+/g, 'bot<token>'); setRs(this.d.db, 'telegram.error', { error: this.lastError, at: now() }); this.d.log?.warn('telegram cycle failed', { err: (e as Error).message.replace(/bot\d+:[\w-]+/g, 'bot<token>') }); await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(60_000, backoff * 2); } } } finally { this.running = false; }
  }
}
