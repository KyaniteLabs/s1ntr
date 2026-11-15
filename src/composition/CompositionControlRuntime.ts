import {
  validateControlRecipe,
  type ControlMapping,
  type ControlRecipe,
  type ControlValueType,
} from './ControlRecipe.js';

export type ControlValue = number | string | boolean;

export interface LayerControlBinding {
  start?(): void;
  stop?(): void;
  readSignal?(id: string): ControlValue | undefined;
  writeTarget?(id: string, value: ControlValue): void;
  releaseResource?(id: string): void;
}

export interface ControlScheduler {
  now(): number;
  schedule(clock: ControlRecipe['transport']['clock'], cadenceMs: number, tick: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface ControlRuntimeReceipt {
  recipeId: string;
  startedLayers: string[];
  stoppedLayers: string[];
  releasedResources: string[];
  ticks: number;
  stopped: boolean;
}

interface MappingState {
  values: ControlValue[];
  lastSeenAt: number;
  lastValue?: ControlValue;
}

function browserScheduler(): ControlScheduler {
  return {
    now: () => Date.now(),
    schedule: (clock, cadenceMs, tick) => {
      if (clock === 'animation-frame' && typeof requestAnimationFrame === 'function') {
        let active = true;
        let last = Date.now() - cadenceMs;
        const loop = (): void => {
          if (!active) return;
          const now = Date.now();
          if (now - last >= cadenceMs) {
            last = now;
            tick();
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        return { stop: () => { active = false; } };
      }
      return setInterval(tick, cadenceMs);
    },
    cancel: handle => {
      if (typeof handle === 'object' && handle && 'stop' in handle) {
        (handle as { stop(): void }).stop();
      } else clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

export class CompositionControlRuntime {
  private readonly states = new Map<string, MappingState>();
  private readonly receipt: ControlRuntimeReceipt;
  private handle?: unknown;
  private running = false;
  private stopped = false;

  constructor(
    private readonly recipe: ControlRecipe,
    private readonly bindings: ReadonlyMap<string, LayerControlBinding>,
    private readonly scheduler: ControlScheduler = browserScheduler(),
  ) {
    validateControlRecipe(recipe);
    for (const layer of recipe.layers) {
      const binding = bindings.get(layer.id);
      if (!binding) throw new Error(`Missing runtime binding for layer ${layer.id}`);
      if (recipe.signals.some(port => port.layerId === layer.id) && !binding.readSignal) {
        throw new Error(`Layer ${layer.id} cannot read its declared signals`);
      }
      if (recipe.targets.some(port => port.layerId === layer.id) && !binding.writeTarget) {
        throw new Error(`Layer ${layer.id} cannot write its declared targets`);
      }
      if (recipe.resources.some(resource => resource.ownerLayerId === layer.id)
        && !binding.releaseResource) {
        throw new Error(`Layer ${layer.id} cannot release its declared resources`);
      }
    }
    this.receipt = {
      recipeId: recipe.id,
      startedLayers: [],
      stoppedLayers: [],
      releasedResources: [],
      ticks: 0,
      stopped: false,
    };
  }

  start(options: { userGesture?: boolean } = {}): void {
    if (this.running) return;
    if (this.stopped) throw new Error('A stopped control runtime cannot be restarted');
    if (this.recipe.audio.ownerLayerId && options.userGesture !== true) {
      throw new Error('Audio unlock requires a user gesture');
    }
    const now = this.scheduler.now();
    for (const mapping of this.recipe.mappings) {
      this.states.set(mapping.id, { values: [], lastSeenAt: now });
    }
    try {
      for (const layerId of this.recipe.lifecycle.startOrder) {
        this.bindings.get(layerId)!.start?.();
        this.receipt.startedLayers.push(layerId);
      }
      this.running = true;
      this.handle = this.scheduler.schedule(
        this.recipe.transport.clock,
        this.recipe.transport.cadenceMs,
        () => this.tick(),
      );
    } catch (error) {
      try {
        this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Control runtime start and rollback failed');
      }
      throw error;
    }
  }

  tick(): void {
    if (!this.running) return;
    const now = this.scheduler.now();
    for (const mapping of this.recipe.mappings) this.applyMapping(mapping, now);
    this.receipt.ticks += 1;
  }

  private applyMapping(mapping: ControlMapping, now: number): void {
    const signal = this.recipe.signals.find(port => port.id === mapping.signalId)!;
    const target = this.recipe.targets.find(port => port.id === mapping.targetId)!;
    const state = this.states.get(mapping.id)!;
    const value = this.bindings.get(signal.layerId)!.readSignal!(signal.id);
    if (value !== undefined && !this.isExpectedType(value, signal.type)) {
      throw new Error(`Signal ${signal.id} produced an incompatible value`);
    }
    if (value !== undefined) {
      state.lastSeenAt = now;
      state.values.push(value);
      if (state.values.length > this.recipe.transport.bufferSize) state.values.shift();
      state.lastValue = this.bufferedValue(state.values, signal.type);
      this.bindings.get(target.layerId)!.writeTarget!(
        target.id,
        this.transformValue(state.lastValue, mapping),
      );
      return;
    }
    if (now - state.lastSeenAt < this.recipe.transport.staleAfterMs) return;
    const stale = this.recipe.transport.staleBehavior;
    if (stale === 'hold' && state.lastValue !== undefined) {
      this.bindings.get(target.layerId)!.writeTarget!(
        target.id,
        this.transformValue(state.lastValue, mapping),
      );
    } else if (stale === 'zero' && signal.type === 'number') {
      this.bindings.get(target.layerId)!.writeTarget!(target.id, 0);
    } else if (stale === 'error') {
      throw new Error(`Signal ${signal.id} became stale`);
    }
  }

  private isExpectedType(value: ControlValue, type: ControlValueType): boolean {
    return typeof value === type;
  }

  private bufferedValue(values: ControlValue[], type: ControlValueType): ControlValue {
    if (type !== 'number') return values.at(-1)!;
    const numbers = values as number[];
    return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  }

  private transformValue(value: ControlValue, mapping: ControlMapping): ControlValue {
    if (typeof value !== 'number') return value;
    let transformed = value * mapping.scale + mapping.offset;
    if (mapping.clamp) {
      transformed = Math.min(mapping.clamp[1], Math.max(mapping.clamp[0], transformed));
    }
    return transformed;
  }

  stop(): ControlRuntimeReceipt {
    if (this.stopped) return this.getReceipt();
    const errors: unknown[] = [];
    if (this.handle !== undefined) {
      this.scheduler.cancel(this.handle);
      this.handle = undefined;
    }
    const started = new Set(this.receipt.startedLayers);
    for (const layerId of this.recipe.lifecycle.teardownOrder) {
      if (!started.has(layerId) || this.receipt.stoppedLayers.includes(layerId)) continue;
      try {
        this.bindings.get(layerId)!.stop?.();
        this.receipt.stoppedLayers.push(layerId);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const resource of this.recipe.resources) {
      if (!started.has(resource.ownerLayerId)) continue;
      if (this.receipt.releasedResources.includes(resource.id)) continue;
      try {
        this.bindings.get(resource.ownerLayerId)!.releaseResource!(resource.id);
        this.receipt.releasedResources.push(resource.id);
      } catch (error) {
        errors.push(error);
      }
    }
    this.running = false;
    this.stopped = true;
    this.receipt.stopped = true;
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Control runtime teardown failed');
    }
    return this.getReceipt();
  }

  getReceipt(): ControlRuntimeReceipt {
    return {
      ...this.receipt,
      startedLayers: [...this.receipt.startedLayers],
      stoppedLayers: [...this.receipt.stoppedLayers],
      releasedResources: [...this.receipt.releasedResources],
    };
  }
}
