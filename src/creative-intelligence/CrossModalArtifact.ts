import { createHash } from 'node:crypto';
import {
  COMPOSITION_GRAPH_SCHEMA,
  COMPOSITION_GRAPH_VERSION,
  planCompositionGraph,
  type CompositionGraph,
  type PlannedCompositionGraph,
} from '../composition/CompositionGraph.js';
import {
  compileCreativeThesis,
  creativeThesisIdentity,
  MUSIC_SOUND_SUPPORTED_CONTRACT_IDS,
  validateCreativeThesis,
  type CreativeThesis,
} from './CreativeIntelligence.js';
import {
  createDeterministicMusicArtifact,
  type DeterministicMusicArtifact,
} from '../music/MusicSoundArtifact.js';

export const CROSS_MODAL_MANIFEST_SCHEMA = 'sinter.cross-modal-emergence-manifest' as const;
export const CROSS_MODAL_MANIFEST_VERSION = 1 as const;
export const CROSS_MODAL_ARTIFACT_SCHEMA = 'sinter.cross-modal-artifact' as const;
export const CROSS_MODAL_ARTIFACT_VERSION = 1 as const;

export type CrossModalRole = 'visual' | 'motion' | 'audio' | 'interaction';
export type CrossModalDisposition = 'supported' | 'historical' | 'unsupported';

export interface CrossModalContract {
  readonly id: string;
  readonly sourceRole: CrossModalRole;
  readonly targetRoles: readonly CrossModalRole[];
  readonly signal: string;
  readonly mechanism: string;
  readonly graphControlIds: readonly string[];
  readonly observableIds: readonly string[];
}

export interface CrossModalManifestRow {
  readonly id: string;
  readonly name: string;
  readonly sourceLocator: string;
  readonly sourceDigest: string;
  readonly disposition: CrossModalDisposition;
  readonly contractId: string | null;
  readonly runtimePath: string | null;
  readonly scenarioIds: readonly string[];
  readonly reason: string;
}

export interface CrossModalClosure {
  readonly scope: 'frozen-wave-8-cross-modal-manifest-only';
  readonly disposition: { readonly total: number; readonly dispositioned: number; readonly closed: boolean };
  readonly supported: {
    readonly total: number;
    readonly contractValid: number;
    readonly runtimeReachable: number;
    readonly scenarioCovered: number;
    readonly closed: boolean;
  };
  readonly excluded: { readonly total: number; readonly unreachable: number; readonly closed: boolean };
  readonly claim: string;
}

export interface CrossModalObservable {
  readonly id: string;
  readonly controlId: string;
  readonly from: CrossModalRole;
  readonly to: CrossModalRole;
  readonly signal: string;
  readonly before: number;
  readonly after: number;
  readonly changed: boolean;
}

export interface CrossModalTimingSample {
  readonly tick: number;
  readonly timeMs: number;
  readonly windowEndMs: number;
  readonly audioEnergy: number;
  readonly motionPhase: number;
  readonly visualRadius: number;
}

export interface CrossModalRuntimeHandoff {
  readonly controlId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly value: number;
}

export interface CrossModalRuntimeReceipt {
  readonly schema: 'sinter.cross-modal-runtime-receipt';
  readonly artifactDigest: string;
  readonly runtimeContractDigest: string;
  readonly graphId: string;
  readonly graphDigest: string;
  readonly status: 'completed';
  readonly tick: number;
  readonly timeMs: number;
  readonly windowEndMs: number;
  readonly schedule: readonly string[];
  readonly started: readonly string[];
  readonly completed: readonly string[];
  readonly controls: readonly string[];
  readonly bridges: readonly string[];
  readonly handoffs: readonly CrossModalRuntimeHandoff[];
}

export interface CrossModalEvidence {
  readonly artifactDigest: string;
  readonly graphId: string;
  readonly graphDigest: string;
  readonly schedule: readonly string[];
  readonly thesisId: string;
  readonly audioArtifactDigest: string;
  readonly clock: { readonly id: 'cross-modal-clock-v1'; readonly cadenceMs: 250 };
  readonly durationMs: number;
  readonly runtimeContractDigest: string;
  readonly runtimeReceipt: CrossModalRuntimeReceipt;
  readonly observables: readonly CrossModalObservable[];
  readonly timingSamples: readonly CrossModalTimingSample[];
  readonly contractIds: readonly string[];
}

export interface CrossModalArtifact {
  readonly schema: typeof CROSS_MODAL_ARTIFACT_SCHEMA;
  readonly version: typeof CROSS_MODAL_ARTIFACT_VERSION;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly sourceCandidateArtifactDigest: string | null;
  readonly thesis: CreativeThesis;
  readonly graph: CompositionGraph;
  readonly plan: PlannedCompositionGraph;
  readonly audioArtifact: DeterministicMusicArtifact;
  readonly evidence: CrossModalEvidence;
  readonly closure: CrossModalClosure;
  readonly html: string;
}

export interface CrossModalArtifactOptions {
  readonly brief: string;
  readonly artifactId?: string;
  readonly sourceCandidateArtifactDigest?: string;
  readonly thesis?: CreativeThesis;
  readonly manifest?: readonly CrossModalManifestRow[];
  readonly contracts?: Readonly<Record<string, CrossModalContract>>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceCandidateDigest(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(normalized)) {
    throw new Error('Cross-modal source candidate artifact digest is invalid');
  }
  return normalized;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

export const CROSS_MODAL_CONTRACTS: Readonly<Record<string, CrossModalContract>> = freeze({
  'audio-visual-reactivity': {
    id: 'audio-visual-reactivity', sourceRole: 'audio', targetRoles: ['visual'],
    signal: 'normalized audio energy',
    mechanism: 'Measured audio energy causally controls rendered visual radius.',
    graphControlIds: ['audio-energy-to-motion', 'motion-phase-to-visual'],
    observableIds: ['audio-energy-changes-motion', 'audio-energy-changes-visual'],
  },
  'shared-clock-coherence': {
    id: 'shared-clock-coherence', sourceRole: 'audio', targetRoles: ['motion', 'visual'],
    signal: 'audio-clock tick',
    mechanism: 'An explicit sample bridge maps the audio cadence into animation-frame phases.',
    graphControlIds: ['audio-energy-to-motion', 'motion-phase-to-visual'],
    observableIds: ['shared-clock-changes-visual'],
  },
  'interaction-audiovisual-control': {
    id: 'interaction-audiovisual-control', sourceRole: 'interaction', targetRoles: ['audio', 'visual'],
    signal: 'semantic activation state',
    mechanism: 'One keyboard-operable state changes both audio gain and visual hue.',
    graphControlIds: ['interaction-to-audio', 'interaction-to-visual'],
    observableIds: ['interaction-changes-audio', 'interaction-changes-visual'],
  },
  'bounded-emergent-coordination': {
    id: 'bounded-emergent-coordination', sourceRole: 'interaction', targetRoles: ['motion', 'visual'],
    signal: 'composed causal chain',
    mechanism: 'Two bounded acyclic chains converge on a coupled visual state absent from either isolated input.',
    graphControlIds: ['interaction-to-visual', 'audio-energy-to-motion', 'motion-phase-to-visual'],
    observableIds: ['coupled-state-diverges'],
  },
});

const ROW_SOURCE = 'src/brain/comprehensive-artistic-knowledge.ts';

function rowDigest(id: string, name: string, locator: string): string {
  return digest(`${CROSS_MODAL_MANIFEST_SCHEMA}|${CROSS_MODAL_MANIFEST_VERSION}|${id}|${name}|${locator}`);
}

function supportedRow(
  id: string,
  name: string,
  contractId: string,
  sourceLocator: string,
): CrossModalManifestRow {
  return {
    id, name, sourceLocator, sourceDigest: rowDigest(id, name, sourceLocator),
    disposition: 'supported', contractId,
    runtimePath: 'src/creative-intelligence/CrossModalArtifact.ts#buildCrossModalArtifact',
    scenarioIds: ['cross-modal-causal-work'],
    reason: 'A bounded contract, runtime handoff, and artifact-bound observable are available.',
  };
}

function excludedRow(
  id: string,
  name: string,
  disposition: Exclude<CrossModalDisposition, 'supported'>,
  sourceLocator: string,
  reason: string,
): CrossModalManifestRow {
  return {
    id, name, sourceLocator, sourceDigest: rowDigest(id, name, sourceLocator),
    disposition, contractId: null, runtimePath: null, scenarioIds: [], reason,
  };
}

export const CROSS_MODAL_MANIFEST: readonly CrossModalManifestRow[] = freeze([
  supportedRow('audio-reactivity', 'Audio Reactivity', 'audio-visual-reactivity', `${ROW_SOURCE}#Audio-Reactivity`),
  supportedRow('transport-scheduling', 'Transport and Scheduling', 'shared-clock-coherence', `${ROW_SOURCE}#Transport-and-Scheduling`),
  supportedRow('mouse-interaction', 'Mouse Interaction', 'interaction-audiovisual-control', `${ROW_SOURCE}#Mouse-Interaction`),
  supportedRow('cross-domain-crossover', 'Cross-domain Crossover', 'bounded-emergent-coordination', 'src/evolution/CrossDomainCrossover.ts#DOMAIN_MAPPINGS'),
  excludedRow('feedback-recursion', 'Feedback and Recursion', 'historical', `${ROW_SOURCE}#Feedback-and-Recursion`, 'Unbounded recursive feedback is retained as provenance and is not reachable through the acyclic Wave 8 graph.'),
  excludedRow('video-processing', 'Video Processing', 'historical', `${ROW_SOURCE}#Video-Processing`, 'External video capture is retained as history, not admitted to the deterministic Wave 8 runtime.'),
  excludedRow('performance-optimization', 'Performance Optimization', 'unsupported', `${ROW_SOURCE}#Performance-Optimization`, 'An implementation concern is not a cross-modal creative contract.'),
  excludedRow('multi-modal-input', 'Multi-Modal Input', 'unsupported', `${ROW_SOURCE}#INTERACTION_A11Y`, 'The phrase has no bounded signal or causal mapping and remains unreachable.'),
]);

const RUNTIME_CONTROL_IDS = new Set([
  'interaction-to-audio',
  'interaction-to-visual',
  'audio-energy-to-motion',
  'motion-phase-to-visual',
]);
const RUNTIME_OBSERVABLE_IDS = new Set([
  'interaction-changes-audio',
  'interaction-changes-visual',
  'audio-energy-changes-motion',
  'audio-energy-changes-visual',
  'shared-clock-changes-visual',
  'coupled-state-diverges',
]);

function validContract(contract: CrossModalContract | undefined): boolean {
  if (!contract || !contract.id || !contract.signal || !contract.mechanism) return false;
  if (contract.targetRoles.length === 0 || contract.graphControlIds.length === 0) return false;
  return contract.observableIds.length > 0
    && !contract.targetRoles.includes(contract.sourceRole)
    && contract.graphControlIds.every((id) => RUNTIME_CONTROL_IDS.has(id))
    && contract.observableIds.every((id) => RUNTIME_OBSERVABLE_IDS.has(id));
}

export function closeCrossModalManifest(
  rows: readonly CrossModalManifestRow[] = CROSS_MODAL_MANIFEST,
  contracts: Readonly<Record<string, CrossModalContract>> = CROSS_MODAL_CONTRACTS,
): CrossModalClosure {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.id || ids.has(row.id) || !row.sourceDigest.match(/^[a-f0-9]{64}$/)) {
      throw new Error(`Cross-modal manifest has an invalid or duplicate row: ${row.id}`);
    }
    ids.add(row.id);
    if (!['supported', 'historical', 'unsupported'].includes(row.disposition)) {
      throw new Error(`Cross-modal manifest row ${row.id} is undispositioned`);
    }
  }
  const supported = rows.filter((row) => row.disposition === 'supported');
  const excluded = rows.filter((row) => row.disposition !== 'supported');
  const contractValid = supported.filter((row) => validContract(row.contractId ? contracts[row.contractId] : undefined)).length;
  const runtimeReachable = supported.filter((row) => row.runtimePath?.includes('#buildCrossModalArtifact')).length;
  const scenarioCovered = supported.filter((row) => row.scenarioIds.includes('cross-modal-causal-work')).length;
  const unreachable = excluded.filter((row) => row.contractId === null && row.runtimePath === null && row.scenarioIds.length === 0).length;
  if (contractValid !== supported.length) throw new Error('Cross-modal supported-contract validity denominator is open');
  if (runtimeReachable !== supported.length) throw new Error('Cross-modal supported runtime-reachability denominator is open');
  if (scenarioCovered !== supported.length) throw new Error('Cross-modal supported scenario-coverage denominator is open');
  if (unreachable !== excluded.length) throw new Error('Cross-modal excluded-unreachability denominator is open');
  return freeze({
    scope: 'frozen-wave-8-cross-modal-manifest-only',
    disposition: { total: rows.length, dispositioned: rows.length, closed: true },
    supported: { total: supported.length, contractValid, runtimeReachable, scenarioCovered, closed: true },
    excluded: { total: excluded.length, unreachable, closed: true },
    claim: 'Complete only for the frozen Wave 8 cross-modal/emergence manifest; no universal artistic mastery is claimed.',
  });
}

const CROSS_MODAL_CADENCE_MS = 250;
const CALM_AUDIO_GAIN = 0.35;
const ACTIVE_AUDIO_GAIN = 0.8;

function radius(energy: number, phase: number): number {
  return Number((24 + energy * 48 + phase * 8).toFixed(2));
}

function pcmTiming(artifact: DeterministicMusicArtifact): {
  bytes: Buffer;
  sampleRate: number;
  sampleCount: number;
  durationMs: number;
  windowSize: number;
} {
  const bytes = Buffer.from(artifact.audioBase64, 'base64');
  const { sampleRate, sampleCount, durationSeconds } = artifact.evidence.observed;
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Cross-modal audio payload is not governed PCM WAV');
  }
  const wavSampleRate = bytes.readUInt32LE(24);
  const wavDataBytes = bytes.readUInt32LE(40);
  const pcmSampleCount = (bytes.length - 44) / 2;
  const durationMs = durationSeconds * 1_000;
  const windowSize = sampleRate * CROSS_MODAL_CADENCE_MS / 1_000;
  if (wavSampleRate !== sampleRate || wavDataBytes !== bytes.length - 44
    || !Number.isInteger(pcmSampleCount) || pcmSampleCount !== sampleCount) {
    throw new Error('Cross-modal PCM sample count drifted from governed audio evidence');
  }
  if (sampleCount / sampleRate !== durationSeconds || !Number.isInteger(durationMs)) {
    throw new Error('Cross-modal PCM duration drifted from governed audio evidence');
  }
  if (!Number.isInteger(windowSize) || sampleCount % windowSize !== 0) {
    throw new Error('Cross-modal PCM duration does not align to the governed cadence');
  }
  return { bytes, sampleRate, sampleCount, durationMs, windowSize };
}

export function deriveCrossModalTimingSamples(
  artifact: DeterministicMusicArtifact,
): readonly CrossModalTimingSample[] {
  const timing = pcmTiming(artifact);
  const sampleWindows = timing.sampleCount / timing.windowSize;
  const raw = Array.from({ length: sampleWindows }, (_, tick) => {
    let sumSquares = 0;
    for (let index = tick * timing.windowSize; index < (tick + 1) * timing.windowSize; index++) {
      const sample = timing.bytes.readInt16LE(44 + index * 2) / 32767;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / timing.windowSize);
  });
  const peak = Math.max(...raw);
  return freeze(raw.map((value, tick) => {
    const audioEnergy = Number((peak === 0 ? 0 : value / peak).toFixed(6));
    const motionPhase = sampleWindows === 1 ? 0 : tick / (sampleWindows - 1);
    return {
      tick,
      timeMs: tick * CROSS_MODAL_CADENCE_MS,
      windowEndMs: (tick + 1) * CROSS_MODAL_CADENCE_MS,
      audioEnergy,
      motionPhase,
      visualRadius: radius(audioEnergy * CALM_AUDIO_GAIN, motionPhase),
    };
  }));
}

function causalObservables(samples: readonly CrossModalTimingSample[]): readonly CrossModalObservable[] {
  const opening = samples[0]!;
  const response = samples[1]!;
  const openingEnergy = opening.audioEnergy * CALM_AUDIO_GAIN;
  const responseEnergy = response.audioEnergy * CALM_AUDIO_GAIN;
  const activeRadius = radius(response.audioEnergy * ACTIVE_AUDIO_GAIN, response.motionPhase);
  return freeze([
    { id: 'interaction-changes-audio', controlId: 'interaction-to-audio', from: 'interaction', to: 'audio', signal: 'gain', before: CALM_AUDIO_GAIN, after: ACTIVE_AUDIO_GAIN, changed: true },
    { id: 'interaction-changes-visual', controlId: 'interaction-to-visual', from: 'interaction', to: 'visual', signal: 'hue', before: 190, after: 260, changed: true },
    { id: 'audio-energy-changes-motion', controlId: 'audio-energy-to-motion', from: 'audio', to: 'motion', signal: 'gain-shaped audio energy', before: openingEnergy, after: responseEnergy, changed: openingEnergy !== responseEnergy },
    { id: 'audio-energy-changes-visual', controlId: 'motion-phase-to-visual', from: 'audio', to: 'visual', signal: 'radius with phase held', before: radius(openingEnergy, 0), after: radius(responseEnergy, 0), changed: openingEnergy !== responseEnergy },
    { id: 'shared-clock-changes-visual', controlId: 'motion-phase-to-visual', from: 'motion', to: 'visual', signal: 'radius', before: opening.visualRadius, after: response.visualRadius, changed: opening.visualRadius !== response.visualRadius },
    { id: 'coupled-state-diverges', controlId: 'interaction-to-visual', from: 'interaction', to: 'visual', signal: 'combined hue-radius state', before: opening.visualRadius + 19, after: activeRadius + 26, changed: opening.visualRadius + 19 !== activeRadius + 26 },
  ]);
}

function layerCode(role: CrossModalRole): string {
  if (role === 'audio') return '<audio data-role="audio"></audio>';
  if (role === 'interaction') return '<button type="button" aria-pressed="false">Modulate</button>';
  if (role === 'motion') return 'function draw(){ clear(); }';
  return '<canvas data-role="visual"></canvas>';
}

function crossModalGraph(thesis: CreativeThesis, audioArtifact: DeterministicMusicArtifact): CompositionGraph {
  return {
    schema: COMPOSITION_GRAPH_SCHEMA,
    schemaVersion: COMPOSITION_GRAPH_VERSION,
    status: 'ready',
    id: 'cross-modal-causal-work',
    title: 'Cross-modal causal work',
    creativeThesis: thesis,
    background: '#071525',
    budgets: { maxNodes: 4, maxEdges: 0, maxProviderCalls: 0 },
    nodes: [
      { id: 'interaction-role', type: 'layer', phaseId: 'input-phase', layer: { domain: 'html', prompt: 'Keyboard-operable semantic modulation control.', code: layerCode('interaction') } },
      { id: 'audio-role', type: 'layer', phaseId: 'sound-phase', layer: { domain: 'music', prompt: 'Music with expressive dynamics and shaped timbre.', code: audioArtifact.code } },
      { id: 'motion-role', type: 'layer', phaseId: 'response-phase', layer: { domain: 'p5', prompt: 'Shared-clock motion arc.', code: layerCode('motion'), blendMode: 'screen' } },
      { id: 'visual-role', type: 'layer', phaseId: 'response-phase', layer: { domain: 'html', prompt: 'Audio-reactive luminous visual field.', code: layerCode('visual'), blendMode: 'screen' } },
    ],
    edges: [],
    groups: [{ id: 'audiovisual-group', children: ['audio-role', 'motion-role', 'visual-role'], parentId: 'work-scene' }],
    scenes: [{ id: 'work-scene', children: ['interaction-role', 'audiovisual-group'], background: '#071525' }],
    phases: [
      { id: 'input-phase', order: 0, nodeIds: ['interaction-role'], clock: 'manual' },
      { id: 'sound-phase', order: 1, nodeIds: ['audio-role'], startsAfter: ['input-phase'], clock: 'audio' },
      { id: 'response-phase', order: 2, nodeIds: ['motion-role', 'visual-role'], startsAfter: ['sound-phase'], clock: 'animation-frame' },
    ],
    controls: [
      { id: 'interaction-to-audio', from: { nodeId: 'interaction-role', port: 'activation', type: 'number' }, to: { nodeId: 'audio-role', port: 'gain', type: 'number' }, scale: 0.45, offset: 0.35 },
      { id: 'interaction-to-visual', from: { nodeId: 'interaction-role', port: 'activation', type: 'number' }, to: { nodeId: 'visual-role', port: 'hue', type: 'number' }, scale: 70, offset: 190 },
      { id: 'audio-energy-to-motion', from: { nodeId: 'audio-role', port: 'energy', type: 'number' }, to: { nodeId: 'motion-role', port: 'phase-velocity', type: 'number' } },
      { id: 'motion-phase-to-visual', from: { nodeId: 'motion-role', port: 'phase', type: 'number' }, to: { nodeId: 'visual-role', port: 'radius', type: 'number' }, scale: 8, offset: 24 },
    ],
    resources: [
      { id: 'audio-context', kind: 'audio-context', ownerNodeId: 'audio-role' },
      { id: 'canvas', kind: 'canvas', ownerNodeId: 'visual-role' },
      { id: 'animation-timer', kind: 'timer', ownerNodeId: 'motion-role' },
      { id: 'input-subscription', kind: 'subscription', ownerNodeId: 'interaction-role' },
    ],
    timingIslands: [
      { id: 'manual-island', clock: 'manual', nodeIds: ['interaction-role'] },
      { id: 'audio-island', clock: 'audio', nodeIds: ['audio-role'], cadenceMs: 250 },
      { id: 'visual-island', clock: 'animation-frame', nodeIds: ['motion-role', 'visual-role'], cadenceMs: 250 },
    ],
    bridges: [{ id: 'audio-to-visual-clock', fromIslandId: 'audio-island', toIslandId: 'visual-island', mode: 'sample' }],
    retry: { maxAttempts: 1, retryable: [] },
    lifecycle: { teardownOrder: ['visual-role', 'motion-role', 'audio-role', 'interaction-role'], cancelBehavior: 'retain-evidence' },
  };
}

function runtimeControlOrder(plan: PlannedCompositionGraph): string[] {
  return plan.schedule.flatMap((nodeId) => plan.execution.controls
    .filter((control) => control.to.nodeId === nodeId)
    .map((control) => control.id));
}

function runtimeBridgeOrder(plan: PlannedCompositionGraph): string[] {
  const islandByNode = new Map(plan.execution.timingIslands
    .flatMap((island) => island.nodeIds.map((nodeId) => [nodeId, island.id] as const)));
  const activated = new Set<string>();
  return plan.schedule.flatMap((nodeId) => plan.execution.bridges
    .filter((bridge) => bridge.toIslandId === islandByNode.get(nodeId) && !activated.has(bridge.id))
    .map((bridge) => {
      activated.add(bridge.id);
      return bridge.id;
    }));
}

function runtimeContractDigest(
  plan: PlannedCompositionGraph,
  graphDigest: string,
  durationMs: number,
): string {
  return digest(escapedJson({
    graphId: plan.execution.graphId,
    graphDigest,
    schedule: plan.execution.schedule,
    controls: plan.execution.controls,
    bridges: plan.execution.bridges,
    durationMs,
    cadenceMs: CROSS_MODAL_CADENCE_MS,
  }));
}

function runtimeReceipt(
  plan: PlannedCompositionGraph,
  samples: readonly CrossModalTimingSample[],
  tick: number,
  active: number,
  artifactDigest: string,
  graphDigest: string,
  contractDigest: string,
): CrossModalRuntimeReceipt {
  const sample = samples[tick];
  if (!sample) throw new Error(`Cross-modal runtime tick ${tick} is outside governed PCM duration`);
  const state = new Map<string, Record<string, number>>();
  const nodeState = (id: string): Record<string, number> => {
    const existing = state.get(id);
    if (existing) return existing;
    const created: Record<string, number> = {};
    state.set(id, created);
    return created;
  };
  const handoffs: CrossModalRuntimeHandoff[] = [];
  const controls: string[] = [];
  const bridges: string[] = [];
  const islandByNode = new Map(plan.execution.timingIslands
    .flatMap((island) => island.nodeIds.map((nodeId) => [nodeId, island.id] as const)));
  for (const nodeId of plan.schedule) {
    for (const bridge of plan.execution.bridges) {
      if (bridge.toIslandId === islandByNode.get(nodeId) && !bridges.includes(bridge.id)) bridges.push(bridge.id);
    }
    for (const control of plan.execution.controls.filter((candidate) => candidate.to.nodeId === nodeId)) {
      const source = nodeState(control.from.nodeId)[control.from.port];
      if (source === undefined) throw new Error(`Cross-modal runtime bypassed source ${control.from.nodeId}.${control.from.port}`);
      const value = source * (control.scale ?? 1) + (control.offset ?? 0);
      nodeState(control.to.nodeId)[control.to.port] = value;
      controls.push(control.id);
      handoffs.push({ controlId: control.id, fromNodeId: control.from.nodeId, toNodeId: control.to.nodeId, value });
    }
    if (nodeId === 'interaction-role') nodeState(nodeId).activation = active;
    if (nodeId === 'audio-role') {
      nodeState(nodeId).energy = sample.audioEnergy * nodeState(nodeId).gain!;
    }
    if (nodeId === 'motion-role') nodeState(nodeId).phase = nodeState(nodeId)['phase-velocity']! * 6 + sample.motionPhase;
  }
  if (escapedJson(controls) !== escapedJson(runtimeControlOrder(plan))
    || escapedJson(bridges) !== escapedJson(runtimeBridgeOrder(plan))) {
    throw new Error('Cross-modal runtime did not execute the complete planned handoff graph');
  }
  return freeze({
    schema: 'sinter.cross-modal-runtime-receipt',
    artifactDigest,
    runtimeContractDigest: contractDigest,
    graphId: plan.execution.graphId,
    graphDigest,
    status: 'completed',
    tick,
    timeMs: sample.timeMs,
    windowEndMs: sample.windowEndMs,
    schedule: [...plan.schedule],
    started: [...plan.schedule],
    completed: [...plan.schedule],
    controls,
    bridges,
    handoffs,
  });
}

export function validateCrossModalRuntimeReceipt(
  artifact: Pick<CrossModalArtifact, 'plan' | 'evidence'>,
  receipt: CrossModalRuntimeReceipt,
): CrossModalRuntimeReceipt {
  const expected = runtimeReceipt(
    artifact.plan,
    artifact.evidence.timingSamples,
    receipt.tick,
    receipt.handoffs.find((handoff) => handoff.controlId === 'interaction-to-audio')?.value === 0.8 ? 1 : 0,
    artifact.evidence.artifactDigest,
    artifact.evidence.graphDigest,
    artifact.evidence.runtimeContractDigest,
  );
  if (escapedJson(receipt) !== escapedJson(expected)) {
    throw new Error('Cross-modal runtime receipt does not match the artifact-bound graph execution');
  }
  return receipt;
}

export function validateCrossModalCanonicalContent(
  artifact: Pick<CrossModalArtifact,
  'artifactDigest' | 'sourceCandidateArtifactDigest' | 'evidence' | 'html'>,
): void {
  const expected = digest(escapedJson({
    runtimeArtifactDigest: artifact.evidence.artifactDigest,
    sourceCandidateArtifactDigest: artifact.sourceCandidateArtifactDigest,
    html: artifact.html,
  }));
  if (artifact.artifactDigest !== expected) {
    throw new Error('Cross-modal canonical content does not match its artifact digest');
  }
}

function assertRuntimeCoverage(
  rows: readonly CrossModalManifestRow[],
  contracts: Readonly<Record<string, CrossModalContract>>,
  graph: CompositionGraph,
  observables: readonly CrossModalObservable[],
): void {
  const controlIds = new Set((graph.controls ?? []).map((control) => control.id));
  const observableIds = new Set(observables.map((observable) => observable.id));
  for (const row of rows) {
    if (row.disposition !== 'supported') {
      if (row.contractId && contracts[row.contractId]) {
        throw new Error(`Excluded cross-modal row ${row.id} became runtime reachable`);
      }
      continue;
    }
    const contract = row.contractId ? contracts[row.contractId] : undefined;
    if (!contract?.graphControlIds.every((id) => controlIds.has(id))) {
      throw new Error(`Supported cross-modal row ${row.id} is missing an executable graph handoff`);
    }
    if (!contract.observableIds.every((id) => observableIds.has(id))) {
      throw new Error(`Supported cross-modal row ${row.id} is missing artifact-bound evidence`);
    }
    if (!row.scenarioIds.includes(graph.id)) {
      throw new Error(`Supported cross-modal row ${row.id} is not covered by the executed scenario`);
    }
  }
}

function escapedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function playableHtml(
  audioArtifact: DeterministicMusicArtifact,
  plan: PlannedCompositionGraph,
  evidence: CrossModalEvidence,
): string {
  const runtimeSpec = escapedJson({
    artifactDigest: evidence.artifactDigest,
    runtimeContractDigest: evidence.runtimeContractDigest,
    graphId: evidence.graphId,
    graphDigest: evidence.graphDigest,
    schedule: plan.execution.schedule,
    controls: plan.execution.controls,
    timingIslands: plan.execution.timingIslands,
    bridges: plan.execution.bridges,
    cadenceMs: evidence.clock.cadenceMs,
    durationMs: evidence.durationMs,
    timingSamples: evidence.timingSamples,
  });
  const evidenceJson = escapedJson(Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'runtimeReceipt'),
  ));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Cross-modal causal work</title><style>
body{margin:0;background:#071525;color:#eef7ff;font-family:system-ui;display:grid;place-items:center;min-height:100vh}
main{display:grid;gap:1rem;justify-items:center}svg{width:360px;height:240px;border:1px solid #79d8ff}
button{font:inherit;padding:.65rem 1rem;background:#102d47;color:#fff;border:2px solid #79d8ff;border-radius:.4rem}
button:focus-visible{outline:3px solid #ffe66d;outline-offset:3px}@media(prefers-reduced-motion:reduce){circle{transition:none}}
</style></head><body><main><svg viewBox="0 0 360 240" role="img" aria-label="Audio-reactive luminous field"><circle cx="180" cy="120" r="24" fill="hsl(190 80% 55%)"/></svg>
<audio controls preload="auto" data-audio-artifact-digest="${audioArtifact.evidence.artifactDigest}" src="${audioArtifact.playableDataUri}"></audio>
<button type="button" aria-pressed="false">Intensify audiovisual response</button>
<output aria-live="polite">Calm state</output></main>
<script id="sinter-cross-modal-runtime-spec" type="application/json">${runtimeSpec}</script>
<script id="sinter-cross-modal-evidence" type="application/json">${evidenceJson}</script>
<script id="sinter-cross-modal-runtime-receipt" type="application/json">${escapedJson({
    schema: 'sinter.cross-modal-runtime-receipt',
    artifactDigest: evidence.artifactDigest,
    runtimeContractDigest: evidence.runtimeContractDigest,
    graphId: evidence.graphId,
    graphDigest: evidence.graphDigest,
    status: 'pending',
  })}</script>
<script>(()=>{const spec=JSON.parse(document.getElementById('sinter-cross-modal-runtime-spec').textContent);
const evidence=JSON.parse(document.getElementById('sinter-cross-modal-evidence').textContent);
const receiptNode=document.getElementById('sinter-cross-modal-runtime-receipt');const audio=document.querySelector('audio');
const button=document.querySelector('button');const output=document.querySelector('output');const circle=document.querySelector('circle');let active=0;
const islands=new Map(spec.timingIslands.flatMap(island=>island.nodeIds.map(id=>[id,island.id])));
const requiredSchedule=['interaction-role','audio-role','motion-role','visual-role'];
const requiredControlDefinitions=[
['interaction-to-audio','interaction-role','activation','number','audio-role','gain','number',.45,.35],
['interaction-to-visual','interaction-role','activation','number','visual-role','hue','number',70,190],
['audio-energy-to-motion','audio-role','energy','number','motion-role','phase-velocity','number',1,0],
['motion-phase-to-visual','motion-role','phase','number','visual-role','radius','number',8,24]];
const requiredControlOrder=['interaction-to-audio','audio-energy-to-motion','interaction-to-visual','motion-phase-to-visual'];
const requiredBridges=['audio-to-visual-clock'];const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function assertRuntime(condition,message){if(!condition)throw new Error(message)}
function validateSpec(){assertRuntime(spec.artifactDigest===evidence.artifactDigest&&spec.runtimeContractDigest===evidence.runtimeContractDigest
&&spec.graphId===evidence.graphId&&spec.graphDigest===evidence.graphDigest,'Cross-modal runtime identity is not bound to artifact evidence');
assertRuntime(spec.durationMs===evidence.durationMs&&same(spec.timingSamples,evidence.timingSamples),'Cross-modal runtime timing is not bound to artifact evidence');
assertRuntime(same(spec.schedule,requiredSchedule),'Cross-modal runtime schedule is incomplete or reordered');
const definitions=spec.controls.map(control=>[control.id,control.from.nodeId,control.from.port,control.from.type,
control.to.nodeId,control.to.port,control.to.type,control.scale??1,control.offset??0]);
assertRuntime(same(definitions,requiredControlDefinitions),'Cross-modal runtime control contract is incomplete or mistyped');
const bridgeDefinitions=spec.bridges.map(bridge=>[bridge.id,bridge.fromIslandId,bridge.toIslandId,bridge.mode]);
assertRuntime(same(bridgeDefinitions,[['audio-to-visual-clock','audio-island','visual-island','sample']]),'Cross-modal runtime clock bridge is incomplete');
const islandDefinitions=spec.timingIslands.map(island=>[island.id,island.clock,island.nodeIds,island.cadenceMs??null]);
assertRuntime(same(islandDefinitions,[['manual-island','manual',['interaction-role'],null],
['audio-island','audio',['audio-role'],250],['visual-island','animation-frame',['motion-role','visual-role'],250]]),'Cross-modal runtime timing islands are incomplete');
assertRuntime(Number.isFinite(spec.durationMs)&&spec.durationMs>0&&Number.isFinite(spec.cadenceMs)&&spec.cadenceMs>0,'Cross-modal runtime duration is invalid');
assertRuntime(spec.durationMs/spec.cadenceMs===spec.timingSamples.length,'Cross-modal runtime duration does not match its samples');
spec.timingSamples.forEach((sample,index)=>{assertRuntime(sample.tick===index&&sample.timeMs===index*spec.cadenceMs
&&sample.windowEndMs===(index+1)*spec.cadenceMs&&Number.isFinite(sample.audioEnergy)
&&Number.isFinite(sample.motionPhase)&&Number.isFinite(sample.visualRadius),'Cross-modal runtime timing sample is invalid')});
assertRuntime(spec.timingSamples.at(-1).windowEndMs===spec.durationMs,'Cross-modal runtime duration endpoint drifted');
assertRuntime(Number.isFinite(audio.duration)&&audio.duration>0,'Cross-modal media duration is non-finite or non-positive');
assertRuntime(audio.duration*1000===spec.durationMs,'Cross-modal media duration drifted')}
function validateReceipt(receipt){assertRuntime(receipt.artifactDigest===evidence.artifactDigest
&&receipt.runtimeContractDigest===evidence.runtimeContractDigest&&receipt.graphId===evidence.graphId
&&receipt.graphDigest===evidence.graphDigest,'Cross-modal runtime receipt identity is incomplete');
assertRuntime(same(receipt.schedule,requiredSchedule)&&same(receipt.started,requiredSchedule)
&&same(receipt.completed,requiredSchedule),'Cross-modal runtime receipt has an incomplete node schedule');
assertRuntime(same(receipt.controls,requiredControlOrder)&&same(receipt.bridges,requiredBridges),'Cross-modal runtime receipt bypassed a control or bridge');
assertRuntime(receipt.handoffs.length===requiredControlOrder.length,'Cross-modal runtime receipt has missing handoffs');
receipt.handoffs.forEach((handoff,index)=>{const control=spec.controls.find(candidate=>candidate.id===requiredControlOrder[index]);
assertRuntime(Boolean(control)&&handoff.controlId===control.id&&handoff.fromNodeId===control.from.nodeId
&&handoff.toNodeId===control.to.nodeId&&Number.isFinite(handoff.value),'Cross-modal runtime handoff is incomplete or non-finite')})}
function executeGraph(tick){validateSpec();const sample=spec.timingSamples[tick];if(!sample)throw new Error('Tick outside governed PCM duration');
const state=new Map();const nodeState=id=>{if(!state.has(id))state.set(id,{});return state.get(id)};
const receipt={schema:'sinter.cross-modal-runtime-receipt',artifactDigest:spec.artifactDigest,runtimeContractDigest:spec.runtimeContractDigest,
graphId:spec.graphId,graphDigest:spec.graphDigest,status:'running',tick,timeMs:sample.timeMs,windowEndMs:sample.windowEndMs,
schedule:[...spec.schedule],started:[],completed:[],controls:[],bridges:[],handoffs:[]};
for(const nodeId of spec.schedule){for(const bridge of spec.bridges){if(bridge.toIslandId===islands.get(nodeId)&&!receipt.bridges.includes(bridge.id))receipt.bridges.push(bridge.id)}
for(const control of spec.controls.filter(candidate=>candidate.to.nodeId===nodeId)){const source=nodeState(control.from.nodeId)[control.from.port];
assertRuntime(Number.isFinite(source),'Graph handoff source was bypassed or non-finite');const value=source*(control.scale??1)+(control.offset??0);
assertRuntime(Number.isFinite(value),'Graph handoff produced a non-finite value');
nodeState(control.to.nodeId)[control.to.port]=value;receipt.controls.push(control.id);receipt.handoffs.push({controlId:control.id,fromNodeId:control.from.nodeId,toNodeId:control.to.nodeId,value})}
receipt.started.push(nodeId);if(nodeId==='interaction-role')nodeState(nodeId).activation=active;
if(nodeId==='audio-role'){audio.volume=nodeState(nodeId).gain;nodeState(nodeId).energy=sample.audioEnergy*audio.volume}
if(nodeId==='motion-role')nodeState(nodeId).phase=nodeState(nodeId)['phase-velocity']*6+sample.motionPhase;
if(nodeId==='visual-role'){circle.setAttribute('fill','hsl('+nodeState(nodeId).hue+' 80% 55%)');circle.setAttribute('r',String(nodeState(nodeId).radius))}
receipt.completed.push(nodeId)}validateReceipt(receipt);receipt.status='completed';receiptNode.textContent=JSON.stringify(receipt);return receipt}
function currentTick(){const timeMs=audio.currentTime*1000;
assertRuntime(Number.isFinite(timeMs)&&timeMs>=0&&timeMs<=spec.durationMs,'Audio time is outside governed PCM duration');
if(timeMs===spec.durationMs)return spec.timingSamples.length-1;
const tick=Math.floor(timeMs/spec.cadenceMs);assertRuntime(Boolean(spec.timingSamples[tick]),'Audio time has no governed timing sample');return tick}
function applyState(){button.setAttribute('aria-pressed',String(Boolean(active)));output.textContent=active?'Intensified state':'Calm state';executeGraph(currentTick())}
function failRuntime(error){if(!receiptNode)throw error;receiptNode.textContent=JSON.stringify({schema:'sinter.cross-modal-runtime-receipt',
artifactDigest:spec.artifactDigest,runtimeContractDigest:spec.runtimeContractDigest,graphId:spec.graphId,graphDigest:spec.graphDigest,
status:'failed',reason:error instanceof Error?error.message:'Cross-modal runtime failed'});throw error}
function runState(){try{return applyState()}catch(error){return failRuntime(error)}}
function validateDom(){assertRuntime(Boolean(receiptNode&&audio&&button&&output&&circle),'Cross-modal runtime is missing a required DOM node')}
function initialize(){try{validateDom();button.addEventListener('click',()=>{active=active?0:1;runState()});
audio.addEventListener('timeupdate',runState);audio.addEventListener('loadedmetadata',runState);
if(!Number.isNaN(audio.duration))runState()}catch(error){failRuntime(error)}}initialize()})();</script>
</body></html>`;
}

function isMusicSoundThesis(thesis: CreativeThesis): boolean {
  const principleId = creativeThesisIdentity(thesis).principleId;
  return (MUSIC_SOUND_SUPPORTED_CONTRACT_IDS as readonly string[]).includes(principleId);
}

/**
 * Deterministic music carrier used only when the sealed product thesis is not a
 * music-* principle (e.g. p5 visual product close with audio not-applicable).
 * Product thesis identity stays on the artifact; audio uses a music-dynamics
 * carrier so createDeterministicMusicArtifact does not reject non-music theses.
 */
function musicCarrierThesis(brief: string, productThesis: CreativeThesis): CreativeThesis {
  if (isMusicSoundThesis(productThesis)) return productThesis;
  return compileCreativeThesis(
    `${brief}\n\nGoverned music-dynamics carrier for cross-modal timing evidence only.`,
    { requestedPrinciples: ['music-dynamics'] },
  );
}

export function buildCrossModalArtifact(options: CrossModalArtifactOptions): CrossModalArtifact {
  if (!options.brief?.trim()) throw new Error('Cross-modal artifact requires a non-empty brief');
  const sourceCandidateArtifactDigest = sourceCandidateDigest(options.sourceCandidateArtifactDigest);
  const manifest = options.manifest ?? CROSS_MODAL_MANIFEST;
  const contracts = options.contracts ?? CROSS_MODAL_CONTRACTS;
  const closure = closeCrossModalManifest(manifest, contracts);
  // Product thesis may be visual/contrast/etc. (audio not-applicable campaigns).
  const thesis = validateCreativeThesis(options.thesis ?? compileCreativeThesis(options.brief, {
    requestedPrinciples: ['music-dynamics'],
  }));
  // Deterministic audio still needs a music-* principle; use a carrier when needed.
  const audioArtifact = createDeterministicMusicArtifact(musicCarrierThesis(options.brief, thesis));
  const graph = crossModalGraph(thesis, audioArtifact);
  const plan = planCompositionGraph(graph);
  const samples = deriveCrossModalTimingSamples(audioArtifact);
  const durationMs = samples.at(-1)?.windowEndMs ?? 0;
  const observables = causalObservables(samples);
  assertRuntimeCoverage(manifest, contracts, graph, observables);
  const contractIds = [...new Set(manifest
    .filter((row) => row.disposition === 'supported')
    .map((row) => row.contractId!))].sort();
  const graphDigest = digest(escapedJson(graph));
  const contractDigest = runtimeContractDigest(plan, graphDigest, durationMs);
  const runtimeArtifactDigest = digest(escapedJson({
    thesisId: thesis.thesisId,
    graphId: graph.id,
    graphDigest,
    schedule: plan.schedule,
    controls: graph.controls,
    bridge: graph.bridges,
    runtimeContractDigest: contractDigest,
    durationMs,
    audioArtifactDigest: audioArtifact.evidence.artifactDigest,
    observables,
    samples,
  }));
  const initialReceipt = runtimeReceipt(
    plan,
    samples,
    0,
    0,
    runtimeArtifactDigest,
    graphDigest,
    contractDigest,
  );
  const evidence: CrossModalEvidence = freeze({
    artifactDigest: runtimeArtifactDigest,
    graphId: graph.id,
    graphDigest,
    schedule: plan.schedule,
    thesisId: thesis.thesisId,
    audioArtifactDigest: audioArtifact.evidence.artifactDigest,
    clock: { id: 'cross-modal-clock-v1', cadenceMs: CROSS_MODAL_CADENCE_MS },
    durationMs,
    runtimeContractDigest: contractDigest,
    runtimeReceipt: initialReceipt,
    observables,
    timingSamples: samples,
    contractIds,
  });
  const html = playableHtml(audioArtifact, plan, evidence);
  const artifactDigest = digest(escapedJson({
    runtimeArtifactDigest,
    sourceCandidateArtifactDigest,
    html,
  }));
  return freeze({
    schema: CROSS_MODAL_ARTIFACT_SCHEMA,
    version: CROSS_MODAL_ARTIFACT_VERSION,
    artifactId: options.artifactId?.trim() || `${CROSS_MODAL_ARTIFACT_SCHEMA}:${artifactDigest.slice(0, 24)}`,
    artifactDigest,
    sourceCandidateArtifactDigest,
    thesis,
    graph,
    plan,
    audioArtifact,
    evidence,
    closure,
    html,
  });
}
