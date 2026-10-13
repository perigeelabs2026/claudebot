#!/usr/bin/env node
// An ISOLATED OpenClaw gateway for fault-injection tests (Gate 7): profile "claudebot-test", state ~/.openclaw-claudebot-test,
// port 48410, its own random token, browser disabled, temporary workspaces. It reuses the installed acpx plugin code by
// symlink (read-only) and the same Claude route (bin/claude-acp → isolated Claude profile), but shares no gateway state,
// sessions or token with the owner's ClaudeBot gateway on 48310 — so restarting or killing it cannot disturb live work.
//   node scripts/isolated-gateway.mjs setup|start|stop|status
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const HOME = os.homedir();
const LAB = path.join(HOME, '.openclaw-claudebot');
const DIR = path.join(HOME, '.openclaw-claudebot-test');
const PORT = Number(process.env.CLAUDEBOT_TEST_GATEWAY_PORT ?? 48410);
const TOKEN = path.join(DIR, 'secrets', 'gateway.token');
const PIDFILE = path.join(DIR, 'gateway.pid');
const NODE = path.join(HOME, '.local', 'bin', 'node');
const OC = path.join(HOME, '.local', 'lib', 'node_modules', 'openclaw', 'dist', 'index.js');

function setup() {
  fs.mkdirSync(path.join(DIR, 'secrets'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(DIR, 'extensions'), { recursive: true }); fs.mkdirSync(path.join(DIR, 'tmp'), { recursive: true });
  if (!fs.existsSync(TOKEN)) fs.writeFileSync(TOKEN, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  const link = path.join(DIR, 'extensions', 'acpx'); if (!fs.existsSync(link)) fs.symlinkSync(path.join(LAB, 'extensions', 'acpx'), link);
  const c = JSON.parse(fs.readFileSync(path.join(LAB, 'openclaw.json'), 'utf8'));
  const ws = path.join(os.tmpdir(), 'claudebot-test-gw-workspaces'); fs.mkdirSync(path.join(ws, '_control'), { recursive: true }); fs.mkdirSync(path.join(ws, '_parity'), { recursive: true });
  c.gateway = { ...(c.gateway ?? {}), port: PORT, bind: 'loopback' };
  c.secrets = { ...(c.secrets ?? {}), providers: { ...(c.secrets?.providers ?? {}), claudebot: { source: 'file', path: TOKEN, mode: 'singleValue' } } };
  c.browser = { ...(c.browser ?? {}), enabled: false };                 // never drives the owner's managed Chrome
  for (const id of Object.keys(c.agents?.entries ?? {})) { const e = c.agents.entries[id]; if (e.workspace) e.workspace = path.join(ws, id === 'parity' ? '_parity' : '_control'); if (e.runtime?.acp?.cwd) e.runtime.acp.cwd = ws; }
  fs.writeFileSync(path.join(DIR, 'openclaw.json'), JSON.stringify(c, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ dir: DIR, port: PORT, token_file: TOKEN }));
}
const env = () => ({ ...process.env, HOME, OPENCLAW_CONFIG_PATH: path.join(DIR, 'openclaw.json'), OPENCLAW_STATE_DIR: DIR, OPENCLAW_PROFILE: 'claudebot-test', OPENCLAW_GATEWAY_PORT: String(PORT), TMPDIR: path.join(DIR, 'tmp'), NODE_OPTIONS: '' });
function pid() { try { const p = Number(fs.readFileSync(PIDFILE, 'utf8')); process.kill(p, 0); return p; } catch { return null; } }
async function start() {
  if (pid()) { console.log(JSON.stringify({ running: pid() })); return; }
  const out = fs.openSync(path.join(DIR, 'gateway.log'), 'a');
  const child = spawn(NODE, ['--max-old-space-size=2048', OC, 'gateway', '--port', String(PORT)], { env: env(), detached: true, stdio: ['ignore', out, out] });
  fs.writeFileSync(PIDFILE, String(child.pid)); child.unref();
  for (let i = 0; i < 60; i++) { try { execFileSync(NODE, [OC, '--profile', 'claudebot-test', 'gateway', 'health'], { env: env(), stdio: 'ignore', timeout: 10_000 }); console.log(JSON.stringify({ started: child.pid, port: PORT })); return; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  console.log(JSON.stringify({ started: child.pid, port: PORT, healthy: false })); process.exitCode = 1;
}
async function stop() { const p = pid(); if (!p) { console.log('{"running":false}'); return; } process.kill(-p, 'SIGTERM'); for (let i = 0; i < 20 && pid(); i++) await new Promise((r) => setTimeout(r, 500)); if (pid()) process.kill(-p, 'SIGKILL'); fs.rmSync(PIDFILE, { force: true }); console.log(JSON.stringify({ stopped: p })); }
const cmd = process.argv[2];
if (cmd === 'setup') setup(); else if (cmd === 'start') await start(); else if (cmd === 'stop') await stop(); else if (cmd === 'status') console.log(JSON.stringify({ running: pid(), port: PORT })); else { console.error('usage: setup|start|stop|status'); process.exitCode = 2; }
