/** The single model-runtime seam. Only `claude-acp` is enabled in this build. */
export type RuntimeId = 'claude-acp' | 'claude-work' | 'anthropic-api' | 'bedrock' | 'vertex' | 'simulated';

export type FailureCategory = 'quota_exhausted' | 'rate_limited' | 'auth_required' | 'access_denied' | 'transient' | 'cancelled' | 'hung' | 'crashed' | 'internal' | 'model_refused';

export interface TurnRequest {
  jobId: string;
  sessionRef: string;        // stable session key (e.g. agent:market_research:job-xyz)
  label?: string;            // ACP session label (defaults to jobId); conversations use their own id so turns share one session
  role: string;
  cwd: string;
  prompt: string;
  resume: boolean;           // true when continuing an existing session after interruption
  timeoutMs: number;
  /** the assistant's own Claude model (its Edit assistant setting); applied to the session before the turn, never silently replaced */
  model?: string;
  /** used for this turn only when the backend refuses `model` (the assistant's previous model); the result then carries modelFallback */
  fallbackModel?: string;
  onHeartbeat?: (note: string) => void;
  /** called as soon as the runtime session is bound, before the turn starts, so a stop can target it immediately */
  onSession?: (sessionRef: string) => void;
  signal?: AbortSignal;
  /** a control command in an existing session (e.g. /usage): never spawn a session, never change its timeout, never fall back to history */
  probeOnly?: boolean;
}

export interface ModelFallback { requested: string; used: string; reason: string }
export interface TurnSuccess { ok: true; text: string; runtimeSessionId?: string | null; usage?: Record<string, unknown>; durationMs: number; modelFallback?: ModelFallback }
export interface TurnFailure { ok: false; category: FailureCategory; message: string; resetAt?: string | null; retryable: boolean; runtimeSessionId?: string | null; detail?: Record<string, unknown>; modelFallback?: ModelFallback; modelRefused?: { model: string; reason: string } }
export type TurnResult = TurnSuccess | TurnFailure;

export interface RuntimeHealth { id: RuntimeId; configured: boolean; ok: boolean; state: 'ready' | 'auth_required' | 'limited' | 'unreachable' | 'not_configured'; detail: string; observedAt: string; account?: { loggedIn: boolean; method?: string; subscription?: string; email?: string } }

export interface ModelRuntime {
  readonly id: RuntimeId;
  describe(): { label: string; route: string; account: string };
  health(): Promise<RuntimeHealth>;
  startTurn(req: TurnRequest): Promise<TurnResult>;
  cancel(sessionRef: string): Promise<void>;
  /** Close a persistent session and free its processes (adapter + model CLI). Optional for runtimes without sessions. */
  closeSession?(sessionRef: string): Promise<void>;
  /** The models the Claude connection advertises, in its own words (null when it does not list them). */
  advertisedModels?(opts?: { probe?: boolean; fresh?: boolean; sessionKey?: string | null; sessionKeys?: string[]; roleModels?: Record<string, string>; budgetMs?: number }): Promise<{ models: string[]; reply: string } | null>;
  /** Read-only inspection of a known owned session; no model turn or setting changes. */
  inspectSession?(sessionRef: string): Promise<{ text: string; observed_at: string }>;
}
