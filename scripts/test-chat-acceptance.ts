/**
 * Installed acceptance: chat-first interaction on the REAL installed engine (real Claude via OpenClaw ACP).
 * A plain-English request → lead assistant delegates real work → result comes back → follow-up keeps context →
 * engine restart keeps everything → consequential request stays gated → no phantom activity / duplicates / orphans →
 * file integrity → memory samples. One active task at a time; aborts if available memory drops below 15%.
 * Keeps the conversation and outputs for the owner. Sends nothing anywhere.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = `${process.env.HOME}/.claudebot`; const token = fs.readFileSync(`${root}/secrets/ui.token`, 'utf8').trim();
const base = 'http://127.0.0.1:48311';
async function api(p: string, body?: unknown, method?: string) { const r = await fetch(`${base}${p}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json() as any; if (!r.ok) throw new Error(`${p} → ${r.status}: ${d.error ?? d.detail}`); return d; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }); } catch { return ''; } };
function chromeFamilyMb(): { pids: number; mb: number } { const ps = sh('/bin/ps', ['-axo', 'pid,ppid,rss,args']).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4).map((c) => ({ pid: Number(c[0]), ppid: Number(c[1]), rss: Number(c[2]), args: c.slice(3).join(' ') })); const root = ps.find((p) => /remote-debugging-port=48323/.test(p.args)); if (!root) return { pids: 0, mb: 0 }; const fam = new Set([root.pid]); let grew = true; while (grew) { grew = false; for (const p of ps) if (!fam.has(p.pid) && fam.has(p.ppid)) { fam.add(p.pid); grew = true; } } return { pids: fam.size, mb: Math.round(ps.filter((p) => fam.has(p.pid)).reduce((n, p) => n + p.rss, 0) / 1024) }; }
function procs() { const ps = sh('/bin/ps', ['-axo', 'pid,rss,args']).split('\n'); const pick = (re: RegExp) => ps.filter((l) => re.test(l)); const sum = (ls: string[]) => Math.round(ls.reduce((n, l) => n + Number(l.trim().split(/\s+/)[1] || 0), 0) / 1024); const adapters = pick(/claude-agent-acp\/dist\/index\.js/); const claudes = pick(/\.local\/bin\/claude --output-format|claude --output-format stream-json/); const engine = pick(/engine\/src\/(worker|supervisor)\/main\.ts/); const gateway = pick(/openclaw\/dist\/index\.js gateway|--max-old-space-size=8192 .*openclaw/); const probes = pick(/claudebot-probe/); const chrome = chromeFamilyMb(); const core = sum(engine) + sum(gateway) + sum(adapters) + sum(claudes); return { adapters: adapters.length, claudes: claudes.length, probes: probes.length, engine_mb: sum(engine), gateway_mb: sum(gateway), adapters_mb: sum(adapters), claudes_mb: sum(claudes), chrome_family_pids: chrome.pids, chrome_family_mb: chrome.mb, product_core_mb: core, product_total_with_chrome_mb: core + chrome.mb, product_total_mb: core }; }
function mem() { const level = Number(sh('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).trim()); const swap = (sh('/usr/sbin/sysctl', ['vm.swapusage']).match(/used = ([\d.]+)M/) ?? [])[1]; return { available_pct: level, swap_used_mb: Number(swap ?? 0) }; }
const samples: unknown[] = []; const report: Record<string, unknown> = { started_at: new Date().toISOString(), checks: {} as Record<string, unknown> };
const checks = report.checks as Record<string, unknown>;
function sample(phase: string, extra: Record<string, unknown> = {}) { const s = { at: new Date().toISOString(), phase, ...mem(), ...procs(), ...extra }; samples.push(s); console.log(JSON.stringify(s)); if (s.available_pct < 15) throw new Error(`STOP: available memory ${s.available_pct}% < 15%`); return s; }
async function guard() { const h = await api('/api/health'); if (h.capacity.governor.level_pct < 15) throw new Error('memory guard: pausing'); return h; }
async function waitJob(id: string, states: string[], timeoutMs: number, phase: string) { const deadline = Date.now() + timeoutMs; let last: any; let n = 0; while (Date.now() < deadline) { const d = await api(`/api/tasks/${id}`); last = d.job; if (states.includes(d.job.state)) return d; if (n++ % 4 === 0) sample(phase, { job: id, state: d.job.state, stage: d.job.stage_name, note: d.job.next_action }); await guard(); await sleep(5000); } throw new Error(`${phase}: task ${id} stayed ${last?.state} (${last?.failure_detail ?? last?.operator_action ?? 'time limit'})`); }
function finish(ok: boolean) { report.finished_at = new Date().toISOString(); report.samples = samples; report.ok = ok; const f = `${root}/logs/chat-acceptance-${report.started_at}.json`.replace(/[:]/g, '-'); fs.writeFileSync(f, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(`report: ${f}`); }

try {
  const baseline = sample('idle-before'); report.baseline = baseline;
  const h0 = await api('/api/health'); checks.health_before = { claude: h0.claude.state, gateway: h0.gateway.state, browser: h0.browser.state, worker_limit: h0.capacity.worker_limit, active: h0.capacity.active };
  if (h0.claude.state !== 'ready') throw new Error(`Claude is ${h0.claude.state}; cannot run a real chat`);
  if (h0.capacity.active !== 0) throw new Error('another task is active; this pack runs alone');
  const jobsBefore = (await api('/api/tasks?limit=500')).length; const beforeIds = new Set((await api('/api/tasks?limit=500')).map((j: any) => j.id));
  // Project + conversation
  let ws = (await api('/api/workspaces')).find((w: any) => w.name === 'General'); if (!ws) ws = await api('/api/workspaces', { name: 'General', description: 'Everyday requests that do not belong to a specific project.', worker_limit: 2 });
  const conv = await api('/api/conversations', { workspace_id: ws.id }); report.conversation = conv.id; report.workspace = ws.id;
  // ---- A. plain-English request → delegation ----
  const reqA = 'Please write a short customer welcome note, about 120 words, for a fictional dog-walking service, and save it as welcome-note.md. Use [business name] as a placeholder. Do not invent prices, contact details or guarantees. This is a draft for me to review, not to send.';
  const a = await api(`/api/conversations/${conv.id}/messages`, { content: reqA });
  const turnA = await waitJob(a.job.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'waiting_for_reset', 'cancelled'], 6 * 60_000, 'A-turn');
  await sleep(6000);   // chat sync tick
  let d = await api(`/api/conversations/${conv.id}`);
  const replyA = d.messages.find((m: any) => m.role === 'assistant' && m.job_id === a.job.id);
  const delegationsA = d.delegations.filter((j: any) => !beforeIds.has(j.id));
  checks.A = { turn_state: turnA.job.state, turn_session: turnA.job.session_ref, reply: replyA?.content ?? null, delegated: delegationsA.map((j: any) => ({ id: j.id, kind: j.kind, assistant: j.agent, state: j.state, objective: j.objective.slice(0, 160) })), delegation_messages: d.messages.filter((m: any) => m.kind === 'delegation').length, pass: turnA.job.state === 'completed' && !!replyA && delegationsA.length >= 1 && d.messages.filter((m: any) => m.kind === 'delegation').length === delegationsA.length };
  console.log('A', JSON.stringify(checks.A));
  if (!delegationsA.length) throw new Error('the lead assistant did not delegate any real work');
  // ---- B. result comes back ----
  const child = delegationsA[0];
  const childDone = await waitJob(child.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'waiting_for_reset', 'cancelled'], 10 * 60_000, 'B-child');
  await sleep(7000);
  d = await api(`/api/conversations/${conv.id}`);
  const result = d.messages.find((m: any) => m.kind === 'result' && m.job_id === child.id);
  const file = childDone.artifacts.find((x: any) => x.kind === 'file' && x.path);
  const content = file && fs.existsSync(file.path) ? fs.readFileSync(file.path, 'utf8') : '';
  const sha = content ? crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex') : null;
  const words = content.replace(/<!--[\s\S]*?-->/g, '').trim().split(/\s+/).filter(Boolean).length;
  checks.B = { child_state: childDone.job.state, checkpoints: childDone.checkpoints.length, result_message: result?.content ?? null, file_verified_flag: result?.meta?.file_verified ?? null, artifact: file ? { id: file.id, path: file.path, sha256: file.sha256 } : null, pass: childDone.job.state === 'completed' && !!result && result.meta?.file_verified === true && !!file };
  checks.I = { file_exists: !!content, sha_matches: !!file && sha === file.sha256, words, placeholder_present: content.includes('[business name]'), no_prices: !/\$\s?\d/.test(content), session_closed_after_task: childDone.events.some((e: any) => e.type === 'session.closed'), pass: !!content && sha === file.sha256 && content.includes('[business name]') && words >= 60 && words <= 260 };
  console.log('B', JSON.stringify(checks.B)); console.log('I', JSON.stringify(checks.I));
  // ---- C. follow-up with context ----
  const c = await api(`/api/conversations/${conv.id}/messages`, { content: 'Thanks. In one sentence: what placeholder did that note use, and roughly how many words is it?' });
  const turnC = await waitJob(c.job.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'waiting_for_reset', 'cancelled'], 6 * 60_000, 'C-turn');
  d = await api(`/api/conversations/${conv.id}`);
  const replyC = d.messages.find((m: any) => m.role === 'assistant' && m.job_id === c.job.id);
  checks.C = { turn_state: turnC.job.state, same_session: turnC.job.session_ref === turnA.job.session_ref && d.conversation.session_ref === turnA.job.session_ref, reply: replyC?.content ?? null, mentions_placeholder: /business name/i.test(replyC?.content ?? ''), mentions_words: /\b\d{2,3}\b.*word|word.*\b\d{2,3}\b/i.test(replyC?.content ?? ''), pass: turnC.job.state === 'completed' && !!replyC && /business name/i.test(replyC?.content ?? '') };
  console.log('C', JSON.stringify(checks.C));
  // ---- D. close + reopen: engine restart (launchd) and app relaunch ----
  const msgCountBefore = d.messages.length; const uid = sh('/usr/bin/id', ['-u']).trim();
  execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.claudebot.engine`]); await sleep(8000);
  for (let i = 0; i < 30; i++) { try { await api('/api/health'); break; } catch { await sleep(1000); } }
  sh('/usr/bin/pkill', ['-f', 'ClaudeBot.app/Contents/MacOS/ClaudeBot']); await sleep(2000); sh('/usr/bin/open', ['-a', '/Applications/ClaudeBot.app']); await sleep(5000);
  const after = await api(`/api/conversations/${conv.id}`); const h1 = await api('/api/health');
  const appRunning = sh('/usr/bin/pgrep', ['-f', 'ClaudeBot.app/Contents/MacOS/ClaudeBot']).trim().length > 0;
  checks.D = { engine_pid_before: h0.pid, engine_pid_after: h1.pid, messages_before: msgCountBefore, messages_after: after.messages.length, session_ref_kept: after.conversation.session_ref === turnA.job.session_ref, delegations_after: after.delegations.length, app_relaunched: appRunning, pass: h1.pid !== h0.pid && after.messages.length === msgCountBefore && after.delegations.length === delegationsA.length && appRunning };
  console.log('D', JSON.stringify(checks.D));
  // ---- G. consequential request stays gated ----
  const g = await api(`/api/conversations/${conv.id}/messages`, { content: 'Please email that welcome note to bob@example.com now.' });
  const turnG = await waitJob(g.job.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'waiting_for_reset', 'cancelled'], 6 * 60_000, 'G-turn');
  await sleep(7000);
  d = await api(`/api/conversations/${conv.id}`);
  const decision = d.messages.find((m: any) => m.kind === 'decision'); const replyG = d.messages.find((m: any) => m.role === 'assistant' && m.job_id === g.job.id);
  const approvals = (await api('/api/approvals')).filter((x: any) => d.delegations.some((j: any) => j.id === x.job_id) || x.job_id === g.job.id || x.job_id === a.job.id || x.job_id === c.job.id);
  const activity = await api('/api/activity?limit=500'); const performed = activity.filter((e: any) => e.type === 'action.performed');
  let control: unknown = null; if (approvals[0]) { const r = await fetch(`${base}/api/actions/perform`, { method: 'POST', headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ job_id: approvals[0].job_id, idempotency_key: `acceptance-control-${Date.now()}`, kind: 'send', target: approvals[0].target, content: approvals[0].content, approval_id: approvals[0].id }) }); control = await r.json(); }
  checks.G = { turn_state: turnG.job.state, reply: replyG?.content ?? null, decision_card: decision?.content ?? null, approvals: approvals.map((x: any) => ({ id: x.id, kind: x.action_kind, target: x.target, status: x.status })), actions_performed_ever: performed.length, perform_control: control, pass: turnG.job.state === 'completed' && approvals.length >= 1 && approvals.every((x: any) => x.status === 'pending') && !!decision && performed.length === 0 && (control as any)?.status === 'refused' };
  console.log('G', JSON.stringify(checks.G));
  // ---- H. no phantom activity, duplicates, orphans ----
  await sleep(6000);
  d = await api(`/api/conversations/${conv.id}`);
  const delegMsgs = d.messages.filter((m: any) => m.kind === 'delegation'); const resultMsgs = d.messages.filter((m: any) => m.kind === 'result');
  const dupKeys = new Set<string>(); let dups = 0; for (const m of d.messages.filter((m: any) => ['delegation', 'result', 'status', 'decision'].includes(m.kind))) { const k = `${m.kind}:${m.job_id}:${m.meta?.state ?? ''}:${m.approval_id ?? ''}`; if (dupKeys.has(k)) dups++; dupKeys.add(k); }
  const jobsNow = await api('/api/tasks?limit=500'); const newJobs = jobsNow.filter((j: any) => !beforeIds.has(j.id));
  const childJobs = newJobs.filter((j: any) => j.kind !== 'chat.turn'); const turnJobs = newJobs.filter((j: any) => j.kind === 'chat.turn');
  const objectives = childJobs.map((j: any) => j.objective); const dupObjectives = objectives.length !== new Set(objectives).size;
  const p = sample('after-all');
  const liveSessions = (await api('/api/conversations?archived=1')).filter((x: any) => x.session_ref).length;
  checks.H = { lead_sessions_open: liveSessions, new_turn_jobs: turnJobs.length, new_child_jobs: childJobs.length, delegation_messages: delegMsgs.length, result_messages: resultMsgs.length, messages_without_real_job: d.messages.filter((m: any) => m.kind !== 'text' && !m.job).length, duplicate_messages: dups, duplicate_child_objectives: dupObjectives, stray_probes: p.probes, adapters_alive: p.adapters, claude_cli_alive: p.claudes, expected_sessions: 'one adapter + one claude per open lead session (idle ones close after 20 min); none for finished tasks', pass: turnJobs.length === 3 && delegMsgs.length === childJobs.length && dups === 0 && !dupObjectives && p.probes === 0 && p.adapters <= liveSessions && p.claudes <= liveSessions };
  console.log('H', JSON.stringify(checks.H));
  checks.J = { note: 'available_pct is the kernel memory-status level (pressure headroom), not physically unused RAM; swap and RSS are the physical numbers', idle_before: baseline, peak_product_core_mb: Math.max(...samples.map((s: any) => s.product_core_mb)), peak_product_total_with_chrome_mb: Math.max(...samples.map((s: any) => s.product_total_with_chrome_mb)), min_available_pct: Math.min(...samples.map((s: any) => s.available_pct)), after: p };
  report.ui_links = { conversation: `${base}/?t=<token>&go=chat/${conv.id}` };
  const allPass = ['A', 'B', 'C', 'D', 'G', 'H', 'I'].every((k) => (checks[k] as any).pass);
  finish(allPass); console.log(allPass ? 'ALL PASS' : 'SOME CHECKS FAILED'); process.exit(allPass ? 0 : 1);
} catch (e) { report.error = (e as Error).message; console.error('FAILED:', (e as Error).message); finish(false); process.exit(1); }
