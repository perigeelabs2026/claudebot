// Executors for approved consequential actions. In this build the only enabled executor is the LOCAL OUTBOX: the exact
// approved content is written to ~/.claudebot/outbox/<kind>/ and nothing leaves this Mac. Real providers (email, social,
// payments) are not implemented; enabling one is an owner decision with its own credentials and an owner-authorised test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Executor } from './store.ts';

export function localOutbox(home: string): Executor {
  return async ({ id, kind, target, content }) => {
    const dir = path.join(home, 'outbox', kind); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.json`);
    const body = JSON.stringify({ action_id: id, kind, target, content, written_at: new Date().toISOString(), note: 'Local outbox: written on this Mac only. Nothing was sent, posted or published anywhere.' }, null, 1);
    fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    return { ok: true, result: { delivered_to: 'local outbox' }, receipt: { executor: 'local_outbox', path: file, sha256, left_this_mac: false } };
  };
}
export const LOCAL_OUTBOX_KINDS = ['send', 'publish'] as const;
