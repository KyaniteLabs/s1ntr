import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  StudioLineageLedger,
  type StudioLineageRecord,
} from '../tui-bridge/StudioLineage.js';
import type { Wave6Lane } from '../composition/StudioControlRecipe.js';

export const FORMAL_RUN_ORDER = ['C1', 'T1', 'T2', 'C2', 'C3', 'T3'] as const;
export type Wave6RunLabel = typeof FORMAL_RUN_ORDER[number];
export type Wave6Status = 'PASS' | 'FAIL' | 'DEFERRED' | 'PENDING_OWNER';

interface Wave6GeneratorRole {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function createWave6LiveEnvironment(input: {
  inherited: NodeJS.ProcessEnv;
  configPath: string;
  lineagePath: string;
  generator: Wave6GeneratorRole;
}): NodeJS.ProcessEnv {
  const environment = { ...input.inherited };
  for (const key of Object.keys(environment)) {
    if (/^LIMINAL_(?:LLM|HARNESS|EVALUATOR|STUDIO)_/.test(key)) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    SINTER_CONFIG_PATH: input.configPath,
    LIMINAL_CONFIG_PATH: input.configPath,
    SINTER_STUDIO_LINEAGE_PATH: input.lineagePath,
    LLM_PROVIDER: input.generator.provider,
    LLM_BASE_URL: input.generator.baseUrl,
    LLM_MODEL: input.generator.model,
    LLM_API_KEY: input.generator.apiKey,
    LIMINAL_LLM_PROVIDER: input.generator.provider,
    LIMINAL_LLM_BASE_URL: input.generator.baseUrl,
    LIMINAL_LLM_MODEL: input.generator.model,
    LIMINAL_LLM_API_KEY: input.generator.apiKey,
    OPENAI_API_KEY: input.generator.apiKey,
  };
}

const TRANSPORT = {
  cadenceMs: 33,
  bufferSize: 4,
  staleAfterMs: 132,
  staleBehavior: 'hold' as const,
};

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function laneDefinition(input: {
  brief: string;
  source: string;
  target: string;
  mapping: { scale: number; offset: number; clamp: [number, number] };
  allowlist: string[];
}) {
  return {
    ...input,
    transport: TRANSPORT,
    allowlistDigest: sha256(input.allowlist),
  };
}

export const WAVE6_LANE_DEFINITIONS = {
  'p5-tone': laneDefinition({
    brief: 'A living tidal observatory at blue hour: bioluminescent currents and generative bells share one slow breathing rhythm. Mouse or touch changes both current and harmony. The work should feel calm but emotionally specific, with a clear focal evolution over 45 seconds.',
    source: 'tone-transport-phase',
    target: 'p5-current-luminosity',
    mapping: { scale: 0.5, offset: 0.5, clamp: [0.5, 1] },
    allowlist: ['src/prompts/p5.ts', 'src/prompts/music.ts', 'src/composition/LayerContract.ts'],
  }),
  'three-shader': laneDefinition({
    brief: 'A glass weather cathedral suspended in darkness: volumetric architecture and a living surface shader behave as one weather system. Pointer movement changes both wind and light. The work should evolve from stillness to a legible atmospheric event over 45 seconds.',
    source: 'three-pointer-wind',
    target: 'shader-turbulence-amplitude',
    mapping: { scale: 0.8, offset: 0.2, clamp: [0.2, 1] },
    allowlist: ['src/prompts/three.ts', 'src/prompts/glsl.ts', 'src/composition/LayerContract.ts'],
  }),
  'strudel-p5': laneDefinition({
    brief: 'A nocturnal pulse garden: the musical beat phase visibly drives the radius of luminous blooms while pointer movement changes pattern density. Sound and image must feel composed as one instrument, with a distinct beginning, development, and release over 45 seconds.',
    source: 'strudel-beat-phase',
    target: 'p5-bloom-radius',
    mapping: { scale: 80, offset: 10, clamp: [10, 90] },
    allowlist: ['src/prompts/music.ts', 'src/prompts/p5.ts', 'src/composition/LayerContract.ts'],
  }),
} as const satisfies Record<Wave6Lane, unknown>;

export interface Wave6FormalPair {
  trialId: string;
  controlConfigurationDigest: string;
  treatmentConfigurationDigest: string;
  controlScore: number;
  treatmentScore: number;
  coordinationPass: boolean;
  technicalPass: boolean;
  blindPreference: 'control' | 'treatment' | 'tie';
}

const COORDINATION_CONDITIONS = [
  'baseline',
  'signal-mutation',
  'coupling-ablation',
] as const;
const COORDINATION_SCORE_KEYS = [
  'coherence',
  'technicalValidity',
  'creativeQuality',
  'tasteQuality',
] as const;

export function normalizeWave6CoordinationScores(value: unknown) {
  if (!value || typeof value !== 'object') {
    throw new Error('coordination reviewer omitted condition scores');
  }
  return Object.fromEntries(COORDINATION_CONDITIONS.map((condition) => {
    const input = (value as Record<string, unknown>)[condition];
    if (!input || typeof input !== 'object') {
      throw new Error(`coordination reviewer omitted ${condition} scores`);
    }
    const scores = Object.fromEntries(COORDINATION_SCORE_KEYS.map((key) => {
      const score = Number((input as Record<string, unknown>)[key]);
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error(`coordination reviewer returned invalid ${condition}.${key}`);
      }
      return [key, score];
    }));
    return [condition, scores];
  })) as Record<typeof COORDINATION_CONDITIONS[number],
    Record<typeof COORDINATION_SCORE_KEYS[number], number>>;
}

export interface Wave6ExperimentEvidence {
  lane: Wave6Lane;
  lineageId: string;
  recipeDigest: string;
  artifactRecipeDigest: string;
  lineageRecipeDigest: string;
  evaluationRecipeDigest: string;
  causalRecipeDigest: string;
  configurationDigest: string;
  mutationPath: string;
  identities: {
    author: string;
    generator: string;
    mutationReviewer: string;
    creativeReviewer: string;
  };
  runOrder: Wave6RunLabel[];
  pairs: Wave6FormalPair[];
  restoredFailure: {
    restored: boolean;
    quarantined: boolean;
    lane: Wave6Lane;
    lineageId: string;
    allowlistDigest: string;
    oracleDigest: string;
  };
  expectedOracleDigest: string;
  interventions: number;
  creativeProofPass: boolean;
  cortexPass: boolean;
  lineageIntegrityPass: boolean;
  parentIntegrityPass: boolean;
  ownerDecision?: 'control' | 'treatment';
  deferredReason?: string;
}

export interface Wave6ExperimentResult {
  status: Wave6Status;
  meanEffect: number;
  ownerPairTrialId?: string;
  checks: {
    recipeBound: boolean;
    configurationFrozen: boolean;
    formalOrder: boolean;
    roleSeparation: boolean;
    mutationAllowlisted: boolean;
    restoredFailureBound: boolean;
    interventionBudget: boolean;
    threePlayablePairs: boolean;
    coordinationImproved: boolean;
    blindQualityImproved: boolean;
    causalEffect: boolean;
    creativeProof: boolean;
    cortex: boolean;
    lineageIntegrity: boolean;
    parentIntegrity: boolean;
    ownerAccepted: boolean;
  };
}

export function hasCompleteWave6Evidence(
  evidenceRefs: Record<string, string[]> | undefined,
  evidenceDigests: Record<string, string> | undefined,
): boolean {
  const required = [
    ['formalArtifacts', '.html'],
    ['screenshots', '.png'],
    ['media', '.webm'],
  ] as const;
  return required.every(([key, extension]) => {
    const refs = evidenceRefs?.[key];
    if (!Array.isArray(refs)) return false;
    return refs.length === FORMAL_RUN_ORDER.length
      && new Set(refs).size === refs.length
      && FORMAL_RUN_ORDER.every(label =>
        refs.some(ref => path.basename(ref) === `${label}${extension}`))
      && refs.every(ref => /^[a-f0-9]{64}$/.test(evidenceDigests?.[ref] ?? ''));
  });
}

export function aggregateWave6LaneReceipts(receipts: Array<{
  lane: Wave6Lane;
  status: Wave6Status;
  recipeDigest: string;
}>): {
  status: Wave6Status;
  byLane: Record<Wave6Lane, Wave6Status>;
} {
  const lanes = Object.keys(WAVE6_LANE_DEFINITIONS) as Wave6Lane[];
  if (receipts.length !== lanes.length || new Set(receipts.map(item => item.lane)).size !== lanes.length) {
    throw new Error('Wave 6 close gate requires exactly three distinct lane receipts');
  }
  if (receipts.some(item =>
    !lanes.includes(item.lane)
    || (
      ['PASS', 'PENDING_OWNER'].includes(item.status)
      && !/^[a-f0-9]{64}$/.test(item.recipeDigest)
    )
    || (Boolean(item.recipeDigest) && !/^[a-f0-9]{64}$/.test(item.recipeDigest))
    || !['PASS', 'FAIL', 'DEFERRED', 'PENDING_OWNER'].includes(item.status))) {
    throw new Error('Wave 6 close gate received an invalid lane receipt');
  }
  const byLane = Object.fromEntries(
    receipts.map(item => [item.lane, item.status]),
  ) as Record<Wave6Lane, Wave6Status>;
  const statuses = Object.values(byLane);
  const status = statuses.includes('FAIL')
    ? 'FAIL'
    : statuses.includes('DEFERRED')
      ? 'DEFERRED'
      : statuses.includes('PENDING_OWNER')
        ? 'PENDING_OWNER'
        : 'PASS';
  return { status, byLane };
}

function sameOrder(actual: readonly string[]): boolean {
  return actual.length === FORMAL_RUN_ORDER.length
    && actual.every((value, index) => value === FORMAL_RUN_ORDER[index]);
}

function ownerPair(pairs: Wave6FormalPair[], meanEffect: number): Wave6FormalPair | undefined {
  return [...pairs].sort((left, right) => {
    const distance = Math.abs((left.treatmentScore - left.controlScore) - meanEffect)
      - Math.abs((right.treatmentScore - right.controlScore) - meanEffect);
    return distance || left.trialId.localeCompare(right.trialId, undefined, { numeric: true });
  })[0];
}

export function evaluateWave6Experiment(input: Wave6ExperimentEvidence): Wave6ExperimentResult {
  const effects = input.pairs.map((pair) => pair.treatmentScore - pair.controlScore);
  const meanEffect = effects.length > 0
    ? effects.reduce((sum, effect) => sum + effect, 0) / effects.length
    : Number.NaN;
  const representative = ownerPair(input.pairs, meanEffect);
  const identities = Object.values(input.identities)
    .map(identity => identity.split('/')
      .map(part => part.trim().toLowerCase()).join('/'));
  const definition = WAVE6_LANE_DEFINITIONS[input.lane];
  const checks = {
    recipeBound: [
      input.recipeDigest,
      input.artifactRecipeDigest,
      input.lineageRecipeDigest,
      input.evaluationRecipeDigest,
      input.causalRecipeDigest,
    ].every((digest) => digest === input.recipeDigest),
    configurationFrozen: input.pairs.every((pair) =>
      pair.controlConfigurationDigest === input.configurationDigest
      && pair.treatmentConfigurationDigest === input.configurationDigest),
    formalOrder: sameOrder(input.runOrder),
    roleSeparation: identities.every(Boolean)
      && new Set(identities).size === identities.length,
    mutationAllowlisted: definition.allowlist.includes(input.mutationPath as never),
    restoredFailureBound:
      input.restoredFailure.restored
      && input.restoredFailure.quarantined
      && input.restoredFailure.lane === input.lane
      && input.restoredFailure.lineageId === input.lineageId
      && input.restoredFailure.allowlistDigest === definition.allowlistDigest
      && input.restoredFailure.oracleDigest === input.expectedOracleDigest,
    interventionBudget: Number.isInteger(input.interventions)
      && input.interventions >= 1
      && input.interventions <= 2,
    threePlayablePairs: input.pairs.length === 3
      && input.pairs.every((pair) =>
        pair.trialId && pair.technicalPass
        && Number.isFinite(pair.controlScore)
        && Number.isFinite(pair.treatmentScore)),
    coordinationImproved: input.pairs.filter((pair) => pair.coordinationPass).length >= 2,
    blindQualityImproved: input.pairs.filter((pair) => pair.blindPreference === 'treatment').length >= 2,
    causalEffect: Number.isFinite(meanEffect) && meanEffect >= 0.05,
    creativeProof: input.creativeProofPass,
    cortex: input.cortexPass,
    lineageIntegrity: input.lineageIntegrityPass,
    parentIntegrity: input.parentIntegrityPass,
    ownerAccepted: input.ownerDecision === 'treatment',
  };
  const causalChecks = Object.entries(checks)
    .filter(([name]) => name !== 'ownerAccepted')
    .every(([, passed]) => passed);
  const status = input.deferredReason
    ? 'DEFERRED'
    : !causalChecks
      ? 'FAIL'
      : !input.ownerDecision
        ? 'PENDING_OWNER'
        : checks.ownerAccepted
          ? 'PASS'
          : 'FAIL';
  return {
    status,
    meanEffect,
    ownerPairTrialId: representative?.trialId,
    checks,
  };
}

function latest(records: StudioLineageRecord[], predicate: (record: StudioLineageRecord) => boolean) {
  return [...records].reverse().find(predicate);
}

export async function resumeWave6Lineage(input: {
  lineageId: string;
  lane: Wave6Lane;
  ledger?: StudioLineageLedger;
}): Promise<{
  lineageId: string;
  lane: Wave6Lane;
  recipeDigest: string;
  artifactPath: string;
  artifactCodeDigest: string;
  artifactCode: string;
}> {
  const trace = await (input.ledger ?? new StudioLineageLedger()).query(input.lineageId);
  const contract = latest(trace.records, (record) =>
    record.origin === 'studio-composition-contract' && record.status === 'observed');
  if (!contract || contract.payload.coupled !== true) {
    throw new Error(`Wave 6 lineage ${input.lineageId} has no observed coupled composition contract`);
  }
  if (contract.payload.lane !== input.lane) {
    throw new Error(`Wave 6 lineage ${input.lineageId} does not match requested lane ${input.lane}`);
  }
  const recipeDigest = contract.payload.recipeDigest;
  if (typeof recipeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(recipeDigest)) {
    throw new Error(`Wave 6 lineage ${input.lineageId} has an invalid recipe digest`);
  }
  const artifact = latest(trace.records, (record) =>
    record.stage === 'artifact' && record.status === 'observed');
  const artifactPath = artifact?.payload.artifactPath;
  const artifactCodeDigest = artifact?.payload.codeDigest;
  if (typeof artifactPath !== 'string' || typeof artifactCodeDigest !== 'string') {
    throw new Error(`Wave 6 lineage ${input.lineageId} has no resumable artifact`);
  }
  const artifactCode = await fs.readFile(path.resolve(artifactPath), 'utf8')
    .catch(() => null);
  if (artifactCode === null) {
    throw new Error(`Wave 6 lineage ${input.lineageId} artifact digest mismatch`);
  }
  const observedDigest = createHash('sha256').update(artifactCode).digest('hex');
  if (observedDigest !== artifactCodeDigest) {
    throw new Error(`Wave 6 lineage ${input.lineageId} artifact digest mismatch`);
  }
  return {
    lineageId: input.lineageId,
    lane: input.lane,
    recipeDigest,
    artifactPath,
    artifactCodeDigest,
    artifactCode,
  };
}
