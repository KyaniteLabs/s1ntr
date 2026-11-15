/** Wave budget ceiling enforcer (UMD-V2 F3). */

export const DEFAULT_BUDGET = {
  maxCalls: Number(process.env.LIMINAL_WAVE_BUDGET_CALLS || process.env.SINTER_WAVE_BUDGET_CALLS || 200),
  maxTokens: Number(process.env.LIMINAL_WAVE_BUDGET_TOKENS || process.env.SINTER_WAVE_BUDGET_TOKENS || 2_000_000),
  maxUsd: Number(process.env.LIMINAL_WAVE_BUDGET_USD || process.env.SINTER_WAVE_BUDGET_USD || 50),
  maxMs: Number(process.env.LIMINAL_WAVE_BUDGET_MS || process.env.SINTER_WAVE_BUDGET_MS || 3_600_000),
};

export function loadBudget(overrides = {}) {
  return { ...DEFAULT_BUDGET, ...overrides };
}

/**
 * @param {{ calls?: number, tokens?: number, usd?: number, ms?: number }} usage
 * @param {ReturnType<typeof loadBudget>} budget
 */
export function checkBudget(usage, budget = loadBudget()) {
  const breaches = [];
  if ((usage.calls ?? 0) > budget.maxCalls) breaches.push(`calls ${usage.calls} > ${budget.maxCalls}`);
  if ((usage.tokens ?? 0) > budget.maxTokens) breaches.push(`tokens ${usage.tokens} > ${budget.maxTokens}`);
  if ((usage.usd ?? 0) > budget.maxUsd) breaches.push(`usd ${usage.usd} > ${budget.maxUsd}`);
  if ((usage.ms ?? 0) > budget.maxMs) breaches.push(`ms ${usage.ms} > ${budget.maxMs}`);
  return { ok: breaches.length === 0, breaches, budget, usage };
}

export function assertBudget(usage, budget = loadBudget()) {
  const r = checkBudget(usage, budget);
  if (!r.ok) {
    const err = new Error(`wave budget exceeded: ${r.breaches.join('; ')}`);
    err.code = 'WAVE_BUDGET_EXCEEDED';
    err.detail = r;
    throw err;
  }
  return r;
}
