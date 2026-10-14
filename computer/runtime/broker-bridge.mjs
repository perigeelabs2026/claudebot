// Inside the assistants' computer: the claudebot MCP server Claude Code starts from the task folder's .mcp.json.
// It holds only this task's capability (scoped tools, per-task token) and forwards each call to the engine on the Mac.
// A file Claude wrote here is sent along with write_artifact, because the Mac cannot see this computer's disk.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const ENGINE = process.env.CLAUDEBOT_ENGINE ?? 'http://host.lima.internal:48311';
const CAP_FILE = process.env.CLAUDEBOT_CAP_FILE ?? path.join(process.cwd(), '.claudebot', 'capability.json');
const cap = () => { try { return JSON.parse(fs.readFileSync(CAP_FILE, 'utf8')); } catch { return null; } };
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const headers = (c) => ({ 'content-type': 'application/json', 'x-capability': c.token, 'x-job-id': c.job_id, 'x-capability-key': c.key ?? c.job_id });
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return; let req; try { req = JSON.parse(line); } catch { return; }
  const reply = (result) => { if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, result }); };
  const c = cap();
  switch (req.method) {
    case 'initialize': return reply({ protocolVersion: String(req.params?.protocolVersion ?? '2025-06-18'), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'claudebot', version: '1' } });
    case 'notifications/initialized': return;
    case 'ping': return reply({});
    case 'tools/list': { if (!c) return reply({ tools: [] }); try { const r = await fetch(`${ENGINE}/api/broker/tools`, { headers: headers(c) }); const j = await r.json(); return reply({ tools: j.tools ?? [] }); } catch { return reply({ tools: [] }); } }
    case 'tools/call': {
      if (!c) return reply({ content: [{ type: 'text', text: 'No active task capability; this tool call was refused.' }], isError: true });
      const p = req.params ?? {}; const args = { ...(p.arguments ?? {}) };
      if (p.name === 'write_artifact' && args.content === undefined && typeof args.path === 'string') { const f = path.resolve(process.cwd(), args.path); if (f.startsWith(process.cwd() + path.sep) && fs.existsSync(f) && fs.statSync(f).size <= 1024 * 1024) args.content = fs.readFileSync(f, 'utf8'); }
      try { const r = await fetch(`${ENGINE}/api/broker/call`, { method: 'POST', headers: headers(c), body: JSON.stringify({ tool: p.name, args }) }); const j = await r.json(); return reply({ content: [{ type: 'text', text: j.text }], isError: !j.ok }); }
      catch (e) { return reply({ content: [{ type: 'text', text: `engine unreachable: ${e.message}` }], isError: true }); }
    }
    default: if (req.id !== undefined) out({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
