/**
 * HydraAdapter - Adapter for Hydra video synthesis layers.
 *
 * Renders Hydra video synthesis in a container and exposes
 * synth outputs and frame data for cross-layer communication.
 *
 * SECURITY: generated Hydra code is untrusted. It never runs in the host
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

const DANGEROUS_HYDRA_CODE_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
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

function findDangerousHydraCodePatterns(code: string): string[] {
  return DANGEROUS_HYDRA_CODE_PATTERNS
    .filter(({ pattern }) => pattern.test(code))
    .map(({ name }) => name);
}

/**
 * Adapter for Hydra video synthesis layers.
 * 
 * Hydra is a live coding visual synthesizer that uses method chaining
 * to create complex video effects. This adapter renders Hydra code
 * and exposes outputs for cross-layer communication.
 */
export class HydraAdapter implements LayerAdapter {
  private hydraSource?: string;
  private instances = new Map<string, SandboxedInstance>();

  /** Load the vendored Hydra source that is inlined into each sandbox frame. */
  async initialize(): Promise<void> {
    if (!this.hydraSource) this.hydraSource = await loadSandboxLib(VENDOR_ASSETS.hydra);
  }

  /**
   * Render a Hydra layer into the container (inside a sandboxed iframe).
   *
   * @param layer - The layer to render
   * @param container - The container element
   * @param context - Optional render context for cross-layer communication
   * @returns The sandboxed instance (frame plus mirrored state)
   */
  render(layer: Layer, container: HTMLElement, context?: RenderContext): SandboxedInstance {
    const hydraSource = this.hydraSource;
    if (!hydraSource) {
      throw new Error('Hydra not loaded. Call async initialize() first.');
    }

    const settings = context?.settings;
    const width = settings?.width || 800;
    const height = settings?.height || 600;

    const violations = [
      ...findGeneratedCodeViolations(layer.code),
      ...findDangerousHydraCodePatterns(layer.code),
    ];
    if (violations.length > 0) {
      Logger.warn('HydraAdapter', `Blocked unsafe Hydra layer code: ${violations.join(', ')}`);
    }

    const imports = context?.state.get<Record<string, unknown>>(`__imports_${layer.id}`);
    const script = `${importsPrelude(imports)}
(function () {
  var canvas = document.createElement('canvas');
  canvas.width = ${width}; canvas.height = ${height};
  canvas.style.width = '100%'; canvas.style.height = '100%';
  document.body.appendChild(canvas);
  var hydra = new Hydra({ canvas: canvas, autoLoop: true, makeGlobal: true, detectAudio: false, width: ${width}, height: ${height} });
  window.__s1ntrReport({ width: ${width}, height: ${height} });
${layer.code}
})();`;

    const instance = mountGuardedFrame(container, violations, {
      libs: [hydraSource],
      script,
      width,
      height,
      transparent: layer.config.transparentBackground,
      title: `Hydra layer ${layer.id}`,
    });
    this.instances.get(layer.id)?.destroy();
    this.instances.set(layer.id, instance);
    return instance;
  }

  /**
   * Get exports from a Hydra layer.
   *
   * Only plain data crosses the sandbox boundary, so the canvas and output
   * handles (o0-o3) are no longer exported.
   */
  getExports(layer: Layer): Export[] {
    const instance = this.instances.get(layer.id);
    if (!instance) return [];
    const read = (key: string) => () => instance.state[key];

    return [
      { name: 'width', type: 'number', getter: read('width'), description: 'Canvas width' },
      { name: 'height', type: 'number', getter: read('height'), description: 'Canvas height' },
    ];
  }

  /**
   * Get imports that Hydra layers can use from other layers.
   * 
   * Hydra can use canvas outputs from other visual layers as sources.
   * 
   * @returns Array of import definitions
   */
  getImports(): Import[] {
    // Hydra can import from other visual layers to use as sources
    return [
      {
        from: 'p5',
        name: 'canvas',
        as: 'p5Canvas',
        required: false,
      },
      {
        from: 'three',
        name: 'canvas',
        as: 'threeCanvas',
        required: false,
      },
    ];
  }

  /**
   * Destroy/cleanup a Hydra layer instance: removes the sandbox frame.
   *
   * @param layer - The layer to destroy
   * @param _instance - The instance to cleanup (unused, we track internally)
   */
  destroy(layer: Layer, _instance: unknown): void {
    const instance = this.instances.get(layer.id);
    if (instance) {
      instance.destroy();
      this.instances.delete(layer.id);
    }
  }

  /**
   * Validate Hydra layer code.
   * 
   * Checks for required Hydra syntax and common errors.
   * 
   * @param layer - The layer to validate
   * @returns Validation result with optional errors
   */
  validate(layer: Layer): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const code = layer.code;

    if (!code || code.trim().length === 0) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    // Check for required .out() call
    if (!code.includes('.out(') && !code.includes('.out()')) {
      errors.push('Hydra code MUST end with .out() to render');
    }

    // Check for source function
    const sourceFunctions = ['osc(', 'src(', 'noise(', 'shape(', 'gradient(', 'solid(', 'voronoi('];
    const hasSource = sourceFunctions.some(fn => code.includes(fn));
    if (!hasSource) {
      errors.push('Hydra code should use a source function: osc(), src(), noise(), shape(), gradient(), solid(), voronoi()');
    }

    // Check for invalid method chains
    const invalidMethods = ['.sin(', '.cos(', '.tan('];
    for (const method of invalidMethods) {
      if (code.includes(method)) {
        errors.push(`Hydra code contains invalid method: ${method} - use math functions differently in Hydra`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Generate standalone HTML script for a Hydra layer.
   * 
   * @param layer - The layer to generate script for
   * @param _settings - Global settings (unused for basic Hydra)
   * @returns HTML script string
   */
  generateScript(layer: Layer, _settings: GlobalSettings): string {
    return `
<!-- Hydra -->
<script src="${VENDOR_ASSETS.hydra}"></script>
<script>
(function() {
  const container = document.createElement('div');
  container.className = 'layer';
  container.style.zIndex = ${layer.config.zIndex};
  document.getElementById('composition').appendChild(container);
  
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.appendChild(canvas);
  
  const hydra = new Hydra({
    canvas: canvas,
    autoLoop: true,
    makeGlobal: true
  });
  
${scriptSafe(layer.code).split('\n').map(line => '  ' + line).join('\n')}
})();
</script>`;
  }
}

/** Singleton instance */
export const hydraAdapter = new HydraAdapter();
