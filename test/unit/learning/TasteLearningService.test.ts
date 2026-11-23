import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SinterFS } from '../../../src/fs/SinterFS.js';
import { resolveSinterProjectRoot } from '../../../src/fs/projectRoot.js';
import { ArchiveEntriesFSAdapter } from '../../../src/fs/adapters/ArchiveEntries.js';
import { TasteLearningService, type NimaScorer } from '../../../src/learning/TasteLearningService.js';
import type { ArchiveEntry } from '../../../src/emergence/types.js';
import { createHash } from 'node:crypto';
import { createCreativeLabelAdmission } from
  '../../../src/learning/CreativeLabelAdmission.js';

function makeEntry(id: string, orderChaos: number, qualityScore: number): ArchiveEntry {
  const artifactDigest = createHash('sha256').update(id).digest('hex');
  return {
    id,
    artifactRef: { kind: 'generated-code', uri: `sinter://artifact/${id}`, hash: artifactDigest },
    creativeLabel: createCreativeLabelAdmission({ trustKind: 'owner-preference',
      allowedUses: ['evaluator-training'], artifactDigest,
      evidenceDigest: 'b'.repeat(64), decisionDigest: 'c'.repeat(64), rendered: true,
      identityValid: true, digestMatched: true, degraded: false }),
    descriptor: {
      values: [
        { axis: 'order-chaos', value: orderChaos },
        { axis: 'sparse-dense', value: 1 - orderChaos },
      ],
      source: 'test',
      extractedAt: '2026-01-01T00:00:00.000Z',
    },
    lineage: {
      artifactId: id,
      parentIds: [],
      provenance: 'fresh-generation',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    qualityScore,
    signals: {
      novelty: 0.5,
      structure: 0.5,
      temporalRichness: 0.5,
      perturbationResilience: 0.5,
      fertility: 0.5,
      aesthetic: 0.5,
    },
    archivedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('TasteLearningService', () => {
  let tmpRoot: string;
  let savedRoot: string | undefined;
  let sinterFs: SinterFS;

  beforeEach(() => {
    savedRoot = process.env.SINTER_PROJECT_ROOT;
    tmpRoot = mkdtempSync(join(tmpdir(), 'taste-learning-service-test-'));
    process.env.SINTER_PROJECT_ROOT = tmpRoot;
    sinterFs = SinterFS.open(resolveSinterProjectRoot());
  });

  afterEach(() => {
    sinterFs.close();
    if (savedRoot !== undefined) process.env.SINTER_PROJECT_ROOT = savedRoot;
    else delete process.env.SINTER_PROJECT_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('records a preference event in project-local preferences and SinterFS refs', async () => {
    const service = new TasteLearningService(sinterFs);

    const result = await service.recordPreference({
      action: 'pin',
      artifactId: 'artifact-a',
      sessionId: 'session-a',
    });

    expect(result.persisted).toBe(true);
    expect(result.record).toMatchObject({
      action: 'pin',
      artifactId: 'artifact-a',
      sessionId: 'session-a',
    });

    const preferenceDir = join(tmpRoot, '.sinter', 'preferences');
    expect(existsSync(preferenceDir)).toBe(true);
    expect(readdirSync(preferenceDir).filter(file => file.endsWith('.json'))).toHaveLength(1);
    expect(sinterFs.listRefs('preference').some(ref => ref.includes('artifact-a/pin'))).toBe(true);
  });

  it('trains and reloads latest taste weights from persisted archive plus preference events', async () => {
    const archive = new ArchiveEntriesFSAdapter(sinterFs);
    archive.writeArchiveEntry(makeEntry('liked', 0.9, 0.8));
    archive.writeArchiveEntry(makeEntry('rejected', 0.1, 0.4));

    const service = new TasteLearningService(sinterFs);
    await service.recordPreference({ action: 'pin', artifactId: 'liked', sessionId: 'session-a' });
    await service.recordPreference({ action: 'reject', artifactId: 'rejected', sessionId: 'session-a' });

    const summary = await service.trainFromProject();

    expect(summary).toMatchObject({
      archiveEntryCount: 2,
      preferenceEventCount: 2,
      persisted: true,
    });
    expect(summary.pairCount).toBeGreaterThan(0);
    expect(summary.weights?.pairCount).toBe(summary.pairCount);
    expect(sinterFs.readRef('taste/model/latest')).toMatchObject({ kind: 'taste-model' });

    const loaded = service.loadLatestModel();
    expect(loaded).toMatchObject({
      pairCount: summary.pairCount,
      trainingAgreement: summary.weights?.trainingAgreement,
    });
  });

  it('scores the persisted model on root-held-out pairs, never only in-sample', async () => {
    const archive = new ArchiveEntriesFSAdapter(sinterFs);
    for (let r = 0; r < 5; r++) {
      const root = makeEntry(`root-${r}`, 0.9, 0.9);
      archive.writeArchiveEntry(root);
      for (const [suffix, q] of [['mid', 0.5], ['low', 0.1]] as const) {
        const child = makeEntry(`root-${r}-${suffix}`, q, q);
        child.lineage = { ...child.lineage, parentIds: [root.id], provenance: 'branch' };
        archive.writeArchiveEntry(child);
      }
    }

    const summary = await new TasteLearningService(sinterFs).trainFromProject();

    expect(summary.heldOutStatus).toBe('evaluated');
    // One held-out root of three entries (0.9 / 0.5 / 0.1) → exactly 3 score-gap pairs.
    expect(summary.weights?.heldOutPairCount).toBe(3);
    expect(typeof summary.weights?.heldOutAgreement).toBe('number');
    expect(new TasteLearningService(sinterFs).loadLatestModel()?.heldOutPairCount).toBe(3);
  });

  it('says so when there are too few lineage roots to hold any out', async () => {
    const archive = new ArchiveEntriesFSAdapter(sinterFs);
    archive.writeArchiveEntry(makeEntry('liked', 0.9, 0.8));
    archive.writeArchiveEntry(makeEntry('rejected', 0.1, 0.4));

    const summary = await new TasteLearningService(sinterFs).trainFromProject();

    expect(summary.persisted).toBe(true);
    expect(summary.heldOutStatus).toBe('insufficient-roots');
    expect(summary.weights?.heldOutAgreement).toBeUndefined();
  });

  it('keeps legacy scalar scores visible but out of taste training', async () => {
    const archive = new ArchiveEntriesFSAdapter(sinterFs);
    const { creativeLabel: _label, ...legacy } = makeEntry('legacy', 0.9, 0.99);
    archive.writeArchiveEntry(legacy);
    const service = new TasteLearningService(sinterFs);
    await service.recordPreference({ action: 'pin', artifactId: 'legacy' });
    const summary = await service.trainFromProject();
    expect(summary.archiveEntryCount).toBe(1);
    expect(summary.persisted).toBe(false);
    expect(summary.reason).toBe('no rendered admitted labels');
  });
});

/** Builds an in-memory NimaScorer stub. Default: unavailable (fallback path). */
function makeNimaStub(opts: {
  available?: boolean;
  score?: number | null;
} = {}): NimaScorer & { scoreCallCount: () => number; availabilityCallCount: () => number } {
  let scoreCalls = 0;
  let availCalls = 0;
  const scoreValue = opts.score === undefined ? null : opts.score;
  return {
    isAvailable: async () => { availCalls++; return opts.available ?? false; },
    score: async () => { scoreCalls++; return scoreValue === null ? null : { score: scoreValue }; },
    scoreCallCount: () => scoreCalls,
    availabilityCallCount: () => availCalls,
  };
}

describe('TasteLearningService — NIMA aesthetic enrichment', () => {
  let tmpRoot: string;
  let savedRoot: string | undefined;
  let sinterFs: SinterFS;

  beforeEach(() => {
    savedRoot = process.env.SINTER_PROJECT_ROOT;
    tmpRoot = mkdtempSync(join(tmpdir(), 'taste-nima-test-'));
    process.env.SINTER_PROJECT_ROOT = tmpRoot;
    sinterFs = SinterFS.open(resolveSinterProjectRoot());
  });

  afterEach(() => {
    sinterFs.close();
    if (savedRoot !== undefined) process.env.SINTER_PROJECT_ROOT = savedRoot;
    else delete process.env.SINTER_PROJECT_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('falls back to existing qualityScore when NIMA is unavailable', async () => {
    const entries = [makeEntry('a', 0.9, 0.8), makeEntry('b', 0.1, 0.4)];
    const preview = Buffer.from('fake-png-bytes');
    const nima = makeNimaStub({ available: false });
    const previewProvider = vi.fn(() => preview);

    const service = new TasteLearningService(sinterFs, { nima, previewProvider });
    const enriched = await service.enrichArchiveWithNima(entries);

    // NIMA was unavailable → score() never called, preview never rendered,
    // and every entry keeps its original qualityScore with no nimaScore.
    expect(nima.scoreCallCount()).toBe(0);
    expect(previewProvider).not.toHaveBeenCalled();
    expect(enriched).toEqual(entries);
    expect(enriched.every(e => e.nimaScore === undefined)).toBe(true);
  });

  it('falls back to existing qualityScore when no preview is available', async () => {
    const entries = [makeEntry('a', 0.9, 0.8)];
    const nima = makeNimaStub({ available: true, score: 9 });
    const previewProvider = vi.fn(() => null);

    const service = new TasteLearningService(sinterFs, { nima, previewProvider });
    const enriched = await service.enrichArchiveWithNima(entries);

    expect(nima.availabilityCallCount()).toBe(1);
    expect(nima.scoreCallCount()).toBe(0);
    expect(enriched[0].qualityScore).toBe(0.8);
    expect(enriched[0].nimaScore).toBeUndefined();
  });

  it('uses nimaScore/10 as qualityScore when NIMA is available and a preview exists', async () => {
    const entries = [makeEntry('a', 0.9, 0.8), makeEntry('b', 0.1, 0.4)];
    const preview = Buffer.from('fake-png-bytes');
    const nima = makeNimaStub({ available: true, score: 7.5 });
    const previewProvider = vi.fn(() => preview);

    const service = new TasteLearningService(sinterFs, { nima, previewProvider });
    const enriched = await service.enrichArchiveWithNima(entries);

    // Every entry scored once against its preview, qualityScore overridden by
    // nimaScore/10 (7.5/10 = 0.75), and the raw nimaScore recorded.
    expect(nima.scoreCallCount()).toBe(2);
    expect(previewProvider).toHaveBeenCalledTimes(2);
    for (const e of enriched) {
      expect(e.qualityScore).toBeCloseTo(0.75, 5);
      expect(e.nimaScore).toBe(7.5);
    }
    // Original entries are not mutated.
    expect(entries[0].qualityScore).toBe(0.8);
    expect(entries[0].nimaScore).toBeUndefined();
  });

  it('falls back per-entry when NIMA scoring returns null', async () => {
    const entries = [makeEntry('a', 0.9, 0.8), makeEntry('b', 0.1, 0.4)];
    const preview = Buffer.from('fake-png-bytes');
    const nima = makeNimaStub({ available: true, score: null });
    const previewProvider = vi.fn(() => preview);

    const service = new TasteLearningService(sinterFs, { nima, previewProvider });
    const enriched = await service.enrichArchiveWithNima(entries);

    expect(nima.scoreCallCount()).toBe(2);
    expect(enriched).toEqual(entries);
    expect(enriched.every(e => e.nimaScore === undefined)).toBe(true);
  });

  it('never mixes NIMA and prior quality: one missing preview keeps every entry on prior quality', async () => {
    const entries = [makeEntry('a', 0.9, 0.8), makeEntry('b', 0.1, 0.4)];
    const nima = makeNimaStub({ available: true, score: 7.5 });
    const previewProvider = vi.fn((entry: { id: string }) => (entry.id === 'a' ? Buffer.from('png') : null));

    const service = new TasteLearningService(sinterFs, { nima, previewProvider });
    const enriched = await service.enrichArchiveWithNima(entries);

    expect(enriched).toEqual(entries);
    expect(enriched.map(e => e.qualityScore)).toEqual([0.8, 0.4]);
    expect(enriched.every(e => e.nimaScore === undefined)).toBe(true);
  });

  it('treats an out-of-range or non-finite NIMA score as a failure, not a quality value', async () => {
    const entries = [makeEntry('a', 0.9, 0.8)];
    for (const bad of [Number.NaN, 0, 11, Number.POSITIVE_INFINITY]) {
      const service = new TasteLearningService(sinterFs, {
        nima: makeNimaStub({ available: true, score: bad }),
        previewProvider: () => Buffer.from('png'),
      });
      const enriched = await service.enrichArchiveWithNima(entries);
      expect(enriched[0].qualityScore).toBe(0.8);
      expect(enriched[0].nimaScore).toBeUndefined();
    }
  });

  it('reports the NIMA enrichment outcome in the training summary', async () => {
    const archive = new ArchiveEntriesFSAdapter(sinterFs);
    archive.writeArchiveEntry(makeEntry('liked', 0.9, 0.8));
    archive.writeArchiveEntry(makeEntry('rejected', 0.1, 0.4));

    const unavailable = new TasteLearningService(sinterFs, { nima: makeNimaStub({ available: false }), previewProvider: () => null });
    expect((await unavailable.trainFromProject()).nimaEnrichment).toEqual({ status: 'unavailable', scored: 0, missingPreview: 0, failedScore: 0 });

    const incomplete = new TasteLearningService(sinterFs, { nima: makeNimaStub({ available: true, score: null }), previewProvider: () => Buffer.from('png') });
    expect((await incomplete.trainFromProject()).nimaEnrichment).toEqual({ status: 'incomplete', scored: 0, missingPreview: 0, failedScore: 2 });
  });

  it('keeps the verified score and skips preview rendering for signed generation labels', async () => {
    const operationDigest = 'a'.repeat(64);
    const id = 'sinter://artifact/' + operationDigest;
    const entry = makeEntry(id, 0.4, 0.8);
    const artifactRef = sinterFs.writeArtifact({ kind: 'generated-code', content: '<html>art</html>', filename: 'source.html' });
    const creativeLabel = createCreativeLabelAdmission({ trustKind: 'judge-scoring', allowedUses: ['evaluator-training'],
      artifactDigest: artifactRef.hash!, evidenceDigest: 'b'.repeat(64), decisionDigest: 'c'.repeat(64),
      rendered: true, identityValid: true, digestMatched: true, degraded: false,
      trainingEvidence: { operationDigest, quality: entry.qualityScore } });
    new ArchiveEntriesFSAdapter(sinterFs).writeArchiveEntry({ ...entry, artifactRef, creativeLabel,
      lineage: { ...entry.lineage, artifactId: operationDigest } });
    const nima = makeNimaStub({ available: true, score: 9.5 });
    const previewProvider = vi.fn(() => Buffer.from('mutable preview'));
    const summary = await new TasteLearningService(sinterFs, { nima, previewProvider }).trainFromProject();
    expect(summary.reason).toBe('no usable preference pairs');
    expect(nima.availabilityCallCount()).toBe(0);
    expect(previewProvider).not.toHaveBeenCalled();
  });

  it('trainFromProject() persists a model using NIMA-derived quality', async () => {
    const archive = new ArchiveEntriesFSAdapter(sinterFs);
    archive.writeArchiveEntry(makeEntry('liked', 0.9, 0.8));
    archive.writeArchiveEntry(makeEntry('rejected', 0.1, 0.4));

    const nima = makeNimaStub({ available: true, score: 6 });
    const previewProvider = () => Buffer.from('fake-png-bytes');

    const service = new TasteLearningService(sinterFs, { nima, previewProvider });
    await service.recordPreference({ action: 'pin', artifactId: 'liked', sessionId: 'session-a' });
    await service.recordPreference({ action: 'reject', artifactId: 'rejected', sessionId: 'session-a' });

    const summary = await service.trainFromProject();

    expect(summary.persisted).toBe(true);
    expect(summary.pairCount).toBeGreaterThan(0);
    expect(nima.scoreCallCount()).toBe(2);
    // The persisted model is reloadable.
    expect(service.loadLatestModel()?.pairCount).toBe(summary.pairCount);
  });
});
