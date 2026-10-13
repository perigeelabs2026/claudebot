/**
 * Installed proofs on the real engine (one active task at a time): successful and blocked reads, direction that reaches the next
 * Claude step and changes the work, read-only session inspection, a schedule that survives an engine restart and runs once,
 * a bounded code task with engine-run tests, and the 180 s per-turn boundary. Aborts below 15% kernel memory level.
 * Nothing is sent or published; no login, MFA or CAPTCHA is attempted (a blocked read is left for the owner, then cancelled).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = `${process.env.HOME}/.claudebot`; const token = fs.readFileSync(`${root}/secrets/ui.token`, 'utf8').trim(); const base = 'http://127.0.0.1:48311';
async function api(p: string, body?: unknown, method?: string) { const r = await fetch(`${base}${p}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json() as any; if (!r.ok) throw new Error(`${p} → ${r.status}: ${d.error ?? d.detail}`); return d; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }); } catch { return ''; } };
const level = () => Number(sh('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).trim());
const report: Record<string, any> = { started_at: new Date().toISOString(), checks: {} }; const checks = report.checks; const samples: any[] = [];
function sample(phase: string, extra: Record<string, unknown> = {}) { const ps = sh('/bin/ps', ['-axo', 'rss,args']).split('\n'); const sum = (re: RegExp) => Math.round(ps.filter((l) => re.test(l)).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024); const s = { at: new Date().toISOString(), phase, level_pct: level(), engine_mb: sum(/engine\/src\/(worker|supervisor)\/main\.ts/), gateway_mb: sum(/--max-old-space-size=8192 .*openclaw/), sessions_mb: sum(/claude-agent-acp\/dist\/index\.js|claude --output-format stream-json/), adapters: ps.filter((l) => /claude-agent-acp\/dist\/index\.js/.test(l)).length, probes: ps.filter((l) => /claudebot-probe/.test(l)).length, ...extra }; samples.push(s); console.log(JSON.stringify(s)); if (s.level_pct < 15) throw new Error('STOP: memory level < 15%'); return s; }
async function waitJob(id: string, states: string[], timeoutMs: number, phase: string, onPoll?: (d: any) => Promise<void> | void) { const deadline = Date.now() + timeoutMs; let last: any; let n = 0; while (Date.now() < deadline) { const d = await api(`/api/tasks/${id}`); last = d.job; if (onPoll) await onPoll(d); if (states.includes(d.job.state)) return d; if (n++ % 6 === 0) sample(phase, { job: id, state: d.job.state, stage: d.job.stage_name, note: d.job.next_action }); await sleep(2500); } throw new Error(`${phase}: ${id} stayed ${last?.state} (${last?.failure_detail ?? last?.operator_action ?? 'time limit'})`); }
async function waitTurn(convId: string, jobId: string, phase: string) { await waitJob(jobId, ['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'], 6 * 60_000, phase); await sleep(2500); return api(`/api/conversations/${convId}`); }
function finish(ok: boolean) { report.finished_at = new Date().toISOString(); report.samples = samples; report.ok = ok; const f = `${root}/logs/truth-acceptance-${String(report.started_at).replace(/[:]/g, '-')}.json`; fs.writeFileSync(f, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(`report: ${f}`); }
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean); const want = (k: string) => !ONLY.length || ONLY.includes(k);
const tabs = async () => { try { return ((await (await fetch('http://127.0.0.1:48323/json', { signal: AbortSignal.timeout(2000) })).json()) as any[]).filter((t) => t.type === 'page').map((t) => t.id); } catch { return [] as string[]; } };

try {
  sample('idle-before'); const h0 = await api('/api/health'); if (h0.claude.state !== 'ready') throw new Error(`Claude ${h0.claude.state}`); if (h0.capacity.active) throw new Error('another task is active');
  const beforeIds = new Set((await api('/api/tasks?limit=800')).map((j: any) => j.id));
  const ws = (await api('/api/workspaces')).find((w: any) => w.name === 'General') ?? (await api('/api/workspaces'))[0];
  const conv = await api('/api/conversations', { workspace_id: ws.id }); report.conversation = conv.id;
  // ---- T1: successful read with bounded tabs ----
  if (want('T1') || want('T2') || want('T4')) {
  const tabsBefore = await tabs();
  const t1 = await api(`/api/conversations/${conv.id}/messages`, { content: 'Please read https://example.com in the browser and tell me its main heading and first sentence. Read only.' });
  let d = await waitTurn(conv.id, t1.job.id, 'T1-turn'); let child = d.delegations.find((j: any) => !beforeIds.has(j.id) && j.kind.startsWith('browser.')); if (!child) throw new Error('T1: no browser task delegated');
  const c1 = await waitJob(child.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'], 8 * 60_000, 'T1-read'); await sleep(7000);
  d = await api(`/api/conversations/${conv.id}`); const card1 = d.messages.find((m: any) => m.kind === 'result' && m.job_id === child.id); const tabsAfter = await tabs();
  const wb1 = (await api('/api/workbench')).tasks.find((t: any) => t.id === child.id);
  checks.T1_success_read = { task: child.id, state: c1.job.state, outcome: c1.job.outcome, outcome_reported: c1.events.find((e: any) => e.type === 'outcome.reported')?.detail?.outcome ?? null, card: card1?.content, card_outcome: card1?.meta?.outcome, office_state: wb1?.plain_state, tab_opened: c1.events.some((e: any) => e.type === 'browser.tab'), tabs_released: c1.events.find((e: any) => e.type === 'browser.tabs_released')?.detail ?? null, tabs_before: tabsBefore.length, tabs_after: tabsAfter.length, honest_partial: c1.job.outcome === 'partial' && !!(JSON.parse(c1.job.outcome_detail || '{}').remaining), pass: c1.job.state === 'completed' && (c1.job.outcome === 'success' ? !!card1 && /Ready to review/.test(card1.content) : c1.job.outcome === 'partial' && !!card1 && /Partial result/.test(card1.content) && !!(JSON.parse(c1.job.outcome_detail || '{}').remaining)) && c1.events.some((e: any) => e.type === 'outcome.reported') && tabsAfter.length <= tabsBefore.length && c1.events.some((e: any) => e.type === 'browser.tabs_released') };
  console.log('T1', JSON.stringify(checks.T1_success_read));
  // ---- T2: blocked read (sign-in wall) → paused for the owner, never "Ready to review" ----
  const t2 = await api(`/api/conversations/${conv.id}/messages`, { content: 'Please read my LinkedIn feed at https://www.linkedin.com/feed/ and tell me the first three post headlines. Do not sign in yourself; just tell me what you can see.' });
  d = await waitTurn(conv.id, t2.job.id, 'T2-turn'); child = d.delegations.find((j: any) => !beforeIds.has(j.id) && j.id !== checks.T1_success_read.task); if (!child) throw new Error('T2: nothing delegated');
  const c2 = await waitJob(child.id, ['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'], 8 * 60_000, 'T2-read'); await sleep(7000);
  d = await api(`/api/conversations/${conv.id}`); const msgs2 = d.messages.filter((m: any) => m.job_id === child.id && ['result', 'status'].includes(m.kind)); const wb2 = (await api('/api/workbench')).tasks.find((t: any) => t.id === child.id);
  const blockedOk = (c2.job.state === 'waiting_for_auth' && String(c2.job.waiting_on).startsWith('browser:')) || (c2.job.state === 'failed_terminal' && c2.job.blocker_code === 'BLOCKED');
  checks.T2_blocked_read = { task: child.id, state: c2.job.state, waiting_on: c2.job.waiting_on, blocker: c2.job.blocker_code, outcome: c2.job.outcome, outcome_detail: c2.job.outcome_detail, operator_action: c2.job.operator_action, conversation_cards: msgs2.map((m: any) => m.content.slice(0, 160)), office_state: wb2?.plain_state, office_status: wb2?.status, never_ready_to_review: !msgs2.some((m: any) => /Ready to review/.test(m.content)), session_released: c2.events.some((e: any) => e.type === 'session.closed'), pass: blockedOk && c2.job.outcome === 'blocked' && !msgs2.some((m: any) => /Ready to review/.test(m.content)) && msgs2.length >= 1 && wb2?.status !== 'finished' };
  console.log('T2', JSON.stringify(checks.T2_blocked_read));
  if (c2.job.state === 'waiting_for_auth') { await api(`/api/tasks/${child.id}/cancel`, {}, 'POST'); checks.T2_blocked_read.cleanup = 'cancelled (sign-in is owner-only; not attempted)'; }
  // ---- T4: read-only session inspection on the lead session (no model turn) ----
  const before4 = await api(`/api/conversations/${conv.id}`); const turnJob = t2.job.id; const ev4 = (await api(`/api/tasks/${turnJob}`)).events.length;
  const insp = await api(`/api/workbench/${turnJob}/session`); await sleep(3000);
  const after4 = await api(`/api/conversations/${conv.id}`); const ev4b = (await api(`/api/tasks/${turnJob}`)).events.length;
  checks.T4_session_inspection = { available: insp.available, detail: insp.detail ?? null, text_head: (insp.text || '').slice(0, 300), session: insp.session ?? null, messages_unchanged: after4.messages.length === before4.messages.length, active_turn_after: after4.active_turn, events_unchanged: ev4 === ev4b, pass: insp.available === true && /session|backend|state/i.test(insp.text || '') && after4.messages.length === before4.messages.length && !after4.active_turn };
  console.log('T4', JSON.stringify(checks.T4_session_inspection));
  }
  // ---- T3: direction reaches the next Claude step and changes the work ----
  if (want('T3')) {
  const t3 = await api('/api/tasks', { workspace_id: ws.id, kind: 'team.plan_build_review', objective: 'Write a short note (two paragraphs) about why tide pools matter to coastal ecosystems. The plan step lists the sections; the build step writes the note as tide-pools.md.' });
  let directed = false; let dirWhen = '';
  const c3 = await waitJob(t3.job.id, ['completed', 'failed_terminal', 'cancelled'], 12 * 60_000, 'T3-direction', async (det) => { if (!directed && det.job.state === 'running' && det.job.stage_name === 'plan') { const r = await api(`/api/tasks/${t3.job.id}/direction`, { note: 'When you write the note in the build step, make its title exactly "Tide Pools, Revised" and end it with the sentence "Reviewed per owner direction."' }); directed = true; dirWhen = r.when; } });
  const built = c3.artifacts.find((a: any) => a.kind === 'file' && /tide/i.test(a.title + ' ' + (a.path || '')) && !/plan/i.test(a.path || '')) || c3.artifacts.find((a: any) => a.kind === 'file' && !/plan\.md$/.test(a.path || ''));
  const builtText = built && fs.existsSync(built.path) ? fs.readFileSync(built.path, 'utf8') : '';
  const delivered = c3.events.find((e: any) => e.type === 'owner.direction.delivered');
  checks.T3_direction_changes_work = { task: t3.job.id, directed_during_plan: directed, when: dirWhen, delivered_at: delivered?.detail?.how ?? null, state: c3.job.state, built_file: built?.path?.split('/').pop() ?? null, title_applied: /Tide Pools, Revised/.test(builtText), sentence_applied: /Reviewed per owner direction/.test(builtText), sha_ok: !!built && crypto.createHash('sha256').update(fs.readFileSync(built.path)).digest('hex') === built.sha256, pass: directed && !!delivered && /step build/.test(String(delivered.detail.how)) && /Tide Pools, Revised/.test(builtText) && c3.job.state === 'completed' };
  console.log('T3', JSON.stringify(checks.T3_direction_changes_work));
  }
  // ---- T6: bounded code task with engine-run tests in a disposable repository ----
  if (want('T6')) {
  const repo = `${process.env.HOME}/ClaudeBot-Repos/demo-${Date.now()}`; fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(`${repo}/package.json`, JSON.stringify({ name: 'demo', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2));
  fs.writeFileSync(`${repo}/sum.js`, "module.exports = { add: (a, b) => a - b };\n"); fs.writeFileSync(`${repo}/sum.test.js`, "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('./sum');\ntest('add adds', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n");
  const t6 = await api('/api/tasks', { workspace_id: ws.id, kind: 'code.task', objective: 'The test in sum.test.js fails because add() subtracts. Fix add() in sum.js so it adds its two arguments. Do not change the test.', inputs: { repository: repo, change: 'fix add()', test_command: 'node --test' } });
  const c6 = await waitJob(t6.job.id, ['completed', 'failed_terminal', 'cancelled'], 12 * 60_000, 'T6-code');
  const testOut = c6.artifacts.find((a: any) => /Test output/.test(a.title)); const changes = c6.artifacts.find((a: any) => /CHANGES/.test(a.path || ''));
  const outText = testOut && fs.existsSync(testOut.path) ? fs.readFileSync(testOut.path, 'utf8') : '';
  checks.T6_code_task = { task: t6.job.id, repo, state: c6.job.state, outcome: c6.job.outcome, sum_js: fs.readFileSync(`${repo}/sum.js`, 'utf8').trim(), test_output_title: testOut?.title ?? null, test_output_pass: /pass 1/.test(outText) && /fail 0/.test(outText), changes_sha_ok: !!changes && crypto.createHash('sha256').update(fs.readFileSync(changes.path)).digest('hex') === changes.sha256, command_ran_event: c6.events.some((e: any) => e.type === 'command.ran'), pass: c6.job.state === 'completed' && c6.job.outcome === 'success' && /pass 1/.test(outText) && !!changes };
  console.log('T6', JSON.stringify(checks.T6_code_task));
  }
  // ---- T7: the 180 s boundary (acpx timeoutSeconds applies per turn; this backend rejects /acp timeout) ----
  if (want('T7')) {
  const t7 = await api('/api/tasks', { workspace_id: ws.id, kind: 'document.create', objective: 'Write a very thorough 7,000-word essay on the history of lighthouses, in eight titled sections (ancient beacons, the Pharos of Alexandria, Roman and medieval coastal lights, the Eddystone lighthouses, Fresnel lenses, the age of iron and offshore towers, keepers and daily life, automation and the present), saved as lighthouses.md. Write the whole essay in one pass; do not stop early.' });
  const t7start = Date.now(); let turnFailures: any[] = [];
  const c7 = await waitJob(t7.job.id, ['completed', 'failed_terminal', 'cancelled'], 25 * 60_000, 'T7-long', async (det) => { turnFailures = det.events.filter((e: any) => e.type === 'job.transition' && e.detail.to === 'retry_scheduled').map((e: any) => e.detail); });
  const essay = c7.artifacts.find((a: any) => a.kind === 'file'); const essayText = essay && fs.existsSync(essay.path) ? fs.readFileSync(essay.path, 'utf8') : '';
  const workerLog = sh('/usr/bin/tail', ['-n', '600', `${root}/logs/worker.log`]); const timeoutSet = workerLog.split('\n').filter((l) => /acp (session timeout|per-session timeout|timeout not applied)/.test(l)).slice(-3).map((l) => l.slice(0, 260)); const turnErrors = c7.events.filter((e: any) => e.type === 'job.transition' && ['retry_scheduled', 'queued'].includes(e.detail.to)).map((e: any) => e.detail);
  const writeCp = c7.checkpoints.filter((c: any) => c.stage_name === 'write');
  const writeBefore = c7.checkpoints.find((c: any) => c.stage_name === 'write' && c.phase === 'before'); const writeAfter = [...c7.checkpoints].reverse().find((c: any) => c.stage_name === 'write' && c.phase === 'after');
  checks.T7_long_turn = { task: t7.job.id, state: c7.job.state, wall_ms: Date.now() - t7start, write_step_ms: writeBefore && writeAfter ? Date.parse(writeAfter.created_at) - Date.parse(writeBefore.created_at) : null, words: essayText.split(/\s+/).filter(Boolean).length, files: c7.artifacts.filter((a: any) => a.kind === 'file').length, retries: turnFailures, turn_errors: turnErrors, write_attempts: Math.max(0, ...writeCp.map((c: any) => c.attempt)), acp_timeout_log: timeoutSet, session_ref: c7.job.session_ref, continuation_prompt_used: writeCp.some((c: any) => c.attempt > 1), boundary_crossed: !!writeBefore && !!writeAfter && Date.parse(writeAfter.created_at) - Date.parse(writeBefore.created_at) > 180_000, pass: c7.job.state === 'completed' && !!essay && c7.artifacts.filter((a: any) => a.kind === 'file').length === 1 };
  console.log('T7', JSON.stringify(checks.T7_long_turn));
  }
  // ---- T5: a safe schedule survives an engine restart before it fires and runs once (interval 300 s; window 330 s) ----
  if (want('T5')) {
  const sched = await api('/api/automations', { workspace_id: ws.id, name: 'acceptance schedule (safe, deterministic)', kind: 'system.workspace_summary', objective: 'Scheduled project summary', every_seconds: 300 });
  const uid = sh('/usr/bin/id', ['-u']).trim(); execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.claudebot.engine`]); await sleep(8000); for (let i = 0; i < 30; i++) { try { await api('/api/health'); break; } catch { await sleep(1000); } }
  const h5 = await api('/api/health');
  await sleep(330_000);
  const runs = (await api('/api/tasks?limit=800')).filter((j: any) => j.schedule_id === sched.id);
  await api(`/api/automations/${sched.id}/disable`, {}, 'POST'); await api(`/api/automations/${sched.id}`, undefined, 'DELETE');
  const survived = (await api('/api/automations')).some((s: any) => s.id === sched.id);
  checks.T5_schedule_restart = { schedule: sched.id, engine_pid_after_restart: h5.pid, runs: runs.map((j: any) => ({ id: j.id, state: j.state, created_at: j.created_at })), ran_once: runs.length === 1, removed: !survived, pass: runs.length === 1 && runs[0].state === 'completed' && !survived };
  console.log('T5', JSON.stringify(checks.T5_schedule_restart));
  }
  // ---- hygiene ----
  await sleep(5000); const p = sample('after-all'); const newJobs = (await api('/api/tasks?limit=800')).filter((j: any) => !beforeIds.has(j.id)); const objs = newJobs.filter((j: any) => j.kind !== 'chat.turn' && !j.schedule_id).map((j: any) => j.objective);
  checks.hygiene = { new_jobs: newJobs.length, duplicate_objectives: objs.length !== new Set(objs).size, probes: p.probes, adapters: p.adapters, lead_sessions_open: (await api('/api/conversations?archived=1')).filter((x: any) => x.session_ref).length, actions_performed_ever: (await api('/api/activity?limit=1000')).filter((e: any) => e.type === 'action.performed').length, pass: p.probes === 0 && objs.length === new Set(objs).size };
  console.log('HYG', JSON.stringify(checks.hygiene));
  const ok = Object.keys(checks).every((k) => checks[k]?.pass); finish(ok); console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED'); process.exit(ok ? 0 : 1);
} catch (e) { report.error = (e as Error).message; console.error('FAILED:', (e as Error).message); finish(false); process.exit(1); }
