import { bankKnows } from '../memory/answer-bank.ts';
import { classifyBlocked } from '../cos/owner-needs.ts';
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
import { describeApproval } from '../approvals/describe.ts';
import { cancelDescendants } from '../coord/delegation.ts';
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
    if (method === 'sendMessage' || method === 'editMessageText') body = { link_preview_options: { is_disabled: true }, ...body };   // no giant link previews under a message
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
      const now2 = this.d.approvals.get(m[1]); const tgId = (cb.message as { message_id?: number } | undefined)?.message_id;
      if (now2 && now2.status !== 'pending' && tgId) { await this.closeDecision(chatId, tgId, now2.status, now2.decided_by ?? null).catch(() => {}); db.prepare("UPDATE telegram_outbox SET kind = 'decision-closed' WHERE chat_id = ? AND tg_message_id = ?").run(chatId, tgId); }
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
    if (text.startsWith('/')) return this.command(chatId, text);
    // Route: a reply to one of our notices goes to that conversation; otherwise the latest direct chat with the Chief of Staff.
    let conv: string | null = null;
    if (msg.reply_to_message) conv = (db.prepare('SELECT m.conversation_id FROM telegram_outbox o JOIN messages m ON m.id = o.message_id WHERE o.tg_message_id = ? AND o.chat_id = ?').get(msg.reply_to_message.message_id, chatId) as { conversation_id: string } | undefined)?.conversation_id ?? null;
    if (!conv) conv = (db.prepare("SELECT c.id FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.status = 'active' AND c.type = 'direct' AND cm.agent_id = 'coordinator' ORDER BY c.updated_at DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
    if (!conv) conv = this.d.chat.create({ workspace_id: this.d.defaultWorkspace(), type: 'direct', members: ['coordinator'] }).id;
    const r = this.d.chat.send(conv, text, this.d.defs, 'owner', { source: 'telegram', telegram_message_id: msg.message_id });
    this.d.db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.message.id, chatId, msg.message_id, 'inbound', now());
    this.d.onChange?.(conv); return 'routed';
  }

  /** Owner commands from the bound chat. Everything else is plain language to the Chief of Staff, who can do what the app can. */
  private async command(chatId: string, text: string): Promise<string> {
    const db = this.d.db; const [cmd, ...rest] = text.replace(/@\w+/, '').split(/\s+/); const arg = rest.join(' ').trim();
    const say = (t: string) => this.api('sendMessage', { chat_id: chatId, text: t.slice(0, 4000) }).catch(() => {});
    const live = () => db.prepare("SELECT id, agent_role, objective, state FROM jobs WHERE state IN ('queued','leased','running','retry_scheduled','waiting_for_approval') AND kind NOT IN ('chat.turn','owner.upload') ORDER BY created_at").all() as Array<{ id: string; agent_role: string; objective: string; state: string }>;
    const name = (id: string) => this.d.defs.getAgent(id)?.name ?? id;
    if (cmd === '/help') { await say('Talk to your Chief of Staff in plain words: assign or redirect work, rename or create assistants, ask for files or status.\n/status: what is running and waiting\n/approvals: decisions waiting, with buttons\n/stop <number>: stop a task from /status'); return 'command:help'; }
    if (cmd === '/status') {
      const tasks = live(); const pend = (db.prepare("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
      await say(tasks.length ? `${tasks.length} task${tasks.length > 1 ? 's' : ''} open, ${pend} decision${pend === 1 ? '' : 's'} waiting:\n${tasks.slice(0, 15).map((j, i) => `${i + 1}. ${name(j.agent_role)}: ${j.objective.replace(/\s+/g, ' ').slice(0, 90)} (${j.state.replace(/_/g, ' ')})`).join('\n')}\nStop one with /stop <number>.` : `Nothing running. ${pend} decision${pend === 1 ? '' : 's'} waiting.`); return 'command:status';
    }
    if (cmd === '/approvals') {
      const pend = db.prepare("SELECT m.id FROM messages m JOIN approvals a ON a.id = m.approval_id WHERE m.kind = 'decision' AND a.status = 'pending'").all() as Array<{ id: string }>;
      if (!pend.length) { await say('No decisions are waiting.'); return 'command:approvals'; }
      db.prepare(`DELETE FROM telegram_outbox WHERE chat_id = ? AND kind IN ('decision','skipped') AND message_id IN (${pend.map(() => '?').join(',')})`).run(chatId, ...pend.map((p) => p.id));   // send each again, with fresh buttons
      const n = await this.flush(50, pend.map((p) => p.id)); return `command:approvals:${n}`;
    }
    if (cmd === '/stop') {
      const tasks = live(); const k = Number(arg); const j = Number.isInteger(k) && k >= 1 ? tasks[k - 1] : undefined;
      if (!j) { await say(tasks.length ? 'Which one? Send /status, then /stop <number>.' : 'Nothing is running.'); return 'command:stop:none'; }
      this.d.store.transition(j.id, 'cancelled', 'owner', { next_action: null }, { by: 'owner', via: 'telegram' }); const kids = cancelDescendants(db, this.d.store, j.id, 'owner', 'parent task stopped by the owner');
      ev(db, 'telegram.stopped', { job: j.id, children: kids.length }); await say(`Stopped: ${name(j.agent_role)}: ${j.objective.replace(/\s+/g, ' ').slice(0, 90)}.`); this.d.onChange?.(''); return 'command:stop';
    }
    await say('Unknown command. Send /help, or just tell your Chief of Staff what you want.'); return 'command:unknown';
  }

  /** Send the lead's important updates once, to the bound chat: its replies in the Telegram conversation, decision cards and files it sends
   *  there (Telegram is reserved for the lead's important updates; all work shows in the group chat instead). */
  async flush(limit = 20, onlyIds: string[] | null = null): Promise<number> {
    const db = this.d.db; const b = binding(db); if (!b) return 0;
    const since = String((rs(db, KEY_SINCE) as { since?: string } | null)?.since ?? now());
    // Quiet hours over: one short good-morning summary, once per quiet window; decisions still waiting are sent again as cards (other held notices stay in the app).
    let n = 0; const quietTill = String((rs(db, 'telegram.quiet_until') as { until?: string } | null)?.until ?? '');
    if (!onlyIds && quietTill && quietTill <= now() && String((rs(db, 'telegram.quiet_summary') as { for?: string } | null)?.for ?? '') !== quietTill) {
      const held = db.prepare("SELECT o.message_id, m.kind, m.approval_id FROM telegram_outbox o JOIN messages m ON m.id = o.message_id WHERE o.kind = 'held-quiet' AND o.chat_id = ?").all(b.chat_id) as Array<{ message_id: string; kind: string; approval_id: string | null }>;
      const waiting = held.filter((x) => x.kind === 'decision' && x.approval_id && this.d.approvals.get(x.approval_id)?.status === 'pending');
      setRs(db, 'telegram.quiet_summary', { for: quietTill, held: held.length, waiting: waiting.length, at: now() });   // recorded first: a failed send never repeats the summary
      db.prepare("UPDATE telegram_outbox SET kind = 'held-quiet-summarized' WHERE kind = 'held-quiet' AND chat_id = ?").run(b.chat_id);
      for (const w of waiting) db.prepare('DELETE FROM telegram_outbox WHERE message_id = ? AND chat_id = ?').run(w.message_id, b.chat_id);
      {   // always one line when quiet ends, so the owner knows ClaudeBot is live
        const text = `Good morning. Quiet hours are over. ${held.length ? `While you slept I held ${held.length} update${held.length === 1 ? '' : 's'} here; everything is in the app.` : 'Nothing came in overnight.'}${waiting.length ? ` ${waiting.length} decision${waiting.length === 1 ? ' waits' : 's wait'} on you; ${waiting.length === 1 ? 'the card follows' : 'the cards follow'}.` : ' Nothing needs you.'} Send /status for what is running.`;
        await this.api('sendMessage', { chat_id: b.chat_id, text }).then(() => { n++; }).catch(() => {});
      }
      ev(db, 'telegram.quiet_ended', { held: held.length, waiting: waiting.length });
    }
    // Verified application receipts are important: one plain line each (never during quiet hours or from test projects).
    if (!onlyIds) {
      const quietNow = String((rs(db, 'telegram.quiet_until') as { until?: string } | null)?.until ?? '') > now();
      const recs = db.prepare(`SELECT e.seq, e.detail, w.policies FROM job_events e JOIN jobs j ON j.id = e.job_id LEFT JOIN workspaces w ON w.id = j.workspace_id WHERE e.type = 'application.verified' AND e.at >= ? AND NOT EXISTS (SELECT 1 FROM telegram_outbox o WHERE o.message_id = 'receipt:' || e.seq) ORDER BY e.seq LIMIT 10`).all(since) as Array<{ seq: number; detail: string; policies: string | null }>;
      for (const r of recs) {
        let d: { company?: string; role?: string } = {}; let pol: { telegram?: boolean; dry_run?: boolean } = {}; try { d = JSON.parse(r.detail); pol = JSON.parse(r.policies || '{}'); } catch { /* */ }
        const skip = quietNow || pol.telegram === false || pol.dry_run;
        const sent = skip ? null : await this.api<{ message_id: number }>('sendMessage', { chat_id: b.chat_id, text: `Applied: ${d.company ?? 'a company'}, ${d.role ?? 'a role'}. Confirmation page seen and receipt saved.` }).catch(() => null);
        db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(`receipt:${r.seq}`, b.chat_id, sent?.message_id ?? null, skip ? (quietNow ? 'held-quiet' : 'skipped-test') : 'receipt', now()); if (sent) n++;
      }
    }
    // True blockers that only the owner can clear (a password, a code, a CAPTCHA, a sign-in) are important: one plain line each.
    if (!onlyIds) {
      const quietNow = String((rs(db, 'telegram.quiet_until') as { until?: string } | null)?.until ?? '') > now();
      const blocked = db.prepare(`SELECT j.id, j.agent_role, j.objective, j.failure_detail, j.state, j.waiting_on, w.policies FROM jobs j LEFT JOIN workspaces w ON w.id = j.workspace_id WHERE j.updated_at >= ? AND ((j.state = 'failed_terminal' AND j.blocker_code = 'BLOCKED') OR j.state = 'waiting_for_auth') AND NOT EXISTS (SELECT 1 FROM telegram_outbox o WHERE o.message_id = 'blocker:' || j.id) ORDER BY j.updated_at LIMIT 10`).all(since) as Array<{ id: string; agent_role: string; objective: string; failure_detail: string | null; state: string; waiting_on: string | null; policies: string | null }>;
      for (const j of blocked) {
        let pol: { telegram?: boolean; dry_run?: boolean } = {}; try { pol = JSON.parse(j.policies || '{}'); } catch { /* */ }
        const detail = String(j.failure_detail ?? '').replace(/^blocked: /, ''); const secret = /\b(password|passcode|code|sign[- ]?in|log[- ]?in|purchase|payment|spend)\b/i.test(detail);   // only the owner can type or pay
        const ownerOnly = j.state === 'waiting_for_auth' || /captcha/i.test(detail) || (classifyBlocked({ kind: 'blocker', title: j.objective, detail }) === 'owner' && (secret || !bankKnows(detail)));   // an answer the bank already holds is not his to give
        if (!ownerOnly) { db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(`blocker:${j.id}`, b.chat_id, null, 'skipped-team', now()); continue; }
        const skip = quietNow || pol.telegram === false || pol.dry_run; const who = (this.d.defs.getAgent(j.agent_role)?.name ?? j.agent_role).replace(/\s*\(.*\)$/, '');
        const what = j.state === 'waiting_for_auth' ? `needs you to sign in${j.waiting_on?.startsWith('browser:') ? ` to ${j.waiting_on.slice(8)}` : ''}` : `is stuck on something only you can do: ${detail.replace(/\s+/g, ' ').slice(0, 200)}`;
        const sent = skip ? null : await this.api<{ message_id: number }>('sendMessage', { chat_id: b.chat_id, text: `${who} ${what}. Open ClaudeBot to take over.` }).catch(() => null);
        db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(`blocker:${j.id}`, b.chat_id, sent?.message_id ?? null, skip ? (quietNow ? 'held-quiet' : 'skipped-test') : 'blocker', now()); if (sent) n++;
      }
    }
    const rows = db.prepare(`SELECT m.id, m.conversation_id, m.kind, m.role, m.sender, m.content, m.approval_id, c.title, c.type FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${onlyIds ? `m.id IN (${onlyIds.map(() => '?').join(',')}) AND ? <> ''` : 'm.created_at >= ?'} AND ((m.role = 'assistant' AND m.kind = 'text' AND m.sender = 'coordinator' AND COALESCE(json_extract(m.meta, '$.update'), 0) = 0 AND EXISTS (SELECT 1 FROM jobs jj JOIN telegram_outbox oi ON oi.message_id = json_extract(jj.inputs, '$.message_id') AND oi.kind = 'inbound' WHERE jj.id = m.job_id)) OR m.kind = 'decision') AND NOT EXISTS (SELECT 1 FROM telegram_outbox o WHERE o.message_id = m.id) ORDER BY m.created_at LIMIT ?`).all(...(onlyIds ?? []), since, limit) as Array<{ id: string; conversation_id: string; kind: string; role: string; sender: string; content: string; approval_id: string | null; title: string; type: string }>;
    // Quiet hours (runtime_state telegram.quiet_until) and test projects (workspace policies.telegram === false): nothing is sent;
    // the notice is marked held so it never goes later either.
    const quiet = String((rs(db, 'telegram.quiet_until') as { until?: string } | null)?.until ?? ''); const isQuiet = !onlyIds && quiet > now();
    const testConv = (convId: string) => { try { const w = db.prepare('SELECT w.policies FROM conversations c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?').get(convId) as { policies: string } | undefined; return !!w && (JSON.parse(w.policies || '{}') as { telegram?: boolean }).telegram === false; } catch { return false; } };
    for (const r of rows) {
      { const isTest = testConv(r.conversation_id); if (isTest || isQuiet) { db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.id, b.chat_id, null, isTest ? 'skipped-test' : 'held-quiet', now()); continue; } }
      const who = this.d.defs.getAgent(r.sender)?.name ?? (r.kind === 'result' ? 'Result' : 'ClaudeBot'); const where = r.title ? ` · ${r.title}` : '';
      let body: Record<string, unknown>;
      if (r.kind === 'decision' && r.approval_id) {
        const ap = this.d.approvals.get(r.approval_id); if (!ap || ap.status !== 'pending') { db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.id, b.chat_id, null, 'skipped', now()); continue; }
        const v = describeApproval(ap); const asker = ap.job_id ? (db.prepare('SELECT agent_role FROM jobs WHERE id = ?').get(ap.job_id) as { agent_role: string } | undefined)?.agent_role : undefined;
        // One plain sentence about what will happen, and the email itself when it is an email; no ids, fingerprints, expiry or raw links.
        const askerName = (asker ? this.d.defs.getAgent(asker)?.name : null)?.replace(/\s*\(.*\)$/, '') ?? 'An assistant';
        const text = v.email ? `${askerName} wants to send this email. Allow it?\n\n${v.text.slice(0, 3400)}` : v.browser ? `${askerName} wants to ${v.text}. Allow it?` : `${askerName} wants to ${v.label.toLowerCase()}: ${String(ap.target).replace(/https?:\/\/\S+/g, '').trim().slice(0, 300)}. Allow it?`;
        const keys = v.missingBody ? [{ text: 'Deny', callback_data: `ap:${ap.id}:${ap.content_hash.slice(0, 12)}:deny` }] : [{ text: 'Allow once', callback_data: `ap:${ap.id}:${ap.content_hash.slice(0, 12)}:allow` }, { text: 'Deny', callback_data: `ap:${ap.id}:${ap.content_hash.slice(0, 12)}:deny` }];
        body = { chat_id: b.chat_id, text, reply_markup: { inline_keyboard: [keys] } };
      } else if (r.kind === 'result') {
        const a = db.prepare('SELECT path, title FROM artifacts a JOIN messages m ON m.artifact_id = a.id WHERE m.id = ?').get(r.id) as { path: string | null; title: string } | undefined;
        let sent: { message_id: number } | null = null;
        if (a?.path && fs.existsSync(a.path) && fs.statSync(a.path).size <= 20 * 1024 * 1024) sent = await this.sendDocument(b.chat_id, a.path, a.title).catch(() => null);
        db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.id, b.chat_id, sent?.message_id ?? null, sent ? 'result' : 'skipped', now()); if (sent) n++;
        continue;
      } else body = { chat_id: b.chat_id, text: r.content.slice(0, 3500) };   // the bot is the lead: plain text, no name or chat-title header
      // Approvals from a group are private by nature here: the bound chat is the owner's own.
      const sentMsg = await this.api<{ message_id: number }>('sendMessage', body);
      db.prepare('INSERT OR IGNORE INTO telegram_outbox(message_id, chat_id, tg_message_id, kind, sent_at) VALUES (?,?,?,?,?)').run(r.id, b.chat_id, sentMsg.message_id, r.kind, now()); n++;
    }
    // Decisions answered in the app (or expired) lose their buttons here and say what happened, so both sides always agree.
    for (const o of db.prepare("SELECT o.message_id, o.tg_message_id, m.approval_id FROM telegram_outbox o JOIN messages m ON m.id = o.message_id WHERE o.kind = 'decision' AND o.chat_id = ? AND o.tg_message_id IS NOT NULL").all(b.chat_id) as Array<{ message_id: string; tg_message_id: number; approval_id: string }>) {
      const ap = this.d.approvals.get(o.approval_id); if (!ap || ap.status === 'pending') continue;
      await this.closeDecision(b.chat_id, o.tg_message_id, ap.status, ap.decided_by ?? null).catch(() => {});
      db.prepare("UPDATE telegram_outbox SET kind = 'decision-closed' WHERE message_id = ? AND chat_id = ?").run(o.message_id, b.chat_id);
    }
    return n;
  }
  private async closeDecision(chatId: string, tgId: number, status: string, by: string | null): Promise<void> {
    const word = status === 'approved' || status === 'consumed' ? (String(by ?? '').startsWith('permission:') ? 'Allowed by your standing permission' : 'Allowed') : status === 'rejected' ? 'Denied' : status === 'expired' ? 'Expired: nobody decided in time' : status === 'stale' ? 'Replaced by an edited version' : status;
    await this.api('editMessageReplyMarkup', { chat_id: chatId, message_id: tgId, reply_markup: { inline_keyboard: [] } });
    await this.api('sendMessage', { chat_id: chatId, text: `${word} (${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}).`, reply_to_message_id: tgId });
  }
  private async sendDocument(chatId: string, file: string, caption: string): Promise<{ message_id: number }> {
    const tok = this.token(); if (!tok) throw new Error('no bot token');
    const form = new FormData(); form.append('chat_id', chatId); form.append('caption', caption.slice(0, 1000)); form.append('document', new Blob([fs.readFileSync(file)]), path.basename(file));
    const res = await (this.d.fetchImpl ?? fetch)(`${this.d.apiBase ?? 'https://api.telegram.org'}/bot${tok}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    const j = await res.json() as { ok: boolean; result?: { message_id: number }; description?: string }; if (!j.ok) throw new Error(`telegram sendDocument: ${j.description ?? res.status}`); return j.result!;
  }

  /** Run the long-poll loop until stopped; backs off on errors (never logs the token). */
  async run(isStopped: () => boolean): Promise<void> {
    if (this.running) return; this.running = true; let backoff = 2000;
    try { while (!isStopped()) { if (!this.token()) { await new Promise((r) => setTimeout(r, 10_000)); continue; } try { await this.cycle(); backoff = 2000; this.lastError = null; setRs(this.d.db, 'telegram.error', { error: null, at: now() }); } catch (e) { this.lastError = (e as Error).message.replace(/bot\d+:[\w-]+/g, 'bot<token>'); setRs(this.d.db, 'telegram.error', { error: this.lastError, at: now() }); this.d.log?.warn('telegram cycle failed', { err: (e as Error).message.replace(/bot\d+:[\w-]+/g, 'bot<token>') }); await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(60_000, backoff * 2); } } } finally { this.running = false; }
  }
}
