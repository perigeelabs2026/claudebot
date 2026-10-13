#!/usr/bin/env node
// Gate 8: a BOUNDED soak of the installed product. Declared duration (default 30 min). Through the real engine:
// every 5 min a trigger event creates a deterministic task (no Claude); every 10 min a small real-Claude document task.
// Every 30 s: health, phantom "working" (working without a fresh heartbeat), stuck tasks, orphan adapters/probes, memory.
// It proves nothing about 24/7 operation beyond its duration. Writes ~/.claudebot/logs/soak-<ts>.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MIN = Number(process.argv[2] ?? 30);
const HOME = os.homedir(); const TOKEN = fs.readFileSync(path.join(HOME, '.claudebot', 'secrets', 'ui.token'), 'utf8').trim(); const API = 'http://127.0.0.1:48311';
const api = async (p, body, method) => (await fetch(API + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-claudebot-token': TOKEN }, body: body ? JSON.stringify(body) : undefined })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = () => execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,args=']).toString().split('\n');
const ws = (await api('/api/workspaces')).find((w) => /Workflow test/.test(w.name))?.id;
const trig = await api('/api/triggers', { name: `Soak events ${new Date().toISOString().slice(0, 16)}`, kind: 'system.workspace_summary', objective: 'Soak test: summarise the project state (deterministic, no Claude).', workspace_id: ws });
const hook = async (id) => (await fetch(trig.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claudebot-trigger-token': trig.token }, body: JSON.stringify({ event_id: id, data: { n: id } }) })).json();
const start = Date.now(); const end = start + MIN * 60_000; const created = []; const samples = []; let n = 0;
while (Date.now() < end) {
  const el = Math.round((Date.now() - start) / 60_000);
  if (n % 10 === 0) { const r = await hook(`soak-${el}`); created.push({ kind: 'event', id: r.job_id, at: el }); if (r.duplicate) created.push({ dup: true }); }
  if (n % 20 === 10) { const r = await api('/api/jobs', { kind: 'document.create', objective: `Soak ${el} min: write a two-sentence note about why lighthouses use Fresnel lenses and save it as note.md.`, workspace_id: ws }); created.push({ kind: 'claude', id: r.job?.id ?? r.id, at: el }); }
  const h = await api('/api/health'); const wb = await api('/api/workbench');
  const now = Date.now(); // phantom = shown as working but the database has no lease with a fresh heartbeat (checked against the DB rows via /api/jobs)
  const jobs = await api('/api/jobs?state=leased,running&limit=200'); const live = new Set(jobs.filter((j) => j.lease_heartbeat_at && now - Date.parse(j.lease_heartbeat_at) <= 60_000).map((j) => j.id));
  const phantom = wb.tasks.filter((t) => t.status === 'working' && !live.has(t.id)).length;
  const lines = ps(); const probes = lines.filter((l) => /openclaw .*browser|claude auth status/.test(l)).length; const adapters = lines.filter((l) => /claude-agent-acp/.test(l)).length;
  const mp = execFileSync('memory_pressure').toString().match(/free percentage: (\d+)/)?.[1];
  samples.push({ t: Math.round((now - start) / 1000), ok: { claude: h.claude?.state, gateway: h.gateway?.state, queue: h.queue?.state, workers: h.workers?.state }, working: wb.counts.working, phantom, active: wb.tasks.filter((t) => ['leased', 'running'].includes(t.state)).length, probes, adapters, free_pct: Number(mp) });
  n++; await sleep(30_000);
}
// let the last tasks finish (bounded)
for (let i = 0; i < 60; i++) { const s = await Promise.all(created.filter((c) => c.id).map((c) => api(`/api/jobs/${c.id}`))); if (s.every((j) => ['completed', 'failed_terminal', 'cancelled'].includes(j.job.state))) break; await sleep(10_000); }
const finals = await Promise.all(created.filter((c) => c.id).map(async (c) => { const j = await api(`/api/jobs/${c.id}`); return { ...c, state: j.job.state, outcome: j.job.outcome, artifacts: j.artifacts.length }; }));
await api(`/api/triggers/${trig.trigger.id}`, null, 'DELETE');
const out = { declared_minutes: MIN, started_at: new Date(start).toISOString(), finished_at: new Date().toISOString(), tasks: finals, samples, summary: { tasks: finals.length, completed: finals.filter((f) => f.state === 'completed').length, failed: finals.filter((f) => f.state !== 'completed').map((f) => `${f.id}:${f.state}`), max_phantom: Math.max(...samples.map((s) => s.phantom)), max_probes: Math.max(...samples.map((s) => s.probes)), max_adapters: Math.max(...samples.map((s) => s.adapters)), min_free_pct: Math.min(...samples.map((s) => s.free_pct)), health_not_ok: samples.filter((s) => Object.values(s.ok).some((v) => v && !['ok', 'ready'].includes(v))).length } };
const file = path.join(HOME, '.claudebot', 'logs', `soak-${out.started_at.replace(/[:.]/g, '-')}.json`); fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(file); console.log(JSON.stringify(out.summary));
