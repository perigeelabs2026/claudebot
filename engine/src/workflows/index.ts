import type { SuccessContract } from '../jobs/types.ts';

export type StageKind = 'claude' | 'deterministic' | 'browser_check' | 'approval_gate' | 'review' | 'chat';

export interface StageDef {
  name: string; kind: StageKind;
  /** claude stages: prompt template; {{objective}} {{workspace}} {{job_id}} {{previous}} {{agent_name}} and any task input are substituted */
  prompt?: string;
  /** optional agent override for this stage (defaults to the workflow's default agent) */
  agent?: string;
  /** deterministic stages: named function in worker/deterministic.ts */
  fn?: string;
  /** browser_check: site hostname (template allowed) */
  site?: string;
  /** approval_gate: consequential kind the next stage would perform */
  approval_kind?: string;
  timeoutMs?: number;
  /** claude stages: 'repository' runs Claude inside the task's repository (from the prepare step) instead of the task folder */
  cwd?: 'workspace' | 'repository';
}

export interface WorkflowDef { id: string; name: string; description: string; default_agent: string; stages: StageDef[]; contract: SuccessContract; inputs: Array<{ name: string; description: string; required: boolean }> }

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
}
