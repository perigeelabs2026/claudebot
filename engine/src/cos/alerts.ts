/**
 * One line in the team group about something that would otherwise stay silent (a refused model, a failure streak, a stalled queue).
 * Each line is posted once per key. owner: true also sends it to the owner's Telegram (telegram/bridge.ts), held during quiet hours.
 */
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import { ChatStore } from '../chat/store.ts';

export function teamLine(db: DB, store: JobStore, line: { key: string; text: string; owner?: boolean; jobId?: string | null; mirrorOf?: string | null }): boolean {
  try {
    const chat = new ChatStore(db, store); const team = chat.teamConversation(); if (!team) return false;
    if (db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND json_extract(meta, '$.alert_key') = ? LIMIT 1").get(team, line.key)) return false;
    chat.add({ conversation_id: team, role: 'system', kind: 'activity', job_id: line.jobId ?? null, content: line.text,
      meta: { alert_key: line.key, ...(line.owner ? { owner_alert: true } : {}), ...(line.mirrorOf ? { mirror_of: line.mirrorOf } : {}) } } as never);
    return true;
  } catch { return false; }
}
