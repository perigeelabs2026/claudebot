import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, createLogger } from '../../src/log.ts';
import { loadConfig } from '../../src/config.ts';

test('redact hides token-like values and leaves plain text alone', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
  assert.equal(redact(`token=${token}`), 'token=[REDACTED]');
  assert.equal(redact(`Authorization: Bearer ${token}`), 'Authorization: Bearer [REDACTED]');
  assert.equal(redact('key sk-ant-api03-0123456789abcdef'), 'key sk-ant-[REDACTED]');
  assert.equal(redact(`blob ${token}`), 'blob [REDACTED-BLOB]');
  // control: ordinary prose is untouched
  assert.equal(redact('job research-1 moved to running'), 'job research-1 moved to running');
});

test('logger output is redacted and structured', () => {
  const chunks: string[] = [];
  const stream = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WritableStream;
  const log = createLogger({ name: 't', stream });
  log.info('gateway connect', { token: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ' });
  const rec = JSON.parse(chunks[0]);
  assert.equal(rec.level, 'info');
  assert.equal(rec.msg, 'gateway connect');
  assert.equal(rec.token, '[REDACTED]');
});

test('config keeps runtime state outside the source tree', () => {
  const c = loadConfig({ CLAUDEBOT_HOME: '/tmp/x' } as NodeJS.ProcessEnv);
  assert.equal(c.dbPath, '/tmp/x/data/claudebot.sqlite');
  assert.equal(c.claudeConfigDir, '/tmp/x/claude');
  assert.equal(c.gatewayUrl, 'ws://127.0.0.1:48310');
  assert.ok(!c.dbPath.startsWith(c.sourceRoot));
});
