/** Turns inside the assistants' computer: the task folder goes in and comes back, the VM gets only this task's capability, and only task folders map. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRuntime, vmPath, capabilityKey, VM_WORKSPACES } from '../../src/runtime/computer.ts';
import { issueCapability, mcpJson } from '../../src/broker/capabilities.ts';
import type { ModelRuntime, TurnRequest } from '../../src/runtime/types.ts';

test('only folders under the workspaces root map into the computer', () => {
  assert.equal(vmPath('/h/ws', '/h/ws/general/tasks/job-1'), `${VM_WORKSPACES}/general/tasks/job-1`);
  assert.throws(() => vmPath('/h/ws', '/h/secrets'), /refused/); assert.throws(() => vmPath('/h/ws', '/h/ws'), /refused/); assert.throws(() => vmPath('/h/ws', '/h/ws/../x'), /refused/);
});

test('a turn: copy in, capability + bridge config written in the VM, run there with the VM path, copy back (also after a failure)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-')); const ws = path.join(tmp, 'workspaces'); const runDir = path.join(tmp, 'run'); const dir = path.join(ws, 'general', 'tasks', 'job-abc'); fs.mkdirSync(dir, { recursive: true });
  const cap = issueCapability(runDir, { id: 'job-abc', agent_role: 'researcher' }, dir, ['list_my_tools']); fs.writeFileSync(path.join(dir, '.mcp.json'), mcpJson('/src', 'job-abc', tmp));
  assert.equal(capabilityKey(dir), 'job-abc');
  const calls: Array<{ cmd: string; args: string[]; input?: string }> = []; let seenCwd = '';
  const inner = { id: 'claude-acp', describe: () => ({ label: 'x', route: 'ClaudeBot → OpenClaw Gateway → acpx', account: '' }), health: async () => ({}) as never, cancel: async () => {}, startTurn: async (r: TurnRequest) => { seenCwd = r.cwd; return { ok: true, text: 'done' } as never; } } as unknown as ModelRuntime;
  const rt = new ComputerRuntime(inner, { hostWorkspaces: ws, runDir, enginePort: 48311, log: { info: () => {}, warn: () => {} }, exec: async (cmd, args, input) => { calls.push({ cmd, args, input }); return ''; } });
  const r = await rt.startTurn({ jobId: 'job-abc', sessionRef: 'job-abc', role: 'researcher', cwd: dir, prompt: 'p', resume: false, timeoutMs: 1000 });
  assert.equal(r.ok, true); assert.equal(seenCwd, `${VM_WORKSPACES}/general/tasks/job-abc`);
  const rs = calls.filter((c) => c.cmd === 'rsync'); assert.equal(rs.length, 2); assert.ok(rs[0].args.at(-1)!.endsWith(`${VM_WORKSPACES}/general/tasks/job-abc/`)); assert.ok(rs[1].args.at(-1) === `${dir}/`, 'copied back to the Mac');
  for (const x of ['.mcp.json', '.claudebot/', '.claude/', '/shared']) assert.ok(rs[0].args.includes(x), `never copies ${x}`);
  assert.ok(calls.some((c) => c.cmd === 'ssh' && /ln -sfn '[^']*_shared' '[^']*job-abc'\/shared/.test(c.args.at(-1)!)), 'the team folder is linked in as ./shared');
  const capWrite = calls.find((c) => c.cmd === 'ssh' && /capability\.json/.test(c.args.at(-1)!))!; assert.deepEqual(JSON.parse(capWrite.input!), { token: cap.token, job_id: 'job-abc', key: 'job-abc' });
  const mcp = JSON.parse(calls.find((c) => c.cmd === 'ssh' && /\.mcp\.json/.test(c.args.at(-1)!))!.input!); assert.equal(mcp.mcpServers.claudebot.env.CLAUDEBOT_ENGINE, 'http://host.lima.internal:48311');
  assert.match(rt.describe().route, /in the assistants' computer/);
  // copy-back still happens when the turn throws
  calls.length = 0; const failing = new ComputerRuntime({ ...inner, startTurn: async () => { throw new Error('boom'); } } as ModelRuntime, { hostWorkspaces: ws, runDir, enginePort: 1, log: { info: () => {}, warn: () => {} }, exec: async (cmd, args, input) => { calls.push({ cmd, args, input }); return ''; } });
  await assert.rejects(failing.startTurn({ jobId: 'job-abc', sessionRef: 'job-abc', role: 'researcher', cwd: dir, prompt: 'p', resume: false, timeoutMs: 1000 }), /boom/);
  assert.equal(calls.filter((c) => c.cmd === 'rsync').length, 2);
  // a folder outside the workspaces root is refused before anything runs
  calls.length = 0; const bad = await rt.startTurn({ jobId: 'x', sessionRef: 'x', role: 'r', cwd: tmp, prompt: 'p', resume: false, timeoutMs: 1 }); assert.equal(bad.ok, false); assert.equal(calls.length, 0);
});

test('a fresh install runs assistants on the Mac: the private computer is opt-in', async () => {
  const { setupBroker } = await import('./helpers-broker.ts'); const { runtimeLocation } = await import('../../src/runtime/select.ts');
  assert.equal(runtimeLocation(setupBroker().db), 'mac');
});
