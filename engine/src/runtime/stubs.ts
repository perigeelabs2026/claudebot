import type { ModelRuntime, RuntimeHealth, RuntimeId, TurnRequest, TurnResult } from './types.ts';

function notConfigured(id: RuntimeId, label: string, route: string): ModelRuntime {
  return {
    id,
    describe: () => ({ label, route, account: 'not configured' }),
    health: async (): Promise<RuntimeHealth> => ({ id, configured: false, ok: false, state: 'not_configured', detail: `${label} adapter is an interface stub in this build; no credentials are configured and none are read.`, observedAt: new Date().toISOString() }),
    startTurn: async (_req: TurnRequest): Promise<TurnResult> => ({ ok: false, category: 'internal', message: `${label} runtime is not configured`, retryable: false }),
    cancel: async () => {},
  };
}

export const claudeWorkStub = notConfigured('claude-work', 'Claude for Work / Enterprise', 'official Claude Code login with a Work/Enterprise org (not configured)');
export const anthropicApiStub = notConfigured('anthropic-api', 'Anthropic API', 'direct Messages API with an API key (not configured, no key read)');
export const bedrockStub = notConfigured('bedrock', 'Amazon Bedrock', 'Claude via Bedrock (not configured)');
export const vertexStub = notConfigured('vertex', 'Google Vertex AI', 'Claude via Vertex (not configured)');
