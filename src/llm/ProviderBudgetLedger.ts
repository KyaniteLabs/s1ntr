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
import { withFileLockSync } from '../utils/fileLock.js';
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
  /** Worst-case USD held for submitted-but-unsettled work (Message Batches), keyed by reservation id. */
  reservations?: Record<string, number>;
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

export const providerBudgetPath = (): string =>
  path.resolve(process.env.SINTER_LIMINAL_RUNTIME_ROOT || homedir(), '.sinter', 'provider-budgets.json');

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

function loadBudgets(file = providerBudgetPath()): BudgetFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ProviderBudgetConfigInvalidError(`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProviderBudgetConfigInvalidError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderBudgetConfigInvalidError(`${file} must map endpoint hosts to budgets`);
  }
  const validUsd = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const [host, entry] of Object.entries(parsed as BudgetFile)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !validUsd(entry.capUsd) || !validUsd(entry.spendUsd)) {
      throw new ProviderBudgetConfigInvalidError(`${file} has an invalid budget for ${host}`);
    }
    if (entry.allowedModels !== undefined && (!Array.isArray(entry.allowedModels)
      || !entry.allowedModels.every(model => typeof model === 'string' && model.length > 0))) {
      throw new ProviderBudgetConfigInvalidError(`${file} has invalid model earmarks for ${host}`);
    }
    if (entry.reservations !== undefined && (!entry.reservations || typeof entry.reservations !== 'object'
      || Array.isArray(entry.reservations) || !Object.values(entry.reservations).every(validUsd))) {
      throw new ProviderBudgetConfigInvalidError(`${file} has invalid reservations for ${host}`);
    }
  }
  return parsed as BudgetFile;
}

function updateBudgets<T>(filePath: string, update: (file: BudgetFile) => T): T {
  mkdirSync(path.dirname(filePath), { recursive: true });
  return withFileLockSync(filePath + '.lock', () => {
    const file = loadBudgets(filePath);
    const result = update(file);
    writeAtomicSync(filePath, JSON.stringify(file, null, 2) + '\n');
    return result;
  });
}

function assertModelAllowed(host: string, entry: BudgetEntry, model: string): void {
  if (entry.allowedModels?.length && !entry.allowedModels.includes(model)) {
    throw new ProviderBudgetModelNotAllowedError(host, model, entry);
  }
}

/** Throws when the endpoint's cap is reached or the model is outside the earmark. */
export function assertWithinBudget(baseUrl: string, model: string, filePath = providerBudgetPath()): void {
  const host = hostOf(baseUrl);
  const entry = loadBudgets(filePath)[host];
  if (!entry) return;
  assertModelAllowed(host, entry, model);
  if (entry.spendUsd + sumReserved(entry) >= entry.capUsd) {
    throw new ProviderBudgetExceededError(host, entry);
  }
}

/** Accumulate server-reported spend (idempotent per call — each response costs once). */
export function recordServerCost(baseUrl: string, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const host = hostOf(baseUrl);
  try {
    const filePath = providerBudgetPath();
    if (!loadBudgets(filePath)[host]) return;
    updateBudgets(filePath, file => {
      const entry = file[host];
      if (!entry) return;
      entry.spendUsd = round6(entry.spendUsd + usd);
      entry.costReported = true;
    });
  } catch (error) {
    // A ledger error should be visible without discarding a successful provider response.
    Logger.warn('ProviderBudgetLedger', error instanceof Error ? error.message : String(error));
  }
}

export function budgetStatus(): Array<{ host: string } & BudgetEntry & { remainingUsd: number; closed: boolean }> {
  return Object.entries(loadBudgets()).map(([host, e]) => ({
    host,
    ...e,
    remainingUsd: Math.max(0, Math.round((e.capUsd - e.spendUsd - sumReserved(e)) * 1e6) / 1e6),
    closed: e.spendUsd + sumReserved(e) >= e.capUsd,
  }));
}

const sumReserved = (e: BudgetEntry): number => Object.values(e.reservations ?? {}).reduce((a, b) => a + b, 0);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Create the endpoint's entry on first use; afterwards the cap can only be LOWERED by a smaller operator value, never raised
 * (raising a cap is a deliberate edit of the ledger file). The cap is cumulative across runs and resumes.
 */
export function ensureBudgetEntry(baseUrl: string, capUsd: number, note?: string,
  filePath = providerBudgetPath()): BudgetEntry {
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new ProviderBudgetConfigInvalidError('a budget cap must be a positive USD amount');
  const host = hostOf(baseUrl);
  return updateBudgets(filePath, file => {
    const entry = file[host];
    if (!entry) file[host] = { capUsd, spendUsd: 0, ...(note ? { note } : {}) };
    else if (capUsd < entry.capUsd) entry.capUsd = capUsd;
    return file[host];
  });
}

/** USD still spendable on the endpoint: cap minus recorded spend minus open reservations. Null when the endpoint is unmetered. */
export function budgetRemainingUsd(baseUrl: string, filePath = providerBudgetPath()): number | null {
  const entry = loadBudgets(filePath)[hostOf(baseUrl)];
  return entry ? Math.max(0, round6(entry.capUsd - entry.spendUsd - sumReserved(entry))) : null;
}

/** Hold worst-case USD for one submission. Idempotent per id. Throws when the hold would pass the cap. */
export function reserveBudget(baseUrl: string, id: string, usd: number, filePath = providerBudgetPath(), model?: string): void {
  if (!Number.isFinite(usd) || usd <= 0) throw new ProviderBudgetConfigInvalidError('reservation must be positive and finite');
  updateBudgets(filePath, file => {
    const entry = file[hostOf(baseUrl)];
    if (!entry) throw new ProviderBudgetConfigInvalidError(`no budget entry for ${hostOf(baseUrl)}`);
    if (model !== undefined) assertModelAllowed(hostOf(baseUrl), entry, model);
    entry.reservations ??= {};
    if (Object.hasOwn(entry.reservations, id)) return;
    const amount = Math.ceil(usd * 1e6) / 1e6;
    if (entry.spendUsd + sumReserved(entry) + amount > entry.capUsd + 1e-9) {
      throw new ProviderBudgetExceededError(hostOf(baseUrl), entry);
    }
    entry.reservations[id] = amount;
  });
}

/** Release a hold and book the real cost. Idempotent: a second settle of the same id books nothing. */
export function settleBudget(baseUrl: string, id: string, actualUsd: number, filePath = providerBudgetPath()): void {
  if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new ProviderBudgetConfigInvalidError('actual cost must be finite and non-negative');
  updateBudgets(filePath, file => {
    const entry = file[hostOf(baseUrl)];
    if (!entry?.reservations || !Object.hasOwn(entry.reservations, id)) return;
    delete entry.reservations[id];
    entry.spendUsd = round6(entry.spendUsd + actualUsd);
    entry.costReported = true;
  });
}
