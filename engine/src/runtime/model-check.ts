/**
 * Model aliases (owner, 2026-10-14: every Fable turn was refused from 9:30 and Jude stopped silently). Each assistant's model must map to
 * a model the Claude connection advertises; a refused model falls back to the assistant's previous model for that turn, and the team
 * group is told. At startup every configured model is checked, so a bad alias is reported before a turn fails. No model call.
 */
import type { DB } from '../db/open.ts';
import type { JobStore } from '../jobs/store.ts';
import { acpModel } from './claude-acp.ts';
import { ChatStore } from '../chat/store.ts';

/** What Claude Code's ACP agent advertises (`/acp model`): these aliases, or a full id it lists itself. */
export const ADVERTISED_MODELS = ['default', 'opus', 'fable', 'sonnet', 'haiku'] as const;
export const resolves = (model: string): boolean => (ADVERTISED_MODELS as readonly string[]).includes(acpModel(model));

export interface ModelProblem { agent: string; name: string; model: string; fallback: string }

/** Every configured model that does not resolve: each enabled assistant's model and the re-plan model setting. */
export function checkModelAliases(db: DB, previousModel: (agentId: string) => string): ModelProblem[] {
  const out: ModelProblem[] = [];
  for (const a of db.prepare('SELECT id, name, model FROM agent_definitions WHERE enabled = 1').all() as Array<{ id: string; name: string; model: string }>)
    if (a.model && !resolves(a.model)) out.push({ agent: a.id, name: a.name, model: a.model, fallback: previousModel(a.id) });
  const replan = String((db.prepare("SELECT value FROM settings WHERE key = 'replan_model'").get() as { value: string } | undefined)?.value ?? process.env.CLAUDEBOT_REPLAN_MODEL ?? '').replace(/^"|"$/g, '').trim();
  if (replan && !resolves(replan)) out.push({ agent: 'coordinator', name: 'Re-planning', model: replan, fallback: previousModel('coordinator') });
  return out;
}

/** Tell the team group (once per assistant, model and day) that a model was refused or does not resolve; returns whether it posted. */
export function reportModelProblem(db: DB, store: JobStore, p: { agent: string; name: string; model: string; fallback: string | null; reason: string; jobId?: string | null }): boolean {
  try {
    const chat = new ChatStore(db, store); const team = chat.teamConversation(); if (!team) return false;
    const key = `${p.agent}|${p.model}|${new Date().toISOString().slice(0, 10)}`;
    if (db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND json_extract(meta, '$.model_problem') = ? LIMIT 1").get(team, key)) return false;
    chat.add({ conversation_id: team, role: 'system', kind: 'activity', job_id: p.jobId ?? null,
      content: `${p.name}'s model "${p.model}" is not accepted by the Claude connection (${p.reason}). ${p.fallback ? `${p.name} is running on ${p.fallback} instead until it is fixed in Edit assistant > Advanced.` : `${p.name}'s turns cannot run until a model is picked in Edit assistant > Advanced.`}`,
      meta: { model_problem: key } } as never);
    return true;
  } catch { return false; }
}
