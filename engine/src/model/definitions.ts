/** Database-backed, owner-configurable agent and workflow definitions, with protected system defaults and template packs. */
import type { DB } from '../db/open.ts';
import { now } from '../jobs/store.ts';
import type { StageDef } from '../workflows/index.ts';
import type { SuccessContract } from '../jobs/types.ts';
import { SYSTEM_AGENTS, SYSTEM_WORKFLOWS, type AgentSeed, type WorkflowSeed } from '../templates/core.ts';
import * as RevenueOps from '../templates/revenue-ops.ts';

export interface AgentDef extends AgentSeed { role: string; responsibilities: string[]; model: string; routines_ref: string | null; created_by: string; color_index: number | null; station: string | null; is_system: boolean; enabled: boolean; template_pack: string | null; created_at: string; updated_at: string }
export interface WorkflowDef extends WorkflowSeed { is_system: boolean; enabled: boolean; template_pack: string | null; created_at: string; updated_at: string }
/** Office stations (design/system/office.js), in the order they are handed out. */
export const STATIONS = ['table', 'desk', 'mailroom', 'library', 'stage', 'loft', 'workshop', 'porch'];
export const STAGE_KINDS = ['claude', 'deterministic', 'browser_check', 'approval_gate', 'review', 'chat'] as const;
export const PACKS: Record<string, { meta: typeof RevenueOps.PACK; agents: AgentSeed[]; workflows: WorkflowSeed[] }> = { [RevenueOps.PACK.id]: { meta: RevenueOps.PACK, agents: RevenueOps.AGENTS, workflows: RevenueOps.WORKFLOWS } };

const J = (v: unknown) => JSON.stringify(v);
const P = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };

function rowToAgent(r: Record<string, unknown>): AgentDef {
  return { id: String(r.id), name: String(r.name), purpose: String(r.purpose), system_instructions: String(r.system_instructions ?? ''), allowed_tools: P(String(r.allowed_tools), []), data_scopes: P(String(r.data_scopes), []), prohibited_actions: P(String(r.prohibited_actions), []), approval_rules: P(String(r.approval_rules), []), measurable_outputs: P(String(r.measurable_outputs), []), acceptance_tests: P(String(r.acceptance_tests), []), concurrency_limit: Number(r.concurrency_limit), memory_scope: P(String(r.memory_scope), []), role: String(r.role ?? ''), responsibilities: P(String(r.responsibilities ?? '[]'), []), model: String(r.model ?? 'claude-sonnet-5-5'), routines_ref: (r.routines_ref as string) ?? null, created_by: String(r.created_by ?? 'system'), color_index: r.color_index === null || r.color_index === undefined ? null : Number(r.color_index), station: (r.station as string) ?? null, is_system: !!r.is_system, enabled: !!r.enabled, template_pack: (r.template_pack as string) ?? null, created_at: String(r.created_at), updated_at: String(r.updated_at) };
}
function rowToWorkflow(r: Record<string, unknown>): WorkflowDef {
  return { id: String(r.id), name: String(r.name), description: String(r.description ?? ''), default_agent: String(r.default_agent), stages: P(String(r.stages), []), contract: P(String(r.contract), {}), inputs: P(String(r.inputs), []), is_system: !!r.is_system, enabled: !!r.enabled, template_pack: (r.template_pack as string) ?? null, created_at: String(r.created_at), updated_at: String(r.updated_at) };
}

/** Default model of each built-in assistant. */
export const SYSTEM_MODEL: Record<string, string> = { coordinator: 'claude-haiku-5-5', researcher: 'claude-opus-5-5', reviewer: 'claude-sonnet-5-5', browser_operator: 'claude-sonnet-5-5', builder: 'claude-sonnet-5-5' };

export class Definitions {
  private db: DB;
  constructor(db: DB) { this.db = db; }

  private audit(actor: string, type: string, detail: Record<string, unknown>) { this.db.prepare('INSERT INTO job_events(job_id, at, actor, type, detail) VALUES (NULL, ?, ?, ?, ?)').run(now(), actor, type, J(detail)); }

  /** Idempotent: inserts missing system definitions, refreshes system rows' protected fields, never touches owner rows. */
  seedSystemDefaults(): { agents: number; workflows: number } {
    let a = 0, w = 0; const t = now();
    for (const s of SYSTEM_AGENTS) {
      const r = this.db.prepare(`INSERT INTO agent_definitions(id, name, purpose, system_instructions, allowed_tools, data_scopes, prohibited_actions, approval_rules, measurable_outputs, acceptance_tests, concurrency_limit, memory_scope, is_system, enabled, template_pack, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,NULL,?,?) ON CONFLICT(id) DO UPDATE SET is_system=1`).run(s.id, s.name, s.purpose, s.system_instructions, J(s.allowed_tools), J(s.data_scopes), J(s.prohibited_actions), J(s.approval_rules), J(s.measurable_outputs), J(s.acceptance_tests), s.concurrency_limit, J(s.memory_scope), t, t);
      a += Number(r.changes);
      // Tools and instructions are owner-editable on system agents, so the seed refreshes them only while the owner has never edited that agent.
      const edited = this.db.prepare("SELECT 1 FROM job_events WHERE type = 'agent.updated' AND actor = 'owner' AND json_extract(detail, '$.id') = ? LIMIT 1").get(s.id);
      // Model defaults (owner direction 2026-10-13): the lead on Haiku, deep research on Opus, everyone else on Sonnet. Only while the
      // owner has never edited the assistant and it still has the old column default; an owner's choice is never replaced.
      if (!edited) this.db.prepare("UPDATE agent_definitions SET model = ? WHERE id = ? AND model = 'claude-opus-5-5'").run(SYSTEM_MODEL[s.id] ?? 'claude-sonnet-5-5', s.id);
      if (!edited) this.db.prepare('UPDATE agent_definitions SET name = ?, purpose = ?, prohibited_actions = ?, approval_rules = ? WHERE id = ?').run(s.name, s.purpose, J(s.prohibited_actions), J(s.approval_rules), s.id);   /* the owner's wording wins once they have edited this assistant */
      if (!edited) { const u = this.db.prepare('UPDATE agent_definitions SET allowed_tools = ?, system_instructions = ?, updated_at = ? WHERE id = ? AND (allowed_tools != ? OR system_instructions != ?)').run(J(s.allowed_tools), s.system_instructions, t, s.id, J(s.allowed_tools), s.system_instructions); if (Number(u.changes)) this.audit('system', 'agent.seed_refreshed', { id: s.id, tools: s.allowed_tools }); }
    }
    // System identity defaults (color, office station, short role); owner edits are kept.
    // Short roles describe the job, not restate the name. A role still at an earlier default is updated; an owner's own wording is kept.
    const IDENTITY: Record<string, [number, string, string, string]> = { coordinator: [0, 'workshop', 'Leads the team', 'Leads the team'], researcher: [1, 'library', 'Finds and checks sources', 'Research'], builder: [2, 'desk', 'Drafts documents and code', 'Writing and building'], reviewer: [3, 'stage', "Checks work before it's accepted", 'Review'], browser_operator: [4, 'mailroom', 'Uses web pages for you', 'Web pages'] };
    for (const [id, [color, station, role, old]] of Object.entries(IDENTITY)) this.db.prepare("UPDATE agent_definitions SET color_index = COALESCE(color_index, ?), station = COALESCE(station, ?), role = CASE WHEN role = '' OR role = ? THEN ? ELSE role END WHERE id = ?").run(color, station, old, role, id);
    for (const s of SYSTEM_WORKFLOWS) {
      const r = this.db.prepare(`INSERT INTO workflow_definitions(id, name, description, default_agent, stages, contract, inputs, is_system, enabled, template_pack, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,1,NULL,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, stages=excluded.stages, contract=excluded.contract, inputs=excluded.inputs, is_system=1`).run(s.id, s.name, s.description, s.default_agent, J(s.stages), J(s.contract), J(s.inputs), t, t);
      w += Number(r.changes);
    }
    for (const [id, p] of Object.entries(PACKS)) this.db.prepare('INSERT INTO template_packs(id, name, description, version) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, version=excluded.version').run(id, p.meta.name, p.meta.description, p.meta.version);
    return { agents: a, workflows: w };
  }

  // ---- agents ----
  listAgents(opts: { includeDisabled?: boolean } = {}): AgentDef[] { return (this.db.prepare(`SELECT * FROM agent_definitions ${opts.includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY is_system DESC, CASE id WHEN 'coordinator' THEN 0 WHEN 'researcher' THEN 1 WHEN 'reviewer' THEN 2 WHEN 'browser_operator' THEN 3 WHEN 'builder' THEN 4 ELSE 9 END, created_at, id`).all() as Record<string, unknown>[]).map(rowToAgent); }   // stable order: renaming an assistant never moves it
  /** The model a refused model falls back to: the last model the connection accepted for this assistant, else the one it ran on before
   *  its current one, else its built-in default, else Sonnet. */
  previousModel(id: string): string {
    const cur = this.getAgent(id)?.model;
    const r = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(`agent.previous_model.${id}`) as { value: string } | undefined;
    const prev = (() => { try { return r ? String(JSON.parse(r.value)) : ''; } catch { return ''; } })();
    const ok = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(`agent.accepted_model.${id}`) as { value: string } | undefined;
    const accepted = (() => { try { return ok ? String(JSON.parse(ok.value)) : ''; } catch { return ''; } })();
    for (const m of [accepted, prev, SYSTEM_MODEL[id], 'claude-sonnet-5-5']) if (m && m !== cur) return m;
    return 'claude-haiku-5-5';
  }
  getAgent(id: string): AgentDef | undefined { const r = this.db.prepare('SELECT * FROM agent_definitions WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? rowToAgent(r) : undefined; }
  upsertAgent(input: Partial<AgentSeed> & { id: string; name: string; purpose: string }, actor: string): AgentDef {
    const existing = this.getAgent(input.id); const t = now();
    const newModel = (input as { model?: string }).model;
    if (existing && newModel && newModel !== existing.model) this.db.prepare("INSERT INTO runtime_state(key, value, evidence, observed_at) VALUES (?, ?, 'model changed in Edit assistant', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, evidence=excluded.evidence, observed_at=excluded.observed_at").run(`agent.previous_model.${input.id}`, JSON.stringify(existing.model), t);
    if (existing?.is_system) {
      // Built-in assistants are the owner's too: name, description, role, colour, instructions, tools and the wording of their limits can all change.
      // Safety does not depend on this text: what an assistant can do is enforced by the broker's tools and approvals, whatever the wording says.
      this.db.prepare('UPDATE agent_definitions SET name = ?, purpose = ?, system_instructions = ?, allowed_tools = ?, concurrency_limit = ?, memory_scope = ?, data_scopes = ?, prohibited_actions = ?, approval_rules = ?, updated_at = ? WHERE id = ?').run(String(input.name || existing.name), String(input.purpose || existing.purpose), input.system_instructions ?? existing.system_instructions, J(input.allowed_tools ?? existing.allowed_tools), input.concurrency_limit ?? existing.concurrency_limit, J(input.memory_scope ?? existing.memory_scope), J(input.data_scopes ?? existing.data_scopes), J(input.prohibited_actions ?? existing.prohibited_actions), J(input.approval_rules ?? existing.approval_rules), t, input.id);
      this.db.prepare('UPDATE agent_definitions SET role = ?, responsibilities = ?, station = ?, color_index = ?, model = ? WHERE id = ?').run(input.role ?? existing.role, J(input.responsibilities ?? existing.responsibilities), input.station ?? existing.station, input.color_index ?? existing.color_index, input.model ?? existing.model, input.id);
    } else {
      this.db.prepare(`INSERT INTO agent_definitions(id, name, purpose, system_instructions, allowed_tools, data_scopes, prohibited_actions, approval_rules, measurable_outputs, acceptance_tests, concurrency_limit, memory_scope, is_system, enabled, template_pack, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,1,NULL,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, purpose=excluded.purpose, system_instructions=excluded.system_instructions, allowed_tools=excluded.allowed_tools, data_scopes=excluded.data_scopes, prohibited_actions=excluded.prohibited_actions, approval_rules=excluded.approval_rules, measurable_outputs=excluded.measurable_outputs, acceptance_tests=excluded.acceptance_tests, concurrency_limit=excluded.concurrency_limit, memory_scope=excluded.memory_scope, updated_at=excluded.updated_at`)
        .run(input.id, input.name, input.purpose, input.system_instructions ?? '', J(input.allowed_tools ?? []), J(input.data_scopes ?? []), J(input.prohibited_actions ?? []), J(input.approval_rules ?? []), J(input.measurable_outputs ?? []), J(input.acceptance_tests ?? []), input.concurrency_limit ?? 2, J(input.memory_scope ?? []), t, t);
      // Identity: a color from the palette in creation order and a free office station, unless given.
      const color = input.color_index ?? existing?.color_index ?? this.nextColor(input.id);
      this.db.prepare('UPDATE agent_definitions SET role = ?, responsibilities = ?, model = ?, routines_ref = ?, created_by = COALESCE(?, created_by), color_index = ?, station = ? WHERE id = ?').run(input.role ?? existing?.role ?? '', J(input.responsibilities ?? existing?.responsibilities ?? []), input.model ?? existing?.model ?? 'claude-sonnet-5-5', input.routines_ref ?? existing?.routines_ref ?? null, existing ? null : (input.created_by ?? actor), color, input.station ?? existing?.station ?? this.freeStation(), input.id);
    }
    this.audit(actor, existing ? 'agent.updated' : 'agent.created', { id: input.id, system: !!existing?.is_system });
    return this.getAgent(input.id)!;
  }
    /** Next identity color (6-color palette, assigned in creation order). */
  nextColor(exceptId = ''): number { const n = (this.db.prepare('SELECT count(*) AS n FROM agent_definitions WHERE id != ?').get(exceptId) as { n: number }).n; return n % 6; }
  /** An office station not yet taken by an enabled assistant (the office has five). */
  freeStation(): string | null { const taken = new Set((this.db.prepare('SELECT station FROM agent_definitions WHERE enabled = 1 AND station IS NOT NULL').all() as Array<{ station: string }>).map((r) => r.station)); return STATIONS.find((x) => !taken.has(x)) ?? null; }
  setAgentEnabled(id: string, enabled: boolean, actor: string): void { this.db.prepare('UPDATE agent_definitions SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id); this.audit(actor, enabled ? 'agent.enabled' : 'agent.disabled', { id }); }
  deleteAgent(id: string, actor: string): { ok: boolean; reason?: string } { const a = this.getAgent(id); if (!a) return { ok: false, reason: 'not found' }; if (a.is_system) return { ok: false, reason: 'system agents cannot be removed; disable instead' }; { const n = (this.db.prepare('SELECT count(*) AS n FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE m.agent_id = ?').get(id) as { n: number }).n; if (n) return { ok: false, reason: `${a.name} is part of ${n} conversation(s), whose history needs it; turn the assistant off instead` }; } this.db.prepare('DELETE FROM assistant_drafts WHERE agent_id = ?').run(id); this.db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id); this.audit(actor, 'agent.deleted', { id }); return { ok: true }; }
  duplicateAgent(id: string, newId: string, actor: string): AgentDef | undefined { const a = this.getAgent(id); if (!a) return undefined; return this.upsertAgent({ ...a, id: newId, name: `${a.name} (copy)` }, actor); }

  // ---- workflows ----
  listWorkflows(opts: { includeDisabled?: boolean } = {}): WorkflowDef[] { return (this.db.prepare(`SELECT * FROM workflow_definitions ${opts.includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY is_system DESC, name`).all() as Record<string, unknown>[]).map(rowToWorkflow); }
  getWorkflow(id: string): WorkflowDef | undefined { const r = this.db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id) as Record<string, unknown> | undefined; return r ? rowToWorkflow(r) : undefined; }
  validateStages(stages: StageDef[]): string[] {
    const errs: string[] = []; if (!Array.isArray(stages) || !stages.length) errs.push('at least one stage');
    for (const [i, s] of (stages ?? []).entries()) { if (!s.name) errs.push(`stage ${i}: name`); if (!STAGE_KINDS.includes(s.kind)) errs.push(`stage ${i}: kind must be one of ${STAGE_KINDS.join(', ')}`); if (s.kind === 'claude' && !s.prompt) errs.push(`stage ${i}: claude stage needs a prompt`); if (s.kind === 'deterministic' && !s.fn) errs.push(`stage ${i}: deterministic stage needs fn`); if (s.agent && !this.getAgent(s.agent)) errs.push(`stage ${i}: unknown agent ${s.agent}`); }
    const names = new Set<string>(); for (const s of stages ?? []) { if (names.has(s.name)) errs.push(`duplicate stage name ${s.name}`); names.add(s.name); }
    return errs;
  }
  upsertWorkflow(input: { id: string; name: string; description?: string; default_agent: string; stages: StageDef[]; contract?: SuccessContract; inputs?: WorkflowSeed['inputs'] }, actor: string): { ok: true; workflow: WorkflowDef } | { ok: false; errors: string[] } {
    const existing = this.getWorkflow(input.id); if (existing?.is_system) return { ok: false, errors: ['system workflows cannot be edited; duplicate it first'] };
    const errors = this.validateStages(input.stages); if (!this.getAgent(input.default_agent)) errors.push(`unknown default agent ${input.default_agent}`); if (errors.length) return { ok: false, errors };
    const t = now();
    this.db.prepare(`INSERT INTO workflow_definitions(id, name, description, default_agent, stages, contract, inputs, is_system, enabled, template_pack, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,1,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, default_agent=excluded.default_agent, stages=excluded.stages, contract=excluded.contract, inputs=excluded.inputs, updated_at=excluded.updated_at`)
      .run(input.id, input.name, input.description ?? '', input.default_agent, J(input.stages), J(input.contract ?? {}), J(input.inputs ?? []), t, t);
    this.audit(actor, existing ? 'workflow.updated' : 'workflow.created', { id: input.id }); return { ok: true, workflow: this.getWorkflow(input.id)! };
  }
  setWorkflowEnabled(id: string, enabled: boolean, actor: string): void { this.db.prepare('UPDATE workflow_definitions SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id); this.audit(actor, enabled ? 'workflow.enabled' : 'workflow.disabled', { id }); }
  deleteWorkflow(id: string, actor: string): { ok: boolean; reason?: string } { const w = this.getWorkflow(id); if (!w) return { ok: false, reason: 'not found' }; if (w.is_system) return { ok: false, reason: 'system workflows cannot be removed; disable instead' }; this.db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id); this.audit(actor, 'workflow.deleted', { id }); return { ok: true }; }
  duplicateWorkflow(id: string, newId: string, actor: string) { const w = this.getWorkflow(id); if (!w) return { ok: false as const, errors: ['not found'] }; return this.upsertWorkflow({ ...w, id: newId, name: `${w.name} (copy)` }, actor); }

  // ---- template packs ----
  listPacks(): Array<{ id: string; name: string; description: string; version: string; installed_at: string | null; agents: number; workflows: number }> {
    return (this.db.prepare('SELECT * FROM template_packs ORDER BY name').all() as Array<{ id: string; name: string; description: string; version: string; installed_at: string | null }>).map((p) => ({ ...p, agents: PACKS[p.id]?.agents.length ?? 0, workflows: PACKS[p.id]?.workflows.length ?? 0 }));
  }
  installPack(id: string, actor: string): { ok: boolean; reason?: string; agents?: number; workflows?: number } {
    const p = PACKS[id]; if (!p) return { ok: false, reason: 'unknown pack' };
    const t = now(); let a = 0, w = 0;
    this.db.exec('BEGIN');
    try {
      for (const s of p.agents) { a += Number(this.db.prepare(`INSERT OR IGNORE INTO agent_definitions(id, name, purpose, system_instructions, allowed_tools, data_scopes, prohibited_actions, approval_rules, measurable_outputs, acceptance_tests, concurrency_limit, memory_scope, is_system, enabled, template_pack, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,1,?,?,?)`).run(s.id, s.name, s.purpose, s.system_instructions, J(s.allowed_tools), J(s.data_scopes), J(s.prohibited_actions), J(s.approval_rules), J(s.measurable_outputs), J(s.acceptance_tests), s.concurrency_limit, J(s.memory_scope), id, t, t).changes); }
      for (const s of p.workflows) { w += Number(this.db.prepare(`INSERT OR IGNORE INTO workflow_definitions(id, name, description, default_agent, stages, contract, inputs, is_system, enabled, template_pack, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,1,?,?,?)`).run(s.id, s.name, s.description, s.default_agent, J(s.stages), J(s.contract), J(s.inputs), id, t, t).changes); }
      this.db.prepare('UPDATE template_packs SET installed_at = ?, installed_by = ? WHERE id = ?').run(t, actor, id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.audit(actor, 'template.installed', { id, agents: a, workflows: w }); return { ok: true, agents: a, workflows: w };
  }
  uninstallPack(id: string, actor: string): { ok: boolean; reason?: string } {
    if (!PACKS[id]) return { ok: false, reason: 'unknown pack' };
    const inUse = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state NOT IN ('completed','failed_terminal','cancelled') AND kind IN (SELECT id FROM workflow_definitions WHERE template_pack = ?)`).get(id) as { n: number }).n;
    if (inUse) return { ok: false, reason: `${inUse} open task(s) still use this pack's workflows` };
    { const chats = (this.db.prepare('SELECT count(*) AS n FROM conversation_members WHERE agent_id IN (SELECT id FROM agent_definitions WHERE template_pack = ?)').get(id) as { n: number }).n; if (chats) return { ok: false, reason: `assistants from this pack are part of ${chats} conversation(s); turn them off instead of uninstalling` }; }
    this.db.exec('BEGIN'); try { this.db.prepare('DELETE FROM workflow_definitions WHERE template_pack = ?').run(id); this.db.prepare('DELETE FROM agent_definitions WHERE template_pack = ?').run(id); this.db.prepare('UPDATE template_packs SET installed_at = NULL, installed_by = NULL WHERE id = ?').run(id); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.audit(actor, 'template.uninstalled', { id }); return { ok: true };
  }
}
