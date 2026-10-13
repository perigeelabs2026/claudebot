/**
 * Installed acceptance E/F: a public, read-only browser task asked in chat, watched through the live stream of the
 * actual ClaudeBot browser (Chrome screencast over DevTools), then owner takeover (flag + window placement + "I'm done"
 * read-only sign-in check). No login, MFA or CAPTCHA is automated; nothing is submitted. One active task at a time.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = `${process.env.HOME}/.claudebot`; const token = fs.readFileSync(`${root}/secrets/ui.token`, 'utf8').trim(); const base = 'http://127.0.0.1:48311';
async function api(p: string, body?: unknown) { const r = await fetch(`${base}${p}`, { method: body ? 'POST' : 'GET', headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json() as any; if (!r.ok) throw new Error(`${p} → ${r.status}: ${d.error ?? d.detail}`); return d; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }); } catch { return ''; } };
const mem = () => Number(sh('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).trim());
const report: Record<string, unknown> = { started_at: new Date().toISOString(), checks: {} }; const checks = report.checks as Record<string, unknown>; const samples: unknown[] = [];
function finish(ok: boolean) { report.ok = ok; report.samples = samples; report.finished_at = new Date().toISOString(); const f = `${root}/logs/browser-acceptance-${String(report.started_at).replace(/[:]/g, '-')}.json`; fs.writeFileSync(f, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log('report:', f); }

// Live stream subscriber: collects frames and status events for the whole run.
const frames: Array<{ at: string; url: string; title: string; bytes: number }> = []; const statuses: any[] = []; let firstFrame: { data: string; url: string; at: string } | null = null;
const ac = new AbortController();
(async () => { try { const r = await fetch(`${base}/api/browser/stream`, { headers: { 'x-claudebot-token': token }, signal: ac.signal }); const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''; for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = (chunk.match(/^event: (.*)$/m) ?? [])[1]; const data = (chunk.match(/^data: (.*)$/m) ?? [])[1]; if (!ev || !data) continue; const j = JSON.parse(data); if (ev === 'frame') { frames.push({ at: j.at, url: j.url, title: j.title, bytes: j.data.length }); if (!firstFrame || !/example\.com/.test(firstFrame.url)) firstFrame = { data: j.data, url: j.url, at: j.at }; } else if (ev === 'status') statuses.push({ at: new Date().toISOString(), running: j.running, current: j.current?.url ?? null, using: j.using?.job_id ?? null, takeover: j.takeover?.active ?? false, streaming: j.streaming }); } } } catch { /* aborted */ } })();

try {
  const h0 = await api('/api/health'); if (h0.claude.state !== 'ready') throw new Error(`Claude ${h0.claude.state}`); if (h0.capacity.active) throw new Error('another task is active');
  const live0 = await api('/api/browser/live'); checks.before = { running: live0.running, tabs: live0.tabs.length, pid: live0.pid, cdp_port: live0.cdp_port, available_pct: mem() };
  const convs = await api('/api/conversations'); const conv = convs[0] ?? await api('/api/conversations', {}); report.conversation = conv.id;
  const beforeIds = new Set((await api('/api/tasks?limit=500')).map((j: any) => j.id));
  // ---- E. public read-only browser task from chat ----
  const e = await api(`/api/conversations/${conv.id}/messages`, { content: 'Please read https://example.com in the browser and tell me the main heading and the first paragraph. Read only; do not sign in or submit anything.' });
  const usingSeen: string[] = []; let child: any = null;
  const deadline = Date.now() + 14 * 60_000; let turnDone = false;
  while (Date.now() < deadline) {
    const lv = await api('/api/browser/live'); if (lv.using) usingSeen.push(`${lv.using.job_id}:${lv.using.assistant}:${lv.using.plain_state}`);
    const level = mem(); samples.push({ at: new Date().toISOString(), available_pct: level, frames: frames.length, using: lv.using?.job_id ?? null, current: lv.current?.url ?? null }); if (level < 15) throw new Error('STOP: memory < 15%');
    const t = await api(`/api/tasks/${e.job.id}`); if (!turnDone && ['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'].includes(t.job.state)) { turnDone = true; checks.E_turn = { state: t.job.state, detail: t.job.failure_detail }; if (t.job.state !== 'completed') throw new Error(`turn ${t.job.state}: ${t.job.failure_detail}`); }
    if (turnDone) { const d = await api(`/api/conversations/${conv.id}`); child = d.delegations.find((j: any) => !beforeIds.has(j.id) && j.kind.startsWith('browser.')); if (child && ['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'].includes(child.state)) break; if (turnDone && !child && d.delegations.filter((j: any) => !beforeIds.has(j.id)).length) { child = d.delegations.find((j: any) => !beforeIds.has(j.id)); if (['completed', 'failed_terminal', 'waiting_for_auth', 'cancelled'].includes(child.state)) break; } }
    await sleep(3000);
  }
  if (!child) throw new Error('no browser task was delegated');
  await sleep(7000);
  const cd = await api(`/api/tasks/${child.id}`); const d = await api(`/api/conversations/${conv.id}`);
  const result = d.messages.find((m: any) => m.kind === 'result' && m.job_id === child.id); const reads = cd.events.filter((x: any) => x.type === 'browser.read').map((x: any) => x.detail.url);
  const exFrames = frames.filter((f) => /example\.com/.test(f.url));
  if (firstFrame && /example\.com/.test(firstFrame.url)) { const f = `${root}/logs/browser-live-frame-${String(report.started_at).replace(/[:]/g, '-')}.jpg`; fs.writeFileSync(f, Buffer.from(firstFrame.data, 'base64'), { mode: 0o600 }); report.frame_file = f; }
  const liveAfter = await api('/api/browser/live');
  checks.E = { child: { id: child.id, kind: cd.job.kind, assistant: child.agent, state: cd.job.state, detail: cd.job.failure_detail }, pages_read: reads, evidence: cd.evidence.map((x: any) => ({ title: x.title, source: x.source_url })), result_message: result?.content ?? null, frames_total: frames.length, frames_of_example_com: exFrames.length, first_example_frame_at: exFrames[0]?.at ?? null, using_observed: [...new Set(usingSeen)], in_use_cleared_after: liveAfter.using === null, pass: cd.job.state === 'completed' && reads.some((u: string) => /example\.com/.test(u)) && exFrames.length >= 1 && usingSeen.some((u) => u.startsWith(child.id)) && !!result && liveAfter.using === null };
  console.log('E', JSON.stringify(checks.E));
  // ---- F. owner takeover (no automation of any login) ----
  const t1 = await api('/api/browser/takeover', { active: true, site: 'example.com', note: 'owner takeover demonstration' });
  const lv1 = await api('/api/browser/live');
  const front = await api('/api/browser/front', {});
  const arranged = await api('/api/browser/arrange', { left: 800, top: 30, width: 640, height: 700 });
  // Verify the real window moved, through DevTools itself.
  let bounds: unknown = null; try { const v = await (await fetch(`http://127.0.0.1:${lv1.cdp_port}/json/version`)).json() as any; const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }); const call = (id: number, method: string, params: any) => new Promise<any>((res) => { const on = (m: MessageEvent) => { const x = JSON.parse(String(m.data)); if (x.id === id) { ws.removeEventListener('message', on); res(x.result); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method, params })); }); const w = await call(1, 'Browser.getWindowForTarget', { targetId: lv1.current.id }); bounds = (await call(2, 'Browser.getWindowBounds', { windowId: w.windowId })).bounds; ws.close(); } catch (err) { bounds = { error: (err as Error).message }; }
  const jobsDuring = (await api('/api/tasks?limit=500')).filter((j: any) => !beforeIds.has(j.id)).length;
  const t0 = await api('/api/browser/takeover', { active: false, site: 'example.com' });
  const lv2 = await api('/api/browser/live'); const act = await api('/api/activity?limit=100');
  checks.F = { takeover_on: t1.takeover && lv1.takeover?.active === true, front, arranged, window_bounds_after: bounds, bounds_match: !!bounds && (bounds as any).left === 800 && (bounds as any).width === 640, takeover_off: t0.takeover === false && lv2.takeover?.active === false, done_check: t0.login, events: act.filter((x: any) => /browser\.takeover/.test(x.type)).map((x: any) => x.type), no_job_created_by_takeover: jobsDuring === 2, pass: t1.takeover === true && lv1.takeover?.active === true && front.ok === true && arranged.ok === true && t0.takeover === false && !!t0.login && t0.login.site === 'example.com' };
  console.log('F', JSON.stringify(checks.F));
  const p = sh('/bin/ps', ['-axo', 'args']).split('\n'); checks.after = { adapters: p.filter((l) => /claude-agent-acp\/dist\/index\.js/.test(l)).length, probes: p.filter((l) => /claudebot-probe/.test(l)).length, available_pct: mem(), statuses: statuses.length };
  ac.abort(); await sleep(500);
  const ok = (checks.E as any).pass && (checks.F as any).pass; finish(ok); console.log(ok ? 'ALL PASS' : 'SOME CHECKS FAILED'); process.exit(ok ? 0 : 1);
} catch (err) { report.error = (err as Error).message; console.error('FAILED:', (err as Error).message); ac.abort(); finish(false); process.exit(1); }
