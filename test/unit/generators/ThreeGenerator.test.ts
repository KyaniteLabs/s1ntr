import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockToolLoop, mockGetConfig } = vi.hoisted(() => ({
  mockToolLoop: vi.fn().mockResolvedValue({
    content: 'const scene = new THREE.Scene();\nconst renderer = new THREE.WebGLRenderer();\nrenderer.render(scene, new THREE.PerspectiveCamera());',
    iterations: 1,
    toolCallsMade: 0,
    success: true,
  }),
  mockGetConfig: vi.fn().mockReturnValue({ model: 'test-model', baseUrl: 'http://localhost:1234/v1' }),
}));

vi.mock('../../../src/llm/LLMClient.js', () => {
  class MockLLMClient {
    generateWithToolLoop = mockToolLoop;
    getConfig = mockGetConfig;
  }
  (MockLLMClient as any).isConfigured = vi.fn().mockReturnValue(true);
  return { LLMClient: MockLLMClient };
});

vi.mock('../../../src/config/ConfigLoader.js', () => ({
  getEffectiveConfig: vi.fn().mockResolvedValue({ baseUrl: '', model: '', apiKey: '' }),
}));

vi.mock('../../../src/llm/PromptBuilder.js', () => ({
  PromptBuilder: class {
    build = vi.fn().mockReturnValue({ system: 'sys', user: 'usr', combined: 'combined' });
    static loadContext = vi.fn().mockResolvedValue({});
  },
}));

vi.mock('../../../src/harness/HarnessMemory.js', () => ({
  harnessMemory: {
    recordEpisode: vi.fn(),
    getSuccessfulAdaptations: vi.fn().mockReturnValue([]),
    getRecentEpisodes: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../../src/harness/MetaHarnessIntegration.js', () => ({
  metaHarness: { onGenerationComplete: vi.fn() },
}));

vi.mock('../../../src/harness/tools/generator-tools.js', () => ({
  GENERATOR_TOOLS: [],
  createGeneratorToolExecutor: vi.fn().mockReturnValue(async () => 'ok'),
}));

import { ThreeGenerator } from '../../../src/generators/three/ThreeGenerator.js';
import { PromptBuilder } from '../../../src/llm/PromptBuilder.js';
import { PromptLibrary } from '../../../src/prompts/index.js';
import { SERVICE_DEFAULTS } from '../../../src/constants/index.js';

class TestableThreeGenerator extends ThreeGenerator {
  validateForTest(code: string) {
    return this.validateOutput(code);
  }
}

describe('ThreeGenerator', () => {
  beforeEach(() => {
    mockToolLoop.mockClear();
  });

  it('constructs with three domain', () => {
    const gen = new ThreeGenerator();
    const info = gen.getTierInfo();
    expect(info.domain).toBe('three');
  });

  it('wrapForGallery wraps bare Three.js code in HTML with importmap', () => {
    const gen = new ThreeGenerator();
    const wrapped = gen.wrapForGallery('const s = new THREE.Scene();');
    expect(wrapped).toContain('<!DOCTYPE html>');
    expect(wrapped).toContain('importmap');
    expect(wrapped).toContain('/vendor/three/0.160.0/three.module.js'); // vendored (#924)
    expect(wrapped).toContain('import*as THREE');
  });

  it('registered prompt and wrapper agree on raw scene JavaScript plus the Three version', () => {
    const gen = new ThreeGenerator();
    const prompt = PromptLibrary.get('three.generate');
    const wrapped = gen.wrapForGallery('const scene = new THREE.Scene();');

    expect(prompt?.systemPrompt).toContain('raw Three.js scene JavaScript');
    expect(prompt?.systemPrompt).not.toContain('Return raw HTML');
    expect(prompt?.systemPrompt).not.toContain('Include OrbitControls');
    expect(prompt?.metadata?.defaultThreeVersion).toBe(SERVICE_DEFAULTS.THREE_VERSION);
    expect(wrapped).toContain(`/vendor/three/${SERVICE_DEFAULTS.THREE_VERSION}/three.module.js`); // vendored (#924)
  });

  it('wrapForGallery extracts script from existing DOCTYPE HTML with Three code', () => {
    const gen = new ThreeGenerator();
    const html = '<!DOCTYPE html><html><body><script>THREE.Scene()</script></body></html>';
    const wrapped = gen.wrapForGallery(html);
    expect(wrapped).toContain('<!DOCTYPE html>');
    expect(wrapped).toContain('import*as THREE');
    expect(wrapped).toContain('THREE.Scene()');
    expect(wrapped).not.toContain('<script>THREE.Scene()</script></body></html>');
  });

  it('wrapForGallery detects <html> tag and returns unchanged', () => {
    const gen = new ThreeGenerator();
    const html = '<html><body>scene</body></html>';
    const wrapped = gen.wrapForGallery(html);
    expect(wrapped).toBe(html);
  });

  it('wrapForGallery strips fenced full HTML before detection', () => {
    const gen = new ThreeGenerator();
    const html = '```html\n<!DOCTYPE html><html><body>scene</body></html>\n```';
    const wrapped = gen.wrapForGallery(html);
    expect(wrapped).toBe('<!DOCTYPE html><html><body>scene</body></html>');
  });

  it('wrapForGallery removes duplicate Three imports from extracted HTML scripts', () => {
    const gen = new ThreeGenerator();
    const html = '<!DOCTYPE html><html><body><script type="module">import * as THREE from "three";\nconst scene = new THREE.Scene();</script></body></html>';
    const wrapped = gen.wrapForGallery(html);
    expect(wrapped).toContain('const scene = new THREE.Scene();');
    expect(wrapped).not.toContain('import * as THREE from "three";');
  });

  it('extracts fenced Three scene code from explanatory output', () => {
    const gen = new ThreeGenerator();
    const wrapped = gen.wrapForGallery(`Here is the scene:
\`\`\`javascript
import * as THREE from "three";
const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer();
renderer.render(scene, new THREE.PerspectiveCamera());
\`\`\``);
    expect(wrapped).toContain('const scene = new THREE.Scene();');
    expect(wrapped).not.toContain('Here is the scene');
    expect(wrapped).not.toContain('import * as THREE from "three";');
  });

  it('rejects OrbitControls example imports for proof stability', () => {
    const gen = new TestableThreeGenerator();
    const result = gen.validateForTest("import { OrbitControls } from 'https://unpkg.com/three/examples/jsm/controls/OrbitControls.js'; new THREE.Scene();");
    expect(result.valid).toBe(false);
    expect(result.error).toContain('OrbitControls');
  });

  it('rejects full HTML documents during generation validation', () => {
    const gen = new TestableThreeGenerator();
    const result = gen.validateForTest('<!DOCTYPE html><html><body><script>new THREE.Scene()</script></body></html>');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('raw scene JavaScript');
  });

  it('rejects truncated Three.js output before preview', () => {
    const gen = new TestableThreeGenerator();
    const result = gen.validateForTest('const scene = new THREE.Scene();\nconst mat = new THREE.PointsMaterial({\n  blending: THREE.Add');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('incomplete or truncated');
  });

  it('rejects placeholder comments instead of complete scene code', () => {
    const gen = new TestableThreeGenerator();
    const result = gen.validateForTest('const scene = new THREE.Scene();\nconst renderer = new THREE.WebGLRenderer();\n// ... setup renderer ...\n// Crystals\n// Animation loop');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('placeholder comments');
  });

  it('generates code via super.generate', async () => {
    mockToolLoop.mockResolvedValueOnce({
      content: 'import * as THREE from "three";\nconst scene = new THREE.Scene();\nconst renderer = new THREE.WebGLRenderer();\nrenderer.render(scene, new THREE.PerspectiveCamera());',
      iterations: 1, toolCallsMade: 0, success: true,
    });
    const gen = new ThreeGenerator();
    const result = await gen.generate('create a 3D scene');
    expect(result).toContain('THREE');
    expect(result).not.toContain('import * as THREE');
  });

  it('rejects debug helpers (THREE.AxesHelper) so finished art has no axis cross', () => {
    const gen = new TestableThreeGenerator();
    const code = [
      'const scene = new THREE.Scene();',
      'scene.add(new THREE.AxesHelper(5));',
      'renderer.render(scene, camera);',
    ].join('\n');
    const result = gen.validateForTest(code);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('debug helpers');
  });

  it('rejects a hard-coded fixed renderer size (must fill the full viewport)', () => {
    const gen = new TestableThreeGenerator();
    const code = [
      'const scene = new THREE.Scene();',
      'const renderer = new THREE.WebGLRenderer();',
      'renderer.setSize(600, 400);',
      'renderer.render(scene, camera);',
    ].join('\n');
    const result = gen.validateForTest(code);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('full viewport');
  });

  it('accepts a renderer sized to the viewport (window.innerWidth/innerHeight)', () => {
    const gen = new TestableThreeGenerator();
    const code = [
      'const scene = new THREE.Scene();',
      'scene.background = new THREE.Color(0x3a4a66);',
      'const renderer = new THREE.WebGLRenderer();',
      'renderer.toneMapping = THREE.ACESFilmicToneMapping;',
      'renderer.toneMappingExposure = 1.0;',
      'scene.add(new THREE.AmbientLight(0xffffff, 0.4));',
      'renderer.setSize(window.innerWidth, window.innerHeight);',
      'renderer.render(scene, camera);',
    ].join('\n');
    const result = gen.validateForTest(code);
    expect(result.error ?? '').not.toContain('full viewport');
  });

  it('rejects a renderer bound to an undeclared canvas (live: ReferenceError, blank render)', () => {
    const gen = new TestableThreeGenerator();
    const scene = (rendererLine: string, extra: string[] = []) => [
      'const scene = new THREE.Scene();',
      ...extra,
      rendererLine,
      'renderer.setSize(window.innerWidth, window.innerHeight);',
      'renderer.render(scene, camera);',
    ].join('\n');
    expect(gen.validateForTest(scene('const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });')).error)
      .toContain('undeclared `canvas`');
    expect(gen.validateForTest(scene('const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });')).error)
      .toContain('undeclared `canvas`');
    const declared = gen.validateForTest(scene('const renderer = new THREE.WebGLRenderer({ canvas: canvas });',
      ["const canvas = document.createElement('canvas');", 'document.body.appendChild(canvas);']));
    expect(declared.error ?? '').not.toContain('undeclared');
    const param = gen.validateForTest(scene('function mk(canvas, w) { return new THREE.WebGLRenderer({ canvas, antialias: true }); }',
      ["const renderer = mk(document.body.appendChild(document.createElement('canvas')), 1);"]));
    expect(param.error ?? '').not.toContain('undeclared');
  });

  it('rejects campaign-style overexposure (high lights, no tone mapping)', () => {
    const gen = new TestableThreeGenerator();
    const code = [
      'const scene = new THREE.Scene();',
      'scene.background = new THREE.Color(0x2a3447);',
      'const renderer = new THREE.WebGLRenderer();',
      'renderer.setSize(window.innerWidth, window.innerHeight);',
      'scene.add(new THREE.AmbientLight(0xcce0ff, Math.PI * 0.55));',
      'scene.add(new THREE.DirectionalLight(0xfff0e0, 6.0));',
      'const mat = new THREE.MeshStandardMaterial({ color: 0xe8a040 });',
      'scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));',
      'function animate() { requestAnimationFrame(animate); renderer.render(scene, camera); }',
      'animate();',
    ].join('\n');
    const result = gen.validateForTest(code);
    expect(result.valid).toBe(false);
    expect(result.error ?? '').toMatch(/toneMapping|overexposed|light intensity/);
  });

  it('generate prompt injects exposure discipline (tone mapping + intensity bounds)', async () => {
    mockToolLoop.mockResolvedValueOnce({
      content: [
        'const scene = new THREE.Scene();',
        'const renderer = new THREE.WebGLRenderer();',
        'renderer.toneMapping = THREE.ACESFilmicToneMapping;',
        'renderer.toneMappingExposure = 1.0;',
        'renderer.setSize(window.innerWidth, window.innerHeight);',
        'scene.add(new THREE.AmbientLight(0xffffff, 0.4));',
        'scene.add(new THREE.DirectionalLight(0xffffff, 1.2));',
        'const mat = new THREE.MeshStandardMaterial({ color: 0xe8a040 });',
        'scene.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1), mat));',
        'function animate(){ requestAnimationFrame(animate); renderer.render(scene, camera); }',
        'animate();',
      ].join('\n'),
      iterations: 1, toolCallsMade: 0, success: true,
    });
    const loadSpy = vi.spyOn(PromptBuilder, 'loadContext').mockResolvedValue({} as any);
    const gen = new ThreeGenerator();
    await gen.generate('create a 3D scene');
    // ThreeGenerator.generate() expands the user prompt with exposure rails before
    // PromptBuilder.loadContext — that expanded string is what the LLM sees.
    expect(loadSpy).toHaveBeenCalledTimes(2);
    const expandedPrompt = String(loadSpy.mock.calls[0]?.[1] ?? '');
    expect(expandedPrompt).toContain('ACESFilmicToneMapping');
    expect(expandedPrompt).toMatch(/0\.8-2\.0/);
    expect(expandedPrompt).toMatch(/0\.25-0\.6/);
    expect(expandedPrompt).not.toMatch(/roughly 3\.0-10\.0/);
    loadSpy.mockRestore();
  });
});
