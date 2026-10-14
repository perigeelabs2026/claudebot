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

/** The connection's own list, or the fallback list when it names none. */
export async function advertised(runtime: Pick<ModelRuntime, 'advertisedModels'> | null | undefined, opts: { fresh?: boolean } = {}): Promise<{ models: readonly string[]; reply: string | null; verified: boolean }> {
  try { const r = await runtime?.advertisedModels?.(opts.fresh ? { fresh: true } : undefined); if (r && r.models.length) return { models: r.models, reply: r.reply, verified: true }; } catch { /* the fallback list */ }
  return { models: ADVERTISED_MODELS, reply: null, verified: false };
}

/** Whether a model may be saved on an assistant. Blocked only when the connection's own list (harvested from a refusal) lacks it;
 *  when the list is not known yet, it passes with a note ("could not verify"), never an alarm. */
export async function validateModel(runtime: Pick<ModelRuntime, 'advertisedModels'> | null | undefined, model: string): Promise<{ ok: true; note?: string } | { ok: false; reason: string }> {
  let a = await advertised(runtime);
  if (resolves(model, a.models)) return { ok: true };
  // The cached list lacks it: ask the connection again before refusing (its list may have changed since it was cached).
  if (a.verified) { a = await advertised(runtime, { fresh: true }); if (resolves(model, a.models)) return { ok: true }; }
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
  const a = await advertised(runtime);
  const problems = checkModelAliases(db, previousModel, a.models);
  if (a.verified) for (const p of problems) reportModelProblem(db, store, { ...p, reason: a.reply ? `it says: ${a.reply}` : 'not one of the models it offers' });
  else if (problems.length) store.event(null, 'supervisor', 'model.unverified', { models: problems.map((p) => ({ agent: p.agent, model: p.model })), note: 'the connection has not listed its models; checked again on the next refusal' });
  return { verified: a.verified, problems };
}
