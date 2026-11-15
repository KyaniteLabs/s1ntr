import { describe, expect, it } from 'vitest';
import {
  assertEvidenceReceiptMatchesReleaseManifest,
  createFrozenDomainManifest,
  createDefaultWave7DeclaredRuns,
  createPreExistingQueueManifest,
  createWave7ReleaseEvidenceManifest,
  parseWave7ReleaseEvidenceManifest,
  validateQueueDispositions,
  WAVE7_CONTRACT_DIGEST,
  type Wave7ReleaseRunSlot,
} from '../../../src/runtime-core/Wave7ReleaseContract.js';
import type { DreamTask } from '../../../src/dreaming/DreamQueue.js';
import { WAVE7_CREATIVE_LANES } from '../../../src/runtime-core/Wave7CreativeLadder.js';

const HEAD = 'a'.repeat(40);
const SOURCE = 'b'.repeat(64);
const domains = createFrozenDomainManifest(['tone', 'p5', 'glsl']);
const queueTasks: DreamTask[] = [{
  id: 'dream-1-100', kind: 'artifact', strategy: 'cross-modal',
  sources: [{ id: 'source-1', descriptor: [0.2], quality: 0.8 }],
  priority: 1, status: 'queued', enqueuedAt: '2026-07-31T00:00:00.000Z',
}];
const queue = createPreExistingQueueManifest(queueTasks);

function runSlots(): Wave7ReleaseRunSlot[] {
  return [
    { id: 'circulation', kind: 'circulation', lineageId: 'lineage-circulation' },
    {
      id: 'recovery', kind: 'recovery', lineageId: 'lineage-recovery',
      cycleIds: ['recovery-cycle-1', 'recovery-cycle-2'],
    },
    ...WAVE7_CREATIVE_LANES.map((lane) => ({
      id: `creative-${lane.id}`, kind: 'creative-lane' as const,
      lineageId: `lineage-${lane.id}`, lane: lane.id,
      seedIds: [...lane.seedIds],
    })),
    { id: 'assimilate', kind: 'assimilate', lineageId: 'lineage-assimilate' },
    ...domains.entries.map(domain => ({
      id: `domain-${domain}`, kind: 'domain-smoke' as const,
      lineageId: `lineage-domain-${domain}`, domain,
    })),
    { id: 'studio', kind: 'studio-journey', lineageId: 'lineage-studio' },
    { id: 'cli', kind: 'cli-journey', lineageId: 'lineage-cli' },
    { id: 'product-delta', kind: 'product-delta', lineageId: 'lineage-product' },
    { id: 'sol-bootstrap', kind: 'sol-review-bootstrap', lineageId: 'lineage-sol-initial' },
    { id: 'sol-confirm', kind: 'sol-review-confirmation', lineageId: 'lineage-sol-confirm' },
  ];
}

function manifest() {
  return createWave7ReleaseEvidenceManifest({
    generatedAt: '2026-07-31T00:00:00.000Z',
    baselineHead: 'c'.repeat(40),
    releaseHead: HEAD,
    sourceFingerprint: SOURCE,
    tourId: 'wave-7-owner-release',
    tourWaveId: `wave-7@${HEAD.slice(0, 8)}`,
    domainManifest: domains,
    queueManifest: queue,
    declaredRuns: runSlots(),
    ownerApprovedUsdCeiling: 50,
  });
}

describe('Wave7ReleaseContract immutable root', () => {
  it('builds one stable root over HEAD, domains, queue, runs, seats, and budgets', () => {
    const built = manifest();
    expect(built.contractDigest).toBe(WAVE7_CONTRACT_DIGEST);
    expect(built.domainManifest.entries).toEqual(['glsl', 'p5', 'tone']);
    expect(built.releaseRootDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(parseWave7ReleaseEvidenceManifest(structuredClone(built))).toEqual(built);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.declaredRuns)).toBe(true);
  });

  it('constructs the complete deterministic run-slot skeleton from the frozen domains', () => {
    const slots = createDefaultWave7DeclaredRuns(domains.entries, HEAD);
    expect(slots.filter(slot => slot.kind === 'domain-smoke')).toHaveLength(3);
    expect(slots.filter(slot => slot.kind === 'creative-lane')).toHaveLength(3);
    expect(() => createWave7ReleaseEvidenceManifest({
      ...manifest(), declaredRuns: slots,
    })).not.toThrow();
  });

  it('rejects empty or drifting domain manifests and incomplete run closure', () => {
    expect(() => createFrozenDomainManifest([])).toThrow('non-empty');
    const built = manifest();
    expect(() => parseWave7ReleaseEvidenceManifest({
      ...structuredClone(built),
      domainManifest: { ...built.domainManifest, entries: ['p5'] },
    })).toThrow('domain manifest');
    expect(() => createWave7ReleaseEvidenceManifest({
      ...built,
      declaredRuns: built.declaredRuns.filter(slot => slot.kind !== 'cli-journey'),
    })).toThrow('cli-journey');
  });

  it('rejects duplicate slots, lineages, and wrong tour/head binding', () => {
    const built = manifest();
    expect(() => createWave7ReleaseEvidenceManifest({
      ...built,
      declaredRuns: [...built.declaredRuns, built.declaredRuns[0]],
    })).toThrow('unique');
    expect(() => createWave7ReleaseEvidenceManifest({
      ...built,
      tourWaveId: 'wave-7@deadbeef',
    })).toThrow('tourWaveId');
  });

  it('rejects tampered embedded budgets, seats, queue IDs, and root digest', () => {
    const built = manifest();
    expect(() => parseWave7ReleaseEvidenceManifest({
      ...structuredClone(built), budgets: { ...built.budgets, wholeWave: { providerCalls: 999 } },
    })).toThrow('embedded contract');
    expect(() => parseWave7ReleaseEvidenceManifest({
      ...structuredClone(built), seatFreeze: { ...built.seatFreeze, harness: { model: 'luna' } },
    })).toThrow('embedded contract');
    expect(() => parseWave7ReleaseEvidenceManifest({
      ...structuredClone(built), releaseRootDigest: 'f'.repeat(64),
    })).toThrow('release root');
    const duplicateItems = [...built.queueManifest.items, built.queueManifest.items[0]];
    expect(() => createWave7ReleaseEvidenceManifest({
      ...built,
      queueManifest: {
        items: duplicateItems,
        digest: createPreExistingQueueManifest([...queueTasks, ...queueTasks]).digest,
      },
    })).toThrow('unique');
  });
});

describe('Wave 7 queue and child-receipt closure', () => {
  it('requires an explicit terminal disposition for every pre-existing queue item', () => {
    expect(validateQueueDispositions(queue, [])).toEqual({
      passed: false,
      failures: ['queue item dream-1-100 has no disposition'],
    });
    expect(validateQueueDispositions(queue, [{
      taskId: 'dream-1-100', disposition: 'owner-review', reason: 'Owner judgment required',
    }])).toEqual({ passed: true, failures: [] });
  });

  it('rejects bulk-style, duplicate, undeclared, or reasonless dispositions', () => {
    expect(validateQueueDispositions(queue, [{
      taskId: '*', disposition: 'archived', reason: 'old',
    }]).passed).toBe(false);
    expect(validateQueueDispositions(queue, [
      { taskId: 'dream-1-100', disposition: 'completed' },
      { taskId: 'dream-1-100', disposition: 'completed' },
    ]).passed).toBe(false);
    expect(validateQueueDispositions(queue, [{
      taskId: 'unknown', disposition: 'completed',
    }]).passed).toBe(false);
    expect(validateQueueDispositions(queue, [{
      taskId: 'dream-1-100', disposition: 'archived', reason: '',
    }]).passed).toBe(false);
  });

  it('binds each child receipt to the exact root, slot, HEAD, source, and lineage', () => {
    const built = manifest();
    const receipt = {
      releaseRootDigest: built.releaseRootDigest,
      runSlotId: 'studio',
      releaseHead: HEAD,
      sourceFingerprint: SOURCE,
      lineageId: 'lineage-studio',
    };
    expect(() => assertEvidenceReceiptMatchesReleaseManifest(built, receipt)).not.toThrow();
    for (const field of ['releaseRootDigest', 'runSlotId', 'releaseHead', 'sourceFingerprint', 'lineageId'] as const) {
      expect(() => assertEvidenceReceiptMatchesReleaseManifest(built, {
        ...receipt,
        [field]: field === 'runSlotId' ? 'undeclared' : 'wrong',
      })).toThrow();
    }
  });
});
