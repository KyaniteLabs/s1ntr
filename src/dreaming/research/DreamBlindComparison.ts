import { createHash } from 'node:crypto';

export interface DreamOperatorDeclaration {
  readonly id: string;
  readonly factor: string;
  readonly compatibleDomains: readonly string[];
  readonly protectedInvariants: readonly string[];
  readonly structuralDiffRules: readonly string[];
  readonly declarationDigest: string;
}

export interface DreamBlindComparisonPolicy {
  readonly criterionIds: readonly string[];
  readonly evaluatorOrderSeeds: readonly [string, string];
  readonly disagreementRule: 'inconclusive';
  readonly uncertaintyThreshold: number;
  readonly criticalRegressionCriteria: readonly string[];
  readonly policyDigest: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    key => `${JSON.stringify(key)}:${canonical(record[key])}`,
  ).join(',')}}`;
}

export function dreamContractDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function sealDreamOperatorDeclaration(
  value: Omit<DreamOperatorDeclaration, 'declarationDigest'>,
): DreamOperatorDeclaration {
  if (!value.id || !value.factor || value.compatibleDomains.length === 0
    || value.protectedInvariants.length === 0 || value.structuralDiffRules.length === 0) {
    throw new Error('DREAM_OPERATOR_DECLARATION_INVALID');
  }
  return Object.freeze({ ...value, declarationDigest: dreamContractDigest(value) });
}

export function sealDreamBlindComparisonPolicy(
  value: Omit<DreamBlindComparisonPolicy, 'policyDigest'>,
): DreamBlindComparisonPolicy {
  if (value.criterionIds.length === 0 || value.evaluatorOrderSeeds.length !== 2
    || value.evaluatorOrderSeeds[0] === value.evaluatorOrderSeeds[1]
    || !value.evaluatorOrderSeeds.every(seed => /^[a-f0-9]{64}$/.test(seed))
    || value.uncertaintyThreshold < 0 || value.uncertaintyThreshold > 1
    || value.criticalRegressionCriteria.some(
      criterion => !value.criterionIds.includes(criterion))) {
    throw new Error('DREAM_BLIND_POLICY_INVALID');
  }
  return Object.freeze({ ...value, policyDigest: dreamContractDigest(value) });
}

export interface DreamAnonymousArm<Evidence> {
  readonly armId: string;
  readonly evidence: Evidence;
}

export interface DreamAnonymousComparison<Evidence> {
  readonly schema: 'sinter.dream-anonymous-comparison';
  readonly policyDigest: string;
  readonly criteria: readonly string[];
  readonly arms: readonly DreamAnonymousArm<Evidence>[];
}

export function structuralRuleMatches(rule: string, path: string): boolean {
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^.]+');
  return new RegExp(`^${escaped}$`).test(path);
}

export function dreamCreativeDeltaDigest(baselineSource: string,
  variantSource: string, changedPaths: readonly string[]): string {
  return dreamContractDigest({ baselineSource, variantSource, changedPaths });
}

export function isCreativeWrapper(baselineSource: string, variantSource: string): boolean {
  const compact = (source: string) => source.replace(/\s+/g, ' ').trim();
  const baseline = compact(baselineSource);
  const variant = compact(variantSource);
  return baseline.length > 0 && variant.length > baseline.length && variant.includes(baseline);
}
