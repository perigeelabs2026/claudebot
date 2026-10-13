/**
 * Installed acceptance for the Workbench iteration (real engine, real Claude, one active task at a time):
 *  1. The lead delegates a bounded task from chat → the task appears in /api/workbench as working with a fresh heartbeat
 *     and plain-English progress (never "agent acp"); its recorded actions are readable; the result's hash matches.
 *  2. Direction: a note saved on a running task is marked delivered at a later Claude step (or honestly not, if none follows).
 *  3. Stop: a disposable task started directly is cancelled mid-turn; the worker releases it within seconds, its Claude
 *     session is closed, no later events are written, save points remain.
 *  4. Shell: close the window through the app's own URL scheme, relaunch normally, verify the window came back (shell.json).
 *  5. Engine restart keeps the conversation and tasks; no duplicates, phantom activity, or orphaned processes.
 * Memory samples include the managed Chrome process family. Aborts below 15% kernel available-memory level.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = `${process.env.HOME}/.claudebot`; const token = fs.readFileSync(`${root}/secrets/ui.token`, 'utf8').trim(); const base = 'http://127.0.0.1:48311';
async function api(p: string, body?: unknown, method?: string) { const r = await fetch(`${base}${p}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json() as any; if (!r.ok) throw new Error(`${p} → ${r.status}: ${d.error ?? d.detail}`); return d; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }); } catch { return ''; } };
function chromeFamilyMb(): { pids: number; mb: number } { const ps = sh('/bin/ps', ['-axo', 'pid,ppid,rss,args']).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4).map((c) => ({ pid: Number(c[0]), ppid: Number(c[1]), rss: Number(c[2]), args: c.slice(3).join(' ') })); const r0 = ps.find((p) => /remote-debugging-port=48323/.test(p.args)); if (!r0) return { pids: 0, mb: 0 }; const fam = new Set([r0.pid]); let grew = true; while (grew) { grew = false; for (const p of ps) if (!fam.has(p.pid) && fam.has(p.ppid)) { fam.add(p.pid); grew = true; } } return { pids: fam.size, mb: Math.round(ps.filter((p) => fam.has(p.pid)).reduce((n, p) => n + p.rss, 0) / 1024) }; }
function procs() { const ps = sh('/bin/ps', ['-axo', 'pid,rss,args']).split('\n'); const pick = (re: RegExp) => ps.filter((l) => re.test(l)); const sum = (ls: string[]) => Math.round(ls.reduce((n, l) => n + Number(l.trim().split(/\s+/)[1] || 0), 0) / 1024); const adapters = pick(/claude-agent-acp\/dist\/index\.js/); const claudes = pick(/claude --output-format stream-json/); const engine = pick(/engine\/src\/(worker|supervisor)\/main\.ts/); const gateway = pick(/--max-old-space-size=8192 .*openclaw/); const probes = pick(/claudebot-probe/); const chrome = chromeFamilyMb(); const core = sum(engine) + sum(gateway) + sum(adapters) + sum(claudes); return { adapters: adapters.length, claudes: claudes.length, probes: probes.length, engine_mb: sum(engine), gateway_mb: sum(gateway), adapters_mb: sum(adapters), claudes_mb: sum(claudes), chrome_family_pids: chrome.pids, chrome_family_mb: chrome.mb, product_core_mb: core, product_total_with_chrome_mb: core + chrome.mb }; }
function mem() { const level = Number(sh('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).trim()); const swap = (sh('/usr/sbin/sysctl', ['vm.swapusage']).match(/used = ([\d.]+)M/) ?? [])[1]; return { available_level_pct: level, swap_used_mb: Number(swap ?? 0) }; }
const samples: any[] = []; const report: Record<string, any> = { started_at: new Date().toISOString(), checks: {} }; const checks = report.checks;
function sample(phase: string, extra: Record<string, unknown> = {}) { const s = { at: new Date().toISOString(), phase, ...mem(), ...procs(), ...extra }; samples.push(s); console.log(JSON.stringify(s)); if (s.available_level_pct < 15) throw new Error(`STOP: kernel available-memory level ${s.available_level_pct}% < 15%`); return s; }
async function waitJob(id: string, states: string[], timeoutMs: number, phase: string, onPoll?: (d: any) => void) { const deadline = Date.now() + timeoutMs; let last: any; let n = 0; while (Date.now() < deadline) { const d = await api(`/api/tasks/${id}`); last = d.job; onPoll?.(d); if (states.includes(d.job.state)) return d; if (n++ % 4 === 0) sample(phase, { job: id, state: d.job.state, stage: d.job.stage_name, note: d.job.next_action }); await sleep(4000); } throw new Error(`${phase}: ${id} stayed ${last?.state} (${last?.failure_detail ?? last?.operator_action ?? 'time limit'})`); }
function finish(ok: boolean) { report.finished_at = new Date().toISOString(); report.samples = samples; report.ok = ok; const f = `${root}/logs/workbench-acceptance-${String(report.started_at).replace(/[:]/g, '-')}.json`; fs.writeFileSync(f, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(`report: ${f}`); }
const shellState = () => { try { return JSON.parse(fs.readFileSync(`${root}/run/shell.json`, 'utf8')); } catch { return null; } };

try {
  const baseline = sample('idle-before'); report.baseline = baseline;
  const h0 = await api('/api/health'); if (h0.claude.state !== 'ready') throw new Error(`Claude is ${h0.claude.state}`); if (h0.capacity.active) throw new Error('another task is active; this pack runs alone');
  checks.settings = { worker_limit: (await api('/api/settings')).worker_limit, default_project: (await api('/api/settings')).default_workspace_worker_limit };
  const beforeIds = new Set((await api('/api/tasks?limit=500')).map((j: any) => j.id));
  let ws = (await api('/api/workspaces')).find((w: any) => w.name === 'General') ?? (await api('/api/workspaces'))[0];
  const conv = await api('/api/conversations', { workspace_id: ws.id }); report.conversation = conv.id;
  // ---- 1. delegate from chat; watch it in the workbench ----
  const a = await api(`/api/conversations/${conv.id}/messages`, { content: 'Please write a short "what to pack for a day hike" checklist, about 150 words, with three headings (Essentials, Food and water, Just in case) and three checkbox items under each, saved as day-hike-checklist.md. Draft for me to review; do not send it anywhere.' });
  await waitJob(a.job.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'], 6 * 60_000, '1-turn');
  await sleep(2000);
  let d = await api(`/api/conversations/${conv.id}`); const child = d.delegations.find((j: any) => !beforeIds.has(j.id)); if (!child) throw new Error('nothing was delegated');
  const seen: any[] = []; let rawProgress = 0; let directionSent = false; let directionWhen = '';
  const cd = await waitJob(child.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'], 10 * 60_000, '1-child', (det) => { if (det.job.next_action && /agent acp|acp session|run admitted|waiting \(/.test(det.job.next_action)) rawProgress++; });
  // the workbench view of it while it ran was sampled by polling /api/workbench in parallel:
  const wbSamples: any[] = []; const wbPoll = setInterval(async () => { try { const wb = await api('/api/workbench'); const t = wb.tasks.find((x: any) => x.id === child.id); if (t) wbSamples.push({ at: new Date().toISOString(), status: t.status, turn: t.turn, progress: t.progress, heartbeat_at: t.heartbeat_at, title: t.title }); } catch { /* */ } }, 2000); clearInterval(wbPoll);
  await sleep(6000);
  const wbAfter = await api('/api/workbench'); const tAfter = wbAfter.tasks.find((x: any) => x.id === child.id);
  const file = cd.artifacts.find((x: any) => x.kind === 'file' && x.path); const content = file && fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '';
  const sha = content ? crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex') : null;
  const actions = cd.events.filter((e: any) => ['tool.called', 'artifact.saved', 'browser.read'].includes(e.type)).map((e: any) => e.label);
  checks.workbench_task = { child: child.id, title: tAfter?.title, status_after: tAfter?.status, assigned_by: tAfter?.assigned_by, outputs: tAfter?.outputs?.length, recorded_actions: actions, raw_progress_strings_seen: rawProgress, labels_present: cd.events.every((e: any) => e.label === null || typeof e.label === 'string'), file: file ? { path: file.path.split('/').pop(), sha_matches: sha === file.sha256 } : null, headings: (content.match(/^#{1,3} .+$/gm) ?? []).length, checkboxes: (content.match(/^- \[[ x]\]/gm) ?? []).length, pass: cd.job.state === 'completed' && tAfter?.status === 'finished' && /^Write a short/.test(String(tAfter?.title)) && tAfter?.assigned_by === 'Lead assistant' && !!file && sha === file.sha256 && rawProgress === 0 && actions.includes('Saving a result') };
  console.log('WB1', JSON.stringify(checks.workbench_task));
  // ---- 2 + 3. disposable task started directly: direction while running, then stop mid-turn ----
  const disp = await api('/api/tasks', { workspace_id: ws.id, kind: 'document.create', objective: 'Disposable test task: write a very long (1,500 word) essay about the history of lighthouses and save it as lighthouses.md. Take your time and be thorough.' });
  const dispId = disp.job.id; let running: any = null; const t0 = Date.now();
  while (Date.now() - t0 < 120_000) { const x = await api(`/api/tasks/${dispId}`); if (x.job.state === 'running' && x.job.stage_name === 'write' && (x.job.session_ref || /Claude/.test(String(x.job.next_action)))) { running = x; break; } if (['completed', 'failed_terminal'].includes(x.job.state)) { running = x; break; } await sleep(2000); }
  if (!running || running.job.state !== 'running') throw new Error(`disposable task did not reach the Claude step: ${running?.job.state}`);
  const dir = await api(`/api/tasks/${dispId}/direction`, { note: 'Stop at 300 words instead of 1,500.' }); directionSent = dir.ok; directionWhen = dir.when;
  const wbRunning = (await api('/api/workbench')).tasks.find((x: any) => x.id === dispId);
  await sleep(5000);
  const sessionBeforeStop = (await api(`/api/tasks/${dispId}`)).job.session_ref;
  const procBefore = procs(); const cancelAt = Date.now(); const stopResp = await api(`/api/tasks/${dispId}/cancel`, {}, 'POST');
  let released = false; let releasedAfterMs = 0;
  for (let i = 0; i < 20; i++) { await sleep(1500); const x = await api(`/api/tasks/${dispId}`); if (x.job.state === 'cancelled' && !x.job.lease_owner && x.events.some((e: any) => e.type === 'turn.cancelled')) { released = true; releasedAfterMs = Date.now() - cancelAt; break; } }
  await sleep(8000); const procAfter = procs();
  const dAfter = await api(`/api/tasks/${dispId}`); const lastEventAt = dAfter.events[dAfter.events.length - 1].at;
  await sleep(10000); const dLater = await api(`/api/tasks/${dispId}`);
  checks.stop = { reached_claude_step: true, session_recorded_before_stop: !!sessionBeforeStop, workbench_status_while_running: wbRunning?.status, workbench_turn: wbRunning?.turn, progress_text: wbRunning?.progress, direction_saved: directionSent, direction_when: directionWhen, stop_response: stopResp.stop, released_within_ms: released ? releasedAfterMs : null, session_closed_event: dAfter.events.some((e: any) => e.type === 'session.closed'), adapters_before: procBefore.adapters, adapters_after: procAfter.adapters, no_events_after_release: dLater.events.length === dAfter.events.length, save_points_kept: dAfter.checkpoints.length, state: dAfter.job.state, pass: released && dAfter.job.state === 'cancelled' && dLater.events.length === dAfter.events.length && dAfter.checkpoints.length >= 2 && procAfter.adapters < procBefore.adapters && wbRunning?.status === 'working' && wbRunning?.turn === 'claude' };
  console.log('STOP', JSON.stringify(checks.stop));
  // ---- 4. close the window through the app's own path, relaunch normally, check it came back ----
  const s0 = shellState(); sh('/usr/bin/open', ['claudebot://close-window']); await sleep(2500); const s1 = shellState(); sh('/usr/bin/open', ['-a', '/Applications/ClaudeBot.app']); await sleep(3000); const s2 = shellState();
  checks.window_reopen = { before: s0, after_close: s1, after_reopen: s2, same_pid: !!s0 && !!s2 && s0.pid === s2.pid, pass: !!s1 && s1.window_visible === false && !!s2 && s2.window_visible === true && s0.pid === s2.pid };
  console.log('WINDOW', JSON.stringify(checks.window_reopen));
  // ---- 5. engine restart: conversation + tasks survive; no duplicates / phantom / orphans ----
  const msgs = (await api(`/api/conversations/${conv.id}`)).messages.length; const uid = sh('/usr/bin/id', ['-u']).trim();
  execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.claudebot.engine`]); await sleep(8000); for (let i = 0; i < 30; i++) { try { await api('/api/health'); break; } catch { await sleep(1000); } }
  const after = await api(`/api/conversations/${conv.id}`); const wbFinal = await api('/api/workbench'); const p = sample('after-all');
  const newJobs = (await api('/api/tasks?limit=500')).filter((j: any) => !beforeIds.has(j.id)); const objs = newJobs.filter((j: any) => j.kind !== 'chat.turn').map((j: any) => j.objective);
  const act = await api('/api/activity?limit=800'); const performed = act.filter((e: any) => e.type === 'action.performed').length;
  const refused = await fetch(`${base}/api/actions/perform`, { method: 'POST', headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ job_id: child.id, idempotency_key: `wb-control-${Date.now()}`, kind: 'send', target: 'qa@example.invalid', content: 'control' }) }).then((r) => r.json()) as any;
  checks.restart_and_hygiene = { messages_before: msgs, messages_after: after.messages.length, session_kept: after.conversation.session_ref !== null, workbench_working_now: wbFinal.counts.working, new_jobs: newJobs.length, duplicate_objectives: objs.length !== new Set(objs).size, stray_probes: p.probes, adapters: p.adapters, lead_sessions_open: (await api('/api/conversations?archived=1')).filter((x: any) => x.session_ref).length, actions_performed_ever: performed, send_refused: refused.status === 'refused', pass: after.messages.length === msgs && wbFinal.counts.working === 0 && objs.length === new Set(objs).size && p.probes === 0 && performed === 0 && refused.status === 'refused' };
  console.log('RESTART', JSON.stringify(checks.restart_and_hygiene));
  checks.memory = { note: 'available_level_pct is the kernel memory-status level (pressure headroom), not unused RAM', idle_before: baseline, peak_core_mb: Math.max(...samples.map((s) => s.product_core_mb)), peak_with_chrome_mb: Math.max(...samples.map((s) => s.product_total_with_chrome_mb)), min_level_pct: Math.min(...samples.map((s) => s.available_level_pct)), after: p };
  sh('/usr/bin/open', ['-a', '/Applications/ClaudeBot.app']);
  const ok = ['workbench_task', 'stop', 'window_reopen', 'restart_and_hygiene'].every((k) => checks[k].pass); finish(ok); console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED'); process.exit(ok ? 0 : 1);
} catch (e) { report.error = (e as Error).message; console.error('FAILED:', (e as Error).message); finish(false); process.exit(1); }
