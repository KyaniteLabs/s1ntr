import { describe, expect, it } from 'vitest';
import {
  CompositionEngine,
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  createCompositionEvaluationGateReceipt,
  createMemoryFeedForwardGateReceipt,
  parseCompositionEvaluationGateReceipt,
  type ControlRecipe,
} from '../../../src/index.js';
import {
  COMPOSITION_EVIDENCE_DIMENSIONS,
  CompositionEvaluator,
  type CompositionEvaluationAttempt,
  type CompositionEvidenceMeasure,
} from '../../../src/evaluation/CompositionEvaluator.js';

function recipe(): ControlRecipe {
  return {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: CONTROL_RECIPE_VERSION,
    id: 'tone-p5-coupling',
    layers: [
      { id: 'sound', domain: 'tone', code: '', order: 0 },
      { id: 'visual', domain: 'p5', code: '', order: 1 },
    ],
    transport: {
      clock: 'interval',
      cadenceMs: 20,
      bufferSize: 2,
      staleAfterMs: 40,
      staleBehavior: 'error',
    },
    signals: [{ id: 'tone-amplitude', layerId: 'sound', type: 'number' }],
    targets: [{ id: 'p5-radius', layerId: 'visual', type: 'number' }],
    mappings: [{
      id: 'amplitude-to-radius',
      signalId: 'tone-amplitude',
      targetId: 'p5-radius',
      scale: 100,
      offset: 10,
      clamp: [10, 110],
    }],
    resources: [
      { id: 'tone-context', kind: 'audio-context', ownerLayerId: 'sound' },
      { id: 'p5-canvas', kind: 'canvas', ownerLayerId: 'visual' },
    ],
    lifecycle: {
      startOrder: ['sound', 'visual'],
      teardownOrder: ['visual', 'sound'],
    },
    audio: { unlock: 'user-gesture', ownerLayerId: 'sound' },
    lineage: {
      parentRecipeIds: ['w5-05-recipe'],
      createdAt: '2026-07-30T00:00:00.000Z',
    },
  };
}

const UNITS: Record<CompositionEvidenceMeasure['dimension'], string> = {
  technical: 'ratio',
  creative: 'ratio',
  taste: 'ratio',
  cost: 'usd',
  latency: 'ms',
  reliability: 'ratio',
  security: 'ratio',
  complexity: 'cyclomatic',
};
const MEASUREMENTS: Record<
  CompositionEvidenceMeasure['dimension'],
  [number, number]
> = {
  technical: [0.96, 0.9],
  creative: [0.82, 0.75],
  taste: [0.79, 0.72],
  cost: [0.0042, 0.005],
  latency: [18, 25],
  reliability: [0.99, 0.97],
  security: [1, 1],
  complexity: [7, 10],
};

function evidence(status: CompositionEvidenceMeasure['status'] = 'observed') {
  return COMPOSITION_EVIDENCE_DIMENSIONS.map(dimension => ({
    dimension,
    status,
    ...(status === 'observed' ? { value: MEASUREMENTS[dimension][0] } : {}),
    unit: UNITS[dimension],
    direction: ['cost', 'latency', 'complexity'].includes(dimension)
      ? 'lower-better' as const
      : 'higher-better' as const,
    baseline: MEASUREMENTS[dimension][1],
    sourceRef: `measurement:${dimension}`,
    ...(status === 'observed' ? {} : { missingReason: `${status} measurement` }),
  }));
}

function completeAttempt(): CompositionEvaluationAttempt {
  return {
    id: 'attempt-rendered',
    method: 'artifact-render-and-ablation',
    status: 'complete',
    mappingId: 'amplitude-to-radius',
    layers: [
      {
        layerId: 'sound',
        technicalValidity: 0.9,
        contribution: 0.8,
        compatibility: 0.9,
        necessity: 0.8,
      },
      {
        layerId: 'visual',
        technicalValidity: 0.9,
        contribution: 0.85,
        compatibility: 0.9,
        necessity: 0.8,
      },
    ],
    trials: [
      {
        condition: 'baseline',
        signalValue: 0.8,
        targetValue: 90,
        signalUnit: 'normalized-amplitude',
        targetUnit: 'px',
        whole: {
          coherence: 0.85,
          technicalValidity: 0.9,
          creativeQuality: 0.8,
          tasteQuality: 0.8,
        },
      },
      {
        condition: 'signal-mutation',
        signalValue: 0.1,
        targetValue: 20,
        signalUnit: 'normalized-amplitude',
        targetUnit: 'px',
        whole: {
          coherence: 0.3,
          technicalValidity: 0.8,
          creativeQuality: 0.3,
          tasteQuality: 0.3,
        },
      },
      {
        condition: 'coupling-ablation',
        signalValue: 0.8,
        targetValue: 10,
        signalUnit: 'normalized-amplitude',
        targetUnit: 'px',
        whole: {
          coherence: 0.25,
          technicalValidity: 0.8,
          creativeQuality: 0.25,
          tasteQuality: 0.25,
        },
      },
    ],
    evidence: evidence(),
  };
}

function prerequisite(downstreamChanged = true) {
  const base = (injected: boolean) => ({
    lineageId: injected ? 'treatment-run' : 'control-run',
    sessionId: injected ? 'treatment-session' : 'control-session',
    contextDigest: injected ? 'treatment-context' : 'control-context',
    requestDigest: injected ? 'treatment-request' : 'control-request',
    artifactDigest: injected ? 'treatment-artifact' : 'control-artifact',
    injected,
    sourceEpisodeIds: injected ? ['episode-one'] : [],
    tainted: injected,
  });
  return createMemoryFeedForwardGateReceipt({
    generatedAt: '2026-07-30T00:00:00.000Z',
    promptDigest: 'prompt-digest',
    control: base(false),
    treatment: base(true),
    checks: {
      controlUninjected: true,
      treatmentInjected: true,
      exactDigestStamped: true,
      sourceLinked: true,
      requestChanged: true,
      downstreamChanged,
      taintPreserved: true,
    },
    evidenceRefs: ['lineage:control-run', 'lineage:treatment-run'],
  });
}

describe('CompositionEvaluator', () => {
  it('proves layers, signal mutation, coupling ablation, and whole-work change', () => {
    const result = new CompositionEvaluator().evaluate(recipe(), [completeAttempt()]);

    expect(result.outcome).toBe('PASS');
    expect(result.terminal).toBe(true);
    expect(result.layers.map(layer => layer.verdict)).toEqual(['PASS', 'PASS']);
    expect(result.whole.map(item => item.verdict)).toEqual(['PASS', 'FAIL', 'FAIL']);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.evidence.map(item => item.unit)).toEqual(
      COMPOSITION_EVIDENCE_DIMENSIONS.map(dimension => UNITS[dimension]),
    );
  });

  it('is integrated with the loaded CompositionEngine control recipe', () => {
    const engine = new CompositionEngine();
    engine.loadControlRecipe(recipe());

    expect(engine.evaluateControlRecipe([completeAttempt()]).outcome).toBe('PASS');
  });

  it('fails when signal mutation does not change the target and whole verdict', () => {
    const attempt = completeAttempt();
    const baseline = attempt.trials![0];
    attempt.trials![1] = {
      ...attempt.trials![1],
      targetValue: baseline.targetValue,
      whole: { ...baseline.whole },
    };
    const result = new CompositionEvaluator().evaluate(recipe(), [attempt]);

    expect(result.outcome).toBe('FAIL');
    expect(result.checks.mutationChangesTarget).toBe(false);
    expect(result.checks.mutationChangesWholeVerdict).toBe(false);
  });

  it('fails when coupling ablation changes the source signal', () => {
    const attempt = completeAttempt();
    attempt.trials![2] = { ...attempt.trials![2], signalValue: 0.4 };
    const result = new CompositionEvaluator().evaluate(recipe(), [attempt]);

    expect(result.outcome).toBe('FAIL');
    expect(result.checks.ablationPreservesSignal).toBe(false);
  });

  it('retains missing evidence semantics without treating them as observed', () => {
    const attempt = completeAttempt();
    attempt.evidence = evidence();
    attempt.evidence[4] = {
      ...attempt.evidence[4],
      status: 'missing',
      value: undefined,
      missingReason: 'render clock unavailable',
    };
    const result = new CompositionEvaluator().evaluate(recipe(), [attempt]);

    expect(result.outcome).toBe('FAIL');
    expect(result.checks.evidenceContractComplete).toBe(false);
    expect(result.evidence[4]).toMatchObject({
      dimension: 'latency',
      status: 'missing',
      unit: 'ms',
      direction: 'lower-better',
      baseline: 25,
      missingReason: 'render clock unavailable',
    });
  });

  it('permits one retry, then records a terminal residual after a distinct attempt', () => {
    const first: CompositionEvaluationAttempt = {
      id: 'attempt-one',
      method: 'browser-render',
      status: 'failed',
      reason: 'browser crashed',
      evidence: evidence('failed'),
    };
    const second: CompositionEvaluationAttempt = {
      id: 'attempt-two',
      method: 'trace-replay',
      status: 'unavailable',
      reason: 'trace was not captured',
      evidence: evidence('unavailable'),
    };
    const evaluator = new CompositionEvaluator();

    expect(evaluator.evaluate(recipe(), [first]).outcome).toBe('RETRY_ALLOWED');
    const result = evaluator.evaluate(recipe(), [first, second]);
    expect(result.outcome).toBe('RESIDUAL');
    expect(result.terminal).toBe(true);
    expect(result.evidence.every(item => item.status === 'unavailable')).toBe(true);
  });

  it('enforces the two-attempt budget and a distinct second method', () => {
    const failed = (id: string, method: string): CompositionEvaluationAttempt => ({
      id,
      method,
      status: 'failed',
      reason: 'measurement failed',
      evidence: evidence('failed'),
    });
    const evaluator = new CompositionEvaluator();

    expect(() => evaluator.evaluate(recipe(), [
      failed('one', 'render'),
      failed('two', 'render'),
    ])).toThrow('distinct method');
    expect(() => evaluator.evaluate(recipe(), [
      failed('one', 'render'),
      failed('two', 'replay'),
      failed('three', 'static'),
    ])).toThrow('one or two attempts');
  });

  it.each([
    ['stale transport', (item: ControlRecipe) => { item.transport.staleAfterMs = 20; }],
    ['malformed transform', (item: ControlRecipe) => { item.mappings[0].scale = Number.NaN; }],
    ['reversed endpoint', (item: ControlRecipe) => {
      item.mappings[0].signalId = 'p5-radius';
    }],
    ['disconnected graph', (item: ControlRecipe) => { item.mappings = []; }],
    ['incompatible ports', (item: ControlRecipe) => { item.targets[0].type = 'string'; }],
  ])('rejects %s before evaluation', (_name, corrupt) => {
    const item = recipe();
    corrupt(item);

    expect(() => new CompositionEvaluator().evaluate(item, [completeAttempt()])).toThrow();
  });

  it('binds W5-03 and W5-06 evidence into a tamper-evident PASS receipt', () => {
    const evaluation = new CompositionEvaluator().evaluate(recipe(), [completeAttempt()]);
    const receipt = createCompositionEvaluationGateReceipt({
      generatedAt: '2026-07-30T00:00:00.000Z',
      prerequisite: prerequisite(),
      evaluation,
      evidenceRefs: ['recipe:tone-p5-coupling', 'attempt:attempt-rendered'],
    });

    expect(receipt.outcome).toBe('PASS');
    expect(parseCompositionEvaluationGateReceipt(receipt)).toEqual(receipt);
    expect(() => parseCompositionEvaluationGateReceipt({
      ...receipt,
      evidenceRefs: ['tampered'],
    })).toThrow('digest mismatch');
  });

  it('cannot claim the W5-06 gate when the composition evidence fails', () => {
    const attempt = completeAttempt();
    attempt.trials![2] = { ...attempt.trials![2], signalValue: 0.2 };
    const receipt = createCompositionEvaluationGateReceipt({
      generatedAt: '2026-07-30T00:00:00.000Z',
      prerequisite: prerequisite(),
      evaluation: new CompositionEvaluator().evaluate(recipe(), [attempt]),
      evidenceRefs: [],
    });

    expect(receipt.outcome).toBe('FAIL');
    expect(receipt.checks.compositionEvaluationPass).toBe(false);
  });

  it('cannot claim W5-06 without the W5-03 prerequisite', () => {
    const receipt = createCompositionEvaluationGateReceipt({
      generatedAt: '2026-07-30T00:00:00.000Z',
      prerequisite: prerequisite(false),
      evaluation: new CompositionEvaluator().evaluate(recipe(), [completeAttempt()]),
      evidenceRefs: [],
    });

    expect(receipt.outcome).toBe('FAIL');
    expect(receipt.checks.memoryFeedForwardPass).toBe(false);
  });
});
