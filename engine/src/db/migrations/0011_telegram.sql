-- Phase 2 gate 6: Telegram bridge. Updates are processed once (by update_id); every outbound notice is sent once (by message id).
CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY, processed_at TEXT NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_outbox (message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, tg_message_id INTEGER, kind TEXT NOT NULL, sent_at TEXT NOT NULL);
