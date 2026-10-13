/** Bounded exponential backoff for retryable failures: 30s,1m,2m,4m,8m then 15m cap. */
export function retryDelaySeconds(retryCount: number): number {
  const unit = Number(process.env.CLAUDEBOT_RETRY_BASE_SECONDS ?? 30);   // tests shrink the schedule; production is 30s doubling
  const base = unit * 2 ** Math.max(0, retryCount);
  return Math.min(base, Math.max(unit, 15 * 60));
}

/** Probe schedule when a plan limit gives no reset time: 5,10,20,40 then 60m cap. */
export function resetProbeDelaySeconds(probeCount: number): number {
  const base = 5 * 60 * 2 ** Math.max(0, probeCount);
  return Math.min(base, 60 * 60);
}

export const DEFAULT_RETRY_BUDGET = 5;

export function retryBudgetExhausted(retryCount: number, budget = DEFAULT_RETRY_BUDGET): boolean {
  return retryCount >= budget;
}
