import { createHash } from 'node:crypto';
import type { DreamTask } from '../dreaming/DreamQueue.js';
import { WAVE7_CREATIVE_DECISION_RULE, WAVE7_CREATIVE_LANES } from './Wave7CreativeLadder.js';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const WAVE7_BUDGETS = deepFreeze({
  perCycle: { wallMinutes: 45, providerCalls: 12, retriesPerStage: 1 },
  concurrency: { autoresearchCandidates: 1, consumersPerQueueItem: 1 },
  wholeWave: { providerCalls: 120, billableTokens: 3_000_000, activeHours: 48 },
  reviews: { creativeLaneRetries: 1, independentPasses: 2, solPasses: 2 },
});

export const WAVE7_SEAT_FREEZE = deepFreeze({
  harness: { model: 'gpt-5.6-sol', effort: 'high', lunaMaySubstitute: false },
  creative: { model: 'gpt-5.6-luna', effort: 'max', liveResolverRequired: true },
  creativeEvaluator: { model: 'grok', effort: 'high', mediaCapabilityRequired: true },
  productReviewer: { model: 'gpt-5.6-terra', effort: 'high' },
});

const WAVE7_RELEASE_CONTRACT = deepFreeze({
  schemaVersion: 1,
  wave: 7,
  releaseClaim: 'owner-release-candidate',
  creativeLanes: WAVE7_CREATIVE_LANES,
  creativeDecisionRule: WAVE7_CREATIVE_DECISION_RULE,
  ownerReleaseWorthinessRequired: true,
  deterministicEvidenceMaySatisfyLive: false,
  preSpendGates: [
    'noSpendCirculationProof',
    'solHighPreSpendApproval',
    'preSpendFeasibilityProof',
  ],
  budgets: WAVE7_BUDGETS,
  seats: WAVE7_SEAT_FREEZE,
});

export const WAVE7_CONTRACT_DIGEST = digest(WAVE7_RELEASE_CONTRACT);

export interface FrozenDomainManifest {
  entries: string[];
  digest: string;
}

export interface FrozenQueueItem {
  id: string;
  kind: DreamTask['kind'];
  strategy: DreamTask['strategy'];
  sourceIds: string[];
  priority: number;
  status: DreamTask['status'];
  enqueuedAt: string;
}

export interface PreExistingQueueManifest {
  items: FrozenQueueItem[];
  digest: string;
}

export type Wave7ReleaseRunKind =
  | 'circulation' | 'recovery' | 'creative-lane' | 'assimilate'
  | 'domain-smoke' | 'studio-journey' | 'cli-journey' | 'product-delta'
  | 'sol-review-bootstrap' | 'sol-review-confirmation';

export interface Wave7ReleaseRunSlot {
  id: string;
  kind: Wave7ReleaseRunKind;
  lineageId: string;
  lane?: string;
  domain?: string;
  seedIds?: string[];
  cycleIds?: string[];
}

export function createDefaultWave7DeclaredRuns(
  domainNames: string[],
  releaseHead: string,
): Wave7ReleaseRunSlot[] {
  const tip = releaseHead.slice(0, 8);
  const slot = (id: string, kind: Wave7ReleaseRunKind): Wave7ReleaseRunSlot => ({
    id,
    kind,
    lineageId: `wave7-${tip}-${id}`,
  });
  return [
    slot('circulation', 'circulation'),
    { ...slot('recovery', 'recovery'), cycleIds: ['cycle-1', 'cycle-2'] },
    ...WAVE7_CREATIVE_LANES.map(lane => ({
      ...slot(`creative-${lane.id}`, 'creative-lane'),
      lane: lane.id,
      seedIds: [...lane.seedIds],
    })),
    slot('assimilate', 'assimilate'),
    ...[...domainNames].sort().map(domain => ({
      ...slot(`domain-${domain}`, 'domain-smoke'), domain,
    })),
    slot('studio', 'studio-journey'),
    slot('cli', 'cli-journey'),
    slot('product-delta', 'product-delta'),
    slot('sol-bootstrap', 'sol-review-bootstrap'),
    slot('sol-confirm', 'sol-review-confirmation'),
  ];
}

export interface Wave7ReleaseEvidenceManifest {
  schemaVersion: 1;
  wave: 7;
  generatedAt: string;
  baselineHead: string;
  releaseHead: string;
  sourceFingerprint: string;
  tourId: string;
  tourWaveId: string;
  contractDigest: string;
  domainManifest: FrozenDomainManifest;
  queueManifest: PreExistingQueueManifest;
  declaredRuns: Wave7ReleaseRunSlot[];
  ownerApprovedUsdCeiling: number;
  budgets: typeof WAVE7_BUDGETS;
  seatFreeze: typeof WAVE7_SEAT_FREEZE;
  releaseRootDigest: string;
}

type ReleaseManifestInput = Omit<Wave7ReleaseEvidenceManifest,
  'schemaVersion' | 'wave' | 'contractDigest' | 'budgets' | 'seatFreeze' | 'releaseRootDigest'>;

export interface QueueDisposition {
  taskId: string;
  disposition: 'completed' | 'archived' | 'owner-review';
  reason?: string;
}

export function createFrozenDomainManifest(domainNames: string[]): FrozenDomainManifest {
  const entries = [...new Set(domainNames.map(name => name.trim()).filter(Boolean))].sort();
  if (entries.length === 0) throw new Error('Wave 7 domain manifest must be non-empty');
  if (entries.length !== domainNames.length) {
    throw new Error('Wave 7 domain manifest entries must be unique and non-blank');
  }
  return deepFreeze({ entries, digest: digest({ entries }) });
}

export function createPreExistingQueueManifest(tasks: DreamTask[]): PreExistingQueueManifest {
  const items = tasks.map(task => ({
    id: task.id,
    kind: task.kind,
    strategy: task.strategy,
    sourceIds: task.sources.map(source => source.id).sort(),
    priority: task.priority,
    status: task.status,
    enqueuedAt: task.enqueuedAt,
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('Wave 7 queue manifest task IDs must be unique');
  }
  return deepFreeze({ items, digest: digest({ items }) });
}

function requireExactRunClosure(
  runs: Wave7ReleaseRunSlot[],
  domains: FrozenDomainManifest,
): void {
  if (runs.length === 0) throw new Error('Wave 7 declared runs must be non-empty');
  if (new Set(runs.map(run => run.id)).size !== runs.length
    || new Set(runs.map(run => run.lineageId)).size !== runs.length) {
    throw new Error('Wave 7 run IDs and lineages must be unique');
  }
  const requireOne = (kind: Wave7ReleaseRunKind): Wave7ReleaseRunSlot => {
    const matches = runs.filter(run => run.kind === kind);
    if (matches.length !== 1) throw new Error(`Wave 7 requires exactly one ${kind} run`);
    return matches[0];
  };
  requireOne('circulation');
  const recovery = requireOne('recovery');
  requireOne('assimilate');
  requireOne('studio-journey');
  requireOne('cli-journey');
  requireOne('product-delta');
  requireOne('sol-review-bootstrap');
  requireOne('sol-review-confirmation');
  if (recovery.cycleIds?.length !== 2 || new Set(recovery.cycleIds).size !== 2) {
    throw new Error('Wave 7 recovery run requires two ordered unique cycle IDs');
  }

  const creative = runs.filter(run => run.kind === 'creative-lane');
  const laneNames = creative.map(run => run.lane).sort();
  const expectedLanes = WAVE7_CREATIVE_LANES.map(lane => lane.id).sort();
  if (stable(laneNames) !== stable(expectedLanes)) {
    throw new Error('Wave 7 creative-lane closure is incomplete or drifting');
  }
  for (const run of creative) {
    const lane = WAVE7_CREATIVE_LANES.find(candidate => candidate.id === run.lane);
    if (!lane || stable(run.seedIds) !== stable(lane.seedIds)) {
      throw new Error(`Wave 7 creative lane ${run.lane} frozen seeds drifted`);
    }
  }

  const smokeDomains = runs.filter(run => run.kind === 'domain-smoke')
    .map(run => run.domain).sort();
  if (stable(smokeDomains) !== stable(domains.entries)) {
    throw new Error('Wave 7 domain-smoke closure does not match the frozen domain manifest');
  }
}

function unsignedManifest(input: ReleaseManifestInput) {
  if (!Number.isFinite(Date.parse(input.generatedAt))) {
    throw new Error('Wave 7 generatedAt must be an ISO timestamp');
  }
  if (!SHA1.test(input.baselineHead) || !SHA1.test(input.releaseHead)) {
    throw new Error('Wave 7 baseline and release HEADs must be full git SHA-1 values');
  }
  if (!SHA256.test(input.sourceFingerprint)) {
    throw new Error('Wave 7 source fingerprint must be SHA-256');
  }
  if (input.tourWaveId !== `wave-7@${input.releaseHead.slice(0, 8)}`) {
    throw new Error('Wave 7 tourWaveId must bind the release HEAD');
  }
  if (!input.tourId.trim()) throw new Error('Wave 7 tourId is required');
  if (!Number.isFinite(input.ownerApprovedUsdCeiling) || input.ownerApprovedUsdCeiling <= 0) {
    throw new Error('Wave 7 owner-approved USD ceiling is required');
  }
  const domains = createFrozenDomainManifest(input.domainManifest.entries);
  if (domains.digest !== input.domainManifest.digest) {
    throw new Error('Wave 7 domain manifest digest mismatch');
  }
  const queueDigest = digest({ items: input.queueManifest.items });
  if (queueDigest !== input.queueManifest.digest) {
    throw new Error('Wave 7 queue manifest digest mismatch');
  }
  const queueIds = input.queueManifest.items.map(item => item.id);
  if (queueIds.some(id => !id.trim()) || new Set(queueIds).size !== queueIds.length) {
    throw new Error('Wave 7 queue manifest task IDs must be unique and non-blank');
  }
  requireExactRunClosure(input.declaredRuns, domains);
  return {
    schemaVersion: 1 as const,
    wave: 7 as const,
    ...input,
    contractDigest: WAVE7_CONTRACT_DIGEST,
    domainManifest: domains,
    budgets: WAVE7_BUDGETS,
    seatFreeze: WAVE7_SEAT_FREEZE,
  };
}

export function createWave7ReleaseEvidenceManifest(
  input: ReleaseManifestInput,
): Wave7ReleaseEvidenceManifest {
  const unsigned = unsignedManifest(input);
  return deepFreeze({ ...unsigned, releaseRootDigest: digest(unsigned) });
}

export function parseWave7ReleaseEvidenceManifest(value: unknown): Wave7ReleaseEvidenceManifest {
  if (!value || typeof value !== 'object') throw new Error('Wave 7 release manifest must be an object');
  const candidate = value as Wave7ReleaseEvidenceManifest;
  if (candidate.schemaVersion !== 1 || candidate.wave !== 7) {
    throw new Error('Wave 7 release manifest schema mismatch');
  }
  if (candidate.contractDigest !== WAVE7_CONTRACT_DIGEST) {
    throw new Error('Wave 7 release contract digest mismatch');
  }
  if (stable(candidate.budgets) !== stable(WAVE7_BUDGETS)
    || stable(candidate.seatFreeze) !== stable(WAVE7_SEAT_FREEZE)) {
    throw new Error('Wave 7 embedded contract values mismatch');
  }
  const rebuilt = createWave7ReleaseEvidenceManifest({
    generatedAt: candidate.generatedAt,
    baselineHead: candidate.baselineHead,
    releaseHead: candidate.releaseHead,
    sourceFingerprint: candidate.sourceFingerprint,
    tourId: candidate.tourId,
    tourWaveId: candidate.tourWaveId,
    domainManifest: candidate.domainManifest,
    queueManifest: candidate.queueManifest,
    declaredRuns: candidate.declaredRuns,
    ownerApprovedUsdCeiling: candidate.ownerApprovedUsdCeiling,
  });
  if (candidate.releaseRootDigest !== rebuilt.releaseRootDigest) {
    throw new Error('Wave 7 release root digest mismatch');
  }
  return rebuilt;
}

export function validateQueueDispositions(
  manifest: PreExistingQueueManifest,
  dispositions: QueueDisposition[],
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const known = new Set(manifest.items.map(item => item.id));
  const seen = new Set<string>();
  for (const disposition of dispositions) {
    if (!known.has(disposition.taskId)) failures.push(`undeclared queue item ${disposition.taskId}`);
    if (seen.has(disposition.taskId)) failures.push(`duplicate disposition for ${disposition.taskId}`);
    seen.add(disposition.taskId);
    if (disposition.disposition !== 'completed' && !disposition.reason?.trim()) {
      failures.push(`queue item ${disposition.taskId} requires a disposition reason`);
    }
  }
  for (const item of manifest.items) {
    if (!seen.has(item.id)) failures.push(`queue item ${item.id} has no disposition`);
  }
  return { passed: failures.length === 0, failures };
}

export interface Wave7ChildEvidenceReceiptBinding {
  releaseRootDigest: string;
  runSlotId: string;
  releaseHead: string;
  sourceFingerprint: string;
  lineageId: string;
}

export function assertEvidenceReceiptMatchesReleaseManifest(
  manifest: Wave7ReleaseEvidenceManifest,
  receipt: Wave7ChildEvidenceReceiptBinding,
): void {
  const validated = parseWave7ReleaseEvidenceManifest(manifest);
  if (receipt.releaseRootDigest !== validated.releaseRootDigest) {
    throw new Error('Wave 7 child receipt release root mismatch');
  }
  if (receipt.releaseHead !== validated.releaseHead) {
    throw new Error('Wave 7 child receipt release HEAD mismatch');
  }
  if (receipt.sourceFingerprint !== validated.sourceFingerprint) {
    throw new Error('Wave 7 child receipt source fingerprint mismatch');
  }
  const slot = validated.declaredRuns.find(run => run.id === receipt.runSlotId);
  if (!slot) throw new Error(`Wave 7 child receipt uses undeclared slot ${receipt.runSlotId}`);
  if (slot.lineageId !== receipt.lineageId) {
    throw new Error('Wave 7 child receipt lineage mismatch');
  }
}
