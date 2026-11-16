/**
 * ThreeGenerator - Three.js generation with tier-based prompts
 */

import { TierBasedGenerator, type TierBasedGeneratorOptions } from '../TierBasedGenerator.js';
import { THREE_CDN } from '../../constants/index.js';
import { ThreeValidator } from '../../core/validators/ThreeValidator.js';
import { fencedBlocks, pickCodeBlock, splitThinking } from '../../llm/ModelOutput.js';
import { scriptSafe } from '../../utils/scriptEmbed.js';

export class ThreeGenerator extends TierBasedGenerator {
  constructor(llmOrConfig?: ConstructorParameters<typeof TierBasedGenerator>[1]) {
    super('three', llmOrConfig);
  }

  async generate(prompt: string, options?: TierBasedGeneratorOptions): Promise<string> {
    const threePrompt = [
      prompt,
      '',
      'Return complete executable raw Three.js scene code only. Do not return a full HTML document.',
      'Do not return prose, design notes, markdown, excerpts, or partial snippets.',
      'Begin immediately with executable code such as const scene = new THREE.Scene();.',
      'Keep the scene concise: under 140 lines of JavaScript.',
      'The output must include THREE.Scene, THREE.WebGLRenderer, visible geometry/materials, and requestAnimationFrame or renderer.render.',
      'Do not include import statements; the gallery wrapper imports THREE.',
      'Use only the core Three.js module. Do not import OrbitControls or examples modules.',
      'Animate the camera manually with sin/cos in the render loop instead of using controls.',
      'Do not use ellipses, TODO comments, placeholder comments, or phrases like setup renderer, crystals, particles, or animation loop without implementing them.',
      'Include visible geometry, lights, camera, renderer setup, and a requestAnimationFrame render loop.',
      'CRITICAL: If you define a named render-loop function (e.g. function animate()), you MUST call it at the end of the script to start the animation. For example: append "animate();" as the last line. Never leave the animation function defined but uncalled — an uncalled function produces a blank scene.',
      'Do NOT add debug helpers or gizmos: no THREE.AxesHelper, THREE.GridHelper, THREE.PolarGridHelper, or any THREE.*Helper. The scene must read as finished art, not a debug viewport with an axis cross.',
      'EXPOSURE DISCIPLINE (critical — Three.js r152+ is physically correct and blows out without tone mapping):',
      '  1) After creating the WebGLRenderer, set renderer.toneMapping = THREE.ACESFilmicToneMapping and renderer.toneMappingExposure = 1.0 (range 0.8-1.2 only).',
      '  2) AmbientLight intensity 0.25-0.6 (numeric). Never Math.PI ambient and never ambient > 1.0.',
      '  3) Key DirectionalLight/PointLight intensity 0.8-2.0; fill/rim ≤ 1.0. Never intensities ≥ 3.0 — they clip MeshStandardMaterial to pure white without recoverable subject detail.',
      '  4) Floor/ground planes must use dark or mid-tone materials (e.g. 0x1a2430-0x3a4a5a), never near-white unlit floors that fill the frame.',
      '  5) Frame the camera so the primary subject is readable (not buried inside geometry, not a white plane filling >70% of the view).',
      '  The render must show readable geometry with mid-tones and dark anchors — never blown-out white, never murky near-black.',
      'Set a DEEP MID-TONE scene.background or renderer.setClearColor — a rich slate, indigo, charcoal, or deep teal (luminance roughly in the 0x2e3850 to 0x556070 range). Two hard rules: never near-white or pale (e.g. 0xdde8f0, 0xf0f0f0, 0xcccccc) — a pale background washes the entire frame to white and fails the render check; and never pure black or near-black (0x000000-0x141414) — keep the background a visible deep tone the lit subject reads against.',
      'Material colors carry the subject: give the primary geometry mid-tone or bright, saturated material colors (e.g. 0x4f9dde, 0xe2a14b). Never make EVERY material near-black (0x111111-class) — a dark subject is invisible no matter how strong the lights are.',
      'Size the renderer to FILL the whole viewport: renderer.setSize(window.innerWidth, window.innerHeight); set camera.aspect = window.innerWidth / window.innerHeight then camera.updateProjectionMatrix(); add a window "resize" handler updating both. NEVER hard-code renderer.setSize to fixed pixel numbers like setSize(600, 400) — the canvas must fill the entire frame, not sit in a corner with black margins.',
    ].join('\n');
    const code = await super.generate(threePrompt, options);
    return this.sanitizeThreeCode(code);
  }

  /**
   * Three.js-specific validation
   */
  protected validateOutput(code: string): { valid: boolean; error?: string } {
    if (/<!DOCTYPE\s+html/i.test(code) || /<html[\s>]/i.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output must be raw scene JavaScript, not a full HTML document',
      };
    }

    code = this.sanitizeThreeCode(code);
    // Three.js code should reference THREE
    const hasThree = code.includes('THREE') || 
                     code.includes('import * as THREE') ||
                     code.includes('from "three"') ||
                     code.includes("from 'three'");
    
    if (!hasThree) {
      return {
        valid: false,
        error: 'Generated code does not appear to use Three.js',
      };
    }

    if (this.isLikelyTruncated(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output appears incomplete or truncated',
      };
    }

    if (/\bOrbitControls\b/.test(code) || /examples\/jsm\//.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output must not import OrbitControls or examples modules; animate the camera manually',
      };
    }

    if (/\.\.\.|TODO|setup renderer|animation loop|\/\/\s*(?:Crystals|Particles)\s*$/im.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output contains placeholder comments instead of complete scene code',
      };
    }

    if (!/\brequestAnimationFrame\s*\(/.test(code) && !/\brenderer\.render\s*\(/.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output must include a render loop or renderer.render call',
      };
    }

    // Reject nested HTML documents inside helper script blocks; these create
    // malformed wrapper-on-wrapper artifacts instead of a single runnable scene.
    if (/<script[\s\S]*?<!DOCTYPE\s+html/i.test(code) || /<script[\s\S]*?<html[\s>]/i.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output must not embed a second HTML document inside a <script> block',
      };
    }

    // Reject debug helpers/gizmos (AxesHelper, GridHelper, any THREE.*Helper) — they
    // leave an axis cross / grid through finished art. The retry loop regenerates without them.
    if (/\bTHREE\.[A-Za-z0-9]*Helper\b/.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output must not add debug helpers/gizmos (THREE.AxesHelper, GridHelper, or any *Helper); produce finished art without a debug axis cross',
      };
    }

    // Reject a hard-coded fixed renderer size with no viewport sizing — it leaves the
    // canvas in a corner with black margins instead of filling the frame. Force
    // full-viewport sizing (window.innerWidth/innerHeight) via the retry loop.
    if (/\.setSize\s*\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)/.test(code) &&
        !/\b(?:innerWidth|innerHeight|clientWidth|clientHeight)\b/.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output must size the renderer to the full viewport (renderer.setSize(window.innerWidth, window.innerHeight)), not fixed pixel dimensions; the canvas must fill the entire frame',
      };
    }

    // `new THREE.WebGLRenderer({ canvas })` with no `canvas` declared throws a
    // ReferenceError in the page and renders nothing (live matrix 2026-11-10).
    // Reject it here so the repair turn fixes it before render.
    if (/\bcanvas\s*(?::\s*canvas\b|[,}])/.test(code)
        && !/\b(?:const|let|var|function)\s+canvas\b|[(,]\s*canvas\s*[,)=]|\bcanvas\s*=(?!=)/.test(code)) {
      return {
        valid: false,
        error: 'Generated Three.js output passes an undeclared `canvas` to WebGLRenderer; omit the canvas option and append renderer.domElement to document.body',
      };
    }

    // Surface exposure / background quality failures from ThreeValidator so the
    // generator retry loop repairs blown-out lighting before shipping.
    const qualityError = ThreeValidator.validate(code).errors.find((error) =>
      error.includes('background/clear color')
      || error.includes('toneMapping')
      || error.includes('overexposed')
      || error.includes('light intensity'),
    );
    if (qualityError) {
      return { valid: false, error: qualityError };
    }

    return { valid: true };
  }

  /**
   * Wrap Three.js scene for gallery iframe display.
   * Injects Three.js CDN and creates a self-contained scene harness.
   */
  wrapForGallery(code: string): string {
    code = this.sanitizeThreeCode(code);
    const trimmed = code.trim();
    if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
      return code;
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Three.js Scene</title>
<style>
*{margin:0;padding:0;overflow:hidden}
body{background:#000}
canvas{display:block}
</style>
</head>
<body>
<script type="importmap">
{"imports":{"three":"${THREE_CDN}"}}
</script>
<script type="module">
import*as THREE from'three';
${scriptSafe(code)}
</script>
</body>
</html>`;
  }

  private sanitizeThreeCode(code: string): string {
    const { answer } = splitThinking(code);
    const block = fencedBlocks(answer).find((candidate) => /\bTHREE\b/.test(candidate.body))
      ?? pickCodeBlock(answer, ['html', 'javascript', 'js']);
    code = block ? block.body : answer;

    const htmlScript = code.match(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i)
      || code.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (htmlScript?.[1] && /\bTHREE\b/.test(htmlScript[1])) {
      code = htmlScript[1]
        .replace(/^\s*import\s+.*?\bTHREE\b.*?from\s+['"][^'"]+['"];?\s*$/gm, '')
        .trim();
    } else {
      code = code
        .replace(/^\s*import\s+.*?\bTHREE\b.*?from\s+['"][^'"]+['"];?\s*$/gm, '')
        .trim();
    }

    // Safety net: if a named render-loop function is defined but never called,
    // auto-inject the call so the scene animates instead of rendering blank.
    const fnMatch = code.match(/\bfunction\s+(animate|render|loop)\s*\(/);
    if (fnMatch && !new RegExp(`\\b${fnMatch[1]}\\s*\\(\\s*\\)`).test(code)) {
      code = code.trimEnd() + `\n${fnMatch[1]}();\n`;
    }

    return code;
  }

  private isLikelyTruncated(code: string): boolean {
    const stripped = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const openBraces = (stripped.match(/\{/g) || []).length;
    const closeBraces = (stripped.match(/\}/g) || []).length;
    const openParens = (stripped.match(/\(/g) || []).length;
    const closeParens = (stripped.match(/\)/g) || []).length;
    if (openBraces !== closeBraces || openParens !== closeParens) return true;
    const trimmed = stripped.trim();
    if (/\bTHREE\.[A-Za-z_][\w$]*$/.test(trimmed)) return true;
    return false;
  }
}
