import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DreamRenderedExperimentExecutor, sealDreamBlindComparisonPolicy,
  sealDreamOperatorDeclaration } from
  '../../../src/dreaming/research/DreamRenderedExperimentExecutor.js';
import { frozenExperiment } from './dreamResearchFixtures.js';
import { createDreamDecisionAuthority } from
  '../../../src/dreaming/research/DreamDecisionAuthority.js';
import { createDreamRenderedEvidenceAuthority } from
  '../../../src/dreaming/research/DreamResearchEvidence.js';
import { dreamCreativeDeltaDigest } from
  '../../../src/dreaming/research/DreamBlindComparison.js';

const digest = (char: string) => char.repeat(64);
const pixelFrames = ['pixel-early', 'pixel-late'].map(dataBase64 => ({
  mimeType: 'image/png', dataBase64,
  digest: createHash('sha256').update(dataBase64).digest('hex'),
}));
const evidence = { artifactDigest: digest('a'), playableDigest: digest('b'),
  rendererEnvironmentDigest: digest('c'), runtimeErrors: [], degraded: false,
  identityValid: true, digestMatched: true, frames: pixelFrames.map(frame => frame.digest),
  pixelFrames,
  temporalSamples: [digest('f')], layerAblations: [digest('9'), digest('0')],
  containment: { networkIsolated: true, permissionsDenied: true,
    resourceLimitsObserved: true, cleanupSucceeded: true, outputBytes: 1,
    assetDigests: [], runtimeDigest: digest('7'), postRunCensus: { durationMs: 1,
      usedHeapBytes: 1, eventListeners: 0, eventsDispatched: 0, timers: 0,
      audioContexts: 0, pagesBefore: 0, pagesAfter: 0 } } };
const renderedEvidence = createDreamRenderedEvidenceAuthority();
renderedEvidence.issuer.attest(evidence);
const baseline = { id: 'baseline', source: 'one', graphDigest: digest('1'),
  layerIds: ['a', 'b'], domains: ['html', 'tone'], invariantDigests: {
    palette: digest('6'), timing: digest('7') }, layerAblations: [
    { removedLayerId: 'a', source: 'baseline-without-a' },
    { removedLayerId: 'b', source: 'baseline-without-b' }] };
const variant = { id: 'variant', source: 'two', graphDigest: digest('2'),
  layerIds: ['a', 'b'], domains: ['html', 'tone'], layerAblations: [
    { removedLayerId: 'a', source: 'variant-without-a' },
    { removedLayerId: 'b', source: 'variant-without-b' }], mutation: {
      operatorId: 'depth-shift', changedFactor: 'spatial-depth',
      changedPaths: ['layers.a.depth'], protectedInvariantDigests: {
        palette: digest('6'), timing: digest('7') },
      creativeDeltaDigest: dreamCreativeDeltaDigest('one', 'two', ['layers.a.depth']) } };
const declaration = sealDreamOperatorDeclaration({ id: 'depth-shift', factor: 'spatial-depth',
  compatibleDomains: ['html', 'tone'], protectedInvariants: ['palette', 'timing'],
  structuralDiffRules: ['layers.*.depth'] });
const policy = sealDreamBlindComparisonPolicy({ criterionIds: ['depth'],
  evaluatorOrderSeeds: [digest('a'), digest('b')], disagreementRule: 'inconclusive',
  uncertaintyThreshold: 0.6, criticalRegressionCriteria: ['depth'] });

function evaluator(identity: string, host: string,
  outcome: 'keeper' | 'rejected' | 'inconclusive' = 'keeper') {
  return { identity: { identityDigest: digest(identity), hostDigest: digest(host) },
    compare: vi.fn(async () => ({ outcome, uncertainty: 0.1, criteria: [{ criterion: 'depth',
      evidenceDigest: digest('8'), direction: outcome === 'rejected'
        ? 'regressed' as const : 'improved' as const }] })) };
}

describe('DreamRenderedExperimentExecutor', () => {
  it('runs genuine multimodal candidates through independent criterion comparison', async () => {
    const executor = new DreamRenderedExperimentExecutor(
      { declaration, produce: vi.fn(async () => ({ baseline, variants: [variant] })) },
      { observe: vi.fn(async () => evidence) },
      [evaluator('1', '2'), evaluator('3', '4')],
      createDreamDecisionAuthority().issuer, policy, renderedEvidence.resolver);
    const transport = vi.fn(async (_purpose: string, operation: () => Promise<unknown>) =>
      operation());
    const plan = frozenExperiment();
    const result = await executor.execute({ ...plan, context: { ...plan.context,
      operatorDigest: declaration.declarationDigest, policyDigest: policy.policyDigest,
      evaluatorManifestDigests: [digest('1'), digest('3')] },
      requiredModalities: ['visual', 'motion', 'multi-layer'] }, transport);
    expect(result.comparison.outcome).toBe('keeper');
    expect(result.variantEvidenceDigests).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it('rejects replay and evaluator pseudo-independence', async () => {
    const one = evaluator('1', '2');
    expect(() => new DreamRenderedExperimentExecutor({ produce: vi.fn() },
      { observe: vi.fn() }, [one, one], createDreamDecisionAuthority().issuer, policy,
      renderedEvidence.resolver))
      .toThrow('DREAM_EVALUATOR_INDEPENDENCE_REQUIRED');
    const executor = new DreamRenderedExperimentExecutor(
      { declaration, produce: vi.fn(async () => ({ baseline, variants: [{ ...variant,
        source: baseline.source }] })) }, { observe: vi.fn(async () => evidence) },
      [evaluator('1', '2'), evaluator('3', '4')],
      createDreamDecisionAuthority().issuer, policy, renderedEvidence.resolver);
    const plan = frozenExperiment();
    await expect(executor.execute({ ...plan, context: { ...plan.context,
      operatorDigest: declaration.declarationDigest, policyDigest: policy.policyDigest,
      evaluatorManifestDigests: [digest('1'), digest('3')] } }, async (_purpose, operation) =>
      operation())).rejects.toThrow('DREAM_REPLAY_REJECTED');
  });

  it('fails closed on undeclared confounding and structural substitutions', async () => {
    const plan = frozenExperiment();
    const run = (candidate: typeof variant) => new DreamRenderedExperimentExecutor(
      { declaration, produce: vi.fn(async () => ({ baseline, variants: [candidate] })) },
      { observe: vi.fn(async () => evidence) },
      [evaluator('1', '2'), evaluator('3', '4')],
      createDreamDecisionAuthority().issuer, policy, renderedEvidence.resolver).execute({ ...plan,
        context: { ...plan.context, operatorDigest: declaration.declarationDigest,
          policyDigest: policy.policyDigest, evaluatorManifestDigests: [digest('1'), digest('3')] },
      }, async (_purpose, operation) => operation());
    await expect(run({ ...variant, mutation: { ...variant.mutation,
      changedFactor: 'palette' } })).rejects.toThrow('DREAM_OPERATOR_FACTOR_CONFOUNDED');
    await expect(run({ ...variant, mutation: { ...variant.mutation,
      changedPaths: ['metadata.filename'] } })).rejects.toThrow('DREAM_STRUCTURAL_DIFF_UNDECLARED');
    await expect(run({ ...variant, mutation: { ...variant.mutation,
      protectedInvariantDigests: { ...variant.mutation.protectedInvariantDigests,
        palette: digest('0') } } })).rejects.toThrow('DREAM_PROTECTED_INVARIANT_CHANGED');
  });

  it('sends only anonymous independently ordered arms and freezes veto policy', async () => {
    const first = evaluator('1', '2');
    const second = evaluator('3', '4');
    const executor = new DreamRenderedExperimentExecutor(
      { declaration, produce: vi.fn(async () => ({ baseline, variants: [variant] })) },
      { observe: vi.fn(async () => evidence) }, [first, second],
      createDreamDecisionAuthority().issuer, policy, renderedEvidence.resolver);
    const plan = frozenExperiment();
    await executor.execute({ ...plan, context: { ...plan.context,
      operatorDigest: declaration.declarationDigest, policyDigest: policy.policyDigest,
      evaluatorManifestDigests: [digest('1'), digest('3')] } },
    async (_purpose, operation) => operation());
    const payloads = [first.compare.mock.calls[0][0], second.compare.mock.calls[0][0]];
    expect(payloads[0].arms.map((arm: { armId: string }) => arm.armId))
      .not.toEqual(payloads[1].arms.map((arm: { armId: string }) => arm.armId));
    expect(JSON.stringify(payloads)).not.toMatch(/baseline|variant|candidateId|"source"|"path"|"content"/i);
    expect(JSON.stringify(payloads)).not.toMatch(/artifactDigest|playableDigest|runtimeErrors/);
    expect(payloads[0].arms[0].evidence.pixelFrames[0].dataBase64).toBe('pixel-early');
    expect(Object.isFrozen(payloads[0].arms[0].evidence.pixelFrames)).toBe(true);
    expect(Object.isFrozen(payloads[0].arms[0].evidence.pixelFrames[0])).toBe(true);
    expect(payloads[0].policyDigest).toBe(policy.policyDigest);
  });

  it('cannot treat reconstructed or static evidence as rendered authority', async () => {
    const authority = createDreamRenderedEvidenceAuthority();
    const executor = new DreamRenderedExperimentExecutor(
      { declaration, produce: vi.fn(async () => ({ baseline, variants: [variant] })) },
      { observe: vi.fn(async () => ({ ...evidence })) },
      [evaluator('1', '2'), evaluator('3', '4')],
      createDreamDecisionAuthority().issuer, policy, authority.resolver);
    const plan = frozenExperiment();
    await expect(executor.execute({ ...plan, context: { ...plan.context,
      operatorDigest: declaration.declarationDigest, policyDigest: policy.policyDigest,
      evaluatorManifestDigests: [digest('1'), digest('3')] } },
    async (_purpose, operation) => operation()))
      .rejects.toThrow('DREAM_RENDERED_EVIDENCE_CAPABILITY_INVALID');
  });

  it('rehydrates only host-signed untampered rendered evidence after restart', () => {
    const secret = 'durable-rendered-evidence-secret';
    const first = createDreamRenderedEvidenceAuthority(secret);
    const signed = { ...evidence, frames: [...evidence.frames] };
    first.issuer.attest(signed);
    const rehydrated = JSON.parse(JSON.stringify(signed));
    expect(() => createDreamRenderedEvidenceAuthority(secret).resolver.assertAttested(rehydrated))
      .not.toThrow();
    expect(() => createDreamRenderedEvidenceAuthority('different-secret')
      .resolver.assertAttested(rehydrated))
      .toThrow('DREAM_RENDERED_EVIDENCE_CAPABILITY_INVALID');
    expect(() => createDreamRenderedEvidenceAuthority(secret).resolver.assertAttested({
      ...rehydrated, frames: [digest('0'), ...rehydrated.frames.slice(1)],
    })).toThrow('DREAM_RENDERED_EVIDENCE_CAPABILITY_INVALID');
  });

  it('rejects wrapper variation and multi-layer collapse before rendering', async () => {
    const plan = frozenExperiment();
    const run = (candidate: typeof variant) => new DreamRenderedExperimentExecutor(
      { declaration, produce: vi.fn(async () => ({ baseline, variants: [candidate] })) },
      { observe: vi.fn(async () => evidence) },
      [evaluator('1', '2'), evaluator('3', '4')], createDreamDecisionAuthority().issuer,
      policy, renderedEvidence.resolver).execute({ ...plan,
        context: { ...plan.context, operatorDigest: declaration.declarationDigest,
          policyDigest: policy.policyDigest, evaluatorManifestDigests: [digest('1'), digest('3')] },
        requiredModalities: ['visual', 'multi-layer'] },
      async (_purpose, operation) => operation());
    const wrapperSource = `<main>${baseline.source}</main>`;
    await expect(run({ ...variant, source: wrapperSource, mutation: { ...variant.mutation,
      creativeDeltaDigest: dreamCreativeDeltaDigest(
        baseline.source, wrapperSource, variant.mutation.changedPaths) } }))
      .rejects.toThrow('DREAM_WRAPPER_VARIATION_REJECTED');
    await expect(run({ ...variant, layerIds: ['a'], layerAblations: [] }))
      .rejects.toThrow('DREAM_LAYER_COLLAPSE_REJECTED');
  });

  it('applies frozen uncertainty and critical-regression vetoes', async () => {
    const plan = frozenExperiment();
    const run = async (first: ReturnType<typeof evaluator>,
      second: ReturnType<typeof evaluator>) => new DreamRenderedExperimentExecutor(
      { declaration, produce: vi.fn(async () => ({ baseline, variants: [variant] })) },
      { observe: vi.fn(async () => evidence) }, [first, second],
      createDreamDecisionAuthority().issuer, policy, renderedEvidence.resolver).execute({
        ...plan, context: { ...plan.context, operatorDigest: declaration.declarationDigest,
          policyDigest: policy.policyDigest,
          evaluatorManifestDigests: [first.identity.identityDigest, second.identity.identityDigest] },
      }, async (_purpose, operation) => operation());
    const uncertain = evaluator('1', '2');
    uncertain.compare.mockResolvedValue({ outcome: 'keeper', uncertainty: 0.9,
      criteria: [{ criterion: 'depth', evidenceDigest: digest('8'), direction: 'improved' }] });
    expect((await run(uncertain, evaluator('3', '4'))).comparison.outcome)
      .toBe('inconclusive');
    const regression = evaluator('5', '6');
    regression.compare.mockResolvedValue({ outcome: 'keeper', uncertainty: 0.1,
      criteria: [{ criterion: 'depth', evidenceDigest: digest('8'), direction: 'regressed' }] });
    expect((await run(regression, evaluator('7', '8'))).comparison.outcome)
      .toBe('rejected');
  });
});
