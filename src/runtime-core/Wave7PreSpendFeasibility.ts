import { createHash } from 'node:crypto';
import {
  createPreSpendFeasibilityProof,
  type PaidCallSlot,
  type PreSpendBudgetRow,
  type PreSpendFeasibilityProof,
} from '../llm/PreSpendInterlock.js';
import {
  parseWave7ReleaseEvidenceManifest,
  WAVE7_SEAT_FREEZE,
  type Wave7ReleaseEvidenceManifest,
  type Wave7ReleaseRunKind,
} from './Wave7ReleaseContract.js';

export type Wave7PaidRole = keyof typeof WAVE7_SEAT_FREEZE;

export interface Wave7ResolvedPaidRoute {
  role: Wave7PaidRole;
  provider: string;
  model: string;
  effort: string;
  pipe: string;
  identityVerified: boolean;
}

export interface Wave7PriceEvidence {
  provider: string;
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  sourceUrl: string;
  verifiedAt: string;
}

export interface Wave7PriceReceipt {
  schemaVersion: 1;
  generatedAt: string;
  routes: Wave7ResolvedPaidRoute[];
  prices: Wave7PriceEvidence[];
}

interface ScheduleRecipe {
  role: Wave7PaidRole;
  minCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  minActiveMinutes: number;
}

const RECIPES: Record<Wave7ReleaseRunKind, ScheduleRecipe[]> = {
  circulation: [
    { role: 'creative', minCalls: 2, maxInputTokens: 12_000, maxOutputTokens: 16_000, minActiveMinutes: 8 },
    { role: 'harness', minCalls: 6, maxInputTokens: 24_000, maxOutputTokens: 12_000, minActiveMinutes: 18 },
  ],
  recovery: [
    { role: 'creative', minCalls: 4, maxInputTokens: 12_000, maxOutputTokens: 16_000, minActiveMinutes: 16 },
    { role: 'harness', minCalls: 12, maxInputTokens: 24_000, maxOutputTokens: 12_000, minActiveMinutes: 36 },
  ],
  'creative-lane': [
    { role: 'creative', minCalls: 6, maxInputTokens: 12_000, maxOutputTokens: 16_000, minActiveMinutes: 18 },
    { role: 'creativeEvaluator', minCalls: 3, maxInputTokens: 16_000, maxOutputTokens: 4_000, minActiveMinutes: 9 },
  ],
  assimilate: [
    { role: 'harness', minCalls: 1, maxInputTokens: 24_000, maxOutputTokens: 8_000, minActiveMinutes: 5 },
  ],
  'domain-smoke': [
    { role: 'creative', minCalls: 1, maxInputTokens: 8_000, maxOutputTokens: 12_000, minActiveMinutes: 3 },
  ],
  'studio-journey': [
    { role: 'creative', minCalls: 2, maxInputTokens: 12_000, maxOutputTokens: 16_000, minActiveMinutes: 8 },
    { role: 'harness', minCalls: 6, maxInputTokens: 24_000, maxOutputTokens: 12_000, minActiveMinutes: 18 },
  ],
  'cli-journey': [
    { role: 'creative', minCalls: 2, maxInputTokens: 12_000, maxOutputTokens: 16_000, minActiveMinutes: 8 },
    { role: 'harness', minCalls: 6, maxInputTokens: 24_000, maxOutputTokens: 12_000, minActiveMinutes: 18 },
  ],
  'product-delta': [
    { role: 'harness', minCalls: 2, maxInputTokens: 32_000, maxOutputTokens: 16_000, minActiveMinutes: 20 },
    { role: 'productReviewer', minCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 8_000, minActiveMinutes: 10 },
  ],
  'sol-review-bootstrap': [
    { role: 'harness', minCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 8_000, minActiveMinutes: 10 },
  ],
  'sol-review-confirmation': [
    { role: 'harness', minCalls: 1, maxInputTokens: 32_000, maxOutputTokens: 8_000, minActiveMinutes: 10 },
  ],
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function interlockRole(role: Wave7PaidRole): PaidCallSlot['role'] {
  if (role === 'creative') return 'generator';
  if (role === 'creativeEvaluator') return 'evaluator';
  if (role === 'productReviewer') return 'critic';
  return 'harness';
}

function validatePriceReceipt(receipt: Wave7PriceReceipt, manifestGeneratedAt: string): string[] {
  const failures: string[] = [];
  if (receipt.schemaVersion !== 1 || !Number.isFinite(Date.parse(receipt.generatedAt))) {
    failures.push('price receipt schema or timestamp is invalid');
  }
  for (const [role, frozen] of Object.entries(WAVE7_SEAT_FREEZE) as Array<
    [Wave7PaidRole, { model: string; effort: string }]
  >) {
    const routes = receipt.routes.filter(route => route.role === role);
    if (routes.length !== 1) {
      failures.push(`${role}: exactly one resolved paid route is required`);
      continue;
    }
    const route = routes[0];
    if (!route.identityVerified || !route.provider || !route.pipe || route.model !== frozen.model
      || route.effort !== frozen.effort) {
      failures.push(`${role}: route identity does not match the frozen seat`);
    }
  }
  for (const price of receipt.prices) {
    const verifiedAt = Date.parse(price.verifiedAt);
    const receiptAt = Date.parse(receipt.generatedAt);
    if (!price.provider || !price.model || !price.sourceUrl
      || !Number.isFinite(Date.parse(price.verifiedAt))
      || verifiedAt > receiptAt || receiptAt - verifiedAt > 24 * 60 * 60 * 1000
      || !Number.isFinite(price.inputUsdPerMillion) || price.inputUsdPerMillion < 0
      || !Number.isFinite(price.outputUsdPerMillion) || price.outputUsdPerMillion < 0) {
      failures.push(`invalid price evidence for ${price.provider}/${price.model}`);
    }
  }
  if (Date.parse(receipt.generatedAt) < Date.parse(manifestGeneratedAt)) {
    failures.push('price receipt predates the release manifest');
  }
  return failures;
}

export interface Wave7FeasibilityBundle {
  declaredSlots: PaidCallSlot[];
  proof: PreSpendFeasibilityProof;
  priceReceiptDigest: string;
  failures: string[];
}

export function buildWave7PreSpendFeasibility(input: {
  manifest: Wave7ReleaseEvidenceManifest;
  planHash: string;
  priceReceipt: Wave7PriceReceipt;
  bootstrapRequestDigests: Record<string, string>;
}): Wave7FeasibilityBundle {
  const manifest = parseWave7ReleaseEvidenceManifest(input.manifest);
  const failures = validatePriceReceipt(input.priceReceipt, manifest.generatedAt);
  const routes = new Map(input.priceReceipt.routes.map(route => [route.role, route]));
  const declaredSlots = manifest.declaredRuns.flatMap(run => RECIPES[run.kind].map((recipe, index) => {
    const route = routes.get(recipe.role);
    const bootstrap = run.kind === 'sol-review-bootstrap' || run.kind === 'sol-review-confirmation';
    const requestDigest = bootstrap ? input.bootstrapRequestDigests[run.id] : undefined;
    if (bootstrap && !/^[a-f0-9]{64}$/.test(requestDigest ?? '')) {
      failures.push(`${run.id}: exact bootstrap request digest is required`);
    }
    return {
      id: `${run.id}:${recipe.role}:${index + 1}`,
      releaseRunSlotId: run.id,
      purpose: bootstrap ? 'sol-review-bootstrap' as const : 'product' as const,
      provider: route?.provider ?? '', model: route?.model ?? '',
      role: interlockRole(recipe.role), minCalls: recipe.minCalls,
      maxCalls: recipe.minCalls + (run.kind === 'creative-lane' ? 1 : 0),
      maxInputTokens: recipe.maxInputTokens, maxOutputTokens: recipe.maxOutputTokens,
      minActiveMinutes: recipe.minActiveMinutes, requestDigest,
    };
  }));
  for (const run of manifest.declaredRuns) {
    if (!declaredSlots.some(slot => slot.releaseRunSlotId === run.id)) failures.push(`${run.id}: no paid schedule mapping`);
  }
  const priceReceiptDigest = digest(input.priceReceipt);
  const budgetRows: PreSpendBudgetRow[] = declaredSlots.map(slot => {
    const price = input.priceReceipt.prices.find(item =>
      item.provider === slot.provider && item.model === slot.model);
    return { slotId: slot.id, maxCalls: slot.maxCalls, maxInputTokens: slot.maxInputTokens,
      maxOutputTokens: slot.maxOutputTokens, minActiveMinutes: slot.minActiveMinutes,
      inputUsdPerMillion: price?.inputUsdPerMillion, outputUsdPerMillion: price?.outputUsdPerMillion };
  });
  const computed = createPreSpendFeasibilityProof({
    planHash: input.planHash, sourceFingerprint: manifest.sourceFingerprint,
    priceReceiptDigest, declaredSlots, budgetRows,
    approvedUsdCeiling: manifest.ownerApprovedUsdCeiling,
  });
  const allFailures = [...failures, ...computed.failures];
  return {
    declaredSlots,
    priceReceiptDigest,
    failures: allFailures,
    proof: { ...computed, passed: allFailures.length === 0, failures: allFailures },
  };
}
