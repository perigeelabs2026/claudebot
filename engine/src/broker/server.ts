/**
 * claudebot-broker: MCP server over stdio, started by Claude Code from the workspace .mcp.json.
 * It exposes ONLY the tools in the current job's capability file and forwards calls to the engine API with the capability token.
 * Transport: newline-delimited JSON-RPC 2.0 (MCP stdio).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config.ts';
import { TOOL_SCHEMAS, readCapability, type Capability } from './capabilities.ts';

const cfg = loadConfig();
const jobArg = process.argv.indexOf('--job'); const explicitJob = jobArg > 0 ? process.argv[jobArg + 1] : undefined;
function currentJobId(): string | null { return explicitJob ?? null; }
function cap(): Capability | null { const id = currentJobId(); return id ? readCapability(cfg.runDir, id) : null; }

const out = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req: { id?: number | string; method: string; params?: Record<string, unknown> };
  try { req = JSON.parse(line); } catch { return; }
  const reply = (result: unknown) => { if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, result }); };
  const error = (code: number, message: string) => { if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, error: { code, message } }); };
  switch (req.method) {
    case 'initialize': return reply({ protocolVersion: String((req.params as { protocolVersion?: string })?.protocolVersion ?? '2025-06-18'), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'claudebot', version: '0.2.0' } });
    case 'notifications/initialized': return;
    case 'ping': return reply({});
    case 'tools/list': { const c = cap(); const tools = (c?.tools ?? []).filter((t) => TOOL_SCHEMAS[t]).map((name) => ({ name, description: TOOL_SCHEMAS[name].description, inputSchema: TOOL_SCHEMAS[name].inputSchema })); return reply({ tools }); }
    case 'tools/call': {
      const c = cap(); const p = (req.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
      if (!c) return reply({ content: [{ type: 'text', text: 'No active job capability; this tool call was refused.' }], isError: true });
      try {
        const token = fs.readFileSync(cfg.uiTokenFile, 'utf8').trim();
        const res = await fetch(`http://127.0.0.1:${cfg.enginePort}/api/broker/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claudebot-token': token, 'x-capability': c.token, 'x-job-id': c.job_id, 'x-capability-key': c.key ?? c.job_id }, body: JSON.stringify({ tool: p.name, args: p.arguments ?? {} }) });
        const j = await res.json() as { ok: boolean; text: string };
        return reply({ content: [{ type: 'text', text: j.text }], isError: !j.ok });
      } catch (e) { return reply({ content: [{ type: 'text', text: `engine unreachable: ${(e as Error).message}` }], isError: true }); }
    }
    default: return error(-32601, `method not found: ${req.method}`);
  }
});
rl.on('close', () => process.exit(0));
