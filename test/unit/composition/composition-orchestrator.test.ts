import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

// Mock at the boundaries: the generator registry (external generation) and the
// HTML wrapper. vi.hoisted is mandatory — vi.mock factories are hoisted above consts.
const mocks = vi.hoisted(() => {
  return {
    entries: [] as Array<{ name: string; generate: (p: string) => Promise<string> | string }>,
    registerAllGenerators: vi.fn(async () => {}),
    wrapCalls: [] as Array<{ domain?: string; compositionForeground?: boolean } | undefined>,
    gateEnabled: vi.fn(() => false),
    measureCompositeHtml: vi.fn(),
    verdictFromMeasure: vi.fn(),
    layersToDemote: vi.fn(),
  };
});

vi.mock('../../../src/generators/GeneratorRegistry.js', () => ({
  generatorRegistry: { getAll: () => mocks.entries },
}));
vi.mock('../../../src/generators/registerGenerators.js', () => ({
  registerAllGenerators: mocks.registerAllGenerators,
}));
vi.mock('../../../src/utils/htmlWrapper.js', () => ({
  HTMLWrapper: { wrap: (code: string, opts: { domain?: string; compositionForeground?: boolean }) => {
    mocks.wrapCalls.push(opts);
    return `<html data-d="${opts?.domain}">${code}</html>`;
  } },
}));
vi.mock('../../../src/composition/CompositeRenderGate.js', () => ({
  gateEnabled: mocks.gateEnabled,
  measureCompositeHtml: mocks.measureCompositeHtml,
  verdictFromMeasure: mocks.verdictFromMeasure,
  layersToDemote: mocks.layersToDemote,
  DEMOTED_OPACITY_FACTOR: 0.7,
}));

import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';
import { LLMClient, LLMTimeoutError } from '../../../src/llm/LLMClient.js';
import { exceedsWashoutBudget } from '../../../src/composition/BlendBudget.js';
import { extractLayerHtml } from '../../../src/composition/LayerPngExporter.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { lowerCompositionGraphForExecution, planCompositionGraph,
} from '../../../src/composition/CompositionGraph.js';

// The measured render gate launches headless Chrome — out of scope for every
// unit test in this file (covered by the CompositeRenderGate suite + probe).
beforeEach(() => {
  process.env.SINTER_COMPOSITE_GATE = '0';
});
afterEach(() => {
  delete process.env.SINTER_COMPOSITE_GATE;
  mocks.gateEnabled.mockReturnValue(false);
  vi.clearAllMocks();
});

describe('CompositionOrchestrator.compose', () => {
  beforeEach(() => {
    mocks.entries = [
      { name: 'shader', generate: async () => 'precision highp float; void main(){gl_FragColor=vec4(1.0);}' },
      { name: 'p5', generate: async () => 'function setup(){} function draw(){clear();}' },
      { name: 'tone', generate: async () => 'const s=new Tone.Synth().toDestination();' },
    ];
    mocks.registerAllGenerators.mockClear();
    mocks.wrapCalls = [];
  });

  it('throws when no layers are given', async () => {
    await expect(CompositionOrchestrator.compose({ layers: [] })).rejects.toThrow(/at least one layer/);
  });

  it('generates each layer and assembles one stacked, blended composite', async () => {
    const result = await CompositionOrchestrator.compose({
      title: 'Test Work',
      layers: [
        { domain: 'shader', prompt: 'a nebula', blendMode: 'normal', opacity: 1 },
        { domain: 'p5', prompt: 'fireflies', blendMode: 'screen', opacity: 0.9 },
      ],
    });

    expect(result.successCount).toBe(2);
    expect(result.layers).toHaveLength(2);
    // Two stacked layer iframes, with z-order increasing.
    expect((result.html.match(/class="sinter-layer"/g) ?? []).length).toBe(2);
    expect(result.html).toContain('z-index:1');
    expect(result.html).toContain('z-index:2');
    // The screen blend + opacity from the second layer are applied.
    expect(result.html).toContain('mix-blend-mode:screen');
    expect(result.html).toContain('opacity:0.9');
    expect(result.html).toContain("event.data.type !== 'sinter:input'");
    expect(result.html).toContain("postMessage({ type: 'sinter:state'");
    const foreground = extractLayerHtml(result.html, 1);
    expect(foreground).toContain('window.sinterCompositionState');
    expect(foreground).toContain("CustomEvent('sinter:state'");
    // Title is reflected in the document.
    expect(result.html).toContain('Test Work');
    // No audio layer → no start overlay.
    expect(result.html).not.toContain('sinter-start');
  });

  it('routes graph control values into downstream layer runtime output', async () => {
    const graph = {
      schema: 'sinter.composition-graph' as const, schemaVersion: '2.0' as const,
      status: 'ready' as const, id: 'causal-pair',
      budgets: { maxNodes: 2, maxEdges: 2, maxProviderCalls: 2 },
      nodes: [
        { id: 'source', type: 'layer' as const, layer: { domain: 'shader' as const, prompt: 'source' } },
        { id: 'target', type: 'layer' as const,
          layer: { domain: 'p5' as const, prompt: 'target', opacity: 0 } },
      ],
      edges: [{ id: 'before', type: 'before' as const, from: 'source', to: 'target' }],
      controls: [{ id: 'energy',
        from: { nodeId: 'source', port: 'causal-output', type: 'number' as const },
        to: { nodeId: 'target', port: 'causal-input', type: 'number' as const } }],
    };
    const spec = lowerCompositionGraphForExecution(planCompositionGraph(graph));
    const result = await CompositionOrchestrator.compose(spec);

    expect(result.html).toContain("type: 'sinter:causal'");
    expect(result.html).toContain(
      'var causalControls = [{"id":"energy","from":0,"to":1,"scale":1,"offset":0}];',
    );
    expect(result.html).toContain('target.style.opacity = String(base * (0.7 + transformed * 0.3))');
    expect(result.html).toContain('data-base-opacity="0"');
    expect(result.html).toContain('Number.isFinite(declaredBase) ? declaredBase : 1');
    const target = extractLayerHtml(result.html, 1);
    expect(target).toContain('window.sinterCausalInput');
    expect(target).toContain("CustomEvent('sinter:causal'");
    expect(result.graphExecution?.controls).toEqual(['energy']);
  });

  it('rejects graph controls the production runtime cannot materialize', async () => {
    const graph = {
      schema: 'sinter.composition-graph' as const, schemaVersion: '2.0' as const,
      status: 'ready' as const, id: 'unsupported-control',
      budgets: { maxNodes: 2, maxEdges: 1, maxProviderCalls: 2 },
      nodes: [
        { id: 'source', type: 'layer' as const, layer: { domain: 'shader' as const, prompt: 'source' } },
        { id: 'target', type: 'layer' as const, layer: { domain: 'p5' as const, prompt: 'target' } },
      ],
      edges: [{ id: 'before', type: 'before' as const, from: 'source', to: 'target' }],
      controls: [{ id: 'metadata',
        from: { nodeId: 'source', port: 'label', type: 'string' as const },
        to: { nodeId: 'target', port: 'caption', type: 'string' as const } }],
    };
    const spec = lowerCompositionGraphForExecution(planCompositionGraph(graph));
    await expect(CompositionOrchestrator.compose(spec)).rejects.toThrow(
      'Composition control metadata is not supported by the production runtime',
    );
  });

  it('accepts only parent-authenticated, closed-schema shared state at runtime', async () => {
    const result = await CompositionOrchestrator.compose({ layers: [
      { domain: 'shader', prompt: 'base' }, { domain: 'p5', prompt: 'subject' },
    ] });
    const dom = new JSDOM(extractLayerHtml(result.html, 1), { runScripts: 'dangerously' });
    const layerWindow = dom.window as unknown as Window & { sinterCompositionState: unknown };
    const initial = structuredClone(layerWindow.sinterCompositionState);
    const valid = { time: 2, sequence: 3, pointer: { x: 0.25, y: 0.75, down: true } };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'sinter:state', state: valid }, source: null,
    }));
    expect(layerWindow.sinterCompositionState).toEqual(initial);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'sinter:state', state: { ...valid, time: -1 } }, source: layerWindow,
    }));
    expect(layerWindow.sinterCompositionState).toEqual(initial);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'sinter:state', state: valid }, source: layerWindow,
    }));
    expect(layerWindow.sinterCompositionState).toEqual(valid);
    dom.window.close();
  });

  it('carries the canonical thesis identity into generation prompts and rendered output', async () => {
    const seen: string[] = [];
    mocks.entries = [{ name: 'p5', generate: async (prompt: string) => { seen.push(prompt); return 'function draw(){clear();}'; } }];
    const creativeThesis = compileCreativeThesis('A restrained field opens into luminous release.');
    const result = await CompositionOrchestrator.compose({ creativeThesis, layers: [{ domain: 'p5', prompt: 'focal field' }] });
    expect(seen[0]).toContain(`thesisId=${creativeThesis.thesisId}`);
    expect(result.html).toContain(creativeThesis.thesisId);
    expect(result.creativeThesis?.thesisId).toBe(creativeThesis.thesisId);
  });

  it('uses one thesis identity for deterministic audio evidence, wrappers, and composition metadata', async () => {
    const creativeThesis = compileCreativeThesis(
      'Music with expressive dynamics, shaped timbre, and a luminous visual field.',
      { requestedPrinciples: ['music-dynamics'] },
    );
    const result = await CompositionOrchestrator.compose({
      creativeThesis,
      layers: [
        { domain: 'p5', prompt: 'luminous visual field', code: 'function draw(){clear();}' },
        { domain: 'music', prompt: 'expressive dynamics with shaped timbre' },
      ],
    });

    expect(result.audioEvidence?.[0].provenance.thesisId).toBe(creativeThesis.thesisId);
    expect(result.layers[1].artifactHtml).toContain(creativeThesis.thesisId);
    expect(result.creativeThesis?.thesisId).toBe(creativeThesis.thesisId);
  });

  it.each(['tone', 'strudel'] as const)(
    'routes %s through the governed artifact path without reserving a provider call',
    async (domain) => {
      const genericGenerate = vi.fn(async () => 'ungoverned provider output');
      mocks.entries = [{ name: domain, generate: genericGenerate }];
      const creativeThesis = compileCreativeThesis(
        'Music with expressive audio dynamics.',
        { requestedPrinciples: ['music-dynamics'] },
      );
      const result = await CompositionOrchestrator.compose({
        creativeThesis,
        maxProviderCalls: 0,
        layers: [{ domain, prompt: 'expressive audio dynamics', code: 'ungoverned supplied audio code' }],
      });

      expect(genericGenerate).not.toHaveBeenCalled();
      expect(result.successCount).toBe(1);
      expect(result.audioEvidence?.[0].provenance.thesisId).toBe(creativeThesis.thesisId);
      expect(result.layers[0].artifactHtml).toContain(result.audioEvidence?.[0].artifactDigest);
      expect(result.layers[0].artifactHtml).not.toContain('ungoverned supplied audio code');
    },
  );

  it.each(['tone', 'strudel'] as const)(
    'uses the frozen provider stage for governed %s generation',
    async (domain) => {
      const generate = vi.fn(async () => 'governed audio code');
      mocks.entries = [{ name: domain, generate }];
      const creativeThesis = compileCreativeThesis(
        'Music with expressive audio dynamics.',
        { requestedPrinciples: ['music-dynamics'] },
      );
      const runProviderStage = vi.fn(async (_input, operation: () => Promise<unknown>) => operation());
      const result = await CompositionOrchestrator.compose({
        creativeThesis, maxProviderCalls: 1,
        executionPlan: {
          graphId: 'governed-audio', nodes: [{ id: 'audio', sourceIndex: 0,
            layer: { domain, prompt: 'expressive audio dynamics' }, phaseId: 'phase-implicit' }],
          schedule: ['audio'], groups: [], scenes: [],
          phases: [{ id: 'phase-implicit', order: -1, nodeIds: ['audio'] }], controls: [],
          resources: [], timingIslands: [], bridges: [], retry: { maxAttempts: 1 },
          lifecycle: { teardownOrder: ['audio'], cancelBehavior: 'teardown', teardownRequired: false },
        },
        generationContext: { runId: 'campaign', candidateId: 'audio',
          ledger: { beginPrimary: vi.fn(), failureProjection: vi.fn() } as never,
          runProviderStage },
        layers: [{ domain, prompt: 'expressive audio dynamics' }],
      });

      expect(runProviderStage).toHaveBeenCalledOnce();
      expect(generate).toHaveBeenCalledOnce();
      expect(generate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        useGeneratorTools: false,
        coordinatorManagedRecovery: true,
      }));
      expect(result.layers[0].codeLength).toBe('governed audio code'.length);
    },
  );

  it('uses the separately admitted graph recovery after one governed call fails', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error('transient empty artifact'))
      .mockResolvedValueOnce('function setup(){} function draw(){clear();}');
    mocks.entries = [{ name: 'p5', generate }];
    const primary = { runId: 'campaign', candidateId: 'visual', attemptId: 'primary',
      attemptOrdinal: 1, domain: 'p5', emit: vi.fn() };
    const recovery = { ...primary, attemptId: 'recovery', attemptOrdinal: 2,
      recoveryOfAttemptId: 'primary' };
    const runProviderStage = vi.fn(async (_input, operation: () => Promise<unknown>) => operation());
    const result = await CompositionOrchestrator.compose({
      maxProviderCalls: 1,
      executionPlan: {
        graphId: 'governed-retry', nodes: [{ id: 'visual', sourceIndex: 0,
          layer: { domain: 'p5', prompt: 'calm field' }, phaseId: 'phase-implicit' }],
        schedule: ['visual'], groups: [], scenes: [],
        phases: [{ id: 'phase-implicit', order: -1, nodeIds: ['visual'] }], controls: [],
        resources: [], timingIslands: [], bridges: [], retry: { maxAttempts: 2 },
        lifecycle: { teardownOrder: ['visual'], cancelBehavior: 'teardown', teardownRequired: false },
      },
      generationContext: {
        runId: 'campaign', candidateId: 'visual',
        ledger: { beginPrimary: vi.fn(async () => primary),
          reserveRecovery: vi.fn(async () => ({ granted: true, context: recovery })),
          failureProjection: vi.fn() } as never,
        runProviderStage,
      },
      layers: [{ domain: 'p5', prompt: 'calm field' }],
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(runProviderStage.mock.calls.map(([input]) => input)).toEqual([
      { nodeId: 'visual', attempt: 1 }, { nodeId: 'visual', attempt: 2 },
    ]);
    expect(generate.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ useGeneratorTools: false,
        coordinatorManagedRecovery: true, attemptTelemetry: primary }),
      expect.objectContaining({ useGeneratorTools: false,
        coordinatorManagedRecovery: true, attemptTelemetry: recovery }),
    ]);
    expect(result.successCount).toBe(1);
  });

  it('does not expand an unsigned planned graph provider-call cap for retries', async () => {
    const provider = {
      name: 'test-provider', getModel: vi.fn(() => 'test-model'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://provider.invalid/v1', model: 'test-model' })),
      generate: vi.fn().mockRejectedValueOnce(new Error('transient empty artifact'))
        .mockResolvedValue({ isErr: () => false,
          value: { success: true, content: 'function setup(){} function draw(){clear();}' } }),
    };
    const client = new LLMClient({ baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKey: 'fake' });
    vi.spyOn(client as any, 'resolveModel').mockResolvedValue('test-model');
    vi.spyOn(client as any, 'getProvider').mockResolvedValue(provider);
    mocks.entries = [{ name: 'p5', generate: async (prompt: string) =>
      (await client.generate('sys', prompt, undefined, true)).code }];
    const primary = { runId: 'campaign', candidateId: 'visual', attemptId: 'primary',
      attemptOrdinal: 1, domain: 'p5', emit: vi.fn() };
    const previousRetries = process.env.SINTER_LLM_MAX_RETRIES;
    process.env.SINTER_LLM_MAX_RETRIES = '0';
    try {
      const result = await CompositionOrchestrator.compose({
        maxProviderCalls: 1,
        executionPlan: {
          graphId: 'unsigned-retry', nodes: [{ id: 'visual', sourceIndex: 0,
            layer: { domain: 'p5', prompt: 'calm field' }, phaseId: 'phase-implicit' }],
          schedule: ['visual'], groups: [], scenes: [],
          phases: [{ id: 'phase-implicit', order: -1, nodeIds: ['visual'] }], controls: [],
          resources: [], timingIslands: [], bridges: [], retry: { maxAttempts: 2 },
          lifecycle: { teardownOrder: ['visual'], cancelBehavior: 'teardown', teardownRequired: false },
        },
        generationContext: {
          runId: 'campaign', candidateId: 'visual',
          ledger: { beginPrimary: vi.fn(async () => primary),
            reserveRecovery: vi.fn(async () => ({ granted: true, context: {
              ...primary, attemptId: 'recovery', attemptOrdinal: 2,
            } })), failureProjection: vi.fn() } as never,
        },
        layers: [{ domain: 'p5', prompt: 'calm field' }],
      });
      expect(provider.generate).toHaveBeenCalledOnce();
      expect(result.successCount).toBe(0);
      expect(result.graphExecution?.status).toBe('failed');
    } finally {
      if (previousRetries === undefined) delete process.env.SINTER_LLM_MAX_RETRIES;
      else process.env.SINTER_LLM_MAX_RETRIES = previousRetries;
    }
  });

  it('rejects a governed provider stage without an execution plan', async () => {
    await expect(CompositionOrchestrator.compose({
      layers: [{ domain: 'tone', prompt: 'expressive audio dynamics' }],
      generationContext: {
        runId: 'campaign', candidateId: 'audio',
        ledger: { beginPrimary: vi.fn(), failureProjection: vi.fn() } as never,
        runProviderStage: vi.fn(),
      },
    })).rejects.toThrow('governed provider stages require an execution plan');
  });

  it('adds a start overlay and an invisible frame for audio layers', async () => {
    const result = await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'a nebula' },
        { domain: 'tone', prompt: 'ambient pad' },
      ],
    });
    expect(result.successCount).toBe(2);
    expect(result.html).toContain('sinter-start');
    // Audio frame is rendered 1px/invisible rather than full-stage.
    expect(result.html).toContain('width:1px;height:1px;opacity:0');
  });

  it('marks non-base visual layers as composition foreground when wrapping them', async () => {
    mocks.entries = [
      { name: 'shader', generate: async () => 'void main(){gl_FragColor=vec4(1.0);}' },
      { name: 'ascii', generate: async () => ' /\\\n/__\\' },
    ];
    await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'paper wash' },
        { domain: 'ascii', prompt: 'constellation text' },
      ],
    });

    expect(mocks.wrapCalls[0]?.compositionForeground).toBe(false);
    expect(mocks.wrapCalls[1]?.compositionForeground).toBe(true);
  });

  it('degrades gracefully when a layer generator throws', async () => {
    mocks.entries = [
      { name: 'shader', generate: async () => 'void main(){}' },
      { name: 'p5', generate: async () => { throw new Error('LLM unavailable'); } },
    ];
    const result = await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'bg' },
        { domain: 'p5', prompt: 'particles' },
      ],
    });
    expect(result.successCount).toBe(1);
    expect(result.layers[1].generated).toBe(false);
    expect(result.layers[1].error).toBe('LLM unavailable');
    // Only the successful layer appears in the stack.
    expect((result.html.match(/class="sinter-layer"/g) ?? []).length).toBe(1);
  });

  it('records an unsupported-domain error without crashing', async () => {
    const result = await CompositionOrchestrator.compose({
      layers: [{ domain: 'video', prompt: 'clip' }],
    });
    expect(result.successCount).toBe(0);
    expect(result.layers[0].generated).toBe(false);
    expect(result.layers[0].error).toMatch(/unsupported layer domain: video/);
  });

  it('caps real provider attempts across multiple generated layers', async () => {
    const provider = {
      name: 'test-provider',
      getModel: vi.fn(() => 'test-model'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://provider.invalid/v1', model: 'test-model' })),
      generate: vi.fn(async () => ({ isErr: () => false, value: { success: true, content: 'function draw(){clear();}' } })),
    };
    const client = new LLMClient({ baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKey: 'fake' });
    vi.spyOn(client as any, 'resolveModel').mockResolvedValue('test-model');
    vi.spyOn(client as any, 'getProvider').mockResolvedValue(provider);
    mocks.entries = [{ name: 'p5', generate: async (prompt: string) => (await client.generate('sys', prompt, undefined, true)).code }];

    const result = await CompositionOrchestrator.compose({
      maxProviderCalls: 1,
      layers: [{ domain: 'p5', prompt: 'layer one' }, { domain: 'p5', prompt: 'layer two' }],
    });

    expect(provider.generate).toHaveBeenCalledOnce();
    expect(result.successCount).toBe(1);
    expect(result.layers.filter(layer => layer.generated)).toHaveLength(1);
  });

  it('blocks a retry before its provider attempt when the graph budget is exhausted', async () => {
    const provider = {
      name: 'test-provider',
      getModel: vi.fn(() => 'test-model'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://provider.invalid/v1', model: 'test-model' })),
      generate: vi.fn()
        .mockRejectedValueOnce(new LLMTimeoutError('test-provider'))
        .mockResolvedValue({ isErr: () => false, value: { success: true, content: 'function draw(){clear();}' } }),
    };
    const client = new LLMClient({ baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKey: 'fake' });
    vi.spyOn(client as any, 'resolveModel').mockResolvedValue('test-model');
    vi.spyOn(client as any, 'getProvider').mockResolvedValue(provider);
    mocks.entries = [{ name: 'p5', generate: async (prompt: string) => (await client.generate('sys', prompt, undefined, true)).code }];
    const previousRetries = process.env.SINTER_LLM_MAX_RETRIES;
    const previousDelay = process.env.SINTER_LLM_RETRY_BASE_DELAY_MS;
    process.env.SINTER_LLM_MAX_RETRIES = '1';
    process.env.SINTER_LLM_RETRY_BASE_DELAY_MS = '0';

    try {
      const result = await CompositionOrchestrator.compose({
        maxProviderCalls: 1,
        layers: [{ domain: 'p5', prompt: 'retrying layer' }],
      });
      expect(provider.generate).toHaveBeenCalledOnce();
      expect(result.successCount).toBe(0);
      expect(result.layers[0].error).toContain('provider-call budget exhausted');
    } finally {
      if (previousRetries === undefined) delete process.env.SINTER_LLM_MAX_RETRIES;
      else process.env.SINTER_LLM_MAX_RETRIES = previousRetries;
      if (previousDelay === undefined) delete process.env.SINTER_LLM_RETRY_BASE_DELAY_MS;
      else process.env.SINTER_LLM_RETRY_BASE_DELAY_MS = previousDelay;
    }
  });

  it('allows arbitrary generated layers while attempts remain within budget', async () => {
    const provider = {
      name: 'test-provider',
      getModel: vi.fn(() => 'test-model'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://provider.invalid/v1', model: 'test-model' })),
      generate: vi.fn(async () => ({ isErr: () => false, value: { success: true, content: 'function draw(){clear();}' } })),
    };
    const client = new LLMClient({ baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKey: 'fake' });
    vi.spyOn(client as any, 'resolveModel').mockResolvedValue('test-model');
    vi.spyOn(client as any, 'getProvider').mockResolvedValue(provider);
    mocks.entries = [{ name: 'p5', generate: async (prompt: string) => (await client.generate('sys', prompt, undefined, true)).code }];

    const result = await CompositionOrchestrator.compose({
      maxProviderCalls: 3,
      layers: Array.from({ length: 3 }, (_, index) => ({ domain: 'p5' as const, prompt: `layer ${index}` })),
    });

    expect(provider.generate).toHaveBeenCalledTimes(3);
    expect(result.successCount).toBe(3);
  });
});

describe('CompositionOrchestrator measured render gate', () => {
  beforeEach(() => {
    mocks.entries = [
      { name: 'shader', generate: async () => 'void main(){gl_FragColor=vec4(1.0);}' },
      { name: 'p5', generate: async () => 'function draw(){clear();circle(1,1,1);}' },
    ];
    mocks.gateEnabled.mockReturnValue(true);
  });

  it('keeps a measured ok composite unchanged', async () => {
    const measure = { meanLuminance: 0.4, brightnessStd: 20 };
    mocks.measureCompositeHtml.mockResolvedValue(measure);
    mocks.verdictFromMeasure.mockReturnValue('ok');
    const result = await CompositionOrchestrator.compose({
      layers: [{ domain: 'p5', prompt: 'visible' }],
    });
    expect(result.renderGate).toMatchObject({ verdict: 'ok', measure });
    expect(mocks.measureCompositeHtml).toHaveBeenCalledOnce();
  });

  it('keeps the better demoted retry when the first frame is too dark', async () => {
    mocks.measureCompositeHtml
      .mockResolvedValueOnce({ meanLuminance: 0.03, brightnessStd: 2 })
      .mockResolvedValueOnce({ meanLuminance: 0.35, brightnessStd: 20 });
    mocks.verdictFromMeasure
      .mockReturnValueOnce('too-dark')
      .mockReturnValueOnce('ok');
    mocks.layersToDemote.mockReturnValue([1]);
    const result = await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'base' },
        { domain: 'p5', prompt: 'subject', blendMode: 'screen' },
      ],
    });
    expect(result.renderGate?.remediation).toMatchObject({
      demotedLayers: [1],
      verdictAfter: 'ok',
      applied: true,
    });
    expect(result.html).toContain('mix-blend-mode:normal');
  });

  it('reports a failed floor when no layer can be demoted', async () => {
    const measure = { meanLuminance: 0.03, brightnessStd: 2 };
    mocks.measureCompositeHtml.mockResolvedValue(measure);
    mocks.verdictFromMeasure.mockReturnValue('too-dark');
    mocks.layersToDemote.mockReturnValue([]);
    const result = await CompositionOrchestrator.compose({
      layers: [{ domain: 'p5', prompt: 'dark base' }],
    });
    expect(result.renderGate).toMatchObject({ verdict: 'too-dark', measure });
    expect(mocks.measureCompositeHtml).toHaveBeenCalledOnce();
  });

  it('records an unavailable verdict when measurement throws', async () => {
    mocks.measureCompositeHtml.mockRejectedValue(new Error('browser missing'));
    const result = await CompositionOrchestrator.compose({
      layers: [{ domain: 'p5', prompt: 'still runnable' }],
    });
    expect(result.renderGate).toEqual({
      verdict: 'unavailable',
      skipped: 'browser missing',
    });
  });
});

describe('CompositionOrchestrator.parseSpec (NL decomposition parsing)', () => {
  it('parses fenced JSON, drops invalid domains, clamps opacity, keeps blend modes', () => {
    const raw = '```json\n' + JSON.stringify({
      title: 'Reef', background: '#012',
      layers: [
        { domain: 'shader', prompt: 'caustics bg', blendMode: 'normal', opacity: 1 },
        { domain: 'NOPE', prompt: 'x' },
        { domain: 'p5', prompt: 'fish', blendMode: 'screen', opacity: 1.7 },
      ],
    }) + '\n```';
    const spec = CompositionOrchestrator.parseSpec(raw, 'a coral reef');
    expect(spec.title).toBe('Reef');
    expect(spec.background).toBe('#012');
    expect(spec.layers).toHaveLength(2); // invalid domain dropped
    expect(spec.layers[0].domain).toBe('shader');
    expect(spec.layers[1].domain).toBe('p5');
    expect(spec.layers[1].blendMode).toBe('screen');
    expect(spec.layers[1].opacity).toBe(1); // 1.7 clamped to 1
  });

  it('falls back to a single p5 layer of the original idea when JSON is unusable', () => {
    const spec = CompositionOrchestrator.parseSpec('this is not json', 'a glowing forest at dusk');
    expect(spec.layers).toHaveLength(1);
    expect(spec.layers[0].domain).toBe('p5');
    expect(spec.layers[0].prompt).toBe('a glowing forest at dusk');
  });

  it('drops non-object layer entries without rejecting the usable layers', () => {
    const raw = JSON.stringify({
      layers: [null, 42, { domain: 'p5', prompt: 'usable subject' }],
    });
    expect(CompositionOrchestrator.parseSpec(raw, 'idea').layers)
      .toEqual([{ domain: 'p5', prompt: 'usable subject', blendMode: 'normal', opacity: 1 }]);
  });

  it('defaults an unknown blend mode to normal and missing opacity to 1', () => {
    const raw = JSON.stringify({ layers: [{ domain: 'three', prompt: 'spheres', blendMode: 'plasma' }] });
    const spec = CompositionOrchestrator.parseSpec(raw, 'idea');
    expect(spec.layers[0].blendMode).toBe('normal');
    expect(spec.layers[0].opacity).toBe(1);
  });

  it('D11 — preserves difference/exclusion blend modes instead of dropping them to normal', () => {
    const raw = JSON.stringify({
      title: 'Phase', background: '#000',
      layers: [
        { domain: 'shader', prompt: 'field', blendMode: 'normal', opacity: 1 },
        { domain: 'p5', prompt: 'inverted edges', blendMode: 'difference', opacity: 1 },
        { domain: 'hydra', prompt: 'soft inversion', blendMode: 'exclusion', opacity: 0.8 },
      ],
    });
    const spec = CompositionOrchestrator.parseSpec(raw, 'phase inversion');
    expect(spec.layers.map(l => l.blendMode)).toEqual(['normal', 'difference', 'exclusion']);
  });
});

describe('CompositionOrchestrator composition entry points', () => {
  it('decomposes a natural-language idea and composes it', async () => {
    mocks.entries = [
      { name: 'p5', generate: async () => 'function draw(){clear();}' },
    ];
    const llm = {
      generate: vi.fn(async () => ({
        code: JSON.stringify({
          title: 'Orbit',
          layers: [{ domain: 'p5', prompt: 'blue orbit' }],
        }),
      })),
    };
    const result = await CompositionOrchestrator.composeFromPrompt(
      'make a blue orbit',
      llm as never,
    );
    expect(result.title).toBe('Orbit');
    expect(result.successCount).toBe(1);
  });

  it('regenerates one source-indexed layer and reports a missing generator', async () => {
    mocks.entries = [];
    const result = await CompositionOrchestrator.regenerateLayer(
      { domain: 'p5', prompt: 'subject' },
      1,
    );
    expect(result.generated).toBe(false);
    expect(result.error).toMatch(/no generator registered/);
  });

  it('threads the canonical thesis through targeted regeneration and its artifact', async () => {
    const seen: string[] = [];
    const thesis = compileCreativeThesis('A restrained field opens into luminous release.');
    mocks.entries = [{ name: 'p5', generate: async (prompt: string) => {
      seen.push(prompt);
      return 'function draw(){clear();}';
    } }];
    const result = await CompositionOrchestrator.regenerateLayer(
      { domain: 'p5', prompt: 'focal field' }, 0, '#000', thesis,
    );
    expect(seen[0]).toContain(`thesisId=${thesis.thesisId}`);
    expect(result.artifactHtml).toContain(thesis.thesisId);
  });

  it.each(['music', 'tone', 'strudel'] as const)(
    'fails closed before generator registration when regenerating an unsupported %s override',
    async (domain) => {
      const generate = vi.fn(async () => 'must not generate');
      const thesis = compileCreativeThesis(
        'A theory-aware music pulse with chord movement, expressive dynamics, and shaped timbre.',
      );
      mocks.entries = [{ name: domain, generate }];

      await expect(CompositionOrchestrator.regenerateLayer(
        { domain, prompt: 'Use Sample Manipulation for this music artifact.' },
        0,
        '#000',
        thesis,
      )).rejects.toThrow(`Unsupported music/sound layer prompt for ${domain}`);

      expect(mocks.registerAllGenerators).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    },
  );
});

describe('CompositionOrchestrator — foreground transparency contract', () => {
  beforeEach(() => {
    mocks.registerAllGenerators.mockClear();
  });

  it('applies foreground transparency and shared whole-work context to generated layers', async () => {
    const seen: Record<string, string> = {};
    mocks.entries = [
      { name: 'shader', generate: async (p: string) => { seen.shader = p; return 'void main(){gl_FragColor=vec4(1.0);}'; } },
      { name: 'p5', generate: async (p: string) => { seen.p5 = p; return 'function draw(){ clear(); circle(1,1,1); }'; } },
    ];
    await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'aurora base' },  // base (z=1) — opaque allowed
        { domain: 'p5', prompt: 'snow particles' },    // foreground (z=2) — must be transparent
      ],
    });
    expect(seen.shader).toContain('aurora base');
    expect(seen.shader).toContain('COMPOSITION WHOLE-WORK CONTEXT');
    expect(seen.shader).toContain('2. p5: snow particles');
    expect(seen.p5).toContain('snow particles');
    expect(seen.p5).toContain('1. shader: aurora base');
    expect(seen.p5).toContain('FULLY TRANSPARENT canvas');
    expect(seen.p5).toContain('clear()');
  });

  it('flags a foreground p5 layer that paints an opaque background; base is exempt', async () => {
    mocks.entries = [
      { name: 'shader', generate: async () => 'void main(){gl_FragColor=vec4(1.0);}' },
      { name: 'p5', generate: async () => 'function draw(){ background(20, 30, 40); ellipse(1,1,1); }' },
    ];
    const result = await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'bg' },
        { domain: 'p5', prompt: 'opaque sky foreground' },
      ],
    });
    expect(result.layers[0].opaqueBackground).toBe(false); // base not guarded
    expect(result.layers[1].opaqueBackground).toBe(true);  // foreground opaque bg flagged
    expect(() => extractLayerHtml(result.html, 1))
      .toThrow(/violates the transparent foreground contract/);
  });

  it('does not flag a base layer that paints an opaque background', async () => {
    mocks.entries = [
      { name: 'p5', generate: async () => 'function draw(){ background(0); }' },
    ];
    const result = await CompositionOrchestrator.compose({
      layers: [{ domain: 'p5', prompt: 'opaque base' }],
    });
    expect(result.layers[0].opaqueBackground).toBe(false);
  });

  it('D11 — seam guard ACTS: forces an opaque foreground layer to a brightening blend (not observe-only)', async () => {
    mocks.entries = [
      { name: 'shader', generate: async () => 'void main(){gl_FragColor=vec4(1.0);}' },
      // Foreground p5 paints an opaque full-canvas background → seam risk under 'normal'.
      { name: 'p5', generate: async () => 'function draw(){ background(20, 30, 40); ellipse(1,1,1); }' },
    ];
    const result = await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'bg', blendMode: 'normal', opacity: 1 },
        { domain: 'p5', prompt: 'opaque foreground', blendMode: 'normal', opacity: 1 },
      ],
    });
    // Detection still reported.
    expect(result.layers[1].opaqueBackground).toBe(true);
    // The guard ACTED on it — blend was changed from 'normal' to a brightening mode.
    expect(result.layers[1].seamGuarded).toBe(true);
    expect(result.layers[1].blendMode).toBe('screen');
    // And the assembled composite carries the acted-on blend, not the original 'normal'.
    expect(result.html).toContain('mix-blend-mode:screen');
  });

  it('D11 — seam guard leaves an already-brightening opaque foreground untouched (no needless change)', async () => {
    mocks.entries = [
      { name: 'shader', generate: async () => 'void main(){gl_FragColor=vec4(1.0);}' },
      { name: 'p5', generate: async () => 'function draw(){ background(20, 30, 40); ellipse(1,1,1); }' },
    ];
    const result = await CompositionOrchestrator.compose({
      layers: [
        { domain: 'shader', prompt: 'bg', blendMode: 'normal', opacity: 1 },
        { domain: 'p5', prompt: 'opaque foreground', blendMode: 'lighten', opacity: 1 },
      ],
    });
    expect(result.layers[1].opaqueBackground).toBe(true);
    // 'lighten' already lets lower layers through → not occluding → no action taken.
    expect(result.layers[1].seamGuarded).toBe(false);
    expect(result.layers[1].blendMode).toBe('lighten');
  });
});

describe('CompositionOrchestrator.decomposePrompt — washout brightness cap', () => {
  const mockLLM = (specObj: unknown) =>
    ({ generate: async () => ({ code: JSON.stringify(specObj) }) }) as unknown as Parameters<
      typeof CompositionOrchestrator.decomposePrompt
    >[1];

  it('caps a decomposition that stacks multiple bright layers to stay within the washout budget', async () => {
    const washy = {
      title: 'Washy', background: '#02030a',
      layers: [
        { domain: 'three', prompt: 'glacier', blendMode: 'normal', opacity: 1 },
        { domain: 'shader', prompt: 'aurora', blendMode: 'screen', opacity: 1 },
        { domain: 'p5', prompt: 'glints', blendMode: 'screen', opacity: 1 },
        { domain: 'hydra', prompt: 'wisps', blendMode: 'lighten', opacity: 1 },
      ],
    };
    const spec = await CompositionOrchestrator.decomposePrompt('an icy cavern', mockLLM(washy));
    expect(exceedsWashoutBudget(spec.layers)).toBe(false);
    // bright blends are KEPT (additive blends never occlude); excess opacity is scaled down
    expect(spec.layers.map((l) => l.blendMode)).toEqual(['normal', 'screen', 'screen', 'lighten']);
    expect(spec.layers[1].opacity).toBe(1);    // first bright layer kept full (running 1.0)
    expect(spec.layers[2].opacity).toBe(0.3);  // reduced to remaining budget (1.3 - 1.0)
    expect(spec.layers[3].opacity).toBe(0);    // budget already full → contributes nothing
  });

  it('leaves a single-bright-layer decomposition unchanged', async () => {
    const ok = {
      title: 'OK', background: '#000',
      layers: [
        { domain: 'three', prompt: 'bg', blendMode: 'normal', opacity: 1 },
        { domain: 'p5', prompt: 'fg', blendMode: 'screen', opacity: 1 },
      ],
    };
    const spec = await CompositionOrchestrator.decomposePrompt('idea', mockLLM(ok));
    expect(spec.layers.map((l) => l.blendMode)).toEqual(['normal', 'screen']);
  });
});

describe('CompositionOrchestrator.decomposePrompt — audio invitation gating (#865)', () => {
  const mockLLM = (specObj: unknown) =>
    ({ generate: async (system: string) => ({ code: JSON.stringify(specObj), system }) }) as unknown as Parameters<
      typeof CompositionOrchestrator.decomposePrompt
    >[1];

  it('does NOT mention tone/strudel domains or audio layer for a visual-only brief', async () => {
    const captured: string[] = [];
    const llm = {
      generate: async (system: string) => {
        captured.push(system);
        return { code: JSON.stringify({ title: 'Particles', layers: [{ domain: 'p5', prompt: 'flowing particles' }] }) };
      },
    } as unknown as Parameters<typeof CompositionOrchestrator.decomposePrompt>[1];
    await CompositionOrchestrator.decomposePrompt(
      'p5.js sketch: flowing particles in blue and green', llm,
    );
    const system = captured[0];
    // Audio domains must NOT appear in the domain list for a visual brief.
    expect(system).not.toContain('"tone"');
    expect(system).not.toContain('"strudel"');
    // The "optional audio layer" hint must NOT be present.
    expect(system).not.toContain('optional audio layer');
  });

  it('DOES invite tone/strudel for a brief that mentions music', async () => {
    const captured: string[] = [];
    const llm = {
      generate: async (system: string) => {
        captured.push(system);
        return { code: JSON.stringify({ title: 'Music Vis', layers: [{ domain: 'shader', prompt: 'bg' }] }) };
      },
    } as unknown as Parameters<typeof CompositionOrchestrator.decomposePrompt>[1];
    await CompositionOrchestrator.decomposePrompt(
      'ambient music visualizer with flowing particles', llm,
    );
    const system = captured[0];
    expect(system).toContain('"tone"');
    expect(system).toContain('"strudel"');
    expect(system).toContain('optional audio layer');
  });

  it.each([
    'flowing particles in blue and green',
    'a neon cityscape at night',
    'p5.js sketch: bouncing ball',
    'fractal tree generator',
  ])('gates audio out for visual brief: "%s"', async (brief) => {
    const captured: string[] = [];
    const llm = {
      generate: async (system: string) => {
        captured.push(system);
        return { code: JSON.stringify({ title: 'T', layers: [{ domain: 'p5', prompt: brief }] }) };
      },
    } as unknown as Parameters<typeof CompositionOrchestrator.decomposePrompt>[1];
    await CompositionOrchestrator.decomposePrompt(brief, llm);
    expect(captured[0]).not.toContain('optional audio layer');
    expect(captured[0]).not.toContain('"tone"');
  });

  it.each([
    'music visualizer',
    'generative sound art',
    'audio-reactive shader',
    'strudel live coding',
    'tone synthesizer',
    'beat sequencer',
  ])('gates audio in for audio brief: "%s"', async (brief) => {
    const captured: string[] = [];
    const llm = {
      generate: async (system: string) => {
        captured.push(system);
        return { code: JSON.stringify({ title: 'T', layers: [{ domain: 'shader', prompt: brief }] }) };
      },
    } as unknown as Parameters<typeof CompositionOrchestrator.decomposePrompt>[1];
    await CompositionOrchestrator.decomposePrompt(brief, llm);
    expect(captured[0]).toContain('"tone"');
    expect(captured[0]).toContain('"strudel"');
  });
});
