/**
 * The managed browser now lives in the assistants' computer. ClaudeBot code that reads tabs, closes them and streams the live view
 * keeps talking to a local DevTools port; this proxy (127.0.0.1 only, like the Mac's own browser was) forwards to computerd with
 * the per-install token, and rewrites DevTools URLs so websocket links point back here.
 */
import http from 'node:http';
import net from 'node:net';

export function startCdpProxy(o: { listenPort: number; computerdPort: number; vmCdpPort: number; token: () => string | null; log: { warn: (m: string, d?: Record<string, unknown>) => void } }): http.Server {
  const fix = (s: string) => s.split(`127.0.0.1:${o.vmCdpPort}`).join(`127.0.0.1:${o.listenPort}`).split(`localhost:${o.vmCdpPort}`).join(`127.0.0.1:${o.listenPort}`);
  const server = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: o.computerdPort, path: `/cdp${req.url}`, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${o.computerdPort}`, authorization: `Bearer ${o.token() ?? ''}` } }, (r) => {
      const chunks: Buffer[] = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => { const body = Buffer.from(fix(Buffer.concat(chunks).toString('utf8'))); const h = { ...r.headers, 'content-length': String(body.length) }; delete (h as Record<string, unknown>)['transfer-encoding']; res.writeHead(r.statusCode ?? 502, h); res.end(body); });
    });
    up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `the assistants' computer is not reachable: ${e.message}` })); });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(o.computerdPort, '127.0.0.1');
    up.once('error', () => socket.destroy());
    up.once('connect', () => {
      const hdrs = Object.entries(req.headers).filter(([k]) => !['host', 'authorization'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      up.write(`GET /cdp${req.url} HTTP/1.1\r\nHost: 127.0.0.1:${o.computerdPort}\r\nAuthorization: Bearer ${o.token() ?? ''}\r\n${hdrs}\r\n\r\n`); if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const end = () => { up.destroy(); socket.destroy(); }; socket.on('error', end); socket.on('close', end); up.on('close', end);
  });
  server.on('error', (e) => o.log.warn('local DevTools proxy failed', { err: (e as Error).message }));
  server.listen(o.listenPort, '127.0.0.1');
  return server;
}
