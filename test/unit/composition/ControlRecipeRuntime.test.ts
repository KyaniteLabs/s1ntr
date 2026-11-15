import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  CompositionEngine,
  CompositionControlRuntime,
  generateControlArtifact,
  migrateControlRecipe,
  validateControlRecipe,
  type ControlRecipe,
  type ControlScheduler,
  type LayerControlBinding,
  type LegacyControlRecipe,
} from '../../../src/composition/index.js';

function recipe(): ControlRecipe {
  return {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: CONTROL_RECIPE_VERSION,
    id: 'p5-tone-pulse',
    layers: [
      {
        id: 'visual',
        domain: 'p5',
        order: 0,
        code: `api.register('visual', {
  readSignal: id => id === 'visual-energy' ? 0.75 : undefined,
  releaseResource: () => {}
});`,
      },
      {
        id: 'sound',
        domain: 'tone',
        order: 1,
        code: `window.__frequency = 0;
api.register('sound', {
  readSignal: () => undefined,
  writeTarget: (id, value) => { if (id === 'tone-frequency') window.__frequency = value; },
  releaseResource: id => { window.__released = id; }
});`,
      },
    ],
    transport: {
      clock: 'interval',
      cadenceMs: 20,
      bufferSize: 2,
      staleAfterMs: 40,
      staleBehavior: 'hold',
    },
    signals: [{ id: 'visual-energy', layerId: 'visual', type: 'number' }],
    targets: [{ id: 'tone-frequency', layerId: 'sound', type: 'number' }],
    mappings: [{
      id: 'energy-to-frequency',
      signalId: 'visual-energy',
      targetId: 'tone-frequency',
      scale: 400,
      offset: 100,
      clamp: [100, 500],
    }],
    resources: [
      { id: 'visual-canvas', kind: 'canvas', ownerLayerId: 'visual' },
      { id: 'tone-context', kind: 'audio-context', ownerLayerId: 'sound' },
    ],
    lifecycle: {
      startOrder: ['visual', 'sound'],
      teardownOrder: ['sound', 'visual'],
    },
    audio: { unlock: 'user-gesture', ownerLayerId: 'sound' },
    lineage: { parentRecipeIds: ['seed-recipe'], createdAt: '2026-07-30T00:00:00.000Z' },
  };
}

class FakeScheduler implements ControlScheduler {
  time = 0;
  tick?: () => void;
  cancelled = false;

  now(): number {
    return this.time;
  }

  schedule(_clock: 'interval' | 'animation-frame', _cadence: number, tick: () => void): unknown {
    this.tick = tick;
    return 'schedule';
  }

  cancel(): void {
    this.cancelled = true;
  }
}

describe('control recipe validation and migration', () => {
  it('accepts a one-layer recipe without synthetic control mappings', () => {
    const single = recipe();
    single.layers = [single.layers[0]];
    single.signals = [];
    single.targets = [];
    single.mappings = [];
    single.resources = [single.resources[0]];
    single.lifecycle = { startOrder: ['visual'], teardownOrder: ['visual'] };
    single.audio = { unlock: 'not-required' };
    expect(validateControlRecipe(single).layers.map(layer => layer.id)).toEqual(['visual']);
  });

  it('migrates a legacy recipe deterministically', () => {
    const current = recipe();
    const legacy: LegacyControlRecipe = {
      schema: CONTROL_RECIPE_SCHEMA,
      schemaVersion: '1.0',
      id: current.id,
      layers: current.layers,
      cadenceMs: 20,
      links: [{
        id: current.mappings[0].id,
        from: current.signals[0],
        to: current.targets[0],
        scale: 400,
        offset: 100,
      }],
      resources: current.resources,
      createdAt: current.lineage.createdAt,
    };
    expect(migrateControlRecipe(legacy)).toEqual(migrateControlRecipe(legacy));
    expect(migrateControlRecipe(legacy).schemaVersion).toBe('2.0');
  });

  it('loads into the existing CompositionEngine instead of a parallel store', () => {
    const engine = new CompositionEngine();
    const loaded = engine.loadControlRecipe(recipe());
    loaded.id = 'caller-mutation';
    expect(engine.getLayers().map(layer => layer.id)).toEqual(['visual', 'sound']);
    expect(engine.getControlRecipe()?.id).toBe('p5-tone-pulse');
    expect(engine.generateControlHTML()).toContain('window.SinterControl');
  });
});

describe('standalone control artifact', () => {
  it('reconstructs a runnable p5 and Tone coupling with teardown', () => {
    const artifact = generateControlArtifact(recipe());
    expect(artifact).toContain('p5.min.js');
    expect(artifact).toContain('Tone.js');
    expect(artifact).toContain('id="sinter-audio-unlock"');
    expect(artifact).toContain('z-index:2147483647');
    const dom = new JSDOM(artifact, {
      runScripts: 'dangerously',
      url: 'https://sinter.invalid/',
    });
    const runtime = (dom.window as unknown as {
      SinterControl: {
        start(options: { userGesture: boolean }): void;
        tick(): void;
        teardown(): { stopped: string[]; released: string[] };
      };
      __frequency: number;
      __released: string;
    });
    runtime.SinterControl.start({ userGesture: true });
    runtime.SinterControl.tick();
    const receipt = runtime.SinterControl.teardown();

    expect(runtime.__frequency).toBe(400);
    expect(runtime.__released).toBe('tone-context');
    expect(receipt.stopped).toEqual(['sound', 'visual']);
    expect(receipt.released).toEqual(['visual-canvas', 'tone-context']);
    dom.window.close();
  });

  it('exposes observed signal mutation and coupling ablation without fabricating trials', () => {
    const dom = new JSDOM(generateControlArtifact(recipe()), {
      runScripts: 'dangerously',
      url: 'https://sinter.invalid/',
    });
    const runtime = (dom.window as unknown as {
      SinterControl: {
        start(options: { userGesture: boolean }): void;
        tick(): void;
        setSignalOverride(mappingId: string, value: number): void;
        setMappingEnabled(mappingId: string, enabled: boolean, options?: {
          ablatedValue: number;
        }): void;
        observe(mappingId: string): { signalValue: number; targetValue: number };
      };
      __frequency: number;
    });

    runtime.SinterControl.start({ userGesture: true });
    runtime.SinterControl.setSignalOverride('energy-to-frequency', 0.25);
    runtime.SinterControl.tick();
    expect(runtime.SinterControl.observe('energy-to-frequency')).toEqual({
      signalValue: 0.25,
      targetValue: 200,
    });

    runtime.SinterControl.setMappingEnabled(
      'energy-to-frequency',
      false,
      { ablatedValue: 100 },
    );
    expect(runtime.__frequency).toBe(100);
    expect(runtime.SinterControl.observe('energy-to-frequency')).toEqual({
      signalValue: 0.25,
      targetValue: 100,
    });
    dom.window.close();
  });
});

  it.each([
    ['incomplete lineage', (value: ControlRecipe) => {
      value.lineage.createdAt = '';
    }],
    ['disconnected layer', (value: ControlRecipe) => {
      value.layers.push({ id: 'text', domain: 'html', code: '', order: 2 });
      value.lifecycle.startOrder.push('text');
      value.lifecycle.teardownOrder.unshift('text');
    }],
    ['stale window shorter than buffer', (value: ControlRecipe) => {
      value.transport.staleAfterMs = 20;
    }],
    ['malformed transform', (value: ControlRecipe) => {
      value.mappings[0].scale = Number.NaN;
    }],
    ['reversed endpoint', (value: ControlRecipe) => {
      value.mappings[0].signalId = 'tone-frequency';
      value.mappings[0].targetId = 'visual-energy';
    }],
    ['incompatible port types', (value: ControlRecipe) => {
      value.targets[0].type = 'boolean';
    }],
    ['duplicate layer identity', (value: ControlRecipe) => {
      value.layers[1].id = 'visual';
    }],
    ['unsupported transport', (value: ControlRecipe) => {
      value.transport.clock = 'invalid' as 'interval';
    }],
    ['non-positive cadence', (value: ControlRecipe) => {
      value.transport.cadenceMs = 0;
    }],
    ['invalid buffer size', (value: ControlRecipe) => {
      value.transport.bufferSize = 0;
    }],
    ['invalid signal owner', (value: ControlRecipe) => {
      value.signals[0].layerId = 'missing';
    }],
    ['same-layer mapping', (value: ControlRecipe) => {
      value.targets[0].layerId = 'visual';
    }],
    ['non-numeric transform', (value: ControlRecipe) => {
      value.signals[0].type = 'string';
      value.targets[0].type = 'string';
    }],
    ['malformed clamp', (value: ControlRecipe) => {
      value.mappings[0].clamp = [500, 100];
    }],
    ['unowned resource', (value: ControlRecipe) => {
      value.resources[0].ownerLayerId = 'missing';
    }],
  ])('rejects %s', (_label, mutate) => {
    const invalid = structuredClone(recipe());
    mutate(invalid);
    expect(() => validateControlRecipe(invalid)).toThrow();
  });

describe('CompositionControlRuntime', () => {
  it('requires explicit audio unlock', () => {
    const bindings = new Map<string, LayerControlBinding>([
      ['visual', { readSignal: () => 1, releaseResource: vi.fn() }],
      ['sound', { writeTarget: vi.fn(), releaseResource: vi.fn() }],
    ]);
    const runtime = new CompositionControlRuntime(recipe(), bindings, new FakeScheduler());
    expect(() => runtime.start()).toThrow('user gesture');
  });

  it('rolls back only resources whose owner actually started', () => {
    const events: string[] = [];
    const bindings = new Map<string, LayerControlBinding>([
      ['visual', {
        start: () => events.push('start:visual'),
        stop: () => events.push('stop:visual'),
        readSignal: () => 1,
        releaseResource: id => events.push(`release:${id}`),
      }],
      ['sound', {
        start: () => { throw new Error('audio start failed'); },
        writeTarget: vi.fn(),
        releaseResource: id => events.push(`release:${id}`),
      }],
    ]);
    const runtime = new CompositionControlRuntime(recipe(), bindings, new FakeScheduler());

    expect(() => runtime.start({ userGesture: true })).toThrow('audio start failed');
    expect(events).toEqual(['start:visual', 'stop:visual', 'release:visual-canvas']);
    expect(runtime.getReceipt().releasedResources).toEqual(['visual-canvas']);
  });

  it('couples p5 signal to Tone target and tears down deterministically', () => {
    const events: string[] = [];
    const output: number[] = [];
    let signal = 0.75;
    const bindings = new Map<string, LayerControlBinding>([
      ['visual', {
        start: () => events.push('start:visual'),
        stop: () => events.push('stop:visual'),
        readSignal: () => signal,
        writeTarget: vi.fn(),
        releaseResource: id => events.push(`release:${id}`),
      }],
      ['sound', {
        start: () => events.push('start:sound'),
        stop: () => events.push('stop:sound'),
        readSignal: () => undefined,
        writeTarget: (_id, value) => output.push(value as number),
        releaseResource: id => events.push(`release:${id}`),
      }],
    ]);
    const scheduler = new FakeScheduler();
    const runtime = new CompositionControlRuntime(recipe(), bindings, scheduler);
    runtime.start({ userGesture: true });
    scheduler.tick!();
    signal = 0.25;
    scheduler.tick!();
    const receipt = runtime.stop();

    expect(output).toEqual([400, 300]);
    expect(events).toEqual([
      'start:visual',
      'start:sound',
      'stop:sound',
      'stop:visual',
      'release:visual-canvas',
      'release:tone-context',
    ]);
    expect(receipt).toMatchObject({
      stopped: true,
      stoppedLayers: ['sound', 'visual'],
      releasedResources: ['visual-canvas', 'tone-context'],
      ticks: 2,
    });
    expect(scheduler.cancelled).toBe(true);
    expect(runtime.stop()).toEqual(receipt);
    expect(events).toHaveLength(6);
    expect(() => runtime.start({ userGesture: true })).toThrow('cannot be restarted');
  });

  it('applies declared stale behavior and rejects runtime type drift', () => {
    let signal: number | string | undefined = 0.5;
    const output: Array<number | string | boolean> = [];
    const bindings = new Map<string, LayerControlBinding>([
      ['visual', {
        readSignal: () => signal,
        releaseResource: vi.fn(),
      }],
      ['sound', {
        writeTarget: (_id, value) => output.push(value),
        releaseResource: vi.fn(),
      }],
    ]);
    const scheduler = new FakeScheduler();
    const runtime = new CompositionControlRuntime(recipe(), bindings, scheduler);
    runtime.start({ userGesture: true });
    runtime.tick();
    signal = undefined;
    scheduler.time = 40;
    runtime.tick();
    signal = 'wrong-type';

    expect(output).toEqual([300, 300]);
    expect(() => runtime.tick()).toThrow('incompatible value');
    runtime.stop();
  });
});
