/**
 * ProviderBudgetLedger — hard USD caps per provider endpoint.
 *
 * Born from the CEO DeepInfra mandate (2026-08-30): "$40 budget total, all
 * used for DeepSeek-V4-Flash-0731". DeepInfra returns `usage.estimated_cost`
 * (server-computed USD) on every completion, so the ledger accumulates exact
 * spend, not token math. Fail-closed: once spend reaches the cap, calls to
 * that endpoint throw before the request leaves the machine; a model
 * allowlist keeps budgeted endpoints from being spent on other models.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import { Logger } from '../utils/Logger.js';

export interface BudgetEntry {
  /** Hard ceiling in USD. At spendUsd >= capUsd the endpoint is closed. */
  capUsd: number;
  /** Accumulated spend in USD (server-reported where available). */
  spendUsd: number;
  /** When set, ONLY these model ids may ride this endpoint (budget is earmarked). */
  allowedModels?: string[];
  note?: string;
  /** Set once the endpoint has reported a cost; until then spend is not being counted. */
  costReported?: boolean;
}

interface BudgetFile {
  [host: string]: BudgetEntry;
}

export class ProviderBudgetExceededError extends Error {
  constructor(readonly host: string, readonly entry: BudgetEntry) {
    super(
      `PROVIDER_BUDGET_EXCEEDED: ${host} spent $${entry.spendUsd.toFixed(4)} of $${entry.capUsd.toFixed(2)} cap` +
        (entry.allowedModels?.length ? ` (earmarked for ${entry.allowedModels.join(', ')})` : ''),
    );
    this.name = 'ProviderBudgetExceededError';
  }
}

export class ProviderBudgetModelNotAllowedError extends Error {
  constructor(readonly host: string, readonly model: string, readonly entry: BudgetEntry) {
    super(
      `PROVIDER_BUDGET_MODEL_NOT_ALLOWED: ${model} is outside the earmark for ${host}` +
        ` (allowed: ${entry.allowedModels?.join(', ')})`,
    );
    this.name = 'ProviderBudgetModelNotAllowedError';
  }
}

const budgetPath = (): string =>
  path.join(process.env.SINTER_LIMINAL_RUNTIME_ROOT || homedir(), '.sinter', 'provider-budgets.json');

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

export class ProviderBudgetConfigInvalidError extends Error {
  constructor(detail: string) {
    super(`PROVIDER_BUDGET_CONFIG_INVALID: ${detail}`);
    this.name = 'ProviderBudgetConfigInvalidError';
  }
}

function loadBudgets(): BudgetFile {
  let raw: string;
  try {
    raw = readFileSync(budgetPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ProviderBudgetConfigInvalidError(`${budgetPath()} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw) as BudgetFile;
  } catch (error) {
    throw new ProviderBudgetConfigInvalidError(`${budgetPath()} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveBudgets(file: BudgetFile): void {
  mkdirSync(path.dirname(budgetPath()), { recursive: true });
  writeAtomicSync(budgetPath(), JSON.stringify(file, null, 2) + '\n');
}

/** Throws when the endpoint's cap is reached or the model is outside the earmark. */
export function assertWithinBudget(baseUrl: string, model: string): void {
  const entry = loadBudgets()[hostOf(baseUrl)];
  if (!entry) return; // unmetered endpoint — pre-existing behavior
  if (entry.allowedModels?.length && !entry.allowedModels.includes(model)) {
    throw new ProviderBudgetModelNotAllowedError(hostOf(baseUrl), model, entry);
  }
  if (entry.spendUsd >= entry.capUsd) {
    throw new ProviderBudgetExceededError(hostOf(baseUrl), entry);
  }
}

/** Accumulate server-reported spend (idempotent per call — each response costs once). */
export function recordServerCost(baseUrl: string, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const host = hostOf(baseUrl);
  let file: BudgetFile;
  try {
    file = loadBudgets();
  } catch (error) {
    // A corrupt ledger must not take down a successful provider response,
    // but it must be visible; spend for this call is simply not recorded.
    Logger.warn('ProviderBudgetLedger', error instanceof Error ? error.message : String(error));
    return;
  }
  const entry = file[host];
  if (!entry) return; // only metered endpoints
  entry.spendUsd = Math.round((entry.spendUsd + usd) * 1e6) / 1e6;
  entry.costReported = true;
  saveBudgets(file);
}

export function budgetStatus(): Array<{ host: string } & BudgetEntry & { remainingUsd: number; closed: boolean }> {
  return Object.entries(loadBudgets()).map(([host, e]) => ({
    host,
    ...e,
    remainingUsd: Math.max(0, Math.round((e.capUsd - e.spendUsd) * 1e6) / 1e6),
    closed: e.spendUsd >= e.capUsd,
  }));
}
