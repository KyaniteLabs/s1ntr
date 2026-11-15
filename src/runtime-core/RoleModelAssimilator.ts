import { createHash } from 'node:crypto';

export const MODEL_ASSIMILATION_SCHEMA_VERSION = 1 as const;

export const ASSIMILATION_ROLES = [
  'companion',
  'generator',
  'evaluator',
  'harness-author',
  'reviewer',
  'dreamer',
  'consolidator',
] as const;

export type AssimilationRole = typeof ASSIMILATION_ROLES[number];

export interface AuditionModelIdentity {
  provider: string | null;
  model: string | null;
  verified: boolean;
  source: 'api' | 'config' | 'unknown';
}

export interface AuditionSlice {
  role: AssimilationRole;
  domain: string;
  composition: string;
  promptDigest: string;
  budgetDigest: string;
  capabilitiesDigest: string;
  evaluatorDigest: string;
  environmentDigest: string;
  evaluatorIdentity: AuditionModelIdentity;
}

export interface AuditionArmResult {
  configurationDigest: string;
  identity: AuditionModelIdentity;
  artifactDigest: string;
  receiptRef: string;
  metrics: Record<string, number>;
}

export interface MatchedModelAudition {
  trialId: string;
  slice: AuditionSlice;
  baseline: AuditionArmResult;
  challenger: AuditionArmResult;
}

export interface ModelAssimilationDecisionRule {
  objective: string;
  minimumEffect: number;
  minimumTrialsPerRole: number;
  hardFloors: Record<string, number>;
}

export interface RoleModelAssimilationInput {
  decisionRule: ModelAssimilationDecisionRule;
  auditions: MatchedModelAudition[];
}

export interface RoleModelRecommendation {
  role: AssimilationRole;
  domain: string;
  composition: string;
  baseline: AuditionModelIdentity;
  challenger: AuditionModelIdentity;
  trialIds: string[];
  meanEffect: number;
  hardFloorsPass: boolean;
  status: 'recommended' | 'retain-baseline' | 'unknown-identity';
  allowedAction: 'request-explicit-model-promotion' | 'none';
}

export interface RoleModelAssimilationReport {
  schemaVersion: typeof MODEL_ASSIMILATION_SCHEMA_VERSION;
  reportId: string;
  status: 'audition-complete';
  routeMutation: 'forbidden';
  decisionRule: ModelAssimilationDecisionRule;
  auditions: MatchedModelAudition[];
  recommendations: RoleModelRecommendation[];
  receiptDigest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireDigest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`MODEL_ASSIMILATION_INVALID_DIGEST:${field}`);
  }
}

function identityKey(identity: AuditionModelIdentity): string {
  return `${identity.provider ?? 'unknown'}:${identity.model ?? 'unknown'}`;
}

function validateIdentity(identity: AuditionModelIdentity, allowUnknown: boolean): void {
  const known = Boolean(identity.provider?.trim() && identity.model?.trim());
  if (identity.verified && (!known || identity.source === 'unknown')) {
    throw new Error('MODEL_ASSIMILATION_IDENTITY_INVALID');
  }
  if (!known && (
    !allowUnknown
    || identity.verified
    || identity.source !== 'unknown'
    || identity.provider !== null
    || identity.model !== null
  )) {
    throw new Error('MODEL_ASSIMILATION_IDENTITY_INVALID');
  }
  if (known && identity.source === 'unknown') {
    throw new Error('MODEL_ASSIMILATION_IDENTITY_INVALID');
  }
}

export function fingerprintAuditionSlice(slice: AuditionSlice): string {
  if (!slice.domain.trim() || !slice.composition.trim()) {
    throw new Error('MODEL_ASSIMILATION_SLICE_INCOMPLETE');
  }
  for (const field of [
    'promptDigest', 'budgetDigest', 'capabilitiesDigest',
    'evaluatorDigest', 'environmentDigest',
  ] as const) {
    requireDigest(slice[field], field);
  }
  validateIdentity(slice.evaluatorIdentity, false);
  return digest(slice);
}

function validateDecisionRule(rule: ModelAssimilationDecisionRule): void {
  if (
    !rule.objective.trim()
    || !Number.isFinite(rule.minimumEffect)
    || !Number.isInteger(rule.minimumTrialsPerRole)
    || rule.minimumTrialsPerRole < 2
    || Object.keys(rule.hardFloors).length === 0
  ) throw new Error('MODEL_ASSIMILATION_DECISION_RULE_INVALID');
  if (Object.values(rule.hardFloors).some(value => !Number.isFinite(value))) {
    throw new Error('MODEL_ASSIMILATION_DECISION_RULE_INVALID');
  }
}

function validateAuditions(input: RoleModelAssimilationInput): void {
  validateDecisionRule(input.decisionRule);
  const ids = new Set<string>();
  for (const audition of input.auditions) {
    if (!audition.trialId.trim() || ids.has(audition.trialId)) {
      throw new Error('MODEL_ASSIMILATION_TRIAL_ID_INVALID');
    }
    ids.add(audition.trialId);
    const configurationDigest = fingerprintAuditionSlice(audition.slice);
    if (
      audition.baseline.configurationDigest !== configurationDigest
      || audition.challenger.configurationDigest !== configurationDigest
    ) throw new Error('MODEL_ASSIMILATION_CONFIGURATION_MISMATCH');
    validateIdentity(audition.baseline.identity, false);
    validateIdentity(audition.challenger.identity, true);
    if (
      identityKey(audition.baseline.identity) === identityKey(audition.challenger.identity)
      ||
      identityKey(audition.slice.evaluatorIdentity) === identityKey(audition.baseline.identity)
      || identityKey(audition.slice.evaluatorIdentity) === identityKey(audition.challenger.identity)
    ) throw new Error('MODEL_ASSIMILATION_EVALUATOR_NOT_INDEPENDENT');
    for (const arm of [audition.baseline, audition.challenger]) {
      requireDigest(arm.artifactDigest, `${audition.trialId}.artifact`);
      if (!arm.receiptRef.trim()) throw new Error('MODEL_ASSIMILATION_RECEIPT_MISSING');
      for (const metric of [
        input.decisionRule.objective,
        ...Object.keys(input.decisionRule.hardFloors),
      ]) {
        if (!Number.isFinite(arm.metrics[metric])) {
          throw new Error(`MODEL_ASSIMILATION_METRIC_MISSING:${metric}`);
        }
      }
    }
    if (
      audition.baseline.artifactDigest === audition.challenger.artifactDigest
      || audition.baseline.receiptRef === audition.challenger.receiptRef
    ) throw new Error('MODEL_ASSIMILATION_ARMS_NOT_DISTINCT');
  }
}

function groupKey(audition: MatchedModelAudition): string {
  return [
    audition.slice.role,
    audition.slice.domain,
    audition.slice.composition,
    identityKey(audition.challenger.identity),
  ].join('|');
}

function recommendGroup(
  auditions: MatchedModelAudition[],
  rule: ModelAssimilationDecisionRule,
): RoleModelRecommendation {
  const first = auditions[0];
  const effects = auditions.map(audition =>
    audition.challenger.metrics[rule.objective]
      - audition.baseline.metrics[rule.objective]);
  const meanEffect = effects.reduce((sum, value) => sum + value, 0) / effects.length;
  const hardFloorsPass = auditions.every(audition =>
    Object.entries(rule.hardFloors).every(([metric, floor]) =>
      audition.challenger.metrics[metric] >= floor));
  const identityKnown = first.challenger.identity.verified
    && first.challenger.identity.provider !== null
    && first.challenger.identity.model !== null;
  const recommended = identityKnown && hardFloorsPass && meanEffect >= rule.minimumEffect;
  return {
    role: first.slice.role,
    domain: first.slice.domain,
    composition: first.slice.composition,
    baseline: structuredClone(first.baseline.identity),
    challenger: structuredClone(first.challenger.identity),
    trialIds: auditions.map(audition => audition.trialId),
    meanEffect,
    hardFloorsPass,
    status: identityKnown
      ? recommended ? 'recommended' : 'retain-baseline'
      : 'unknown-identity',
    allowedAction: recommended ? 'request-explicit-model-promotion' : 'none',
  };
}

export function assimilateModelsByRole(
  input: RoleModelAssimilationInput,
): RoleModelAssimilationReport {
  validateAuditions(input);
  const normalizedInput = {
    decisionRule: structuredClone(input.decisionRule),
    auditions: structuredClone(input.auditions),
  };
  const groups = new Map<string, MatchedModelAudition[]>();
  for (const audition of input.auditions) {
    const key = groupKey(audition);
    groups.set(key, [...(groups.get(key) ?? []), audition]);
  }
  const recommendations: RoleModelRecommendation[] = [];
  for (const auditions of groups.values()) {
    if (auditions.length < input.decisionRule.minimumTrialsPerRole) {
      throw new Error('MODEL_ASSIMILATION_TRIALS_INSUFFICIENT');
    }
    const baselineKey = identityKey(auditions[0].baseline.identity);
    if (auditions.some(audition =>
      identityKey(audition.baseline.identity) !== baselineKey)) {
      throw new Error('MODEL_ASSIMILATION_BASELINE_CHANGED');
    }
    recommendations.push(recommendGroup(auditions, input.decisionRule));
  }
  const coveredRoles = new Set(
    recommendations
      .filter(item => item.status !== 'unknown-identity')
      .map(item => item.role),
  );
  if (!ASSIMILATION_ROLES.every(role => coveredRoles.has(role))) {
    throw new Error('MODEL_ASSIMILATION_ROLE_COVERAGE_INCOMPLETE');
  }
  const unsigned = {
    schemaVersion: MODEL_ASSIMILATION_SCHEMA_VERSION,
    reportId: `assimilation:${digest(normalizedInput).slice(0, 16)}`,
    status: 'audition-complete' as const,
    routeMutation: 'forbidden' as const,
    ...normalizedInput,
    recommendations,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseRoleModelAssimilationReport(
  value: unknown,
): RoleModelAssimilationReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_MODEL_ASSIMILATION_REPORT');
  }
  const report = value as RoleModelAssimilationReport;
  if (
    report.schemaVersion !== MODEL_ASSIMILATION_SCHEMA_VERSION
    || report.status !== 'audition-complete'
    || report.routeMutation !== 'forbidden'
    || !/^assimilation:[a-f0-9]{16}$/.test(report.reportId)
  ) throw new Error('INVALID_MODEL_ASSIMILATION_REPORT');
  const expected = assimilateModelsByRole({
    decisionRule: report.decisionRule,
    auditions: report.auditions,
  });
  if (canonical(expected) !== canonical(report)) {
    throw new Error('INVALID_MODEL_ASSIMILATION_REPORT:digest');
  }
  return report;
}
