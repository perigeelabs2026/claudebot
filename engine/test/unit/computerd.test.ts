/** computerd (runs inside the assistants' VM): every request without the per-install token gets 401; with it, health and screens. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SERVER = path.resolve(import.meta.dirname, '..', '..', '..', 'computer', 'computerd', 'server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('computerd: 401 without the token (HTTP and websocket); with it, health and a websocket bridge to the screen\'s VNC', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')); const tok = 'a'.repeat(48); fs.writeFileSync(path.join(dir, 'token'), tok);
  const vnc = net.createServer((s) => { s.on('error', () => {}); s.write('RFB 003.008\n'); s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))); }); await new Promise<void>((r) => vnc.listen(0, '127.0.0.1', () => r()));
  const vncPort = (vnc.address() as net.AddressInfo).port; const port = 47000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, COMPUTERD_PORT: String(port), COMPUTERD_HOST: '127.0.0.1', COMPUTERD_TOKEN_FILE: path.join(dir, 'token'), COMPUTERD_VNC_BASE: String(vncPort), COMPUTERD_SCREENS: '1' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); } }
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nothing`)).status, 401, 'unknown paths are 401 too, not 404');
    const h = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${tok}` } })).json() as { ok: boolean; screens: Array<{ n: number; streaming: boolean }> };
    assert.equal(h.ok, true); assert.deepEqual(h.screens, [{ n: 1, streaming: true }]);
    const refused = await new Promise<string>((resolve) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/screen/1`); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('refused'); });
    assert.equal(refused, 'refused', 'a websocket without the token is refused');
    const got = await new Promise<string>((resolve) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/screen/1?token=${tok}`, ['binary']); ws.binaryType = 'arraybuffer'; let all = '';
      ws.onmessage = (e) => { all += Buffer.from(e.data as ArrayBuffer).toString(); if (all.includes('echo:hi')) { ws.close(); resolve(all); } }; ws.onopen = () => ws.send(new TextEncoder().encode('hi')); setTimeout(() => resolve(all), 3000); });
    assert.match(got, /^RFB 003\.008\n/); assert.match(got, /echo:hi/);
  } finally { child.kill(); vnc.close(); }
});
