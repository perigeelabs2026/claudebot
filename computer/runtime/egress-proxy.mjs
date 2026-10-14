// Egress proxy for the builder uid (inside the assistants' computer). nftables lets claudebot-builder reach only this proxy (and DNS
// and the engine on the host); the proxy opens tunnels (HTTPS CONNECT) only to Anthropic, GitHub and npm. Plain HTTP is refused.
// Refusals are logged with the host only. Runs as the computer's main user (systemd claudebot-egress).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

export const ALLOWED = ['api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'statsig.anthropic.com', 'github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'registry.npmjs.org'];
export function allowed(host) { const h = String(host).toLowerCase().replace(/\.$/, ''); return ALLOWED.includes(h); }

export function createProxy({ log = () => {}, connect = (port, host) => net.connect(port, host) } = {}) {
  const server = http.createServer((req, res) => { log(`refused plain http ${String(req.headers.host ?? '').slice(0, 200)}`); res.writeHead(403); res.end('ClaudeBot builder egress: only HTTPS to Anthropic, GitHub and npm\n'); });
  server.on('connect', (req, sock, head) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(String(req.url ?? '')); const host = m?.[1] ?? ''; const port = Number(m?.[2] ?? 0);
    if (!m || port !== 443 || !allowed(host)) { log(`refused ${host.slice(0, 200)}:${port}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = connect(port, host);
    up.on('connect', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => { try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* gone */ } }); sock.on('error', () => up.destroy());
  });
  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const logFile = process.env.EGRESS_LOG ?? '/mnt/lima-claudebot-computer-data/logs/builder-egress.log';
  const log = (line) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ } };
  createProxy({ log }).listen(Number(process.env.EGRESS_PORT ?? 18799), '127.0.0.1');
}
