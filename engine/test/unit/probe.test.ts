import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runProbe, startProbe, groupMembers, killAllProbes, reapOrphanProbes, inFlightProbes, killGroup } from '../../src/infra/probe.ts';

const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'claudebot-probe-test-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function gone(pgid: number, ms: number): Promise<boolean> { const t = Date.now() + ms; while (Date.now() < t) { if (groupMembers(pgid).length === 0) return true; await sleep(150); } return groupMembers(pgid).length === 0; }
function deadPid(): number { let p = 99999; for (;;) { try { process.kill(p, 0); p--; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return p; p--; } } }

test('a hung probe and its grandchildren are killed as a group at the deadline', async () => {
  const t0 = Date.now();
  const r = await runProbe('/bin/sh', ['-c', 'sleep 300 & exec sleep 300'], { timeoutMs: 1500, label: 'hang', registryDir: reg });
  assert.equal(r.ok, false); assert.equal(r.timedOut, true, `expected a timeout, got code=${r.code} signal=${r.signal}`);
  assert.ok(Date.now() - t0 < 6000, 'the deadline is enforced promptly');
  assert.ok(r.pgid && (await gone(r.pgid, 2000)), 'no member of the probe group survives (the backgrounded sleep included)');
  assert.equal(fs.readdirSync(reg).length, 0, 'the registry record is removed');
});

test('a probe dies at its deadline even when the engine that started it was SIGKILLed first', async () => {
  const probeUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'src', 'infra', 'probe.ts')).href;
  const script = path.join(reg, 'orphan-engine.mts');
  fs.writeFileSync(script, `import { startProbe } from ${JSON.stringify(probeUrl)};
const p = startProbe('/bin/sh', ['-c', 'sleep 300'], { timeoutMs: 2000, label: 'orphan', registryDir: ${JSON.stringify(reg)} });
process.stdout.write(String(p.pgid) + '\\n');
setInterval(() => {}, 1000);
`);
  const engine = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pgid = await new Promise<number>((resolve, reject) => { let buf = ''; engine.stdout.on('data', (c) => { buf += c; if (buf.includes('\n')) resolve(Number(buf.trim())); }); engine.on('exit', (c) => reject(new Error('fake engine exited early ' + c))); setTimeout(() => reject(new Error('no pgid')), 10_000); });
  engine.kill('SIGKILL'); await new Promise((r) => engine.on('exit', r));
  await sleep(200);
  const control = groupMembers(pgid);
  assert.ok(control.length >= 1, 'control: the orphaned probe is alive right after its engine died (so a later disappearance is the leash, not the parent kill)');
  assert.ok(await gone(pgid, 6000), `orphaned probe group ${pgid} must self-terminate at its 2 s deadline; members still alive: ${groupMembers(pgid).join(',')}`);
  for (const f of fs.readdirSync(reg).filter((f) => f.endsWith('.json'))) fs.rmSync(path.join(reg, f));
});

test('the storm guard refuses a probe beyond the in-flight cap instead of spawning it', async () => {
  process.env.CLAUDEBOT_PROBE_MAX_IN_FLIGHT = '2';
  try {
    const a = startProbe('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 30_000, label: 'a', registryDir: reg });
    const b = startProbe('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 30_000, label: 'b', registryDir: reg });
    const c = await runProbe('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 30_000, label: 'c', registryDir: reg });
    assert.equal(c.skipped, 'storm_guard'); assert.equal(c.pgid, null); assert.match(c.stderr, /2 probes already in flight \(a, b\)/);
    assert.equal(inFlightProbes().length, 2);
    assert.equal(killAllProbes(), 2);
    const [ra, rb] = await Promise.all([a.result, b.result]);
    assert.equal(ra.ok, false); assert.equal(rb.ok, false);
    assert.ok(await gone(a.pgid!, 2000) && (await gone(b.pgid!, 2000)));
    assert.equal(inFlightProbes().length, 0);
  } finally { delete process.env.CLAUDEBOT_PROBE_MAX_IN_FLIGHT; }
});

test('reapOrphanProbes kills a recorded group whose engine is gone and leaves live ones alone', async () => {
  const live = startProbe('/bin/sh', ['-c', 'sleep 300'], { timeoutMs: 120_000, label: 'live', registryDir: reg });
  const orphan = startProbe('/bin/sh', ['-c', 'sleep 300'], { timeoutMs: 120_000, label: 'orphan', registryDir: reg });
  const file = path.join(reg, `${orphan.pgid}.json`);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')); rec.engine_pid = deadPid(); fs.writeFileSync(file, JSON.stringify(rec));
  const warned: string[] = [];
  assert.equal(reapOrphanProbes(reg, { warn: (m, d) => warned.push(m + ' ' + JSON.stringify(d)) }), 1);
  assert.ok(await gone(orphan.pgid!, 2000), 'the orphan group is killed');
  assert.equal(groupMembers(live.pgid!).length >= 1, true, 'the live group (engine alive, deadline ahead) is untouched');
  assert.match(warned.join('\n'), /orphaned probe group killed/);
  const ro = await orphan.result; assert.equal(ro.ok, false);
  assert.ok(killGroup(live.pgid!)); await live.result;
  assert.equal(fs.readdirSync(reg).filter((f) => f.endsWith('.json')).length, 0);
});

test('a healthy probe returns its output and leaves nothing behind', async () => {
  const r = await runProbe('/bin/sh', ['-c', 'echo hello; echo warn >&2'], { timeoutMs: 5000, label: 'ok', registryDir: reg });
  assert.equal(r.ok, true); assert.equal(r.code, 0); assert.equal(r.stdout.trim(), 'hello'); assert.equal(r.stderr.trim(), 'warn'); assert.equal(r.timedOut, false);
  assert.equal(inFlightProbes().length, 0); assert.equal(fs.readdirSync(reg).filter((f) => f.endsWith('.json')).length, 0);
});
