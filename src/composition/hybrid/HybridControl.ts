/**
 * Layered pieces drive their cross-layer beat signals through the control-recipe organs:
 * the plan's signals become a ControlRecipe (validated by CompositionEngine.loadControlRecipe),
 * and the page runs the same CompositionControlRuntime logic (ControlArtifact's embedded runtime)
 * against postMessage bindings, so the beat loop in the self-contained page is a real
 * recipe-driven control loop, not a second hand-written one.
 */
import type { ControlValue, LayerControlBinding } from '../CompositionControlRuntime.js';
import { CompositionEngine } from '../CompositionEngine.js';
import { CONTROL_RECIPE_SCHEMA, CONTROL_RECIPE_VERSION, type ControlRecipe, type ControlPort, type ControlMapping, type ControlLayer } from '../ControlRecipe.js';
import { embeddedRuntime } from '../ControlArtifact.js';
import { scriptSafe } from '../../utils/scriptEmbed.js';
import type { HybridPlan } from './HybridPlan.js';
import type { DomainType } from '../types.js';

const layerId = (index: number): string => `layer-${index}`;

/** The control recipe for a plan's beat signals, or undefined when the plan has none. */
export function buildHybridControlRecipe(plan: HybridPlan): ControlRecipe | undefined {
  const beats = plan.signals.filter((s) => s.kind === 'beat');
  if (!plan.bpm || beats.length === 0) return undefined;
  const layers = new Map<string, ControlLayer>();
  const signals: ControlPort[] = [];
  const targets: ControlPort[] = [];
  const mappings: ControlMapping[] = [];
  const source = (from: number | 'clock'): string => {
    const id = from === 'clock' ? 'clock' : layerId(from);
    if (!layers.has(id)) {
      const domain = from === 'clock' ? 'group' : plan.layers[from].domain;
      layers.set(id, { id, domain: domain as DomainType, code: '', order: 0 });
      signals.push({ id: `beat-${id}`, layerId: id, type: 'number' });
    }
    return id;
  };
  beats.forEach((signal, n) => {
    const from = source(signal.from);
    const to = layerId(signal.to);
    if (!layers.has(to)) layers.set(to, { id: to, domain: plan.layers[signal.to].domain as DomainType, code: '', order: 0 });
    const targetId = `t${n}-${signal.param}`;
    targets.push({ id: targetId, layerId: to, type: 'number' });
    mappings.push({ id: `beat-${n}`, signalId: `beat-${from}`, targetId, scale: signal.depth, offset: 0, clamp: [0, 1] });
  });
  const ordered = [...layers.values()].sort((a, b) => (a.id === 'clock' ? -1 : b.id === 'clock' ? 1 : a.id.localeCompare(b.id, 'en', { numeric: true })));
  ordered.forEach((l, i) => { l.order = i; });
  const order = ordered.map((l) => l.id);
  const cadenceMs = 16;
  return {
    schema: CONTROL_RECIPE_SCHEMA, schemaVersion: CONTROL_RECIPE_VERSION,
    id: 'layered-beat',
    layers: ordered, signals, targets, mappings, resources: [],
    transport: { clock: 'animation-frame', cadenceMs, bufferSize: 1, staleAfterMs: 1000, staleBehavior: 'hold' },
    lifecycle: { startOrder: order, teardownOrder: [...order].reverse() },
    audio: { unlock: 'not-required' },
    lineage: { parentRecipeIds: [], createdAt: new Date(0).toISOString() },
  };
}

/** Validate through the engine (migrate + validate), the same entry the studio recipes use. */
export function validateHybridControlRecipe(recipe: ControlRecipe): ControlRecipe {
  const valid = new CompositionEngine().loadControlRecipe(recipe);
  rehearseHybridControl(valid);
  return valid;
}

/** In-page: the embedded runtime plus postMessage bindings, started on load. */
export function controlScript(recipe: ControlRecipe): string {
  const ports = scriptSafe(JSON.stringify(recipe.targets.map((t) => ({ id: t.id, layer: Number(t.layerId.replace('layer-', '')), param: t.id.replace(/^t\d+-/, '') }))));
  return `<script id="sinter-hybrid-control">${embeddedRuntime(recipe)}
(function(){var api=window.SinterControl,targets=${ports};
var frames=function(){return Array.prototype.slice.call(document.querySelectorAll('iframe.sinter-layer'))};
var reader={readSignal:function(){return window.sinterBeat?window.sinterBeat.beat:undefined}};
api.recipe.layers.forEach(function(l){
  var mine=targets.filter(function(t){return 'layer-'+t.layer===l.id});
  var b={readSignal:reader.readSignal};
  b.writeTarget=function(id,v){var t=targets.find(function(x){return x.id===id});if(!t)return;
    var f=frames().find(function(x){return Number(x.dataset.layerIndex)===t.layer});
    if(f&&f.contentWindow)f.contentWindow.postMessage({type:'sinter:signal',name:'control:'+t.param,value:v},'*')};
  b.releaseResource=function(){};
  api.register(l.id,b)});
/* the beat reaches a wired layer only through this script: strip it and the layer hears nothing */
var wired=[];targets.forEach(function(t){if(wired.indexOf(t.layer)<0)wired.push(t.layer)});
(function pump(){var s=window.sinterBeat;if(s)frames().forEach(function(f){if(wired.indexOf(Number(f.dataset.layerIndex))<0)return;
  try{f.contentWindow.postMessage({type:'sinter:signal',name:'beat',value:s.beat,beats:s.beats},'*')}catch(e){}});requestAnimationFrame(pump)})();
api.start();window.addEventListener('pagehide',function(){try{api.teardown()}catch(e){}})})();
</script>`;
}

/**
 * Build-time rehearsal on the host CompositionControlRuntime: the same recipe, with recording bindings
 * and a manual clock, must write every target a finite value inside its clamp. A recipe that cannot
 * drive its targets fails here, before a page ships with a dead beat loop.
 */
export function rehearseHybridControl(recipe: ControlRecipe, ticks = 4): ReadonlyMap<string, number> {
  const engine = new CompositionEngine();
  engine.loadControlRecipe(recipe);
  const written = new Map<string, number>();
  const bindings = new Map<string, LayerControlBinding>();
  for (const layer of recipe.layers) {
    bindings.set(layer.id, {
      readSignal: () => 1 as ControlValue,
      writeTarget: (id, value) => { if (typeof value === 'number') written.set(id, value); },
    });
  }
  let now = 0;
  const runtime = engine.createControlRuntime(bindings, {
    now: () => now,
    schedule: () => ({}),
    cancel: () => undefined,
  });
  runtime.start();
  for (let i = 0; i < ticks; i += 1) { now += recipe.transport.cadenceMs; runtime.tick(); }
  runtime.stop();
  for (const target of recipe.targets) {
    const value = written.get(target.id);
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`control rehearsal: target ${target.id} on ${target.layerId} was never driven`);
    }
  }
  return written;
}
