// computerd: the only door into the assistants' computer. Runs inside the VM (systemd), no dependencies.
// Every request needs the per-install token (Authorization: Bearer <token>, or ?token= for a websocket). Without it: 401.
//   GET  /health        VM heartbeat, screens, memory, disk
//   GET  /screen/<n>    websocket → that screen's VNC (wayvnc on guest loopback 5900+n-1)
//   *    /cdp/...       the managed browser's DevTools (HTTP and websocket), for ClaudeBot on the Mac
//   POST /input/<n>?on=1|0  owner takeover: enable remote input on screen n only (every other screen goes view-only)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.COMPUTERD_PORT ?? 7777);
const HOST = process.env.COMPUTERD_HOST ?? '0.0.0.0';   // inside the VM; Lima forwards it to the Mac's 127.0.0.1 only
const DATA = process.env.COMPUTERD_DATA ?? '/mnt/lima-claudebot-computer-data';
const TOKEN_FILE = process.env.COMPUTERD_TOKEN_FILE ?? `${DATA}/computerd/token`;
const VNC_BASE = Number(process.env.COMPUTERD_VNC_BASE ?? 5900);
const CDP_PORT = Number(process.env.COMPUTERD_CDP_PORT ?? 48323);   // the managed browser's DevTools endpoint (guest loopback only)
const SCREENS = Number(process.env.COMPUTERD_SCREENS ?? 4);
const started = new Date().toISOString();

const token = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };
function authorized(req) {
  const want = token(); if (!want) return false;
  const url = new URL(req.url, 'http://x'); const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const a = Buffer.from(got); const b = Buffer.from(want); return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function disk(path) { try { const out = execFileSync('df', ['-Pk', path], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/); return { total_mb: Math.round(Number(out[1]) / 1024), used_mb: Math.round(Number(out[2]) / 1024) }; } catch { return null; } }
function memory() { try { const m = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, Number(String(v).trim().split(' ')[0])]; })); return { total_mb: Math.round(m.MemTotal / 1024), available_mb: Math.round(m.MemAvailable / 1024), used_pct: Math.round(100 * (1 - m.MemAvailable / m.MemTotal)) }; } catch { return { total_mb: Math.round(os.totalmem() / 1048576), available_mb: Math.round(os.freemem() / 1048576), used_pct: null }; } }
const listening = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); s.setTimeout(500, () => { s.destroy(); resolve(false); }); });

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (!authorized(req)) return send(401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    const screens = []; for (let i = 1; i <= SCREENS; i++) screens.push({ n: i, streaming: await listening(VNC_BASE + i - 1) });
    return send(200, { ok: true, computerd: { started, now: new Date().toISOString(), uptime_s: Math.round(os.uptime()) }, memory: memory(), disk: { root: disk('/'), data: disk(DATA) }, screens });
  }
  const inp = /^\/input\/(\d+)$/.exec(url.pathname);
  if (req.method === 'POST' && inp) {
    const n = Number(inp[1]); const on = url.searchParams.get('on') === '1'; if (!(n >= 1 && n <= SCREENS)) return send(404, { error: 'no such screen' });
    const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` };
    try {
      for (let i = 1; i <= SCREENS; i++) { const want = on && i === n ? '' : '--disable-input'; const f = `${env.XDG_RUNTIME_DIR}/wayvnc-${i}.env`; const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 'WAYVNC_FLAGS=--disable-input\n'; const next = `WAYVNC_FLAGS=${want}\n`; if (cur !== next) { fs.writeFileSync(f, next); execFileSync('systemctl', ['--user', 'restart', `wayvnc@${i}.service`], { env }); } }
      return send(200, { ok: true, input: on ? n : null });
    } catch (e) { return send(500, { error: e.message }); }
  }
  if (url.pathname.startsWith('/cdp/')) {   // DevTools HTTP (tab list, new, close); bodies pass through unchanged
    const up = http.request({ host: '127.0.0.1', port: CDP_PORT, path: url.pathname.slice(4) + url.search, method: req.method, headers: Object.fromEntries(Object.entries({ ...req.headers, host: `127.0.0.1:${CDP_PORT}` }).filter(([k]) => k !== 'authorization')) }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => send(502, { error: 'the browser is not running' })); req.pipe(up); return;
  }
  return send(404, { error: 'not found' });
});

// Websocket → VNC bridge (RFC 6455, binary frames). Only after the token check above has passed in 'upgrade'.
server.on('upgrade', (req, socket) => {
  if (!authorized(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
  const path0 = new URL(req.url, 'http://x').pathname;
  if (path0.startsWith('/cdp/')) {   // DevTools websocket: raw pass-through after re-issuing the upgrade to the browser
    const up = net.connect(CDP_PORT, '127.0.0.1');
    up.once('error', () => socket.destroy());
    up.once('connect', () => { const hdrs = Object.entries(req.headers).filter(([k]) => !['authorization', 'host'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('\r\n'); up.write(`GET ${path0.slice(4)} HTTP/1.1\r\nHost: 127.0.0.1:${CDP_PORT}\r\n${hdrs}\r\n\r\n`); up.pipe(socket); socket.pipe(up); });
    const end = () => { up.destroy(); socket.destroy(); }; socket.on('error', end); socket.on('close', end); up.on('close', end); return;
  }
  const m = /^\/screen\/(\d+)$/.exec(path0); const n = m ? Number(m[1]) : 0;
  if (!(n >= 1 && n <= SCREENS)) { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return; }
  const key = req.headers['sec-websocket-key']; if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const proto = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).includes('binary') ? 'Sec-WebSocket-Protocol: binary\r\n' : '';
  const vnc = net.connect(VNC_BASE + n - 1, '127.0.0.1');
  vnc.once('error', () => socket.destroy());
  vnc.once('connect', () => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
    vnc.on('data', (d) => socket.write(frame(d, 2)));
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => { buf = Buffer.concat([buf, d]); for (;;) { const f = parse(buf); if (!f) break; buf = buf.subarray(f.length); if (f.op === 8) { socket.end(frame(Buffer.alloc(0), 8)); vnc.end(); return; } if (f.op === 9) { socket.write(frame(f.data, 10)); continue; } if (f.op === 1 || f.op === 2 || f.op === 0) vnc.write(f.data); } });
  });
  const close = () => { vnc.destroy(); socket.destroy(); }; socket.on('close', close); socket.on('error', close); vnc.on('close', close);
});
function frame(data, op) { const n = data.length; const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })(); return Buffer.concat([head, data]); }
function parse(b) {
  if (b.length < 2) return null; const op = b[0] & 15; const masked = (b[1] & 128) !== 0; let len = b[1] & 127; let off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  const mask = masked ? b.subarray(off, off + 4) : null; if (masked) off += 4; if (b.length < off + len) return null;
  const data = Buffer.from(b.subarray(off, off + len)); if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  return { op, data, length: off + len };
}

process.on('uncaughtException', (e) => console.error('computerd error', e.message));   // one bad request never takes the door down
server.listen(PORT, HOST, () => console.log(`computerd listening on ${HOST}:${PORT}`));
