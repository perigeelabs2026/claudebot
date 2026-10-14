/**
 * Model aliases (owner, 2026-10-14: every Fable turn was refused from 9:30 and Jude stopped silently). Each assistant's model must be
 * one the Claude connection advertises. It is checked against the connection's own list (`/acp model`) at startup and on every
 * assistant edit; a refused model falls back to the assistant's last accepted model for the turn; either way the team group and the
 * owner's Telegram (held in quiet hours) are told. No model call.
 */
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import type { ModelRuntime } from './types.ts';
import { acpModel } from './claude-acp.ts';
import { teamLine } from '../cos/alerts.ts';

/** Used only when the connection does not list its models: the aliases verified live (haiku, sonnet, opus). Fable is not in it until
 *  it is verified live; when the connection lists nothing, Fable reports "could not verify" instead of passing. */
export const ADVERTISED_MODELS = ['default', 'opus', 'sonnet', 'haiku'] as const;
export const resolves = (model: string, advertised: readonly string[] = ADVERTISED_MODELS): boolean => advertised.map((a) => a.toLowerCase()).includes(acpModel(model).toLowerCase());

/** The most recent distinct real ACP session keys (agent:<id>:acp:<uuid>) from the jobs table, newest first, each with the assistant
 *  whose job it ran (jobs.agent_role): the only kind of session `/acp model` lists models on. Several, so a closed or broken one does
 *  not end the probe. The key's own <id> segment is OpenClaw's agent id, not the assistant. */
export function latestAcpSessionRoles(db: DB | null | undefined, limit = 5): Array<{ key: string; role: string }> {
  if (!db) return [];
  const rows = db.prepare("SELECT session_ref AS a, runtime_session_id AS b, agent_role AS role FROM jobs WHERE session_ref LIKE 'agent:%:acp:%' OR runtime_session_id LIKE 'agent:%:acp:%' ORDER BY updated_at DESC LIMIT 50").all() as Array<{ a: string | null; b: string | null; role: string }>;
  const out: Array<{ key: string; role: string }> = [];
  for (const r of rows) for (const k of [r.a, r.b]) if (k && /^agent:[a-z_]+:acp:[0-9a-f-]+$/i.test(k) && !out.some((o) => o.key === k)) { out.push({ key: k, role: r.role }); if (out.length >= limit) return out; }
  return out;
}
/** Each session key mapped to the configured model of the assistant whose job ran on it (keys with no job or no model are left out:
 *  the runtime restores those with the connection default). */
export function sessionModels(db: DB, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const r = db.prepare("SELECT d.model AS model FROM jobs j JOIN agent_definitions d ON d.id = j.agent_role WHERE (j.session_ref = ? OR j.runtime_session_id = ?) AND d.model IS NOT NULL AND d.model != '' ORDER BY j.updated_at DESC LIMIT 1").get(k, k) as { model: string } | undefined;
    if (r) out[k] = r.model;
  }
  return out;
}
export const latestAcpSessions = (db: DB | null | undefined, limit = 5): string[] => latestAcpSessionRoles(db, limit).map((o) => o.key);
export const latestAcpSession = (db: DB | null | undefined): string | null => latestAcpSessions(db, 1)[0] ?? null;

/** The connection's own list, or the fallback list when it names none. */
export async function advertised(runtime: Pick<ModelRuntime, 'advertisedModels'> | null | undefined, opts: { fresh?: boolean; db?: DB | null } = {}): Promise<{ models: readonly string[]; reply: string | null; verified: boolean }> {
  try {
    const sessions = latestAcpSessionRoles(opts.db); const sessionKeys = sessions.map((s) => s.key);
    const roleModels: Record<string, string> | undefined = opts.db ? Object.fromEntries((opts.db.prepare("SELECT id, model FROM agent_definitions WHERE model IS NOT NULL AND model != ''").all() as Array<{ id: string; model: string }>).map((r) => [r.id, r.model])) : undefined;
    const sessionModels = roleModels ? Object.fromEntries(sessions.filter((s) => roleModels[s.role]).map((s) => [s.key, roleModels[s.role]])) : undefined;   // = sessionModels(db, keys)
    const r = await runtime?.advertisedModels?.(opts.fresh || sessionKeys.length || roleModels ? { ...(opts.fresh ? { fresh: true } : {}), ...(sessionKeys.length ? { sessionKeys } : {}), ...(roleModels ? { roleModels, sessionModels } : {}) } : undefined); if (r && r.models.length) return { models: r.models, reply: r.reply, verified: true }; } catch { /* the fallback list */ }
  return { models: ADVERTISED_MODELS, reply: null, verified: false };
}

/** Whether a model may be saved on an assistant. Blocked only when the connection's own list (harvested from a refusal) lacks it;
 *  when the list is not known yet, it passes with a note ("could not verify"), never an alarm. */
export async function validateModel(runtime: Pick<ModelRuntime, 'advertisedModels'> | null | undefined, model: string, db?: DB | null): Promise<{ ok: true; note?: string } | { ok: false; reason: string }> {
  let a = await advertised(runtime, { db });
  if (resolves(model, a.models)) return { ok: true };
  // The cached list lacks it: ask the connection again before refusing (its list may have changed since it was cached).
  if (a.verified) { a = await advertised(runtime, { fresh: true, db }); if (resolves(model, a.models)) return { ok: true }; }
  if (!a.verified) return { ok: true, note: `Could not verify "${model}" yet: the Claude connection has not listed its models. If it refuses it, this assistant falls back to its previous model and you are told.` };
  return { ok: false, reason: `The Claude connection does not offer "${model}" (it is sent as "${acpModel(model)}"). ${a.reply ? `It says: ${a.reply}` : `It offers: ${a.models.join(', ')}.`}` };
}

export interface ModelProblem { agent: string; name: string; model: string; fallback: string }

/** Every configured model that does not resolve: each enabled assistant's model and the re-plan model setting. */
export function checkModelAliases(db: DB, previousModel: (agentId: string) => string, list: readonly string[] = ADVERTISED_MODELS): ModelProblem[] {
  const out: ModelProblem[] = [];
  for (const a of db.prepare('SELECT id, name, model FROM agent_definitions WHERE enabled = 1').all() as Array<{ id: string; name: string; model: string }>)
    if (a.model && !resolves(a.model, list)) out.push({ agent: a.id, name: a.name, model: a.model, fallback: previousModel(a.id) });
  const replan = String((db.prepare("SELECT value FROM settings WHERE key = 'replan_model'").get() as { value: string } | undefined)?.value ?? process.env.CLAUDEBOT_REPLAN_MODEL ?? '').replace(/^"|"$/g, '').trim();
  if (replan && !resolves(replan, list)) out.push({ agent: 'coordinator', name: 'Re-planning', model: replan, fallback: previousModel('coordinator') });
  return out;
}

/** Tell the team group and the owner (once per assistant, model and day) that a model was refused or does not resolve. */
export function reportModelProblem(db: DB, store: JobStore, p: { agent: string; name: string; model: string; fallback: string | null; reason: string; jobId?: string | null }): boolean {
  const name = p.name.replace(/\s*\(.*\)$/, '');
  return teamLine(db, store, { key: `model:${p.agent}|${p.model}|${new Date().toISOString().slice(0, 10)}`, owner: true, jobId: p.jobId ?? null,
    text: `${name}'s model "${p.model}" is not accepted by the Claude connection (${p.reason}). ${p.fallback ? `${name} is running on ${p.fallback} instead until you change it in Edit assistant > Advanced.` : `${name}'s turns cannot run until a model is picked in Edit assistant > Advanced.`}` });
}

/** The startup check, after the gateway is healthy: with the connection's own list, each assistant whose model it lacks is reported
 *  (group and owner); without one, it is recorded only (an event and a log line), never an alarm. */
export async function startupModelCheck(db: DB, store: JobStore, runtime: Pick<ModelRuntime, 'advertisedModels'> | null | undefined, previousModel: (agentId: string) => string): Promise<{ verified: boolean; problems: ModelProblem[] }> {
  const a = await advertised(runtime, { db });
  const problems = checkModelAliases(db, previousModel, a.models);
  if (a.verified) for (const p of problems) reportModelProblem(db, store, { ...p, reason: a.reply ? `it says: ${a.reply}` : 'not one of the models it offers' });
  else if (problems.length) store.event(null, 'supervisor', 'model.unverified', { models: problems.map((p) => ({ agent: p.agent, model: p.model })), note: 'the connection has not listed its models; checked again on the next refusal' });
  return { verified: a.verified, problems };
}
