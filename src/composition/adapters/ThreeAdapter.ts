/**
 * ThreeAdapter - Adapter for Three.js 3D layers.
 *
 * Renders Three.js scenes in a container and exposes 3D scene properties
 * for cross-layer communication. Supports camera position exports and
 * mouse coordinate imports from p5 for camera control.
 *
 * SECURITY: generated Three.js code is untrusted. It never runs in the host
 * realm: it is mounted in a sandboxed iframe (see sandboxFrame.ts, #1533).
 * GeneratedCodeGuard and the pattern list below are pre-checks that refuse to
 * mount; the iframe is the boundary.
 *
 * @example
 * ```typescript
 * const adapter = new ThreeAdapter();
 * await adapter.initialize();
 * const instance = adapter.render(layer, container, context);
 * const exports = adapter.getExports(layer);
 * adapter.destroy(layer, instance);
 * ```
 */

import type { Layer, GlobalSettings } from '../types.js';
import type { LayerAdapter, Export, Import } from './index.js';
import type { RenderContext } from '../CompositionEngine.js';
import { VENDOR_ASSETS } from '../../utils/vendorAssets.js';
import { findGeneratedCodeViolations } from '../../guardrails/GeneratedCodeGuard.js';
import { importsPrelude, loadSandboxLib, mountGuardedFrame, type SandboxedInstance } from './sandboxFrame.js';
import { scriptSafe } from '../../utils/scriptEmbed.js';

const DANGEROUS_THREE_CODE_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
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

function findDangerousThreeCodePatterns(code: string): string[] {
  return DANGEROUS_THREE_CODE_PATTERNS
    .filter(({ pattern }) => pattern.test(code))
    .map(({ name }) => name);
}

/**
 * Adapter for rendering Three.js 3D scenes in a composition layer.
 *
 * Implements the LayerAdapter interface for the 'three' domain type.
 * The scene, camera and renderer live inside a sandboxed iframe; the host
 * sees camera position and scene contents as mirrored plain data.
 */
export class ThreeAdapter implements LayerAdapter {
  private threeSource?: string;
  private instances = new Map<string, SandboxedInstance>();

  /** Load the vendored Three.js source that is inlined into each sandbox frame. */
  async initialize(): Promise<void> {
    if (!this.threeSource) this.threeSource = await loadSandboxLib(VENDOR_ASSETS.threeGlobal);
  }

  /**
   * Render the Three.js layer into a container.
   *
   * @throws Error if Three.js is not loaded (call initialize() first) or the
   *   code is blocked by the pre-check (a rejected candidate must throw so a
   *   working layer is kept).
   */
  render(layer: Layer, container: HTMLElement, context?: RenderContext): SandboxedInstance {
    const threeSource = this.threeSource;
    if (!threeSource) {
      throw new Error('Three.js not loaded. Call initialize() first.');
    }

    const settings = context?.settings;
    const width = settings?.width || 800;
    const height = settings?.height || 600;
    const isTransparent = Boolean(layer.config.transparentBackground);

    const violations = [
      ...findGeneratedCodeViolations(layer.code),
      ...findDangerousThreeCodePatterns(layer.code),
    ];
    if (violations.length > 0) {
      throw new Error(`Blocked unsafe Three.js layer code: ${violations.join(', ')}`);
    }

    const imports = context?.state.get<Record<string, unknown>>(`__imports_${layer.id}`);
    // The generated code runs inside a function so it may redeclare these names.
    const script = `${importsPrelude(imports)}
(function () {
  var width = ${width}, height = ${height};
  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  var renderer = new THREE.WebGLRenderer({ alpha: ${isTransparent} });
  renderer.setSize(width, height);
  ${isTransparent ? 'renderer.setClearColor(0x000000, 0);' : ''}
  document.body.appendChild(renderer.domElement);
  var objects = [];
  var RealMesh = THREE.Mesh;
  var TrackedMesh = function (geometry, material) { var m = new RealMesh(geometry, material); objects.push(m); return m; };
  TrackedMesh.prototype = RealMesh.prototype;
  var trackedThree = Object.assign({}, THREE, { Mesh: TrackedMesh });
  (function (THREE, scene, camera, renderer, objects, width, height) {
${layer.code}
  })(trackedThree, scene, camera, renderer, objects, width, height);
  function frame() {
    renderer.render(scene, camera);
    window.__s1ntrReport({
      cameraX: camera.position.x, cameraY: camera.position.y, cameraZ: camera.position.z,
      sceneObjects: scene.children.map(function (c) { return c.type || 'Object3D'; })
    });
    requestAnimationFrame(frame);
  }
  frame();
})();`;

    const instance = mountGuardedFrame(container, violations, {
      libs: [threeSource],
      script,
      width,
      height,
      transparent: isTransparent,
      title: `Three.js layer ${layer.id}`,
    });
    // Replacing a layer: the previous working frame stays mounted and exported
    // until the new frame reports its first frame. A replacement that throws
    // inside the frame is discarded and the working layer is kept (#1533 review).
    const previous = this.instances.get(layer.id);
    if (!previous) {
      this.instances.set(layer.id, instance);
      return instance;
    }
    if (instance.iframe) instance.iframe.style.visibility = 'hidden';
    instance.whenSettled((ok) => {
      if (this.instances.get(layer.id) !== previous) { instance.destroy(); return; }
      if (ok) {
        if (instance.iframe) instance.iframe.style.visibility = '';
        previous.destroy();
        this.instances.set(layer.id, instance);
      } else {
        instance.destroy();
      }
    });
    return instance;
  }

  /**
   * Get exports for this layer: camera position and scene contents, as data
   * mirrored out of the sandbox frame.
   */
  getExports(layer: Layer): Export[] {
    const instance = this.instances.get(layer.id);
    if (!instance) return [];
    const read = (key: string) => () => instance.state[key];

    return [
      { name: 'cameraX', type: 'number', getter: read('cameraX'), description: 'Camera X position' },
      { name: 'cameraY', type: 'number', getter: read('cameraY'), description: 'Camera Y position' },
      { name: 'cameraZ', type: 'number', getter: read('cameraZ'), description: 'Camera Z position' },
      { name: 'sceneObjects', type: 'object', getter: read('sceneObjects'), description: 'Types of the objects in the scene' },
    ];
  }

  /**
   * Get imports that this layer needs.
   *
   * Requests mouseX and mouseY from p5 layers for camera control.
   * These are mapped to cameraControlX and cameraControlY aliases.
   *
   * @param _layer - The layer to get imports for (unused but required by interface)
   * @returns Array of import definitions
   */
  getImports(_layer: Layer): Import[] {
    // Three.js can import from p5 for camera control
    return [
      {
        from: 'p5',
        name: 'mouseX',
        as: 'cameraControlX',
        required: false,
      },
      {
        from: 'p5',
        name: 'mouseY',
        as: 'cameraControlY',
        required: false,
      },
    ];
  }

  /**
   * Destroy/cleanup layer instance: removes the sandbox frame.
   *
   * @param layer - The layer to destroy
   * @param _instance - The instance to destroy (unused - retrieved from internal map)
   */
  destroy(layer: Layer, _instance?: unknown): void {
    const instance = this.instances.get(layer.id);
    if (instance) {
      instance.destroy();
      this.instances.delete(layer.id);
    }
  }

  /**
   * Validate layer code.
   *
   * Checks that the layer code contains required Three.js components:
   * - THREE.Scene
   * - THREE.PerspectiveCamera
   * - THREE.WebGLRenderer
   *
   * @param layer - The layer to validate
   * @returns Validation result with valid flag and optional error messages
   */
  validate(layer: Layer): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    
    if (!layer.code.includes('THREE.Scene')) {
      errors.push('Missing THREE.Scene creation');
    }
    if (!layer.code.includes('THREE.PerspectiveCamera')) {
      errors.push('Missing THREE.PerspectiveCamera creation');
    }
    if (!layer.code.includes('THREE.WebGLRenderer')) {
      errors.push('Missing THREE.WebGLRenderer creation');
    }
    
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Generate standalone script for HTML export.
   *
   * Creates a self-contained HTML script that:
   * - Loads Three.js from CDN
   * - Creates a container element
   * - Executes the layer code
   *
   * @param layer - The layer to generate script for
   * @param _settings - Global settings (unused but required by interface)
   * @returns HTML script string
   */
  generateScript(layer: Layer, _settings: GlobalSettings): string {
    const transparentStyle = layer.config.transparentBackground
      ? "  container.style.background = 'transparent';\n"
      : '';
    const blendStyle = layer.config.blendMode !== 'normal'
      ? `  container.style.mixBlendMode = '${layer.config.blendMode}';\n`
      : '';

    return `
<!-- Three.js -->
<script src="${VENDOR_ASSETS.threeGlobal}"></script>
<script>
(function() {
  const container = document.createElement('div');
  container.className = 'layer';
  container.style.zIndex = ${layer.config.zIndex};
  container.style.opacity = ${layer.config.opacity};
${transparentStyle}${blendStyle}  document.getElementById('composition').appendChild(container);

${scriptSafe(layer.code).split('\n').map(line => '  ' + line).join('\n')}
})();
</script>`;
  }
}

/** Singleton instance for convenient access */
export const threeAdapter = new ThreeAdapter();
