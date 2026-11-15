import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dreamCreativeDeltaDigest, sealDreamBlindComparisonPolicy,
  sealDreamOperatorDeclaration } from '../../src/dreaming/research/DreamBlindComparison.js';
import { createDreamDecisionAuthority } from
  '../../src/dreaming/research/DreamDecisionAuthority.js';
import { DreamRenderedExperimentExecutor } from
  '../../src/dreaming/research/DreamRenderedExperimentExecutor.js';
import { createDreamRenderedEvidenceAuthority } from
  '../../src/dreaming/research/DreamResearchEvidence.js';
import { DreamResearchController, FileDreamResearchPolicyStore } from
  '../../src/dreaming/research/DreamResearchController.js';
import { DreamResearchJournal } from '../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchService } from '../../src/dreaming/research/DreamResearchService.js';
import { DreamProductCommandPort, FileDreamProductProjectionStore } from
  '../../src/runtime-core/DreamProductCommandPort.js';

const digest = (char: string) => char.repeat(64);
const declaration = sealDreamOperatorDeclaration({ id: 'depth-shift', factor: 'depth',
  compatibleDomains: ['p5'], protectedInvariants: ['palette'],
  structuralDiffRules: ['layers.*.depth'] });
const policy = sealDreamBlindComparisonPolicy({ criterionIds: ['depth'],
  evaluatorOrderSeeds: [digest('1'), digest('2')], disagreementRule: 'inconclusive',
  uncertaintyThreshold: 0.5, criticalRegressionCriteria: ['depth'] });

const baseline = { id: 'baseline', source: 'baseline-source', graphDigest: digest('3'),
  layerIds: ['field'], domains: ['p5'], invariantDigests: { palette: digest('4') } };
const variantSource = 'structurally-different-variant';
const variant = { id: 'variant', source: variantSource, graphDigest: digest('5'),
  layerIds: ['field'], domains: ['p5'], mutation: { operatorId: declaration.id,
    changedFactor: declaration.factor, changedPaths: ['layers.field.depth'],
    protectedInvariantDigests: { palette: digest('4') },
    creativeDeltaDigest: dreamCreativeDeltaDigest(
      baseline.source, variantSource, ['layers.field.depth']) } };
const pixelFrames = ['early', 'late'].map(dataBase64 => ({ mimeType: 'image/png', dataBase64,
  digest: createHash('sha256').update(dataBase64).digest('hex') }));
const rendered = { artifactDigest: digest('6'), playableDigest: digest('7'),
  rendererEnvironmentDigest: digest('8'), runtimeErrors: [], degraded: false,
  identityValid: true, digestMatched: true, frames: pixelFrames.map(frame => frame.digest),
  pixelFrames,
  temporalSamples: [digest('b')], containment: { networkIsolated: true,
    permissionsDenied: true, resourceLimitsObserved: true, cleanupSucceeded: true,
    outputBytes: 1, assetDigests: [], runtimeDigest: digest('c'),
    postRunCensus: { durationMs: 1, usedHeapBytes: 1, eventListeners: 0,
      eventsDispatched: 0, timers: 0, audioContexts: 0, pagesBefore: 0, pagesAfter: 0 } } };

function evaluator(identity: string, host: string) {
  return { identity: { identityDigest: digest(identity), hostDigest: digest(host) },
    compare: vi.fn(async () => ({ outcome: 'rejected' as const, uncertainty: 0.1,
      criteria: [{ criterion: 'depth', evidenceDigest: digest('d'),
        direction: 'regressed' as const }] })) };
}

function build(root: string, products: { verifiedOwnerEvidence: ReturnType<typeof vi.fn>;
  runResearchProviderEffect: ReturnType<typeof vi.fn> }) {
  const evidenceAuthority = createDreamRenderedEvidenceAuthority();
  evidenceAuthority.issuer.attest(rendered);
  const decisions = createDreamDecisionAuthority();
  const operator = { declaration, produce: vi.fn(async () => ({ baseline, variants: [variant] })) };
  const observer = { observe: vi.fn(async () => rendered) };
  const executor = new DreamRenderedExperimentExecutor(operator, observer,
    [evaluator('1', '2'), evaluator('3', '4')], decisions.issuer, policy,
    evidenceAuthority.resolver);
  const journal = new DreamResearchJournal(path.join(root, 'journal.sqlite'));
  const linked = vi.fn(async () => []);
  const port = new DreamProductCommandPort({ ...products, linkDreamProjection: linked } as never,
    new DreamResearchController(new FileDreamResearchPolicyStore(path.join(root, 'policy.json'))),
    new DreamResearchService(journal, { assertActive: vi.fn() }, decisions.resolver), executor,
    new FileDreamProductProjectionStore(path.join(root, 'projections.json')),
    { maxCandidates: 1, maxProviderAttempts: 3 }, { campaignId: 'wave-8',
      context: { knowledgeProfileDigest: digest('e'), operatorDigest: declaration.declarationDigest,
        policyDigest: policy.policyDigest, rendererEnvironmentDigest: digest('8'),
        evaluatorManifestDigests: [digest('1'), digest('3')],
        transferCommitmentDigest: digest('f') }, requiredModalities: ['visual', 'motion'],
      lease: { token: 'test-lease', fencingSequence: 1 } });
  return { port, journal, operator, observer, linked };
}

describe('Dream product command path', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }))));

  it('keeps legacy queue generation unreachable from dream run', async () => {
    const cli = await readFile(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
    const start = cli.indexOf("cmd === 'dream' && cmdArgs[0] === 'run'");
    const block = cli.slice(start, cli.indexOf("else if (cmd === 'garden'", start));
    expect(block).toContain('liminalRuntime.dream.run(command)');
    expect(block).not.toMatch(/DreamQueue|runNextDreamTask|useArchiveLearning/);
  });

  it('runs accepted evidence once and records rejection only as negative policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dream-product-'));
    roots.push(root);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const products = { runResearchProviderEffect: vi.fn(async input => input.effect()),
      verifiedOwnerEvidence: vi.fn(async () => ({
      createKey: 'create-1', ownerReviewKey: 'review-1', operationId: 'operation:create-1',
      lineageId: 'lineage:create-1', createCommandDigest: digest('1'),
      createReceiptDigest: digest('2'), reviewCommandDigest: digest('3'),
      reviewDecisionDigest: digest('4'), reviewReceiptDigest: digest('5'),
      artifactDigest: digest('a'), evidenceDigest: digest('b'),
      criterionDigest: digest('c'), domain: 'p5', quality: 0.8, decision: 'accepted' })) };
    const first = build(root, products);
    const command = { schema: 'sinter.dream-product-command' as const, schemaVersion: 1 as const,
      idempotencyKey: 'dream-once', evidence: [{ createKey: 'create-1',
        ownerReviewKey: 'review-1' }] };
    const result = await first.port.run(command);
    expect(result.outcome).toBe('rejected');
    expect(first.operator.produce).toHaveBeenCalledOnce();
    expect(first.observer.observe).toHaveBeenCalledTimes(2);
    expect(products.runResearchProviderEffect).toHaveBeenCalledTimes(3);
    expect(products.runResearchProviderEffect.mock.calls.map(([input]) => input.role))
      .toEqual(['generator', 'evaluator', 'evaluator']);
    expect(first.linked).toHaveBeenCalledWith(['operation:create-1'], expect.stringMatching(
      /^[a-f0-9]{64}$/));
    expect(fetchSpy).not.toHaveBeenCalled();
    first.journal.close();
    const resumed = build(root, products);
    expect(await resumed.port.run(command)).toEqual(result);
    expect(resumed.operator.produce).not.toHaveBeenCalled();
    resumed.journal.close();
    const stored = JSON.parse(await readFile(path.join(root, 'policy.json'), 'utf8'));
    expect(Object.values(stored.negativeNeighborhoods)).toEqual([1]);
    expect(JSON.stringify(stored)).not.toMatch(/guidance|activation|learning/i);
    fetchSpy.mockRestore();
  });
});
