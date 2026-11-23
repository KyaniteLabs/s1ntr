/**
 * P5Adapter - Adapter for p5.js layers.
 *
 * Renders p5.js sketches in a container and exposes sketch properties
 * for cross-layer communication.
 *
 * SECURITY: the sketch is untrusted generated code. It never runs in the host
 * realm: it is mounted in a sandboxed iframe (see sandboxFrame.ts, #1533).
 * GeneratedCodeGuard and the pattern list below are pre-checks that refuse to
 * mount; the iframe is the boundary.
 */

import type { Layer, GlobalSettings } from '../types.js';
import type { LayerAdapter, Export, Import } from './index.js';
import type { RenderContext } from '../CompositionEngine.js';
import { VENDOR_ASSETS } from '../../utils/vendorAssets.js';
import { Logger } from '../../utils/Logger.js';
import { findGeneratedCodeViolations } from '../../guardrails/GeneratedCodeGuard.js';
import { importsPrelude, loadSandboxLib, mountGuardedFrame, type SandboxedInstance } from './sandboxFrame.js';
import { scriptSafe } from '../../utils/scriptEmbed.js';

const DANGEROUS_P5_CODE_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
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
];

function findDangerousP5CodePatterns(code: string): string[] {
  return DANGEROUS_P5_CODE_PATTERNS
    .filter(({ pattern }) => pattern.test(code))
    .map(({ name }) => name);
}

export class P5Adapter implements LayerAdapter {
  private p5Source?: string;
  private instances = new Map<string, SandboxedInstance>();

  /** Load the vendored p5 source that is inlined into each sandbox frame. */
  async initialize(): Promise<void> {
    if (!this.p5Source) this.p5Source = await loadSandboxLib(VENDOR_ASSETS.p5);
  }

  render(layer: Layer, container: HTMLElement, context?: RenderContext): SandboxedInstance {
    const p5Source = this.p5Source;
    if (!p5Source) {
      throw new Error('p5.js not loaded. Call async initialize() first.');
    }

    const settings = context?.settings;
    const width = settings?.width || 800;
    const height = settings?.height || 600;

    const violations = [
      ...findGeneratedCodeViolations(layer.code),
      ...findDangerousP5CodePatterns(layer.code),
    ];
    if (violations.length > 0) {
      Logger.warn('P5Adapter', `Blocked unsafe sketch: ${violations.join(', ')}`);
    }

    const imports = context?.state.get<Record<string, unknown>>(`__imports_${layer.id}`);
    const report = `
window.addEventListener('load', function () {
  setInterval(function () {
    var g = function (n) { try { return window[n]; } catch (_e) { return undefined; } };
    window.__s1ntrReport({
      mouseX: g('mouseX'), mouseY: g('mouseY'), pmouseX: g('pmouseX'), pmouseY: g('pmouseY'),
      frameCount: g('frameCount'), width: g('width'), height: g('height'),
      millis: typeof millis === 'function' ? millis() : undefined
    });
  }, 100);
});`;

    const instance = mountGuardedFrame(container, violations, {
      libs: [p5Source],
      script: `${importsPrelude(imports)}\n${layer.code}\n${report}`,
      width,
      height,
      transparent: layer.config.transparentBackground,
      title: `p5 layer ${layer.id}`,
    });
    this.instances.get(layer.id)?.destroy();
    this.instances.set(layer.id, instance);
    return instance;
  }

  getExports(layer: Layer): Export[] {
    const instance = this.instances.get(layer.id);
    if (!instance) return [];
    const num = (key: string) => () => instance.state[key];

    return [
      { name: 'mouseX', type: 'number', getter: num('mouseX'), description: 'Current mouse X position' },
      { name: 'mouseY', type: 'number', getter: num('mouseY'), description: 'Current mouse Y position' },
      { name: 'pmouseX', type: 'number', getter: num('pmouseX'), description: 'Previous mouse X position' },
      { name: 'pmouseY', type: 'number', getter: num('pmouseY'), description: 'Previous mouse Y position' },
      { name: 'frameCount', type: 'number', getter: num('frameCount'), description: 'Number of frames drawn' },
      { name: 'millis', type: 'number', getter: num('millis'), description: 'Milliseconds since sketch started' },
      { name: 'width', type: 'number', getter: num('width'), description: 'Canvas width' },
      { name: 'height', type: 'number', getter: num('height'), description: 'Canvas height' },
    ];
  }

  getImports(): Import[] {
    // P5 layers are typically self-contained
    return [];
  }

  destroy(layer: Layer, _instance: unknown): void {
    const instance = this.instances.get(layer.id);
    if (instance) {
      instance.destroy();
      this.instances.delete(layer.id);
    }
  }

  validate(layer: Layer): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    
    if (!layer.code.includes('function setup')) {
      errors.push('Missing setup() function');
    }
    if (!layer.code.includes('function draw')) {
      errors.push('Missing draw() function');
    }
    
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  generateScript(layer: Layer, _settings: GlobalSettings): string {
    const transparentStyle = layer.config.transparentBackground
      ? "  container.style.background = 'transparent';\n"
      : '';
    const blendStyle = layer.config.blendMode !== 'normal'
      ? `  container.style.mixBlendMode = '${layer.config.blendMode}';\n`
      : '';

    return `
<!-- p5.js -->
<script src="${VENDOR_ASSETS.p5}"></script>
<script>
(function() {
  const container = document.createElement('div');
  container.className = 'layer';
  container.style.zIndex = ${layer.config.zIndex};
  container.style.opacity = ${layer.config.opacity};
${transparentStyle}${blendStyle}  document.getElementById('composition').appendChild(container);

  new p5(function(sketch) {
${scriptSafe(layer.code).split('\n').map(line => '    ' + line).join('\n')}
  }, container);
})();
</script>`;
  }
}

/** Singleton instance */
export const p5Adapter = new P5Adapter();
