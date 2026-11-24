import { createHash } from 'node:crypto';
import {
  executeDeterministicComposition,
  type ComposedLayer,
  type CompositionResult,
  type CompositionLayerSpec,
} from '../composition/CompositionOrchestrator.js';
import type {
  CampaignBrief,
  CampaignCandidateDiversityFreeze,
  CampaignManifest,
  CampaignSlotGraphProof,
} from './CampaignManifest.js';
import {
  compileCreativeThesis,
  validateCreativeThesis,
  type CreativeThesis,
} from '../creative-intelligence/CreativeIntelligence.js';

export const CANDIDATE_MANIFEST_SCHEMA = 'sinter.candidate-manifest' as const;
export const CANDIDATE_MANIFEST_VERSION = 1 as const;
export const CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_SCHEMA = 'sinter.campaign-actual-candidate-manifest' as const;
export const CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_VERSION = 1 as const;
const MATERIAL_DIMENSIONS = ['composition', 'motion', 'interaction', 'material', 'sound'] as const;

export interface CandidateDimensions {
  readonly subject: string;
  readonly composition: string;
  readonly motion: string;
  readonly interaction: string;
  readonly material: string;
  readonly sound: string;
  readonly palette?: string;
  readonly seed?: string;
  readonly format?: string;
  readonly styleLabel?: string;
  readonly [key: string]: string | undefined;
}

export interface IntentDerivedDimension {
  readonly id: string;
  readonly source: 'user-intent' | 'creative-thesis';
  readonly value: string;
}

export interface CandidateArtifactPlan {
  readonly layers: readonly CompositionLayerSpec[];
  readonly html: string;
  readonly artifactDigest: string;
  readonly planDigest: string;
  readonly successCount: number;
  readonly layerCount: number;
}

export interface CandidateHypothesis {
  readonly id: string;
  readonly label: string;
  readonly hypothesis: string;
  readonly dimensions: CandidateDimensions;
  readonly materialDifference: string;
  readonly artifact: CandidateArtifactPlan;
  readonly qualityScore: number;
  readonly qualityBand: 'high' | 'middle' | 'exploratory';
}

export interface CandidateQualityReport {
  readonly floor: number;
  readonly scores: readonly number[];
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface CandidatePairDifference {
  readonly leftId: string;
  readonly rightId: string;
  readonly materialDimensions: readonly string[];
  readonly passed: boolean;
}

export interface CandidateDiversityReport {
  readonly minimumMaterialDifferences: 2;
  readonly pairwise: readonly CandidatePairDifference[];
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface CandidateGateReport {
  readonly passed: boolean;
  readonly qualityPassed: boolean;
  readonly diversityPassed: boolean;
  readonly quality: CandidateQualityReport;
  readonly diversity: CandidateDiversityReport;
}

export interface CandidateManifest {
  readonly schema: typeof CANDIDATE_MANIFEST_SCHEMA;
  readonly schemaVersion: typeof CANDIDATE_MANIFEST_VERSION;
  readonly intent: string;
  readonly intentDigest: string;
  readonly creativeThesis: CreativeThesis;
  readonly intentDerivedDimensions: readonly IntentDerivedDimension[];
  readonly candidates: readonly CandidateHypothesis[];
  readonly quality: CandidateQualityReport;
  readonly diversity: CandidateDiversityReport;
  readonly gate: CandidateGateReport;
}

export interface CampaignActualCandidateArtifact {
  readonly html: string;
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly layers: readonly ComposedLayer[];
  readonly successCount: number;
  readonly layerCount: number;
}

export interface CampaignActualCandidate {
  readonly id: string;
  readonly briefId: string;
  readonly slotDigest: string;
  readonly graphDigest: string;
  readonly graphNodeIds: readonly string[];
  readonly thesisDigest: string;
  readonly diversity: Readonly<Record<string, string>>;
  readonly artifact: CampaignActualCandidateArtifact;
}

export interface CampaignActualCandidateManifest {
  readonly schema: typeof CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_SCHEMA;
  readonly schemaVersion: typeof CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_VERSION;
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly briefId: string;
  readonly candidates: readonly CampaignActualCandidate[];
}

export interface CampaignActualCandidateInput {
  readonly brief: CampaignBrief;
  readonly proof: CampaignSlotGraphProof;
  readonly diversity: CampaignCandidateDiversityFreeze;
  readonly result: CompositionResult;
}

export interface BuildCandidateManifestOptions {
  readonly creativeThesis?: CreativeThesis;
  readonly layers?: readonly CompositionLayerSpec[];
  readonly candidateCount?: number;
  readonly qualityFloor?: number;
  /** Optional caller-owned resource ceiling. There is no implicit N cap. */
  readonly candidateBudget?: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fullDigest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

export function campaignCreativeThesisDigest(thesis: CreativeThesis): string {
  return fullDigest(thesis);
}

function actualSourceProjection(layers: readonly ComposedLayer[]): unknown {
  return layers.map(({ domain, prompt, blendMode, opacity, generated, error, artifactHtml }) => ({
    domain, prompt, blendMode, opacity, generated,
    ...(error === undefined ? {} : { error }),
    ...(artifactHtml === undefined ? {} : { artifactHtml }),
  }));
}

export function campaignActualSource(layers: readonly ComposedLayer[]): string {
  return stable(actualSourceProjection(layers));
}

export function campaignActualArtifactDigest(html: string): string {
  return fullDigest(html);
}

export function campaignActualSourceDigest(layers: readonly ComposedLayer[]): string {
  return fullDigest(campaignActualSource(layers));
}

function normalizedIntent(intent: string): string {
  const value = intent.trim().replace(/\s+/g, ' ');
  if (!value) throw new Error('Candidate manifest requires non-empty user intent');
  return value;
}

function digestPlan(layers: readonly CompositionLayerSpec[]): string {
  return digest(JSON.stringify(layers.map(({ domain, prompt, code, blendMode, opacity }) => ({
    domain, prompt, code, blendMode, opacity,
  }))));
}

function artifactQuality(candidate: CandidateHypothesis): number {
  const artifact = candidate.artifact;
  const checks = [
    artifact.layerCount === artifact.layers.length && artifact.layerCount > 0,
    artifact.successCount === artifact.layerCount,
    artifact.planDigest === digestPlan(artifact.layers),
    artifact.artifactDigest === digest(artifact.html),
    artifact.html.includes(`<title>${candidate.id}</title>`),
  ];
  return checks.filter(Boolean).length / checks.length;
}

export function evaluateCandidateQuality(
  candidates: readonly CandidateHypothesis[],
  floor = 0.7,
): CandidateQualityReport {
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new Error('Candidate quality floor must be between 0 and 1');
  }
  const scores = candidates.map(artifactQuality);
  const failures = candidates.flatMap((candidate) => {
    const score = artifactQuality(candidate);
    const candidateFailures: string[] = [];
    if (candidate.qualityScore !== score) candidateFailures.push(`${candidate.id} quality score is not artifact-derived`);
    if (score < floor) candidateFailures.push(`${candidate.id} is below the quality floor (${score} < ${floor})`);
    return candidateFailures;
  });
  return { floor, scores, passed: failures.length === 0, failures };
}

export function evaluateCandidateDiversity(
  candidates: readonly CandidateHypothesis[],
): CandidateDiversityReport {
  const pairwise: CandidatePairDifference[] = [];
  const failures: string[] = [];
  if (candidates.length < 3) failures.push('At least three candidates are required');
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const a = candidates[left];
      const b = candidates[right];
      const artifactsDiffer = a.artifact.artifactDigest !== b.artifact.artifactDigest
        && a.artifact.planDigest !== b.artifact.planDigest;
      const materialDimensions = artifactsDiffer
        ? MATERIAL_DIMENSIONS.filter((dimension) => a.dimensions[dimension] !== b.dimensions[dimension])
        : [];
      const passed = materialDimensions.length >= 2;
      pairwise.push({ leftId: a.id, rightId: b.id, materialDimensions, passed });
      if (!passed) failures.push(`${a.id} and ${b.id} differ in fewer than two executed material dimensions`);
    }
  }
  return {
    minimumMaterialDifferences: 2,
    pairwise,
    passed: failures.length === 0,
    failures,
  };
}

export function evaluateCandidateGate(
  candidates: readonly CandidateHypothesis[],
  qualityFloor = 0.7,
): CandidateGateReport {
  const quality = evaluateCandidateQuality(candidates, qualityFloor);
  const diversity = evaluateCandidateDiversity(candidates);
  return {
    passed: quality.passed && diversity.passed,
    qualityPassed: quality.passed,
    diversityPassed: diversity.passed,
    quality,
    diversity,
  };
}

interface CandidateVariant {
  readonly id: string;
  readonly label: string;
  readonly hypothesis: string;
  readonly materialDifference: string;
  readonly dimensions: CandidateDimensions;
}

function numberFrom(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function words(value: string, limit: number): string {
  return value.split(/\s+/).filter(Boolean).slice(0, limit).join(' ');
}

function deriveVariant(
  intent: string,
  thesis: CreativeThesis,
  index: number,
  layers: readonly CompositionLayerSpec[],
): CandidateVariant {
  const principle = thesis.principles[index % Math.max(1, thesis.principles.length)]?.principleId ?? 'intent';
  const arc = thesis.perceptualEmotionalArc[index % Math.max(1, thesis.perceptualEmotionalArc.length)] ?? thesis.intendedExperienceMeaning;
  const seed = numberFrom(`${intent}:${thesis.thesisId}:${index}`);
  const anchor = layers[index % layers.length];
  const order = layers.map((layer) => layer.domain).slice(index % layers.length).concat(
    layers.map((layer) => layer.domain).slice(0, index % layers.length),
  ).join(' > ');
  return {
    id: `candidate-${index + 1}-${digest(`${intent}:${principle}:${index}`)}`,
    label: `${words(thesis.intendedExperienceMeaning, 5)} · ${index + 1}`,
    hypothesis: `Test ${principle} as the governing choice for “${intent}”, moving toward ${arc}.`,
    materialDifference: `${anchor.domain} anchors order ${order}; phase ${seed % 12} controls density and response.`,
    dimensions: {
      subject: intent,
      composition: `${thesis.intendedExperienceMeaning}; order ${order}; anchor ${anchor.domain}`,
      motion: `${arc}; phase ${seed % 12}; cadence ${(seed % 7) + 1}`,
      interaction: `${principle}; response axis ${seed % 5}`,
      material: `${anchor.domain}; density ${(seed % 9) + 1}; principle ${principle}`,
      sound: `${layers.some((layer) => ['music', 'tone', 'strudel'].includes(layer.domain)) ? arc : 'intentional silence'}; register ${seed % 8}`,
    },
  };
}

function intentDimensions(intent: string, thesis: CreativeThesis): readonly IntentDerivedDimension[] {
  return [
    { id: 'subject', source: 'user-intent', value: intent },
    { id: 'experience', source: 'creative-thesis', value: thesis.intendedExperienceMeaning },
    { id: 'emotional-arc', source: 'creative-thesis', value: thesis.perceptualEmotionalArc.join(' -> ') || 'not specified' },
    { id: 'principles', source: 'creative-thesis', value: thesis.principles.map((principle) => principle.principleId).join(', ') || 'none' },
    { id: 'hard-floors', source: 'creative-thesis', value: thesis.hardFloors.join(' | ') || 'none' },
  ];
}

function htmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function executableLayer(
  intent: string,
  variant: CandidateVariant,
  source: CompositionLayerSpec,
  sourceIndex: number,
  candidateIndex: number,
): CompositionLayerSpec {
  const seed = numberFrom(`${variant.id}:${sourceIndex}`);
  const hue = seed % 360;
  const rotation = (seed % 19) - 9;
  const inset = 4 + (seed % 24);
  const prompt = `${variant.hypothesis} Materialize source ${sourceIndex + 1} (${source.domain}) at phase ${candidateIndex + 1}.`;
  const blendMode = sourceIndex === 0 ? 'normal' : (seed % 2 === 0 ? 'screen' : 'difference');
  const opacity = 0.65 + ((seed % 30) / 100);
  if (source.code?.trim()) {
    return { ...source, prompt, blendMode, opacity };
  }
  const content = htmlText(source.prompt);
  const code = `<section data-candidate="${variant.id}" data-source-domain="${source.domain}" `
    + `style="position:absolute;inset:${inset}%;transform:rotate(${rotation}deg);border:2px solid hsl(${hue} 72% 62%);`
    + `background:hsl(${(hue + 180) % 360} 36% 10% / .${5 + (seed % 4)});color:hsl(${hue} 80% 82%);overflow:hidden">`
    + `<strong>${htmlText(words(intent, 12))}</strong><span hidden>${content}</span></section>`;
  return {
    domain: 'html',
    prompt,
    code,
    blendMode,
    opacity,
  };
}

function artifactLayers(
  intent: string,
  variant: CandidateVariant,
  layers: readonly CompositionLayerSpec[],
  candidateIndex: number,
): readonly CompositionLayerSpec[] {
  const pivot = candidateIndex % layers.length;
  const ordered = layers.slice(pivot).concat(layers.slice(0, pivot));
  return ordered.map((layer, sourceIndex) => executableLayer(intent, variant, layer, sourceIndex, candidateIndex));
}

async function buildCandidate(
  intent: string,
  variant: CandidateVariant,
  layers: readonly CompositionLayerSpec[],
  candidateIndex: number,
  thesis: CreativeThesis,
): Promise<CandidateHypothesis> {
  const candidateLayers = artifactLayers(intent, variant, layers, candidateIndex);
  const result = await executeDeterministicComposition({
    title: variant.id,
    background: '#05070f',
    creativeThesis: thesis,
    layers: [...candidateLayers],
  });
  const partial = {
    id: variant.id,
    label: variant.label,
    hypothesis: variant.hypothesis,
    dimensions: variant.dimensions,
    materialDifference: variant.materialDifference,
    artifact: {
      layers: candidateLayers,
      html: result.html,
      artifactDigest: digest(result.html),
      planDigest: digestPlan(candidateLayers),
      successCount: result.successCount,
      layerCount: candidateLayers.length,
    },
  };
  const score = artifactQuality({ ...partial, qualityScore: 0, qualityBand: 'exploratory' });
  return { ...partial, qualityScore: score, qualityBand: score >= 0.9 ? 'high' : score >= 0.75 ? 'middle' : 'exploratory' };
}

export async function buildCandidateManifest(
  userIntent: string,
  options: BuildCandidateManifestOptions = {},
): Promise<CandidateManifest> {
  const intent = normalizedIntent(userIntent);
  const thesis = validateCreativeThesis(options.creativeThesis ?? compileCreativeThesis(intent));
  if (thesis.disposition !== 'supported') throw new Error('Unsupported Creative Thesis for candidate manifest');
  const requestedCount = options.candidateCount ?? 3;
  if (!Number.isInteger(requestedCount) || requestedCount < 1) {
    throw new Error('Candidate count must be a positive integer');
  }
  const candidateCount = Math.max(3, requestedCount);
  if (options.candidateBudget !== undefined
    && (!Number.isInteger(options.candidateBudget) || options.candidateBudget < 1)) {
    throw new Error('Candidate budget must be a positive integer');
  }
  if (options.candidateBudget !== undefined && candidateCount > options.candidateBudget) {
    throw new Error(`Candidate count ${candidateCount} exceeds explicit budget ${options.candidateBudget}`);
  }
  const layers = options.layers ?? [{ domain: 'html', prompt: intent, blendMode: 'normal', opacity: 1 }];
  if (layers.length === 0) throw new Error('Candidate manifest requires at least one composition layer');
  const candidates = await Promise.all(Array.from({ length: candidateCount }, (_, index) => {
    const variant = deriveVariant(intent, thesis, index, layers);
    return buildCandidate(intent, variant, layers, index, thesis);
  }));
  const quality = evaluateCandidateQuality(candidates, options.qualityFloor ?? 0.7);
  const diversity = evaluateCandidateDiversity(candidates);
  const gate: CandidateGateReport = {
    passed: quality.passed && diversity.passed,
    qualityPassed: quality.passed,
    diversityPassed: diversity.passed,
    quality,
    diversity,
  };
  return {
    schema: CANDIDATE_MANIFEST_SCHEMA,
    schemaVersion: CANDIDATE_MANIFEST_VERSION,
    intent,
    intentDigest: digest(intent),
    creativeThesis: thesis,
    intentDerivedDimensions: intentDimensions(intent, thesis),
    candidates,
    quality,
    diversity,
    gate,
  };
}

/** Build one reviewable manifest solely from the executed campaign artifacts. */
export function buildCampaignActualCandidateManifest(
  manifest: CampaignManifest,
  brief: CampaignBrief,
  inputs: readonly CampaignActualCandidateInput[],
): CampaignActualCandidateManifest {
  if (manifest.briefs.find((item) => item.id === brief.id) !== brief) {
    throw new Error(`CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_MISMATCH:${brief.id}`);
  }
  const expected = brief.candidateSlots.map((slot) => slot.id);
  const actual = inputs.map((input) => input.proof.candidateSlotId);
  if (actual.length !== expected.length
    || actual.some((id, index) => id !== expected[index])
    || new Set(actual).size !== actual.length) {
    throw new Error(`CAMPAIGN_ACTUAL_CANDIDATE_ORDER_MISMATCH:${brief.id}`);
  }
  const candidates = inputs.map((input, index): CampaignActualCandidate => {
    const slot = brief.candidateSlots[index]!;
    const { proof, diversity, result } = input;
    if (input.brief !== brief || proof.briefId !== brief.id
      || diversity.briefId !== brief.id || diversity.candidateSlotId !== slot.id
      || proof.candidateSlotId !== slot.id) {
      throw new Error(`CAMPAIGN_ACTUAL_CANDIDATE_BINDING_MISMATCH:${brief.id}/${slot.id}`);
    }
    if (!result.creativeThesis
      || campaignCreativeThesisDigest(result.creativeThesis) !== diversity.thesisDigest) {
      throw new Error(`CAMPAIGN_ACTUAL_CANDIDATE_THESIS_MISMATCH:${brief.id}/${slot.id}`);
    }
    const execution = result.graphExecution;
    if (!execution || execution.status !== 'completed'
      || result.layers.length !== slot.graphNodeIds.length
      || result.successCount !== slot.graphNodeIds.length
      || execution.completed.length !== slot.graphNodeIds.length
      || slot.graphNodeIds.some((id) => !execution.completed.includes(id))) {
      throw new Error(`CAMPAIGN_ACTUAL_CANDIDATE_PARTIAL:${brief.id}/${slot.id}`);
    }
    const artifactDigest = campaignActualArtifactDigest(result.html);
    const sourceDigest = campaignActualSourceDigest(result.layers);
    return {
      id: slot.id, briefId: brief.id, slotDigest: slot.ownerEvidence.slotDigest,
      graphDigest: proof.graphDigest,
      graphNodeIds: [...slot.graphNodeIds], thesisDigest: diversity.thesisDigest,
      diversity: { ...diversity.dimensions },
      artifact: { html: result.html, artifactDigest, sourceDigest,
        layers: result.layers.map((layer) => ({ ...layer })),
        successCount: result.successCount, layerCount: result.layers.length },
    };
  });
  return freeze({ schema: CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_SCHEMA,
    schemaVersion: CAMPAIGN_ACTUAL_CANDIDATE_MANIFEST_VERSION,
    campaignRunId: manifest.campaignRunId, manifestDigest: manifest.manifestDigest,
    briefId: brief.id, candidates });
}

export const generateCandidateHypotheses = buildCandidateManifest;
export const candidateDiversityGate = evaluateCandidateDiversity;
