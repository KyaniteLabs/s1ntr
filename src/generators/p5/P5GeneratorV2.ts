/**
 * P5GeneratorV2 - Tier-based p5.js generation
 * 
 * Uses ModelTier detection to adapt prompt style based on capability
 */

import { TierBasedGenerator, type TierBasedGeneratorOptions } from '../TierBasedGenerator.js';
import { P5Validator } from '../../core/validators/P5Validator.js';
import { Logger } from '../../utils/Logger.js';
import { VENDOR_ASSETS } from '../../utils/vendorAssets.js';

export type P5GeneratorV2Options = TierBasedGeneratorOptions;

const P5_VISIBILITY_RULES = [
  'Generate raw runnable p5.js JavaScript only; no markdown, prose, HTML shell, or code fences.',
  'For screenshot proof, keep the frame balanced: include visible dark/mid-tone regions plus bright accents, never a mostly white, pale-gray, or fogged canvas.',
  'Full-canvas composition required: distribute subject mass across the frame; do not leave most of the canvas empty with a sparse corner cluster.',
  'Particle/point fields: use enough elements (≥120), size upper bound ≥12px, high subject alpha on dark grounds, and soft glow/halos (larger low-alpha ellipse under bright cores). Dim low-alpha dots on near-black are a failure.',
  'If you use glow, keep strokeWeight bounded (usually 1-16px, at most 24px). Do not set strokeWeight from a radius/diameter variable or canvas size such as r * 0.8, gradR * 0.9, width * 0.5, or height * 0.5.',
  'Do not cover most of the canvas with near-white fills or oversized translucent strokes; make the subject readable against its ground.',
];

export class P5GeneratorV2 extends TierBasedGenerator {
  constructor(llmOrConfig?: ConstructorParameters<typeof TierBasedGenerator>[1]) {
    super('p5', llmOrConfig);
  }

  async generate(prompt: string, options?: P5GeneratorV2Options): Promise<string> {
    // Check if prompt suggests sound for additional context
    const needsSound = this.promptSuggestsSound(prompt.toLowerCase());
    if (needsSound) {
      Logger.info('P5GeneratorV2', 'Sound detected in prompt, will include audio guidance');
    }
    
    const p5Prompt = [
      ...P5_VISIBILITY_RULES,
      '',
      `User request: ${prompt}`,
    ].join('\n');
    const code = await super.generate(p5Prompt, options);
    return this.sanitizeP5Code(code);
  }

  /**
   * P5-specific validation
   */
  protected validateOutput(code: string): { valid: boolean; error?: string } {
    code = this.sanitizeP5Code(code);
    // Check for required p5 functions
    const hasSetup = code.includes('function setup()') || code.includes('setup()');
    // Note: draw() is optional for static sketches
    
    // p5 code should have at least setup
    if (!hasSetup) {
      return {
        valid: false,
        error: 'Generated code missing required setup() function',
      };
    }

    if (/\{[\s\n]*(?:\.\.\.|\u2026)[\s\n]*\}/.test(code) || /(?:\.\.\.|\u2026)\s*(?:\/\/|$)/m.test(code)) {
      return {
        valid: false,
        error: 'Generated code contains placeholder ellipses; return complete executable p5.js',
      };
    }

    // Check for createCanvas (usually required)
    if (!code.includes('createCanvas')) {
      Logger.warn('P5GeneratorV2', 'Code may be missing createCanvas()');
    }

    const validation = P5Validator.validate(code);
    if (!validation.valid) {
      return { valid: false, error: validation.errors.join('; ') };
    }

    const renderReliabilityIssue = this.findStaticRenderReliabilityIssue(code);
    if (renderReliabilityIssue) {
      return { valid: false, error: renderReliabilityIssue };
    }

    return { valid: true };
  }

  /**
   * Check if prompt suggests sound/audio needs
   */
  private promptSuggestsSound(lowerPrompt: string): boolean {
    const soundKeywords = ['sound', 'audio', 'music', 'beep', 'tone'];
    return soundKeywords.some((kw) => lowerPrompt.includes(kw));
  }

  private findStaticRenderReliabilityIssue(code: string): string | undefined {
    const withoutComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const oversizedGlow = this.findRadiusScaledStrokeWeight(withoutComments);
    if (oversizedGlow) {
      return `p5 screenshot reliability failed: oversized glow stroke uses strokeWeight(${oversizedGlow}) on radius-scaled ellipse geometry; use bounded strokeWeight values so the render does not wash out to near-white`;
    }
    return undefined;
  }

  private findRadiusScaledStrokeWeight(code: string): string | undefined {
    const scaledStroke = /\bstrokeWeight\s*\(\s*([A-Za-z_$][\w$]*)\s*\*\s*(0?\.\d+|[1-9]\d*(?:\.\d+)?)\s*\)/g;
    for (const match of code.matchAll(scaledStroke)) {
      const variableName = match[1];
      const scale = Number(match[2]);
      if (!Number.isFinite(scale) || scale < 0.5) continue;

      const escaped = this.escapeRegExp(variableName);
      const radiusScaledEllipse = new RegExp(
        `\\bellipse\\s*\\([^)]*\\b${escaped}\\s*\\*\\s*(?:1(?:\\.\\d+)?|[2-9]\\d*(?:\\.\\d+)?)`,
        'm'
      );
      if (radiusScaledEllipse.test(code)) {
        return `${variableName} * ${match[2]}`;
      }
    }
    return undefined;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private sanitizeP5Code(code: string): string {
    let clean = code;
    const fencedSketch = clean.match(/```(?:javascript|js)?\s*\n?([\s\S]*?)```/i);
    if (fencedSketch?.[1] && /function\s+setup\s*\(/.test(fencedSketch[1])) {
      clean = fencedSketch[1];
    } else {
      const unclosedFenceSketch = clean.match(/```(?:javascript|js)?\s*\n?([\s\S]*)/i);
      if (unclosedFenceSketch?.[1] && /function\s+setup\s*\(/.test(unclosedFenceSketch[1])) {
        clean = unclosedFenceSketch[1];
      }
    }

    clean = clean.replace(/(=\s*)#([0-9a-fA-F]{3,8})\b/g, "$1'#$2'");
    const setupColorAssignments: string[] = [];
    clean = clean.replace(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*color\(([^;]+)\);/g,
      (_match, name: string, args: string) => {
        setupColorAssignments.push(`${name} = color(${args});`);
        return `let ${name};`;
      }
    );
    if (setupColorAssignments.length > 0) {
      clean = clean.replace(
        /(createCanvas\s*\([^;]*\)\s*;?)/,
        `$1\n  ${setupColorAssignments.join('\n  ')}`
      );
    }
    return clean;
  }

  /**
   * Wrap p5.js sketch for gallery iframe display.
   * Injects p5.js CDN and creates a self-contained sketch harness.
   */
  wrapForGallery(code: string): string {
    const cleaned = code
      .replace(/^```(?:html|javascript|js)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    if (/<!DOCTYPE\s+html/i.test(cleaned) || /<html\b/i.test(cleaned)) {
      return cleaned;
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>p5.js Sketch</title>
<script src="${VENDOR_ASSETS.p5}"></script>
<style>
*{margin:0;padding:0;overflow:hidden}
body{background:#fff}
canvas{display:block}
</style>
</head>
<body>
<script>
${cleaned}
</script>
</body>
</html>`;
  }
}
