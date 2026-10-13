import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase } from '../../src/db/open.ts';
import { ensureOwnerKey, verifyOwnerPresence, confirmSubject } from '../../src/api/owner-presence.ts';
import { ApprovalStore } from '../../src/approvals/store.ts';

test('owner presence: a fresh signature for exactly this decision is accepted once; replay, wrong action/id, expiry and missing are refused', () => {
  const prev = process.env.CLAUDEBOT_RUNTIME; delete process.env.CLAUDEBOT_RUNTIME;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-')); ensureOwnerKey(dir); const db = openDatabase(':memory:');
    assert.equal(fs.statSync(path.join(dir, 'owner.key')).mode & 0o777, 0o600);
    const key = fs.readFileSync(path.join(dir, 'owner.key')); const now = Date.now(); const ts = String(now);
    const H = 'c'.repeat(64);
    const sign = (action: string, id: string, t = ts, bind = H) => crypto.createHmac('sha256', key).update(`${action}|${id}|${bind}|${t}`).digest('hex');
    const h = (proof: string, t = ts) => ({ 'x-claudebot-owner-proof': proof, 'x-claudebot-owner-ts': t });
    assert.equal(verifyOwnerPresence(db, dir, 'approve', 'apr-1', H, {}, now).ok, false, 'no signature (UI token alone is not enough)');
    assert.equal(verifyOwnerPresence(db, dir, 'execute', 'apr-1', H, h(sign('approve', 'apr-1')), now).ok, false, 'signed for another action');
    assert.equal(verifyOwnerPresence(db, dir, 'approve', 'apr-2', H, h(sign('approve', 'apr-1')), now).ok, false, 'signed for another id');
    const old = String(now - 300_000); assert.equal(verifyOwnerPresence(db, dir, 'approve', 'apr-1', H, h(sign('approve', 'apr-1', old), old), now).ok, false, 'expired');
    assert.equal(verifyOwnerPresence(db, dir, 'approve', 'apr-1', H, h(sign('approve', 'apr-1', ts, 'd'.repeat(64))), now).ok, false, 'signed for other content (the sheet showed something else)');
    assert.equal(verifyOwnerPresence(db, dir, 'approve', 'apr-1', '', h(sign('approve', 'apr-1', ts, '')), now).ok, false, 'no content binding');
    assert.equal(verifyOwnerPresence(db, dir, 'approve', 'apr-1', H, h(sign('approve', 'apr-1')), now).ok, true);
    assert.equal(verifyOwnerPresence(db, dir, 'approve', 'apr-1', H, h(sign('approve', 'apr-1')), now).ok, false, 'single use');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { if (prev !== undefined) process.env.CLAUDEBOT_RUNTIME = prev; }
});

test('owner presence: the confirm subject is read from the engine (full content, stored hash), never from the page', () => {
  const db = openDatabase(':memory:'); const approvals = new ApprovalStore(db);
  const long = 'x'.repeat(5000) + ' TAIL-THAT-MUST-BE-SHOWN';
  const a = approvals.request({ job_id: null, action_kind: 'send', target: 'email to ops@example.org', content: long });
  const s = confirmSubject(db, 'approve', a.id);
  assert.ok(s); assert.equal(s.content, long, 'whole content, not a preview'); assert.equal(s.binding, a.content_hash); assert.equal(s.binding, crypto.createHash('sha256').update(long).digest('hex'));
  assert.equal(confirmSubject(db, 'execute', a.id)?.binding, a.content_hash);
  assert.equal(confirmSubject(db, 'approve', 'apr-missing'), null);
  assert.equal(confirmSubject(db, 'bogus', a.id), null);
});

