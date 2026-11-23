/**
 * ToneAdapter - Adapter for Tone.js audio layers.
 *
 * Renders Tone.js audio in a composition and exposes audio parameters
 * for cross-layer communication.
 *
 * SECURITY: Tone layer code is untrusted generated code. It never runs in the
 * host realm: it is mounted in a sandboxed iframe (see sandboxFrame.ts, #1533).
 * GeneratedCodeGuard and the pattern list below are pre-checks that refuse to
 * mount; the iframe is the boundary.
 */

import type { Layer, GlobalSettings } from '../types.js';
import type { LayerAdapter, Export, Import } from './index.js';
import type { RenderContext } from '../CompositionEngine.js';
import { Logger } from '../../utils/Logger.js';
import { findGeneratedCodeViolations } from '../../guardrails/GeneratedCodeGuard.js';
import { importsPrelude, loadSandboxLib, mountGuardedFrame, type SandboxedInstance } from './sandboxFrame.js';
import { VENDOR_ASSETS } from '../../utils/vendorAssets.js';
import { scriptSafe } from '../../utils/scriptEmbed.js';

const DANGEROUS_TONE_CODE_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bwindow\s*[[.]/i, name: 'window access' },
  { pattern: /\bdocument\s*[[.]/i, name: 'document access' },
  { pattern: /\bfetch\s*\(/i, name: 'fetch API' },
  { pattern: /\beval\s*\(/i, name: 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/i, name: 'Function constructor' },
  { pattern: /\bFunction\s*\(/i, name: 'Function constructor' },
  { pattern: /\bsetTimeout\s*\(\s*['"`]/i, name: 'setTimeout string execution' },
  { pattern: /\bsetInterval\s*\(\s*['"`]/i, name: 'setInterval string execution' },
  { pattern: /\bimport\s*\(/i, name: 'dynamic import()' },
  { pattern: /\bimportScripts\s*\(/i, name: 'importScripts()' },
  { pattern: /\bXMLHttpRequest\b/i, name: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/i, name: 'WebSocket' },
  { pattern: /\bWorker\b/i, name: 'Web Worker' },
  { pattern: /\blocalStorage\b/i, name: 'localStorage' },
  { pattern: /\bsessionStorage\b/i, name: 'sessionStorage' },
  { pattern: /\bindexedDB\b/i, name: 'indexedDB' },
  { pattern: /\bopen\s*\(\s*['"`]/i, name: 'window.open()' },
  { pattern: /\blocation\s*[=.]/i, name: 'location access' },
  { pattern: /\bparent\s*[[.]/i, name: 'parent access' },
  { pattern: /\btop\s*[[.]/i, name: 'top access' },
  { pattern: /<script\b/i, name: 'script tag' },
  { pattern: /\son\w+\s*=/i, name: 'inline event handler' },
  { pattern: /javascript:/i, name: 'javascript URL' },
  { pattern: /data:text\/javascript/i, name: 'javascript data URL' },
];

function findDangerousToneCodePatterns(code: string): string[] {
  return DANGEROUS_TONE_CODE_PATTERNS
    .filter(({ pattern }) => pattern.test(code))
    .map(({ name }) => name);
}

export class ToneAdapter implements LayerAdapter {
  private toneSource?: string;
  private instances = new Map<string, SandboxedInstance>();

  /** Load the vendored Tone.js source that is inlined into each sandbox frame. */
  async initialize(): Promise<void> {
    if (!this.toneSource) this.toneSource = await loadSandboxLib(VENDOR_ASSETS.tone);
  }

  render(layer: Layer, container: HTMLElement, context?: RenderContext): SandboxedInstance {
    const toneSource = this.toneSource;
    if (!toneSource) {
      throw new Error('Tone.js not loaded. Call async initialize() first.');
    }

    // Count synths created by this layer (the frame cannot hand objects back).
    const wrappedCode = layer.code.replace(
      /new\s+Tone\.Synth\s*\(\s*\)/g,
      '(() => { const s = new Tone.Synth(); __trackSynth(s); return s; })()',
    );

    const violations = [
      ...findGeneratedCodeViolations(wrappedCode),
      ...findDangerousToneCodePatterns(wrappedCode),
    ];
    if (violations.length > 0) {
      Logger.warn('ToneAdapter', `Blocked unsafe Tone.js layer code: ${violations.join(', ')}`);
    }

    const imports = context?.state.get<Record<string, unknown>>(`__imports_${layer.id}`);
    const bootstrap = `
var __synthCount = 0, __startedAt = Date.now();
function __trackSynth(s) { __synthCount++; return s; }
window.__s1ntrOnCommand = function (cmd) {
  if (cmd === 'start') { Tone.start(); Tone.Transport.start(); }
  else if (cmd === 'stop') { Tone.Transport.stop(); }
};
setInterval(function () {
  try {
    window.__s1ntrReport({
      isPlaying: Tone.Transport.state === 'started',
      bpm: Tone.Transport.bpm.value,
      currentTime: Tone.getContext().currentTime,
      masterVolume: Tone.Destination.volume.value,
      activeSynths: __synthCount,
      elapsedTime: (Date.now() - __startedAt) / 1000
    });
  } catch (_e) {}
}, 100);`;

    const instance = mountGuardedFrame(container, violations, {
      libs: [toneSource],
      script: `${importsPrelude(imports)}\n${bootstrap}\n${wrappedCode}`,
      width: 1,
      height: 1,
      title: `Tone.js layer ${layer.id}`,
    });
    // The frame is audio-only; keep it out of the layout.
    if (instance.iframe) instance.iframe.style.display = 'none';

    // Host controls talk to the frame, never to Tone directly.
    const controls = document.createElement('div');
    controls.style.position = 'absolute';
    controls.style.bottom = '10px';
    controls.style.left = '10px';
    controls.style.zIndex = '1000';
    const startBtn = document.createElement('button');
    startBtn.id = `tone-start-${layer.id}`;
    startBtn.textContent = 'Start Audio';
    startBtn.addEventListener('click', () => instance.send('start'));
    const stopBtn = document.createElement('button');
    stopBtn.id = `tone-stop-${layer.id}`;
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => instance.send('stop'));
    controls.append(startBtn, stopBtn);
    container.appendChild(controls);

    this.instances.get(layer.id)?.destroy();
    this.instances.set(layer.id, instance);
    return instance;
  }

  getExports(layer: Layer): Export[] {
    const instance = this.instances.get(layer.id);
    if (!instance) return [];
    const read = (key: string) => () => instance.state[key];

    return [
      { name: 'isPlaying', type: 'boolean', getter: read('isPlaying'), description: 'Whether audio is currently playing' },
      { name: 'bpm', type: 'number', getter: read('bpm'), description: 'Current BPM' },
      { name: 'currentTime', type: 'number', getter: read('currentTime'), description: 'Audio context current time' },
      { name: 'masterVolume', type: 'number', getter: read('masterVolume'), description: 'Master output volume in dB' },
      { name: 'activeSynths', type: 'number', getter: read('activeSynths'), description: 'Number of active synths' },
      { name: 'elapsedTime', type: 'number', getter: read('elapsedTime'), description: 'Time since layer started (seconds)' },
    ];
  }

  getImports(): Import[] {
    // Tone can import from visual layers for reactive audio
    return [
      {
        from: 'p5',
        name: 'mouseX',
        as: 'modulationX',
        required: false,
      },
      {
        from: 'p5',
        name: 'mouseY',
        as: 'modulationY',
        required: false,
      },
      {
        from: 'p5',
        name: 'frameCount',
        as: 'syncFrame',
        required: false,
      },
    ];
  }

  destroy(layer: Layer): void {
    const instance = this.instances.get(layer.id);
    if (instance) {
      instance.send('stop');
      instance.destroy();
      this.instances.delete(layer.id);
    }
  }

  validate(layer: Layer): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    
    if (!layer.code.includes('Tone.')) {
      errors.push('Code does not reference Tone.js (Tone. not found)');
    }
    
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  generateScript(layer: Layer, settings: GlobalSettings): string {
    const volume = settings.audio?.volume ?? 0.8;
    
    return `
<!-- Tone.js -->
<script src="${VENDOR_ASSETS.tone}"></script>
<script>
(function() {
  // Wait for user interaction to start audio
  let started = false;
  
  async function initAudio() {
    if (started) return;
    await Tone.start();
    Tone.Destination.volume.value = ${Math.log10(volume) * 20}; // Convert to dB
    started = true;
  }
  
  // Auto-start on first click
  document.addEventListener('click', initAudio, { once: true });
  
  // Execute layer code
${scriptSafe(layer.code).split('\n').map(line => '  ' + line).join('\n')}
})();
</script>`;
  }
}

/** Singleton instance */
export const toneAdapter = new ToneAdapter();
