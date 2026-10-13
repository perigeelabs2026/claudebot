/**
 * Home (the morning brief screen) built only from ledger rows: what finished, what was saved, what needs the owner, what is
 * running, what is scheduled, and each assistant's real current or last work. Every number is a count of rows; empty is empty.
 */
import type { DB } from '../db/open.ts';
import { cronMatches } from '../supervisor/scheduler.ts';
import { taskTitle } from './wording.ts';

const HIDDEN_KINDS = "('chat.turn','assistant.draft','report.morning','priority.rank','owner.upload','system.workspace_summary','browser.login_health','monitor.scheduled')";

export interface HomeSnapshot {
  observed_at: string; window_hours: number; workspace: string | null;
  next_routine?: { title: string; at: string } | null;
  figures: { finished: number; results: number; needs_you: number; working: number };
  today: Array<{ kind: 'approval' | 'blocker' | 'sign_in' | 'routine' | 'draft' | 'done' | 'question'; at: string | null; title: string; detail: string; href: string }>;
  team: Array<{ id: string; name: string; role: string; state: 'working' | 'needs_you' | 'queued' | 'idle'; line: string }>;
  finished: Array<{ id: string; title: string; agent: string; outcome: string | null; at: string }>;
}

export function homeSnapshot(db: DB, opts: { workspace?: string | null; hours?: number; now?: Date } = {}): HomeSnapshot {
  const now = opts.now ?? new Date(); const hours = opts.hours ?? 24; const since = new Date(now.getTime() - hours * 3600_000).toISOString();
  const ws = opts.workspace ?? null; const wsSql = ws ? ' AND j.workspace_id = ?' : ''; const wsArg = ws ? [ws] : [];
  const fresh = new Date(now.getTime() - 45_000).toISOString();
  const names = new Map((db.prepare('SELECT id, name, role FROM agent_definitions').all() as Array<{ id: string; name: string; role: string }>).map((a) => [a.id, a]));
  const finished = (db.prepare(`SELECT j.id, j.objective, j.agent_role, j.outcome, j.completed_at FROM jobs j WHERE j.state = 'completed' AND j.completed_at >= ? AND j.kind NOT IN ${HIDDEN_KINDS}${wsSql} ORDER BY j.completed_at DESC LIMIT 20`).all(since, ...wsArg) as Array<{ id: string; objective: string; agent_role: string; outcome: string | null; completed_at: string }>)
    .map((j) => ({ id: j.id, title: taskTitle(j.objective), agent: names.get(j.agent_role)?.name ?? j.agent_role, outcome: j.outcome, at: j.completed_at }));
  const results = (db.prepare(`SELECT count(*) AS n FROM artifacts a JOIN jobs j ON j.id = a.job_id WHERE a.kind = 'file' AND a.created_at >= ?${wsSql}`).get(since, ...wsArg) as { n: number }).n;
  const approvals = db.prepare(`SELECT a.id, a.action_kind, a.target, a.created_at, a.expires_at FROM approvals a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.status = 'pending' AND a.expires_at > ?${wsSql} ORDER BY a.created_at`).all(now.toISOString(), ...wsArg) as Array<{ id: string; action_kind: string; target: string; created_at: string; expires_at: string }>;
  const blockers = db.prepare(`SELECT j.id, j.objective, j.agent_role, j.state, j.waiting_on, j.operator_action, j.updated_at FROM jobs j WHERE ((j.state = 'failed_terminal' AND j.blocker_code = 'BLOCKED' AND j.updated_at >= ?) OR j.state = 'waiting_for_auth') AND j.kind NOT IN ${HIDDEN_KINDS}${wsSql} ORDER BY j.updated_at DESC LIMIT 10`).all(since, ...wsArg) as Array<{ id: string; objective: string; agent_role: string; state: string; waiting_on: string | null; operator_action: string | null; updated_at: string }>;
  const drafts = db.prepare("SELECT id, draft, created_at FROM assistant_drafts WHERE status = 'pending' ORDER BY created_at").all() as Array<{ id: string; draft: string; created_at: string }>;
  const today: HomeSnapshot['today'] = [];
  // One row per assistant, as designed ("Approve Milo's follow-ups · Review 2 emails"): several waiting decisions read as one.
  const byAgent = new Map<string, typeof approvals>();
  for (const a of approvals) { const ag = (db.prepare('SELECT agent_role FROM jobs WHERE id = (SELECT job_id FROM approvals WHERE id = ?)').get(a.id) as { agent_role: string } | undefined)?.agent_role ?? 'someone'; byAgent.set(ag, [...(byAgent.get(ag) || []), a]); }
  for (const [ag, list] of byAgent) { const who = names.get(ag)?.name ?? ag; const n = list.length; const emails = list.every((a) => a.action_kind === 'send');
    const targets = [...new Set(list.map((a) => a.target.replace(/^email to /i, '')))];
    today.push({ kind: 'approval', at: list[0].created_at, title: `Approve ${who}'s ${emails ? (n > 1 ? 'emails' : 'email') : (n > 1 ? 'requests' : 'request')}`, detail: `to ${targets.slice(0, 2).join(' and ')}${targets.length > 2 ? ` and ${targets.length - 2} more` : ''}`, href: '#approvals', count: n, noun: emails ? (n > 1 ? 'emails' : 'email') : (n > 1 ? 'requests' : 'request') } as never); }
  for (const b of blockers) today.push({ kind: b.state === 'waiting_for_auth' ? 'sign_in' : 'blocker', at: b.updated_at, title: `${b.state === 'waiting_for_auth' ? 'Sign in so work can continue' : 'Blocked'}: ${taskTitle(b.objective)}`, detail: b.operator_action ?? '', href: `#office/task/${b.id}` });
  // Questions an assistant asked the owner with a real ask_owner card, still unanswered (no owner reply to it).
  const questions = db.prepare("SELECT m.id, m.sender, m.content, m.created_at, m.conversation_id FROM messages m WHERE m.kind = 'question' AND json_extract(m.meta, '$.options') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.role = 'owner') ORDER BY m.created_at").all() as Array<{ id: string; sender: string; content: string; created_at: string; conversation_id: string }>;
  for (const q of questions) today.push({ kind: 'question', at: q.created_at, title: `Answer ${names.get(q.sender)?.name ?? q.sender}'s question`, detail: q.content, href: `#chat/${q.conversation_id}` } as never);
  for (const d of drafts) { let role = 'a new assistant'; try { role = (JSON.parse(d.draft) as { role?: string }).role ?? role; } catch { /* */ } today.push({ kind: 'draft', at: d.created_at, title: `Name and confirm ${role}`, detail: 'drafted by the Chief of Staff', href: '#create' }); }
  // Routines that fire in the rest of today (local time): cron schedules checked minute by minute, one-shots by their time.
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  for (const s of db.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as Array<{ id: string; name: string; cron: string | null; once: number; next_run_at: string | null; objective: string; tz?: string | null }>) {
    let at: Date | null = null;
    if (s.once && s.next_run_at) { const t = new Date(s.next_run_at); if (t >= now && t <= endOfDay) at = t; }
    else if (s.cron) for (let m = new Date(Math.ceil(now.getTime() / 60_000) * 60_000); m <= endOfDay; m = new Date(m.getTime() + 60_000)) if (cronMatches(s.cron, m, s.tz ?? null)) { at = m; break; }
    if (at) today.push({ kind: 'routine', at: at.toISOString(), title: s.name || taskTitle(s.objective), detail: 'routine', href: '#automations' });
  }
  // The next routine beyond today too (up to 48 h), so "no routines today" is never said while one is due tomorrow.
  let next_routine: { title: string; at: string } | null = null;
  for (const s of db.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as Array<{ name: string; cron: string | null; once: number; next_run_at: string | null; objective: string; tz?: string | null }>) {
    let at: Date | null = null; const horizon = now.getTime() + 48 * 3600_000;
    if (s.once && s.next_run_at) { const t = new Date(s.next_run_at); if (t >= now) at = t; }
    else if (s.cron) for (let m = Math.ceil(now.getTime() / 60_000) * 60_000; m <= horizon; m += 60_000) if (cronMatches(s.cron, new Date(m), s.tz ?? null)) { at = new Date(m); break; }
    if (at && (!next_routine || at.toISOString() < next_routine.at)) next_routine = { title: s.name || taskTitle(s.objective), at: at.toISOString() };
  }
  const order = { approval: 0, sign_in: 1, blocker: 2, question: 3, draft: 3, routine: 4, done: 5 } as const;
  today.sort((x, y) => order[x.kind] - order[y.kind] || String(x.at).localeCompare(String(y.at)));
  { let up = 0; for (let i = today.length - 1; i >= 0; i--) if (today[i].kind === 'routine' && ++up > 2) today.splice(i, 1); }   // at most two upcoming rows, as designed
  // What already happened today (local day), newest first, after what is still ahead: finished work at the time it finished.
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  for (const f of finished.filter((f) => f.at >= startOfDay.toISOString()).slice(0, 1)) today.push({ kind: 'done', at: f.at, title: f.title, detail: f.agent, href: `#office/task/${f.id}` });
  const working = (db.prepare(`SELECT count(*) AS n FROM jobs j WHERE j.state IN ('leased','running') AND j.lease_heartbeat_at >= ? AND j.kind NOT IN ('report.morning','priority.rank')${wsSql}`).get(fresh, ...wsArg) as { n: number }).n;   // the report does not count itself
  const team = (db.prepare('SELECT id, name, role FROM agent_definitions WHERE enabled = 1 ORDER BY is_system DESC, created_at').all() as Array<{ id: string; name: string; role: string }>).map((a) => {
    const live = db.prepare(`SELECT j.objective, j.next_action FROM jobs j WHERE j.agent_role = ? AND j.state IN ('leased','running') AND j.lease_heartbeat_at >= ?${wsSql} ORDER BY j.lease_heartbeat_at DESC LIMIT 1`).get(a.id, fresh, ...wsArg) as { objective: string; next_action: string | null } | undefined;
    const waiting = (db.prepare(`SELECT j.objective FROM jobs j WHERE j.agent_role = ? AND j.state IN ('waiting_for_approval','waiting_for_auth')${wsSql} LIMIT 1`).get(a.id, ...wsArg) ?? db.prepare(`SELECT ap.target AS objective FROM approvals ap JOIN jobs j ON j.id = ap.job_id WHERE j.agent_role = ? AND ap.status = 'pending' AND ap.expires_at > ?${wsSql} ORDER BY ap.created_at LIMIT 1`).get(a.id, now.toISOString(), ...wsArg)) as { objective: string } | undefined;
    const doneTitles = (db.prepare(`SELECT j.objective FROM jobs j WHERE j.agent_role = ? AND j.state = 'completed' AND j.completed_at >= ? AND j.kind NOT IN ${HIDDEN_KINDS}${wsSql} ORDER BY j.completed_at DESC LIMIT 2`).all(a.id, since, ...wsArg) as Array<{ objective: string }>).map((r) => taskTitle(r.objective));
    const queued = db.prepare(`SELECT j.objective FROM jobs j WHERE j.agent_role = ? AND j.state = 'queued'${wsSql} LIMIT 1`).get(a.id, ...wsArg) as { objective: string } | undefined;
    const done = (db.prepare(`SELECT count(*) AS n FROM jobs j WHERE j.agent_role = ? AND j.state = 'completed' AND j.completed_at >= ? AND j.kind NOT IN ${HIDDEN_KINDS}${wsSql}`).get(a.id, since, ...wsArg) as { n: number }).n;
    const last = db.prepare(`SELECT j.objective, j.completed_at FROM jobs j WHERE j.agent_role = ? AND j.state = 'completed' AND j.kind NOT IN ${HIDDEN_KINDS}${wsSql} ORDER BY j.completed_at DESC LIMIT 1`).get(a.id, ...wsArg) as { objective: string; completed_at: string } | undefined;
    const state: HomeSnapshot['team'][number]['state'] = live ? 'working' : waiting ? 'needs_you' : queued ? 'queued' : 'idle';
    const line = live ? `${doneTitles.length ? `Finished ${doneTitles[0]}. Now w` : 'W'}orking on ${taskTitle(live.objective)}.` : waiting ? `Waiting on you: ${taskTitle(waiting.objective)}.` : queued ? `Next up: ${taskTitle(queued.objective)}.` : done ? `Finished ${doneTitles[0].replace(/\.{3}$/, '…')}${done > 1 ? `, plus ${done - 1} more` : ''}.` : last ? `Last finished ${taskTitle(last.objective)} (${last.completed_at.slice(0, 10)}).` : 'Nothing assigned yet.';
    return { id: a.id, name: a.name, role: a.role, state, line };
  });
  return { observed_at: now.toISOString(), window_hours: hours, workspace: ws, figures: { finished: finished.length, results, needs_you: approvals.length + blockers.length + drafts.length + questions.length, working }, today, team, finished, next_routine };
}
