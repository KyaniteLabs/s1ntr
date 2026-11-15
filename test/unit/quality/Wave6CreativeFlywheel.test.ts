import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORMAL_RUN_ORDER,
  WAVE6_LANE_DEFINITIONS,
  aggregateWave6LaneReceipts,
  createWave6LiveEnvironment,
  evaluateWave6Experiment,
  hasCompleteWave6Evidence,
  normalizeWave6CoordinationScores,
  resumeWave6Lineage,
  type Wave6ExperimentEvidence,
  type Wave6Status,
} from '../../../src/quality/Wave6CreativeFlywheel.js';
import { StudioLineageLedger } from '../../../src/tui-bridge/StudioLineage.js';
import { createCoupledStudioArtifact } from '../../../src/composition/StudioControlRecipe.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';

const tempPaths: string[] = [];
const digest = (character: string) => character.repeat(64);
const artifactFixtureLayer = (domain: 'three' | 'shader') => ({
  domain,
  prompt: domain,
  blendMode: domain === 'shader' ? 'screen' as const : 'normal' as const,
  opacity: 1,
  codeLength: 1,
  generated: true,
});

function coupledArtifact(
  lane: 'p5-tone' | 'strudel-p5',
  sourceArtifactHtml: string,
  creativeThesis?: ReturnType<typeof compileCreativeThesis>,
) {
  const sourceDomain = lane === 'p5-tone' ? 'tone' : 'strudel';
  return createCoupledStudioArtifact(lane, {
    html: '<html></html>',
    title: lane,
    background: '#000',
    successCount: 2,
    creativeThesis,
    layers: [
      {
        domain: 'p5',
        prompt: 'visual',
        blendMode: 'normal',
        opacity: 1,
        codeLength: 1,
        generated: true,
        artifactHtml: '<html><body>p5</body></html>',
      },
      {
        domain: sourceDomain,
        prompt: 'audio',
        blendMode: 'normal',
        opacity: 1,
        codeLength: 1,
        generated: true,
        artifactHtml: sourceArtifactHtml,
      },
    ],
  });
}

function passingEvidence(): Wave6ExperimentEvidence {
  return {
    lane: 'p5-tone',
    lineageId: 'lineage-a',
    recipeDigest: digest('a'),
    artifactRecipeDigest: digest('a'),
    lineageRecipeDigest: digest('a'),
    evaluationRecipeDigest: digest('a'),
    causalRecipeDigest: digest('a'),
    configurationDigest: digest('b'),
    mutationPath: 'src/prompts/p5.ts',
    identities: {
      author: 'provider/sol-author',
      generator: 'provider/luna-generator',
      mutationReviewer: 'provider/sol-reviewer',
      creativeReviewer: 'provider/luna-blind',
    },
    runOrder: [...FORMAL_RUN_ORDER],
    pairs: [
      {
        trialId: '1',
        controlConfigurationDigest: digest('b'),
        treatmentConfigurationDigest: digest('b'),
        controlScore: 0.6,
        treatmentScore: 0.68,
        coordinationPass: true,
        technicalPass: true,
        blindPreference: 'treatment',
      },
      {
        trialId: '2',
        controlConfigurationDigest: digest('b'),
        treatmentConfigurationDigest: digest('b'),
        controlScore: 0.62,
        treatmentScore: 0.68,
        coordinationPass: true,
        technicalPass: true,
        blindPreference: 'treatment',
      },
      {
        trialId: '3',
        controlConfigurationDigest: digest('b'),
        treatmentConfigurationDigest: digest('b'),
        controlScore: 0.61,
        treatmentScore: 0.71,
        coordinationPass: false,
        technicalPass: true,
        blindPreference: 'control',
      },
    ],
    restoredFailure: {
      restored: true,
      quarantined: true,
      lane: 'p5-tone',
      lineageId: 'lineage-a',
      allowlistDigest: WAVE6_LANE_DEFINITIONS['p5-tone'].allowlistDigest,
      oracleDigest: digest('c'),
    },
    expectedOracleDigest: digest('c'),
    interventions: 1,
    creativeProofPass: true,
    cortexPass: true,
    lineageIntegrityPass: true,
    parentIntegrityPass: true,
    ownerDecision: 'treatment',
  };
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((entry) =>
    fs.rm(entry, { recursive: true, force: true })));
});

describe('Wave 6 frozen contract', () => {
  it('accepts reviewer metadata but keeps only sealed coordination scores', () => {
    const conditions = {
      baseline: { coherence: 0.8, technicalValidity: 1, creativeQuality: 0.7, tasteQuality: 0.6, reason: 'extra' },
      'signal-mutation': { coherence: 0.9, technicalValidity: 1, creativeQuality: 0.8, tasteQuality: 0.7 },
      'coupling-ablation': { coherence: 0.3, technicalValidity: 1, creativeQuality: 0.4, tasteQuality: 0.3 },
    };

    expect(normalizeWave6CoordinationScores(conditions)).toEqual({
      baseline: { coherence: 0.8, technicalValidity: 1, creativeQuality: 0.7, tasteQuality: 0.6 },
      'signal-mutation': { coherence: 0.9, technicalValidity: 1, creativeQuality: 0.8, tasteQuality: 0.7 },
      'coupling-ablation': { coherence: 0.3, technicalValidity: 1, creativeQuality: 0.4, tasteQuality: 0.3 },
    });
    expect(() => normalizeWave6CoordinationScores({
      ...conditions,
      baseline: { ...conditions.baseline, creativeQuality: 1.2 },
    })).toThrow('baseline.creativeQuality');
  });

  it('isolates live lane roles from stale ambient provider overrides', () => {
    const environment = createWave6LiveEnvironment({
      inherited: {
        PATH: '/bin',
        LIMINAL_LLM_PROVIDER: 'minimax',
        LIMINAL_LLM_BASE_URL: 'https://stale.example/v1',
        LIMINAL_LLM_MODEL: 'stale-model',
        LIMINAL_LLM_API_KEY: 'stale-key',
        LIMINAL_HARNESS_BASE_URL: 'https://stale-harness.example/v1',
        LIMINAL_EVALUATOR_MODEL: 'stale-evaluator',
      },
      configPath: '/tmp/wave6-config.json',
      lineagePath: '/tmp/wave6-lineage.jsonl',
      generator: {
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: 'gpt-5.6-luna',
        apiKey: 'lane-key',
      },
    });

    expect(environment).toMatchObject({
      PATH: '/bin',
      SINTER_CONFIG_PATH: '/tmp/wave6-config.json',
      LIMINAL_CONFIG_PATH: '/tmp/wave6-config.json',
      SINTER_STUDIO_LINEAGE_PATH: '/tmp/wave6-lineage.jsonl',
      LLM_PROVIDER: 'openai',
      LLM_BASE_URL: 'http://127.0.0.1:8317/v1',
      LLM_MODEL: 'gpt-5.6-luna',
      LLM_API_KEY: 'lane-key',
      LIMINAL_LLM_PROVIDER: 'openai',
      LIMINAL_LLM_BASE_URL: 'http://127.0.0.1:8317/v1',
      LIMINAL_LLM_MODEL: 'gpt-5.6-luna',
      LIMINAL_LLM_API_KEY: 'lane-key',
    });
    expect(environment.LIMINAL_HARNESS_BASE_URL).toBeUndefined();
    expect(environment.LIMINAL_EVALUATOR_MODEL).toBeUndefined();
  });

  it('keeps the Three scene visible while the shader receives real turbulence displacement', () => {
    const artifact = createCoupledStudioArtifact('three-shader', {
      html: '<html></html>',
      title: 'weather',
      background: '#000',
      successCount: 2,
      layers: [
        {
          domain: 'three',
          prompt: 'cathedral',
          blendMode: 'normal',
          opacity: 1,
          codeLength: 1,
          generated: true,
          artifactHtml: '<html><body>three</body></html>',
        },
        {
          domain: 'shader',
          prompt: 'weather',
          blendMode: 'screen',
          opacity: 1,
          codeLength: 1,
          generated: true,
          artifactHtml: '<html><body>shader</body></html>',
        },
      ],
    });
    expect(artifact.html).toContain('feTurbulence');
    expect(artifact.html).toContain('feDisplacementMap');
    expect(artifact.html).toContain('z-index:1');
    expect(artifact.html).toContain('z-index:2');
    const repeated = createCoupledStudioArtifact('three-shader', {
      html: '<html></html>',
      title: 'different generated work',
      background: '#111',
      successCount: 2,
      layers: [
        { ...artifactFixtureLayer('three'), artifactHtml: '<html><body>new three</body></html>' },
        { ...artifactFixtureLayer('shader'), artifactHtml: '<html><body>new shader</body></html>' },
      ],
    }, '2030-01-01T00:00:00.000Z');
    expect(repeated.recipeDigest).toBe(artifact.recipeDigest);
  });

  it('embeds verified thesis identity in coupled HTML and none for legacy artifacts', () => {
    const thesis = compileCreativeThesis('A restrained field opens into luminous release.');
    const governed = coupledArtifact('p5-tone', '<html><body>audio</body></html>', thesis);
    expect(governed.html).toContain(`data-creative-thesis-id="${thesis.thesisId}"`);
    expect(governed.html).toContain('data-creative-principle-id="contrast"');
    expect(governed.html).toContain('data-creative-contract-version="1"');
    expect(governed.html).toContain(`data-creative-projection-digest="${thesis.principles[0].contractIdentity.projectionDigest}"`);
    expect(coupledArtifact('p5-tone', '<html><body>audio</body></html>').html)
      .not.toContain('data-creative-thesis-id');
  });

  it('binds p5-tone to the generated Tone transport instead of a wall-clock simulation', () => {
    const artifact = coupledArtifact(
      'p5-tone',
      '<html><body><button>Start preview</button><script>Tone.Transport.start()</script></body></html>',
    );

    expect(artifact.html).toContain("sourceWindow.Tone.Transport.state !== 'started'");
    expect(artifact.html).toContain('sourceWindow.Tone.Transport.seconds');
    expect(artifact.html).toContain('sourceWindow.Tone.Transport.start()');
    expect(artifact.html).toContain("wave6SignalSource = 'tone-transport'");
    expect(artifact.html).not.toContain('let startedAt = Date.now()');
  });

  it('binds strudel-p5 to the generated Strudel audio clock and evaluates its editor', () => {
    const artifact = coupledArtifact(
      'strudel-p5',
      '<html><body><strudel-editor>bpm(120)</strudel-editor></body></html>',
    );

    expect(artifact.html).toContain('sourceWindow.getAudioContext().currentTime');
    expect(artifact.html).toContain('sourceDocument().querySelector');
    expect(artifact.html).toContain('editor.evaluate()');
    expect(artifact.html).toContain("wave6SignalSource = 'strudel-audio-clock'");
    expect(artifact.html).toContain('const beatSeconds = 60 / 120');
    expect(artifact.html).not.toContain('let startedAt = Date.now()');
  });

  it('freezes all three lanes, mappings, transport, and candidate allowlists', () => {
    expect(Object.keys(WAVE6_LANE_DEFINITIONS)).toEqual([
      'p5-tone',
      'three-shader',
      'strudel-p5',
    ]);
    expect(WAVE6_LANE_DEFINITIONS['p5-tone'].mapping).toEqual({
      scale: 0.5,
      offset: 0.5,
      clamp: [0.5, 1],
    });
    expect(WAVE6_LANE_DEFINITIONS['three-shader'].mapping).toEqual({
      scale: 0.8,
      offset: 0.2,
      clamp: [0.2, 1],
    });
    expect(WAVE6_LANE_DEFINITIONS['strudel-p5'].mapping).toEqual({
      scale: 80,
      offset: 10,
      clamp: [10, 90],
    });
    for (const definition of Object.values(WAVE6_LANE_DEFINITIONS)) {
      expect(definition.transport).toEqual({
        cadenceMs: 33,
        bufferSize: 4,
        staleAfterMs: 132,
        staleBehavior: 'hold',
      });
      expect(definition.allowlist).toHaveLength(3);
      expect(definition.allowlistDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('passes only complete causal evidence and chooses the mean-nearest owner pair', () => {
    const result = evaluateWave6Experiment(passingEvidence());
    expect(result.status).toBe('PASS');
    expect(result.meanEffect).toBeCloseTo(0.08);
    expect(result.ownerPairTrialId).toBe('1');
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it.each([
    ['recipe substitution', (input: Wave6ExperimentEvidence) => {
      input.evaluationRecipeDigest = digest('f');
    }],
    ['role overlap', (input: Wave6ExperimentEvidence) => {
      input.identities.creativeReviewer = input.identities.generator;
    }],
    ['case-only role overlap', (input: Wave6ExperimentEvidence) => {
      input.identities.creativeReviewer = input.identities.generator.toUpperCase();
    }],
    ['run reordering', (input: Wave6ExperimentEvidence) => {
      input.runOrder = ['T1', 'C1', 'T2', 'C2', 'C3', 'T3'];
    }],
    ['foreign restore', (input: Wave6ExperimentEvidence) => {
      input.restoredFailure.lineageId = 'other-lineage';
    }],
    ['sealed path mutation', (input: Wave6ExperimentEvidence) => {
      input.mutationPath = 'src/evaluation/CompositionEvaluator.ts';
    }],
    ['missing creative proof', (input: Wave6ExperimentEvidence) => {
      input.creativeProofPass = false;
    }],
    ['missing Cortex cycle', (input: Wave6ExperimentEvidence) => {
      input.cortexPass = false;
    }],
  ])('fails closed on %s', (_name, mutate) => {
    const input = passingEvidence();
    mutate(input);
    expect(evaluateWave6Experiment(input).status).toBe('FAIL');
  });

  it('keeps a causally passing lane pending until the owner decision exists', () => {
    const input = passingEvidence();
    delete input.ownerDecision;
    const result = evaluateWave6Experiment(input);
    expect(result.status).toBe('PENDING_OWNER');
    expect(result.checks.ownerAccepted).toBe(false);
  });

  it('closes only when all three distinct lanes pass', () => {
    const receipts = (Object.keys(WAVE6_LANE_DEFINITIONS) as Array<keyof typeof WAVE6_LANE_DEFINITIONS>)
      .map(lane => ({ lane, status: 'PASS' as Wave6Status, recipeDigest: digest('a') }));
    expect(aggregateWave6LaneReceipts(receipts).status).toBe('PASS');
    receipts[1].status = 'FAIL';
    expect(aggregateWave6LaneReceipts(receipts).status).toBe('FAIL');
    expect(() => aggregateWave6LaneReceipts(receipts.slice(0, 2))).toThrow('exactly three');
  });

  it('rejects PASS evidence unless every formal output is digest-bound', () => {
    const evidenceRefs = {
      formalArtifacts: FORMAL_RUN_ORDER.map(label => `run/${label}.html`),
      screenshots: FORMAL_RUN_ORDER.map(label => `run/${label}.png`),
      media: FORMAL_RUN_ORDER.map(label => `run/${label}.webm`),
    };
    const refs = Object.values(evidenceRefs).flat();
    const evidenceDigests = Object.fromEntries(refs.map(ref => [ref, digest('d')]));
    expect(hasCompleteWave6Evidence(evidenceRefs, evidenceDigests)).toBe(true);
    expect(hasCompleteWave6Evidence({}, {})).toBe(false);
    delete evidenceDigests[refs[0]];
    expect(hasCompleteWave6Evidence(evidenceRefs, evidenceDigests)).toBe(false);
  });

  it('resumes only a coupled lane with a matching recipe digest', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave6-lineage-'));
    tempPaths.push(dir);
    const artifactPath = path.join(dir, 'artifact.html');
    const artifactCode = '<html><body>coupled artifact</body></html>';
    const artifactCodeDigest = createHash('sha256').update(artifactCode).digest('hex');
    await fs.writeFile(artifactPath, artifactCode);
    const ledger = new StudioLineageLedger({ ledgerPath: path.join(dir, 'lineage.jsonl') });
    await ledger.start({
      lineageId: 'studio-1',
      sessionId: 'session-1',
      origin: 'studio',
      payload: { domain: 'html' },
    });
    await ledger.append('studio-1', {
      stage: 'artifact',
      status: 'observed',
      origin: 'studio-generator',
      trust: 'model-inference',
      payload: { artifactPath, codeDigest: artifactCodeDigest },
    });
    await ledger.append('studio-1', {
      stage: 'evaluation',
      status: 'observed',
      origin: 'studio-composition-contract',
      trust: 'verified-system',
      payload: {
        lane: 'p5-tone',
        recipeDigest: digest('a'),
        coupled: true,
      },
    });

    await expect(resumeWave6Lineage({
      lineageId: 'studio-1',
      lane: 'p5-tone',
      ledger,
    })).resolves.toMatchObject({
      lineageId: 'studio-1',
      lane: 'p5-tone',
      recipeDigest: digest('a'),
      artifactPath,
      artifactCode,
    });
    await expect(resumeWave6Lineage({
      lineageId: 'studio-1',
      lane: 'three-shader',
      ledger,
    })).rejects.toThrow('does not match requested lane');
    await fs.writeFile(artifactPath, '<html>tampered</html>');
    await expect(resumeWave6Lineage({
      lineageId: 'studio-1',
      lane: 'p5-tone',
      ledger,
    })).rejects.toThrow('artifact digest mismatch');
  });
});
