/** One real installed-product workflow. Keeps the task and output for owner review. No sends or publishing. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = process.env.CLAUDEBOT_HOME ?? path.join(os.homedir(), '.claudebot');
const token = fs.readFileSync(`${root}/secrets/ui.token`, 'utf8').trim();
async function api(p: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:48311${p}`, { method: body ? 'POST' : 'GET', headers: { 'x-claudebot-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json() as any; if (!r.ok) throw new Error(`${r.status}: ${d.error}`); return d;
}
const objective = 'Create customer-welcome-guide.md: a 350–500 word welcome guide for customers of a fictional small home-organizing service. Include exactly five sections: Welcome, Before your first visit, What happens during the visit, After your visit, Questions to ask. Use warm plain English. Include a five-item preparation checklist. Do not invent contact details, prices, guarantees, testimonials, or policies. Use [business name] where needed. This is a draft only; save locally and do not send or publish it.';
const created = await api('/api/tasks', { workspace_id: 'workflow-test-customer-welcome-guide', kind: 'document.create', objective, idempotency_key: 'owner-workflow-test:welcome-guide:audited-save-v1' });
const id = created.job.id; console.log(`Real installed task: ${id}`);
const samples: unknown[] = []; let final: any;
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  const d = await api(`/api/tasks/${id}`); final = d;
  const h = await api('/api/health');
  const ps = execFileSync('/bin/ps', ['-axo', 'rss,args'], { encoding: 'utf8', timeout: 2000 });
  const productMb = ps.split('\n').filter(l => /engine\/src\/(worker|supervisor)|openclaw\/dist\/index.js gateway|claude-agent-acp\/dist\/index.js|\.local\/bin\/claude --output-format/.test(l)).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024;
  const sample = { at: new Date().toISOString(), state: d.job.state, stage: d.job.stage_name, active: h.capacity.active, available_pct: h.capacity.governor.level_pct, product_rss_mb: Math.round(productMb), outputs: d.artifacts.length, error: d.job.failure_detail };
  samples.push(sample); console.log(JSON.stringify(sample));
  if (h.capacity.governor.level_pct < 15) { await api(`/api/tasks/${id}/cancel`, {}); throw new Error('Stopped test because available memory fell below 15%.'); }
  if (['completed', 'failed_terminal', 'cancelled', 'waiting_for_auth', 'waiting_for_reset'].includes(d.job.state)) break;
  await new Promise(r => setTimeout(r, 12_000));
}
if (final.job.state !== 'completed') { if (!['failed_terminal','cancelled','waiting_for_auth','waiting_for_reset'].includes(final.job.state)) await api(`/api/tasks/${id}/cancel`, {}); throw new Error(`Task did not complete: ${final.job.state}: ${final.job.failure_detail ?? final.job.operator_action ?? 'time limit'}`); }
const output = final.artifacts.find((a: any) => a.path?.endsWith('/customer-welcome-guide.md'));
if (!output) throw new Error('The requested output file was not registered.');
const content = fs.readFileSync(output.path, 'utf8'); const sha = crypto.createHash('sha256').update(content).digest('hex');
const clean = content.replace(/<!--[\s\S]*?-->/g, '');
const words = clean.trim().split(/\s+/).length;
const headings = [...clean.matchAll(/^## (.+)$/gm)].map(m => m[1]);
const expected = ['Welcome','Before your first visit','What happens during the visit','After your visit','Questions to ask'];
const checks = { completed: true, requested_file: true, hash_matches: sha === output.sha256, word_count: words, length_ok: words >= 350 && words <= 500, five_requested_sections: JSON.stringify(headings) === JSON.stringify(expected), five_checklist_items: (clean.match(/^- \[[ x]\]/gm) ?? []).length === 5, business_placeholder: clean.includes('[business name]'), external_actions: final.approvals.length === 0 && !final.events.some((e: any) => e.type === 'action.performed') };
const report = { task: id, runtime: final.job.runtime_id, session: final.job.session_ref, output: output.path, checkpoints: final.checkpoints.length, checks, samples, generated_at: new Date().toISOString() };
fs.writeFileSync(`${root}/logs/welcome-guide-workflow-test.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2)); console.log(content);
if (Object.entries(checks).some(([k,v]) => k !== 'word_count' && v !== true)) throw new Error('Output failed one or more acceptance checks.');
