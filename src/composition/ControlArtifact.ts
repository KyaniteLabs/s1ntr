import {
  validateControlRecipe,
  type ControlRecipe,
} from './ControlRecipe.js';
import { VENDOR_ASSETS } from '../utils/vendorAssets.js';

function scriptSafe(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function dependencyScripts(recipe: ControlRecipe): string {
  const domains = new Set(recipe.layers.map(layer => layer.domain));
  return [
    domains.has('p5')
      ? `<script src="${VENDOR_ASSETS.p5}"></script>`
      : '',
    domains.has('tone') || domains.has('music')
      ? `<script src="${VENDOR_ASSETS.tone}"></script>`
      : '',
  ].filter(Boolean).join('\n');
}

function embeddedRuntime(recipe: ControlRecipe): string {
  const json = scriptSafe(JSON.stringify(recipe));
  return `
const recipe = ${json};
const bindings = new Map();
const mappingStates = new Map();
const signalOverrides = new Map();
const disabledMappings = new Set();
let timer;
let state = 'idle';
const receipt = { started: [], stopped: [], released: [], ticks: 0 };
const requireBinding = id => {
  const binding = bindings.get(id);
  if (!binding) throw new Error('Missing runtime binding for layer ' + id);
  return binding;
};
const requireMapping = id => {
  const mapping = recipe.mappings.find(candidate => candidate.id === id);
  if (!mapping) throw new Error('Unknown control mapping ' + id);
  return mapping;
};
const validateBindings = () => {
  recipe.layers.forEach(layer => {
    const binding = requireBinding(layer.id);
    if (recipe.signals.some(port => port.layerId === layer.id)
      && typeof binding.readSignal !== 'function') {
      throw new Error('Layer ' + layer.id + ' cannot read its declared signals');
    }
    if (recipe.targets.some(port => port.layerId === layer.id)
      && typeof binding.writeTarget !== 'function') {
      throw new Error('Layer ' + layer.id + ' cannot write its declared targets');
    }
    if (recipe.resources.some(resource => resource.ownerLayerId === layer.id)
      && typeof binding.releaseResource !== 'function') {
      throw new Error('Layer ' + layer.id + ' cannot release its declared resources');
    }
  });
};
const schedule = tick => {
  if (recipe.transport.clock === 'animation-frame'
    && typeof window.requestAnimationFrame === 'function') {
    let active = true;
    let last = Date.now() - recipe.transport.cadenceMs;
    const loop = () => {
      if (!active) return;
      const now = Date.now();
      if (now - last >= recipe.transport.cadenceMs) {
        last = now;
        tick();
      }
      window.requestAnimationFrame(loop);
    };
    window.requestAnimationFrame(loop);
    return { stop: () => { active = false; } };
  }
  const interval = setInterval(tick, recipe.transport.cadenceMs);
  return { stop: () => clearInterval(interval) };
};
const api = {
  recipe,
  register(layerId, binding) { bindings.set(layerId, binding); },
  setSignalOverride(mappingId, value) {
    const mapping = requireMapping(mappingId);
    const signal = recipe.signals.find(port => port.id === mapping.signalId);
    if (signal?.type !== 'number' || !Number.isFinite(value)) {
      throw new Error('Signal override requires a finite numeric value');
    }
    const mappingState = mappingStates.get(mappingId);
    if (!mappingState) throw new Error('Control runtime must be running before signal mutation');
    signalOverrides.set(mappingId, value);
    mappingState.values = [];
    mappingState.lastSignal = value;
  },
  clearSignalOverride(mappingId) {
    requireMapping(mappingId);
    signalOverrides.delete(mappingId);
  },
  setMappingEnabled(mappingId, enabled, options = {}) {
    const mapping = requireMapping(mappingId);
    if (enabled) {
      disabledMappings.delete(mappingId);
      return;
    }
    if (!Number.isFinite(options.ablatedValue)) {
      throw new Error('Coupling ablation requires a finite target value');
    }
    const target = recipe.targets.find(port => port.id === mapping.targetId);
    requireBinding(target.layerId).writeTarget(target.id, options.ablatedValue);
    disabledMappings.add(mappingId);
    mappingStates.get(mappingId).lastTarget = options.ablatedValue;
  },
  observe(mappingId) {
    requireMapping(mappingId);
    const mappingState = mappingStates.get(mappingId);
    if (!mappingState) throw new Error('Control runtime has no observations');
    return {
      signalValue: mappingState.lastSignal,
      targetValue: mappingState.lastTarget,
    };
  },
  start({ userGesture = false } = {}) {
    if (state === 'running') return;
    if (state === 'stopped') throw new Error('A stopped control runtime cannot be restarted');
    if (recipe.audio.ownerLayerId && !userGesture) {
      throw new Error('Audio unlock requires a user gesture');
    }
    validateBindings();
    state = 'running';
    recipe.mappings.forEach(mapping => {
      mappingStates.set(mapping.id, { values: [], lastSeenAt: Date.now() });
    });
    try {
      recipe.lifecycle.startOrder.forEach(id => {
        requireBinding(id).start?.();
        receipt.started.push(id);
      });
      timer = schedule(() => api.tick());
    } catch (error) {
      try {
        api.teardown();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Control runtime start and rollback failed');
      }
      throw error;
    }
  },
  writeMapped(target, mapping, value) {
    const output = typeof value === 'number'
      ? Math.min(mapping.clamp?.[1] ?? Infinity,
        Math.max(mapping.clamp?.[0] ?? -Infinity, value * mapping.scale + mapping.offset))
      : value;
    requireBinding(target.layerId).writeTarget(target.id, output);
    mappingStates.get(mapping.id).lastTarget = output;
  },
  tick() {
    const now = Date.now();
    recipe.mappings.forEach(mapping => {
      const signal = recipe.signals.find(port => port.id === mapping.signalId);
      const target = recipe.targets.find(port => port.id === mapping.targetId);
      const mappingState = mappingStates.get(mapping.id);
      const value = signalOverrides.has(mapping.id)
        ? signalOverrides.get(mapping.id)
        : requireBinding(signal.layerId).readSignal(signal.id);
      if (value !== undefined && typeof value !== signal.type) {
        throw new Error('Signal ' + signal.id + ' produced an incompatible value');
      }
      if (value !== undefined) {
        mappingState.lastSignal = value;
        if (disabledMappings.has(mapping.id)) return;
        mappingState.values.push(value);
        if (mappingState.values.length > recipe.transport.bufferSize) mappingState.values.shift();
        mappingState.lastSeenAt = now;
        mappingState.lastValue = signal.type === 'number'
          ? mappingState.values.reduce((sum, item) => sum + item, 0) / mappingState.values.length
          : mappingState.values.at(-1);
        api.writeMapped(target, mapping, mappingState.lastValue);
        return;
      }
      if (now - mappingState.lastSeenAt < recipe.transport.staleAfterMs) return;
      if (recipe.transport.staleBehavior === 'hold' && mappingState.lastValue !== undefined) {
        api.writeMapped(target, mapping, mappingState.lastValue);
      } else if (recipe.transport.staleBehavior === 'zero' && signal.type === 'number') {
        requireBinding(target.layerId).writeTarget(target.id, 0);
      } else if (recipe.transport.staleBehavior === 'error') {
        throw new Error('Signal ' + signal.id + ' became stale');
      }
    });
    receipt.ticks += 1;
  },
  teardown() {
    if (state === 'stopped') {
      return {
        started: [...receipt.started],
        stopped: [...receipt.stopped],
        released: [...receipt.released],
        ticks: receipt.ticks,
      };
    }
    if (timer !== undefined) {
      timer.stop();
      timer = undefined;
    }
    const errors = [];
    recipe.lifecycle.teardownOrder.filter(id => receipt.started.includes(id)).forEach(id => {
      try {
        requireBinding(id).stop?.();
        receipt.stopped.push(id);
      } catch (error) {
        errors.push(error);
      }
    });
    recipe.resources.filter(resource => receipt.started.includes(resource.ownerLayerId)).forEach(resource => {
      try {
        requireBinding(resource.ownerLayerId).releaseResource(resource.id);
        receipt.released.push(resource.id);
      } catch (error) {
        errors.push(error);
      }
    });
    state = 'stopped';
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Control runtime teardown failed');
    }
    return {
      started: [...receipt.started],
      stopped: [...receipt.stopped],
      released: [...receipt.released],
      ticks: receipt.ticks,
    };
  },
};
window.SinterControl = api;`;
}

function layerScripts(recipe: ControlRecipe): string {
  return [...recipe.layers]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(layer => `<script data-control-layer="${layer.id}">
((api) => {
${scriptSafe(layer.code)}
})(window.SinterControl);
</script>`)
    .join('\n');
}

export function generateControlArtifact(recipe: ControlRecipe): string {
  validateControlRecipe(recipe);
  const unlock = recipe.audio.ownerLayerId
    ? '<button id="sinter-audio-unlock" style="position:fixed;top:16px;right:16px;z-index:2147483647">Start composition</button>'
    : '';
  const automaticStart = recipe.audio.ownerLayerId
    ? `document.getElementById('sinter-audio-unlock').addEventListener('click', () => {
  window.SinterControl.start({ userGesture: true });
}, { once: true });`
    : 'window.SinterControl.start();';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${recipe.id}</title>
  ${dependencyScripts(recipe)}
</head>
<body>
  <main id="composition"></main>
  ${unlock}
  <script>${embeddedRuntime(recipe)}</script>
  ${layerScripts(recipe)}
  <script>${automaticStart}</script>
</body>
</html>`;
}
