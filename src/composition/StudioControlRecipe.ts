import { createHash } from 'node:crypto';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  type ControlRecipe,
} from './ControlRecipe.js';
import { generateControlArtifact } from './ControlArtifact.js';
import type {
  ComposedLayer,
  CompositionResult,
} from './CompositionOrchestrator.js';
import type { DomainType } from './types.js';
import { embedCreativeThesisIdentity } from '../creative-intelligence/CreativeIntelligence.js';

export type Wave6Lane = 'p5-tone' | 'three-shader' | 'strudel-p5';

interface LaneControl {
  sourceDomain: DomainType;
  targetDomain: DomainType;
  signalId: string;
  targetId: string;
  scale: number;
  offset: number;
  clamp: [number, number];
  audio: boolean;
}

const LANE_CONTROLS: Record<Wave6Lane, LaneControl> = {
  'p5-tone': {
    sourceDomain: 'tone',
    targetDomain: 'p5',
    signalId: 'tone-transport-phase',
    targetId: 'p5-current-luminosity',
    scale: 0.5,
    offset: 0.5,
    clamp: [0.5, 1],
    audio: true,
  },
  'three-shader': {
    sourceDomain: 'three',
    targetDomain: 'shader',
    signalId: 'three-pointer-wind',
    targetId: 'shader-turbulence-amplitude',
    scale: 0.8,
    offset: 0.2,
    clamp: [0.2, 1],
    audio: false,
  },
  'strudel-p5': {
    sourceDomain: 'strudel',
    targetDomain: 'p5',
    signalId: 'strudel-beat-phase',
    targetId: 'p5-bloom-radius',
    scale: 80,
    offset: 10,
    clamp: [10, 90],
    audio: true,
  },
};

export interface CoupledStudioArtifact {
  html: string;
  recipe: ControlRecipe;
  recipeDigest: string;
}

function domainsMatch(domains: DomainType[], left: DomainType, right: DomainType): boolean {
  return domains.length === 2 && domains.includes(left) && domains.includes(right);
}

export function detectWave6Lane(domains: DomainType[]): Wave6Lane | undefined {
  if (domainsMatch(domains, 'p5', 'tone')) return 'p5-tone';
  if (domainsMatch(domains, 'three', 'shader')) return 'three-shader';
  if (domainsMatch(domains, 'strudel', 'p5')) return 'strudel-p5';
  return undefined;
}

function requiredArtifact(layers: ComposedLayer[], domain: DomainType): string {
  const layer = layers.find((candidate) => candidate.domain === domain);
  if (!layer?.generated || !layer.artifactHtml) {
    throw new Error(`Wave 6 ${domain} layer did not produce a playable artifact`);
  }
  return layer.artifactHtml;
}

function mountFrame(artifactHtml: string, layerId: string, hidden: boolean): string {
  const visibleStyle = layerId === 'target'
    ? 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:2'
    : 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:1';
  return `
const frame = document.createElement('iframe');
frame.dataset.wave6Layer = ${JSON.stringify(layerId)};
frame.title = ${JSON.stringify(`${layerId} generated layer`)};
frame.allow = 'autoplay';
frame.srcdoc = ${JSON.stringify(artifactHtml)};
frame.style.cssText = ${JSON.stringify(hidden
    ? 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0'
    : visibleStyle)};
document.getElementById('composition').appendChild(frame);`;
}

function audioSourceBinding(
  lane: 'p5-tone' | 'strudel-p5',
  control: LaneControl,
  artifactHtml: string,
): string {
  const bpmMatch = artifactHtml.match(/\bbpm\s*\(\s*(\d+(?:\.\d+)?)\s*\)/i);
  const bpm = lane === 'strudel-p5' ? Number(bpmMatch?.[1]) : undefined;
  if (lane === 'strudel-p5' && (!Number.isFinite(bpm) || bpm! <= 0)) {
    throw new Error('Wave 6 Strudel source must declare a positive bpm(...) clock');
  }
  const start = lane === 'p5-tone'
    ? `if (!sourceWindow?.Tone?.Transport) throw new Error('Generated Tone transport is unavailable');
    const startButton = [...sourceDocument().querySelectorAll('button')].find(button =>
      /start|begin|play|listen/i.test(button.textContent || '') && !/stop/i.test(button.textContent || ''));
    startButton?.click();
    sourceWindow.Tone.start?.().catch(error => { frame.dataset.wave6AudioError = String(error); });
    if (sourceWindow.Tone.Transport.state !== 'started') sourceWindow.Tone.Transport.start();
    frame.dataset.wave6AudioStartDispatched = 'true';`
    : `const editor = sourceDocument().querySelector('strudel-editor')?.editor;
    const sourceCode = sourceDocument().querySelector('[data-strudel-source-code]')?.textContent?.trim();
    if (typeof sourceWindow?.getAudioContext !== 'function'
      || typeof editor?.evaluate !== 'function' || typeof editor?.setCode !== 'function' || !sourceCode) {
      throw new Error('Generated Strudel audio runtime is unavailable');
    }
    sourceWindow.initAudioOnFirstClick?.();
    if (!editor.code?.trim()) editor.setCode(sourceCode);
    editor.evaluate();
    frame.dataset.wave6AudioStartDispatched = 'true';`;
  const read = lane === 'p5-tone'
    ? `if (sourceWindow.Tone?.Transport?.state !== 'started'
      || sourceWindow.Tone?.context?.state !== 'running') return undefined;
    const beatSeconds = 60 / Number(sourceWindow.Tone.Transport.bpm.value);
    const value = (sourceWindow.Tone.Transport.seconds % beatSeconds) / beatSeconds;
    frame.dataset.wave6SignalSource = 'tone-transport';`
    : `const context = sourceWindow.getAudioContext?.();
    if (context?.state !== 'running' || !(context.currentTime > 0)) return undefined;
    const beatSeconds = 60 / ${bpm};
    const value = (sourceWindow.getAudioContext().currentTime % beatSeconds) / beatSeconds;
    frame.dataset.wave6SignalSource = 'strudel-audio-clock';`;
  const ready = lane === 'p5-tone'
    ? 'Boolean(sourceWindow?.Tone?.Transport)'
    : `typeof sourceWindow?.getAudioContext === 'function'
      && typeof sourceDocument().querySelector('strudel-editor')?.editor?.evaluate === 'function'
      && typeof sourceDocument().querySelector('strudel-editor')?.editor?.setCode === 'function'
      && Boolean(sourceDocument().querySelector('[data-strudel-source-code]')?.textContent?.trim())`;
  return `${mountFrame(artifactHtml, 'source', true)}
const sourceWindow = frame.contentWindow;
const sourceDocument = () => frame.contentDocument;
const unlockButton = document.getElementById('sinter-audio-unlock');
unlockButton.disabled = true;
const markAudioReady = () => {
  if (!(${ready})) return;
  frame.dataset.wave6AudioReady = 'true';
  unlockButton.disabled = false;
  clearInterval(readyTimer);
};
const readyTimer = setInterval(markAudioReady, 100);
frame.addEventListener('load', markAudioReady, { once: true });
markAudioReady();
api.register('source', {
  start() { ${start} },
  stop() {},
  readSignal(id) {
    if (id !== ${JSON.stringify(control.signalId)}) return undefined;
    ${read}
    frame.dataset.wave6SignalValue = String(value);
    return value;
  },
  releaseResource() { clearInterval(readyTimer); frame.remove(); },
});`;
}

function sourceBinding(lane: Wave6Lane, control: LaneControl, artifactHtml: string): string {
  if (lane !== 'three-shader') {
    return audioSourceBinding(lane, control, artifactHtml);
  }
  return `${mountFrame(artifactHtml, 'source', control.audio)}
let pointerWind = 0;
const pointerSurface = document.createElement('div');
if (pointerSurface) {
  pointerSurface.dataset.wave6PointerSurface = 'true';
  pointerSurface.style.cssText = 'position:absolute;inset:0;z-index:3;touch-action:none';
  document.getElementById('composition').appendChild(pointerSurface);
}
const onPointer = event => {
  pointerWind = Math.max(0, Math.min(1, event.clientX / Math.max(1, window.innerWidth)));
};
(pointerSurface || window).addEventListener('pointermove', onPointer);
api.register('source', {
  start() {},
  stop() {},
  readSignal(id) {
    if (id !== ${JSON.stringify(control.signalId)}) return undefined;
    const value = pointerWind;
    frame.dataset.wave6SignalSource = 'three-pointer';
    frame.dataset.wave6SignalValue = String(value);
    return value;
  },
  releaseResource() {
    (pointerSurface || window).removeEventListener('pointermove', onPointer);
    pointerSurface?.remove();
    frame.remove();
  },
});`;
}

function targetBinding(lane: Wave6Lane, control: LaneControl, artifactHtml: string): string {
  let apply: string;
  let setup = '';
  let cleanup = '';
  if (lane === 'p5-tone') {
    apply = "frame.style.filter = 'brightness(' + Number(value).toFixed(3) + ')'";
  } else if (lane === 'three-shader') {
    setup = `
const turbulenceHost = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
turbulenceHost.setAttribute('width', '0');
turbulenceHost.setAttribute('height', '0');
turbulenceHost.innerHTML = '<filter id="wave6-shader-turbulence"><feTurbulence type="fractalNoise" baseFrequency="0.01" numOctaves="2" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="8"/></filter>';
document.body.appendChild(turbulenceHost);
const turbulence = turbulenceHost.querySelector('feTurbulence');
const displacement = turbulenceHost.querySelector('feDisplacementMap');
frame.style.filter = 'url(#wave6-shader-turbulence)';`;
    apply = [
      'const amount = Number(value);',
      "turbulence.setAttribute('baseFrequency', (0.005 + amount * 0.03).toFixed(4));",
      "displacement.setAttribute('scale', (amount * 24).toFixed(2));",
    ].join('\n');
    cleanup = 'turbulenceHost.remove();';
  } else {
    apply = "frame.style.filter = 'drop-shadow(0 0 ' + Number(value).toFixed(2) + 'px rgba(90,190,255,0.9))'";
  }
  return `${mountFrame(artifactHtml, 'target', false)}${setup}
api.register('target', {
  start() {},
  stop() {},
  writeTarget(id, value) {
    if (id !== ${JSON.stringify(control.targetId)}) return;
    frame.dataset.wave6TargetValue = String(value);
    ${apply};
  },
  releaseResource() { ${cleanup} frame.remove(); },
});`;
}

export function buildStudioControlRecipe(
  lane: Wave6Lane,
  result: CompositionResult,
  createdAt = new Date().toISOString(),
): ControlRecipe {
  const control = LANE_CONTROLS[lane];
  const sourceArtifact = requiredArtifact(result.layers, control.sourceDomain);
  const targetArtifact = requiredArtifact(result.layers, control.targetDomain);
  return {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: CONTROL_RECIPE_VERSION,
    id: `wave6-${lane}`,
    layers: [
      {
        id: 'target',
        domain: control.targetDomain,
        code: targetBinding(lane, control, targetArtifact),
        order: 0,
      },
      {
        id: 'source',
        domain: control.sourceDomain,
        code: sourceBinding(lane, control, sourceArtifact),
        order: 1,
      },
    ],
    transport: {
      clock: 'interval',
      cadenceMs: 33,
      bufferSize: 4,
      staleAfterMs: 132,
      staleBehavior: 'hold',
    },
    signals: [{ id: control.signalId, layerId: 'source', type: 'number' }],
    targets: [{ id: control.targetId, layerId: 'target', type: 'number' }],
    mappings: [{
      id: 'wave6-control',
      signalId: control.signalId,
      targetId: control.targetId,
      scale: control.scale,
      offset: control.offset,
      clamp: control.clamp,
    }],
    resources: [
      { id: 'target-frame', kind: 'other', ownerLayerId: 'target' },
      {
        id: 'source-frame',
        kind: control.audio ? 'audio-context' : 'other',
        ownerLayerId: 'source',
      },
    ],
    lifecycle: {
      startOrder: ['target', 'source'],
      teardownOrder: ['source', 'target'],
    },
    audio: control.audio
      ? { unlock: 'user-gesture', ownerLayerId: 'source' }
      : { unlock: 'not-required' },
    lineage: { parentRecipeIds: [], createdAt },
  };
}

export function createCoupledStudioArtifact(
  lane: Wave6Lane,
  result: CompositionResult,
  createdAt = new Date().toISOString(),
): CoupledStudioArtifact {
  const recipe = buildStudioControlRecipe(lane, result, createdAt);
  const recipeContract = {
    ...recipe,
    layers: recipe.layers.map(({ code: _code, ...layer }) => layer),
    lineage: { parentRecipeIds: recipe.lineage.parentRecipeIds },
  };
  const recipeDigest = createHash('sha256')
    .update(JSON.stringify(recipeContract))
    .digest('hex');
  const html = generateControlArtifact(recipe).replace(
    '<body>',
    `<body data-wave6-lane="${lane}" data-wave6-recipe-digest="${recipeDigest}">`,
  );
  return { html: result.creativeThesis ? embedCreativeThesisIdentity(html, result.creativeThesis) : html, recipe, recipeDigest };
}
