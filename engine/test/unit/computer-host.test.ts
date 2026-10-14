/** The assistants' computer: the Lima template shares nothing and forwards only computerd to 127.0.0.1; status reads Lima and computerd. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { limaYaml, LimaHost, versions, NAME } from '../../src/computer/host.ts';

test('the VM template: pinned image and size from versions.json, no host mounts, only computerd forwarded and only to 127.0.0.1, everything else ignored', () => {
  const y = limaYaml(); const v = versions();
  assert.match(y, /^mounts: \[\]$/m); assert.match(y, /^vmType: vz$/m); assert.match(y, new RegExp(`memory: "${v.vm.memory}"`)); assert.ok(y.includes(v.image.location));
  const fw = y.split('portForwards:')[1].split('provision:')[0];
  assert.match(fw, /guestIP: "127\.0\.0\.1"\n    guestPort: 7777\n    hostPort: 47777\n    hostIP: "127\.0\.0\.1"/);
  assert.equal((fw.match(/hostIP:/g) || []).length, 1, 'exactly one forwarded port');
  for (const ip of ['127.0.0.1', '0.0.0.0', '::']) assert.ok(fw.includes(`guestIP: "${ip}"`) && /ignore: true/.test(fw), ip);
  assert.match(fw, /proto: udp\n    ignore: true/);
  assert.ok(!/token/i.test(y.replace(/computerd/g, '')) || !/[0-9a-f]{64}/.test(y), 'no token in the template');
});

test('status: not created → stopped → running (from computerd /health, with the token); a wrong token reads as an error', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-')); let list = '';
  const host = new LimaHost({ home, secretsDir: path.join(home, 'secrets'), exec: async (args) => { if (args[0] === 'list') return list; return ''; } });
  assert.equal((await host.status()).state, 'not_created');
  list = JSON.stringify({ name: NAME, status: 'Stopped', cpus: 4, memory: 6 * 2 ** 30, disk: 20 * 2 ** 30 }) + '\n';
  const st = await host.status(); assert.equal(st.state, 'stopped'); assert.deepEqual(st.vm, { cpus: 4, memory_gb: 6, disk_gb: 20 });
  list = JSON.stringify({ name: NAME, status: 'Running', cpus: 4, memory: 6 * 2 ** 30, disk: 20 * 2 ** 30 }) + '\n';
  const realFetch = globalThis.fetch; let seenAuth = '';
  globalThis.fetch = (async (_u: string, init?: { headers?: Record<string, string> }) => { seenAuth = init?.headers?.authorization ?? ''; return new Response(seenAuth === 'Bearer ' ? 'no' : JSON.stringify({ computerd: { now: 'x', uptime_s: 5 }, memory: { used_pct: 12, available_mb: 5000, total_mb: 5900 }, disk: { data: { used_mb: 10, total_mb: 30000 } }, screens: [{ n: 1, streaming: true }] }), { status: seenAuth === 'Bearer ' ? 401 : 200 }); }) as never;
  try {
    assert.equal((await host.status()).state, 'error', 'no token: computerd refuses (401) and the state says so');
    fs.mkdirSync(path.join(home, 'secrets'), { recursive: true }); fs.writeFileSync(path.join(home, 'secrets', 'computer.token'), 'f'.repeat(64));
    const ok = await host.status(); assert.equal(ok.state, 'running'); assert.equal(ok.screens![0].streaming, true); assert.equal(seenAuth, `Bearer ${'f'.repeat(64)}`);
  } finally { globalThis.fetch = realFetch; }
});
