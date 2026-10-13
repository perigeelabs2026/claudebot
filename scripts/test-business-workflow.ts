/**
 * One useful business workflow through the installed chat: research → draft an offer from the evidence → independent review.
 * Verifies real specialist tasks with recorded dependencies, evidence handed to the drafting assistant, an independent review
 * of the actual draft, office activity grounded in events, reviewed results returned to the conversation, file integrity,
 * and no duplicate work. Nothing is sent or published. One chain at a time; aborts below 15% kernel memory level.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = `${process.env.HOME}/.claudebot`; const token = fs.readFileSync(`${root}/secrets/ui.token`, 'utf8').trim(); const base = 'http://127.0.0.1:48311';
async function api(p: string, body?: unknown, method?: string) { const r = await fetch(`${base}${p}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json() as any; if (!r.ok) throw new Error(`${p} → ${r.status}: ${d.error ?? d.detail}`); return d; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }); } catch { return ''; } };
const level = () => Number(sh('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).trim());
function chromeFamilyMb(): { pids: number; mb: number } { const ps = sh('/bin/ps', ['-axo', 'pid,ppid,rss,args']).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4).map((c) => ({ pid: Number(c[0]), ppid: Number(c[1]), rss: Number(c[2]), args: c.slice(3).join(' ') })); const r0 = ps.find((p) => /remote-debugging-port=48323/.test(p.args)); if (!r0) return { pids: 0, mb: 0 }; const fam = new Set([r0.pid]); let grew = true; while (grew) { grew = false; for (const p of ps) if (!fam.has(p.pid) && fam.has(p.ppid)) { fam.add(p.pid); grew = true; } } return { pids: fam.size, mb: Math.round(ps.filter((p) => fam.has(p.pid)).reduce((n, p) => n + p.rss, 0) / 1024) }; }
const report: Record<string, any> = { started_at: new Date().toISOString(), checks: {} }; const checks = report.checks; const samples: any[] = []; const officeSeen: any[] = [];
function sample(phase: string, extra: Record<string, unknown> = {}) { const ps = sh('/bin/ps', ['-axo', 'rss,args']).split('\n'); const sum = (re: RegExp) => Math.round(ps.filter((l) => re.test(l)).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024); const chrome = chromeFamilyMb(); const core = sum(/engine\/src\/(worker|supervisor)\/main\.ts/) + sum(/--max-old-space-size=8192 .*openclaw/) + sum(/claude-agent-acp\/dist\/index\.js|claude --output-format stream-json/) + sum(/ClaudeBot\.app\/Contents\/MacOS\/ClaudeBot/); const s = { at: new Date().toISOString(), phase, level_pct: level(), swap_mb: Number((sh('/usr/sbin/sysctl', ['vm.swapusage']).match(/used = ([\d.]+)M/) ?? [])[1] ?? 0), core_mb: core, shell_mb: sum(/ClaudeBot\.app\/Contents\/MacOS\/ClaudeBot/), chrome_family_mb: chrome.mb, chrome_pids: chrome.pids, total_mb: core + chrome.mb, adapters: ps.filter((l) => /claude-agent-acp\/dist\/index\.js/.test(l)).length, probes: ps.filter((l) => /claudebot-probe/.test(l)).length, ...extra }; samples.push(s); console.log(JSON.stringify(s)); if (s.level_pct < 15) throw new Error('STOP: memory level < 15%'); return s; }
function finish(ok: boolean) { report.finished_at = new Date().toISOString(); report.samples = samples; report.office_observations = officeSeen; report.ok = ok; const f = `${root}/logs/business-workflow-${String(report.started_at).replace(/[:]/g, '-')}.json`; fs.writeFileSync(f, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(`report: ${f}`); }

try {
  sample('idle-before'); const h0 = await api('/api/health'); if (h0.claude.state !== 'ready') throw new Error(`Claude ${h0.claude.state}`); if (h0.capacity.active) throw new Error('another task is active');
  const beforeIds = new Set((await api('/api/tasks?limit=800')).map((j: any) => j.id));
  const ws = (await api('/api/workspaces')).find((w: any) => w.name === 'General') ?? (await api('/api/workspaces'))[0];
  const conv = await api('/api/conversations', { workspace_id: ws.id }); report.conversation = conv.id;
  const ask = 'Research a supported opportunity, have another assistant draft a short offer from the evidence, and have a reviewer check it. Do not send or publish anything. Use only accessible, legitimate public sources; do not invent demand, leads, customers or revenue. Opportunity to look into: a small local dog-walking service adding a short "first-week welcome check-in" for new customers.';
  const turn = await api(`/api/conversations/${conv.id}/messages`, { content: ask });
  // Observe the office while everything runs (statuses seen per assistant, hand-off events) — evidence that the picture is grounded in records.
  const deadline = Date.now() + 40 * 60_000; let chain: any[] = []; let lastSample = 0; let done = false; let directionTried: any = null;
  while (Date.now() < deadline) {
    const wb = await api('/api/workbench'); const mine = wb.tasks.filter((t: any) => !beforeIds.has(t.id) && t.conversation_id === conv.id);
    for (const t of mine) officeSeen.push({ at: wb.observed_at, task: t.id, assistant: t.assistant, status: t.status, turn: t.turn, progress: t.progress, waiting_on: t.waiting_on_tasks.map((w: any) => w.id) });
    for (const ev of wb.recent || []) if (!officeSeen.some((o) => o.event === `${ev.type}:${ev.job_id}:${ev.at}`)) officeSeen.push({ event: `${ev.type}:${ev.job_id}:${ev.at}`, ...ev });
    chain = mine.filter((t: any) => !t.is_reply);
    if (Date.now() - lastSample > 20_000) { lastSample = Date.now(); sample('workflow', { active: wb.counts.working, chain: chain.map((t: any) => `${t.assistant}:${t.status}`) }); }
    // task-bound direction on the review task while it waits (saved; honest timing) — never a second task
    const review = chain.find((t: any) => t.kind === 'document.review'); if (review && !directionTried && ['blocked_on', 'queued'].includes(review.status)) { try { directionTried = await api(`/api/tasks/${review.id}/direction`, { note: 'In your review, say explicitly whether every claim in the offer is backed by the research evidence.' }); } catch (e) { directionTried = { error: (e as Error).message }; } }
    const turnState = (await api(`/api/tasks/${turn.job.id}`)).job.state;
    if (['failed_terminal', 'waiting_for_auth', 'cancelled'].includes(turnState)) throw new Error(`lead turn ${turnState}`);
    if (turnState === 'completed' && chain.length >= 2 && chain.every((t: any) => ['finished', 'stopped', 'waiting'].includes(t.status))) { done = true; break; }
    if (turnState === 'completed' && chain.length === 0) { await sleep(10000); const again = (await api('/api/workbench')).tasks.filter((t: any) => !beforeIds.has(t.id) && t.conversation_id === conv.id && !t.is_reply); if (!again.length) throw new Error('the lead did not delegate any task'); }
    await sleep(5000);
  }
  if (!done) throw new Error('workflow did not finish in time');
  await sleep(8000);
  const d = await api(`/api/conversations/${conv.id}`); const tasks = await Promise.all(chain.map((t: any) => api(`/api/tasks/${t.id}`)));
  const byKind = (k: string) => tasks.filter((x) => x.job.kind === k);
  const research = byKind('research.report')[0] ?? tasks.find((x) => x.job.agent_role === 'researcher'); const draft = tasks.find((x) => x.job.kind === 'document.create'); const review = byKind('document.review')[0] ?? tasks.find((x) => x.job.agent_role === 'reviewer');
  const fileOf = (x: any) => x?.artifacts.find((a: any) => a.kind === 'file' && a.path && fs.existsSync(a.path));
  const text = (a: any) => (a ? fs.readFileSync(a.path, 'utf8') : '');
  const shaOk = (a: any) => !!a && crypto.createHash('sha256').update(fs.readFileSync(a.path)).digest('hex') === a.sha256;
  const rf = fileOf(research), df = fileOf(draft), vf = fileOf(review);
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{7,}/g) ?? []); const shared = [...words(text(rf))].filter((w) => words(text(df)).has(w));
  const deps = { draft_depends_on_research: !!draft && !!research && JSON.parse(draft.job.depends_on || '[]').includes(research.job.id), review_depends_on_draft: !!review && !!draft && JSON.parse(review.job.depends_on || '[]').includes(draft.job.id) };
  const evidence = research?.evidence ?? [];
  const cards = d.messages.filter((m: any) => m.kind === 'result');
  checks.chain = { tasks: tasks.map((x) => ({ id: x.job.id, kind: x.job.kind, assistant: x.agent?.name, state: x.job.state, outcome: x.job.outcome, depends_on: JSON.parse(x.job.depends_on || '[]') })), ...deps, evidence_rows: evidence.length, evidence_sourced: evidence.every((e: any) => /^https?:\/\//.test(e.source_url || '')), research_file: rf?.path?.split('/').pop() ?? null, draft_file: df?.path?.split('/').pop() ?? null, review_file: vf?.path?.split('/').pop() ?? null, shared_terms_research_draft: shared.slice(0, 12), review_verdict: (text(vf).match(/Verdict:\s*(PASS|FAIL)/i) ?? [])[1] ?? null, review_mentions_evidence: /evidence/i.test(text(vf)), hashes_ok: { research: shaOk(rf), draft: shaOk(df), review: shaOk(vf) }, result_cards: cards.map((m: any) => m.content.slice(0, 140)), duplicate_objectives: tasks.map((x) => x.job.objective).length !== new Set(tasks.map((x) => x.job.objective)).size, direction: directionTried, office_statuses_seen: [...new Set(officeSeen.filter((o) => o.status).map((o) => `${o.assistant}:${o.status}`))], office_handoffs: officeSeen.filter((o) => o.event).map((o) => `${o.type} ${o.from} → ${o.to}`), no_actions_performed: (await api('/api/activity?limit=1500')).filter((e: any) => e.type === 'action.performed').length === 0 };
  checks.chain.pass = !!research && !!draft && !!review && deps.draft_depends_on_research && deps.review_depends_on_draft && research.job.state === 'completed' && draft.job.state === 'completed' && review.job.state === 'completed' && evidence.length >= 1 && checks.chain.evidence_sourced && shared.length >= 2 && !!checks.chain.review_verdict && checks.chain.hashes_ok.research && checks.chain.hashes_ok.draft && checks.chain.hashes_ok.review && cards.length >= 3 && !checks.chain.duplicate_objectives && checks.chain.no_actions_performed && checks.chain.office_statuses_seen.some((s: string) => /:working$/.test(s)) && checks.chain.office_statuses_seen.some((s: string) => /:blocked_on$/.test(s));
  console.log('CHAIN', JSON.stringify(checks.chain, null, 1).slice(0, 3000));
  const p = sample('after-all'); checks.memory = { idle: samples[0], peak_core_mb: Math.max(...samples.map((s) => s.core_mb)), peak_total_mb: Math.max(...samples.map((s) => s.total_mb)), min_level_pct: Math.min(...samples.map((s) => s.level_pct)), after: p };
  finish(!!checks.chain.pass); console.log(checks.chain.pass ? 'ALL PASS' : 'SOME CHECKS FAILED'); process.exit(checks.chain.pass ? 0 : 1);
} catch (e) { report.error = (e as Error).message; console.error('FAILED:', (e as Error).message); finish(false); process.exit(1); }
