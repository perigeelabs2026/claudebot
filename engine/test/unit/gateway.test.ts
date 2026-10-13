import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { GatewayClient } from '../../src/gateway/client.ts';
import { ClaudeAcpRuntime, classifyFailure, parseResetAt } from '../../src/runtime/claude-acp.ts';
import { createLogger } from '../../src/log.ts';

/** A tiny RFC6455 server good enough for text frames < 64KiB, so tests need no dependencies. */
function fakeGateway(handler: (frame: Record<string, unknown>, send: (f: Record<string, unknown>) => void, state: Record<string, unknown>) => void) {
  const server = http.createServer();
  const sockets = new Set<import('node:net').Socket>();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket as import('node:net').Socket);
    const send = (obj: Record<string, unknown>) => { const payload = Buffer.from(JSON.stringify(obj)); const len = payload.length; const head = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, len >> 8, len & 255]); socket.write(Buffer.concat([head, payload])); };
    const state: Record<string, unknown> = {};
    send({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts: Date.now() } });
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (buf[1] & 0x80) !== 0; const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
        if (buf.length < off + len) return;
        const data = Buffer.from(buf.subarray(off, off + len)); if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (op === 8) { socket.end(); return; }
        if (op === 1) { const frame = JSON.parse(data.toString()); handler(frame, send, state); }
      }
    });
  });
  return { server, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port))), close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}


/** Fake handler fragment: answers gateway-local /acp commands the way the real gateway does. Returns true when handled. */
function handleAcpCommand(frame: Record<string, unknown>, send: (f: Record<string, unknown>) => void): boolean {
  if (frame.method !== 'chat.send') return false;
  const params = frame.params as { sessionKey: string; message: string };
  send({ type: 'res', id: frame.id, ok: true, payload: { runId: 'cmd-' + Math.random(), status: 'started' } });
  let text = 'unknown command';
  if (params.message.startsWith('/acp spawn')) text = '✅ Spawned ACP session agent:claude:acp:11111111-2222-3333-4444-555555555555 (persistent, backend acpx).';
  else if (params.message.startsWith('/acp status')) text = 'ACP status:\nsession: agent:claude:acp:11111111-2222-3333-4444-555555555555\nstate: idle';
  else if (params.message.startsWith('/acp close') || params.message.startsWith('/acp cancel')) text = '✅ done';
  setTimeout(() => send({ type: 'event', event: 'chat', payload: { sessionKey: params.sessionKey, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text }] } } }), 5);
  return true;
}

function tokenFile(): string { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rtok-')), 'gateway.token'); fs.writeFileSync(p, 'tok-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n', { mode: 0o600 }); return p; }
const log = createLogger({ name: 'test', stream: { write: () => true } as unknown as NodeJS.WritableStream });

test('client handshakes with token from file and completes a turn via agent/agent.wait/chat final', async () => {
  const seen: Record<string, unknown>[] = [];
  const fg = fakeGateway((frame, send, state) => {
    seen.push(frame);
    if (handleAcpCommand(frame, send)) return;
    if (frame.method === 'connect') { state.token = (frame.params as { auth: { token: string } }).auth.token; send({ type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4, server: { version: 't' }, features: { methods: [] }, snapshot: {}, auth: { role: 'operator', scopes: [] }, policy: {} } }); }
    else if (frame.method === 'agent') { send({ type: 'res', id: frame.id, ok: true, payload: { runId: 'run-1', status: 'started' } }); setTimeout(() => { send({ type: 'event', event: 'chat', payload: { sessionKey: (frame.params as { sessionKey: string }).sessionKey, runId: 'run-1', state: 'delta', deltaText: 'Hel' } }); send({ type: 'event', event: 'chat', payload: { sessionKey: (frame.params as { sessionKey: string }).sessionKey, runId: 'run-1', state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello from fake Claude' }] } } }); }, 20); }
    else if (frame.method === 'agent.wait') { setTimeout(() => send({ type: 'res', id: frame.id, ok: true, payload: { status: 'ok' } }), 40); }
    else if (frame.method === 'health') send({ type: 'res', id: frame.id, ok: true, payload: { ok: true } });
  });
  const port = await fg.listen();
  const tf = tokenFile();
  const gw = new GatewayClient({ url: `ws://127.0.0.1:${port}`, tokenFile: tf, log });
  const rt = new ClaudeAcpRuntime({ gateway: gw, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' });
  const beats: string[] = [];
  const r = await rt.startTurn({ jobId: 'job-1', sessionRef: 'job-1', role: 'market_research', cwd: '/tmp', prompt: 'say hi', resume: false, timeoutMs: 5000, onHeartbeat: (n) => beats.push(n) });
  assert.equal(r.ok, true); assert.equal((r as { text: string }).text, 'Hello from fake Claude');
  const connectFrame = seen.find((f) => f.method === 'connect') as { params: { auth: { token: string }, role: string } };
  assert.equal(connectFrame.params.auth.token.startsWith('tok-'), true); assert.equal(connectFrame.params.role, 'operator');
  const agentFrame = seen.find((f) => f.method === 'agent') as { params: Record<string, unknown> };
  assert.equal(agentFrame.params.sessionKey, 'agent:claude:acp:11111111-2222-3333-4444-555555555555'); assert.equal(agentFrame.params.deliver, false); assert.equal(agentFrame.params.acpTurnSource, 'manual_spawn');
  const spawnFrame = seen.find((f) => f.method === 'chat.send' && String((f.params as { message: string }).message).startsWith('/acp spawn')) as { params: { message: string } };
  assert.match(spawnFrame.params.message, /--label job-1 --cwd \/tmp$/); assert.ok(String(agentFrame.params.idempotencyKey).startsWith('claudebot:job-1:'));
  assert.ok(beats.length >= 2);
  gw.close(); fg.close();
});

test('login-required error becomes auth_required; usage limit becomes quota_exhausted with reset time', async () => {
  let mode = 'auth';
  const fg = fakeGateway((frame, send) => {
    if (handleAcpCommand(frame, send)) return;
    if (frame.method === 'connect') send({ type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4, server: {}, features: {}, snapshot: {}, auth: {}, policy: {} } });
    else if (frame.method === 'agent') { const sk = (frame.params as { sessionKey: string }).sessionKey; send({ type: 'res', id: frame.id, ok: true, payload: { runId: 'r2' } }); setTimeout(() => send({ type: 'event', event: 'chat', payload: { sessionKey: sk, runId: 'r2', state: 'error', errorKind: mode === 'auth' ? 'auth_required' : 'quota_exhausted', errorMessage: mode === 'auth' ? 'Not logged in · Please run /login' : "You've hit your usage limit · resets 2026-10-06T22:00:00Z" } }), 10); }
    else if (frame.method === 'agent.wait') setTimeout(() => send({ type: 'res', id: frame.id, ok: true, payload: { status: 'error', error: 'run failed' } }), 30);
  });
  const port = await fg.listen();
  const gw = new GatewayClient({ url: `ws://127.0.0.1:${port}`, tokenFile: tokenFile(), log });
  const rt = new ClaudeAcpRuntime({ gateway: gw, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' });
  const a = await rt.startTurn({ jobId: 'j', sessionRef: 'j', role: 'sales', cwd: '/tmp', prompt: 'x', resume: false, timeoutMs: 3000 });
  assert.equal(a.ok, false); assert.equal((a as { category: string }).category, 'auth_required');
  mode = 'limit';
  const b = await rt.startTurn({ jobId: 'j', sessionRef: 'j', role: 'sales', cwd: '/tmp', prompt: 'x', resume: true, timeoutMs: 3000 });
  assert.equal((b as { category: string }).category, 'quota_exhausted'); assert.equal((b as { resetAt: string }).resetAt, '2026-10-06T22:00:00.000Z');
  gw.close(); fg.close();
});

test('gateway disconnect mid-turn is a retryable transient failure that keeps the session key', async () => {
  const fg = fakeGateway((frame, send) => {
    if (handleAcpCommand(frame, send)) return;
    if (frame.method === 'connect') send({ type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4, server: {}, features: {}, snapshot: {}, auth: {}, policy: {} } });
    else if (frame.method === 'agent') { send({ type: 'res', id: frame.id, ok: true, payload: { runId: 'r3' } }); }
    else if (frame.method === 'agent.wait') { setTimeout(() => fg.close(), 10); }
  });
  const port = await fg.listen();
  const gw = new GatewayClient({ url: `ws://127.0.0.1:${port}`, tokenFile: tokenFile(), log });
  const rt = new ClaudeAcpRuntime({ gateway: gw, log, claudeExecutable: '/bin/false', claudeConfigDir: '/tmp/none' });
  const r = await rt.startTurn({ jobId: 'j', sessionRef: 'j', role: 'sales', cwd: '/tmp', prompt: 'x', resume: false, timeoutMs: 3000 });
  assert.equal(r.ok, false); assert.equal((r as { retryable: boolean }).retryable, true); assert.equal((r as { runtimeSessionId: string }).runtimeSessionId, 'agent:claude:acp:11111111-2222-3333-4444-555555555555');
  gw.close();
});

test('classifyFailure and parseResetAt cover the adapter and CLI phrasings', () => {
  assert.equal(classifyFailure({ message: 'Session expired. Please run /login to sign in again.' }).category, 'auth_required');
  assert.equal(classifyFailure({ message: 'AcpRuntimeError [ACP_TURN_FAILED]: Authentication required' }).category, 'auth_required');
  assert.equal(classifyFailure({ errorKind: 'rate_limited', message: '429' }).category, 'rate_limited');
  assert.equal(classifyFailure({ message: 'claude subprocess exited with code 1' }).category, 'crashed');
  assert.equal(classifyFailure({ message: 'ECONNREFUSED 127.0.0.1:48310' }).category, 'transient');
  assert.equal(classifyFailure({ message: 'something odd' }).category, 'internal');
  const now = new Date('2026-10-06T20:00:00Z');
  assert.equal(parseResetAt('resets in 2 hours 10 minutes', now), '2026-10-06T22:10:00.000Z');
  assert.equal(parseResetAt('limit · resets 2026-10-07T01:00:00Z', now), '2026-10-07T01:00:00.000Z');
  const r = parseResetAt('You have hit your limit · resets 3pm (America/Phoenix)', now)!;
  assert.equal(r, '2026-10-06T22:00:00.000Z'); // 3pm MST = 22:00Z, later today
  assert.equal(parseResetAt('no time here', now), null);
});
