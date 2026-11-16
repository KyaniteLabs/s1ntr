/**
 * P5Validator - P5.js-specific validation logic
 *
 * Extracted from CodeValidator.ts using Strangler Fig pattern.
 * Handles validation of p5.js code including raw JS and HTML-wrapped sketches.
 */

import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { P5_GENERATED_GLOBALS } from './p5Globals.generated.js';

// Note: ValidationResult type can be imported from CodeValidator if needed for integration

export interface P5ValidationResult {
  valid: boolean;
  errors: string[];
}

export class P5Validator {
  private static readonly P5_GLOBALS = new Set<string>([
    ...P5_GENERATED_GLOBALS,
    'Array', 'Boolean', 'Date', 'Error', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Set', 'String',
    'console', 'document', 'p5', 'window',
    'FOUR_PI', 'THREE_PI', 'THREE_PI_2', 'THREE_QUARTERS_PI',
    'draw', 'drawingContext', 'setup',
    // Legit p5 globals the whitelist missed (meta-turn postmortem 2026-08-31:
    // a real piece died on noCanvas — C0_GENERATION_INVALID on a valid API).
    'isnan',
    // Web Audio API
    'AudioContext', 'OscillatorNode', 'AnalyserNode', 'GainNode',
    'Float32Array', 'Float64Array', 'Int32Array', 'Uint8Array', 'Uint32Array', 'ArrayBuffer',
    // Browser globals
    'navigator', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
    // Browser globals commonly used by generated sketches (were false-rejected
    // as undefined identifiers: performance.now(), devicePixelRatio, etc.)
    'performance', 'localStorage', 'devicePixelRatio', 'location', 'URL', 'fetch',
    'windowResized',
    // Input events + state
    'mouseClicked', 'mousePressed', 'mouseReleased', 'mouseMoved', 'mouseDragged', 'mouseWheel',
    'doubleClicked', 'keyPressed', 'keyReleased', 'keyTyped', 'touchStarted',
    'touchMoved', 'touchEnded',
  ]);


  private static readonly P5_CALLABLE_GLOBALS = new Set([
    'background', 'beginShape', 'bezier', 'bezierVertex', 'bezierPoint', 'bezierTangent', 'blendMode',
    'circle', 'color', 'colorMode', 'constrain', 'cos', 'createCanvas', 'createGraphics', 'createVector',
    'curveVertex', 'curvePoint', 'curveTangent', 'dist', 'ellipse', 'endShape', 'fill', 'image', 'lerp',
    'lerpColor', 'line', 'map', 'max', 'millis', 'min', 'nf', 'noise', 'noFill', 'noLoop', 'noStroke',
    'pixelDensity', 'point', 'pop', 'push', 'quadraticVertex', 'radians', 'random', 'rect', 'rectMode',
    'resizeCanvas', 'rotate', 'scale', 'sin', 'stroke', 'strokeWeight', 'text', 'textAlign', 'textFont',
    'textSize', 'textStyle', 'translate', 'triangle', 'vertex',
  ]);

  /**
   * p5 functions that parse a color argument. Calling any of these with the bare
   * `arguments` object (a color helper that forwards `arguments` instead of
   * `...arguments`) throws "[object Arguments] is not a valid color representation"
   * at runtime — a guaranteed-throw the generator must regenerate away from.
   */
  private static readonly COLOR_FUNCTIONS = new Set([
    'fill', 'stroke', 'background', 'color', 'colorMode', 'tint',
    'ambientLight', 'specularColor', 'lerpColor',
  ]);

  private static readonly traverseAst = (
    typeof traverseModule === 'function'
      ? traverseModule
      : (traverseModule as unknown as { default: typeof traverseModule }).default
  ) as typeof traverseModule;

  /**
   * Validate p5.js code structure
   */
  static validate(code: string): P5ValidationResult {
    const errors: string[] = [];
    const trimmed = code.trim();

    if (!trimmed) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    const isHTMLWrapped = this.isAlreadyWrapped(trimmed);

    if (isHTMLWrapped) {
      // HTML-wrapped p5 validation
      errors.push(...this.validateHTMLWrapped(trimmed));
    } else {
      // Raw JS p5 validation
      errors.push(...this.validateRawJS(trimmed));
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Check if code is HTML-wrapped
   */
  private static isAlreadyWrapped(code: string): boolean {
    const trimmed = code.trim();
    return trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html');
  }

  /**
   * Validate raw JS p5 code
   */
  private static validateRawJS(code: string): string[] {
    const errors: string[] = [];

    errors.push(...this.validateJavaScriptSyntax(code));
    if (errors.length === 0) {
      errors.push(...this.validateReferencedIdentifiers(code));
      errors.push(...this.validateColorArgs(code));
    }

    // Raw p5.js must have setup/draw/createCanvas (traditional or arrow functions)
    const hasSetup = /function\s+setup\s*\(/.test(code);
    const hasArrowSetup = /(?:const|let|var)\s+setup\s*=\s*(?:\([^)]*\)|\w+)\s*=>/.test(code);
    const hasDraw = /function\s+draw\s*\(/.test(code);
    const hasArrowDraw = /(?:const|let|var)\s+draw\s*=\s*(?:\([^)]*\)|\w+)\s*=>/.test(code);
    const hasCreateCanvas = /createCanvas\s*\(/.test(code);

    if (!hasSetup && !hasArrowSetup && !hasDraw && !hasArrowDraw && !hasCreateCanvas) {
      errors.push('p5.js code must contain at least one of: function setup(), const setup = () =>..., function draw(), const draw = () =>..., or createCanvas()');
    }

    // Raw JS should not start with <!DOCTYPE
    if (code.startsWith('<!DOCTYPE')) {
      errors.push('p5.js code looks like HTML but was detected as raw JS — unexpected');
    }

    // W6c: static dim-sparse particle guard (beauty-campaign failure mode)
    errors.push(...this.validateParticleLuminosity(code));

    return errors;
  }

  /**
   * Validate HTML-wrapped p5 code
   */
  private static validateHTMLWrapped(code: string): string[] {
    const errors: string[] = [];

    // HTML-wrapped p5 must include p5 CDN
    if (!/p5\.js|p5\.min\.js/.test(code)) {
      errors.push('HTML-wrapped p5.js must include p5.js CDN');
    }

    // Should have script tag with p5 code
    if (!/<script[^>]*>.*[\s\S]*?<\/script>/i.test(code)) {
      errors.push('HTML-wrapped p5.js should contain a <script> tag with the sketch code');
    }

    for (const scriptBody of this.extractInlineScriptBodies(code)) {
      const syntaxErrors = this.validateJavaScriptSyntax(scriptBody);
      errors.push(...syntaxErrors);
      // Audited (C4): the AST pass parses; a bad inline script must produce a
      // retry-able error, never escape as a SyntaxError crash.
      if (syntaxErrors.length === 0) {
        try {
          errors.push(...this.validateReferencedIdentifiers(scriptBody));
        } catch { /* unparseable despite the syntax gate — treated as invalid */ }
        errors.push(...this.validateColorArgs(scriptBody));
      }
    }

    return errors;
  }

  /**
   * Browser p5 sketches must be parseable JavaScript before semantic checks matter.
   */
  private static validateJavaScriptSyntax(code: string): string[] {
    try {
      parse(code, {
        sourceType: 'script',
        allowReturnOutsideFunction: false,
        plugins: ['jsx'],
      });
      return [];
    } catch (error) {
      return [`p5.js code has invalid JavaScript syntax: ${this.formatParseError(error)}`];
    }
  }

  /**
   * Flag a p5 color function called with the bare `arguments` object — a color
   * helper that forwards `arguments` instead of `...arguments`. p5 throws
   * "[object Arguments] is not a valid color representation" at runtime, so the
   * generator's validate->retry loop must regenerate. The valid spread form
   * `fill(...arguments)` is a SpreadElement (not an `arguments` Identifier) and is
   * correctly allowed.
   */
  private static validateColorArgs(code: string): string[] {
    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(code, { sourceType: 'script', allowReturnOutsideFunction: false, plugins: ['jsx'] });
    } catch {
      return []; // invalid syntax is reported separately by validateJavaScriptSyntax
    }
    const colorFns = this.COLOR_FUNCTIONS;
    const offenders = new Set<string>();
    this.traverseAst(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        const name = callee.type === 'Identifier'
          ? callee.name
          : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
            ? callee.property.name
            : null;
        if (!name || !colorFns.has(name)) return;
        const first = path.node.arguments[0];
        if (first && first.type === 'Identifier' && first.name === 'arguments') {
          offenders.add(name);
        }
      },
    });
    if (offenders.size === 0) return [];
    return [
      `p5.js color function(s) called with the \`arguments\` object (${Array.from(offenders).sort().join(', ')}) — use \`...arguments\` (spread) or explicit values; passing \`arguments\` throws "[object Arguments] is not a valid color representation" at runtime`,
    ];
  }

  private static validateReferencedIdentifiers(code: string): string[] {
    const ast = parse(code, {
      sourceType: 'script',
      allowReturnOutsideFunction: false,
      plugins: ['jsx'],
    });
    const missing = new Set<string>();
    const assignedGlobals = new Set<string>();
    const shadowedCalls = new Set<string>();

    this.traverseAst(ast, {
      AssignmentExpression(path) {
        const left = path.node.left;
        if (left.type === 'Identifier' && !path.scope.hasBinding(left.name)) {
          assignedGlobals.add(left.name);
        }
      },
      CallExpression(path) {
        const callee = path.node.callee;
        if (callee.type !== 'Identifier' || !P5Validator.P5_CALLABLE_GLOBALS.has(callee.name)) return;

        const binding = path.scope.getBinding(callee.name);
        if (binding) {
          shadowedCalls.add(callee.name);
        }
      },
      ReferencedIdentifier(path) {
        const name = path.node.name;
        if (!path.scope.hasBinding(name) && !P5Validator.P5_GLOBALS.has(name) && !assignedGlobals.has(name)) {
          missing.add(name);
        }
      },
    });

    return [
      ...Array.from(missing)
        .sort()
        .map((name) => `p5.js code references undeclared identifier: ${name}`),
      ...Array.from(shadowedCalls)
        .sort()
        .map((name) => `p5.js code declares local ${name} and then calls ${name}(), shadowing the p5.js function`),
    ];
  }

  private static extractInlineScriptBodies(html: string): string[] {
    const scripts: string[] = [];
    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptPattern.exec(html)) !== null) {
      const attributes = match[1] ?? '';
      const body = match[2]?.trim() ?? '';
      if (!/\bsrc\s*=/.test(attributes) && body) {
        scripts.push(body);
      }
    }

    return scripts;
  }

  private static formatParseError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Dim-sparse particle guard (W6c).
   *
   * Campaign evidence: particle systems on near-black with low count and/or no
   * soft glow produced empty frames of tiny low-alpha dots. Only fires when the
   * sketch is clearly a Particle system on a near-black background — intentional
   * dark aesthetics with luminosity technique still pass.
   */
  private static validateParticleLuminosity(code: string): string[] {
    const isParticleSystem =
      /class\s+Particle\b/.test(code)
      || /new\s+Particle\b/.test(code)
      || /\bNUM_PARTICLES\b/.test(code)
      || /\bPARTICLE_COUNT\b/.test(code);
    if (!isParticleSystem) return [];
    if (!this.hasNearBlackBackground(code)) return [];

    const errors: string[] = [];

    const countMatch = code.match(
      /(?:\bNUM_PARTICLES\b|\bPARTICLE_COUNT\b|\bconst\s+NUM\b)\s*=\s*(\d+)/,
    );
    if (countMatch) {
      const count = Number(countMatch[1]);
      if (Number.isFinite(count) && count < 100) {
        errors.push(
          `p5 particle system count ${count} is too sparse for a near-black canvas; use ≥100 particles (preferably ≥120) with readable size and soft glow so the frame fills`,
        );
      }
    }

    if (!this.hasParticleLuminosityTechnique(code)) {
      errors.push(
        'p5 particle system on a near-black background has no soft glow / high-alpha luminosity technique — will read as dim sparse points; add soft halo ellipses (size*2 at low alpha), blendMode(ADD), shadowBlur, or an alpha floor ≥140 with bright cores',
      );
    }

    // Life-faded alpha with a low ceiling (campaign run3: map(life, …, 0, 85) on HSB)
    // keeps particles translucent even when a rare halo ellipse exists.
    const lifeAlphaCeiling = this.findLifeAlphaCeiling(code);
    if (lifeAlphaCeiling !== null && lifeAlphaCeiling < 100) {
      errors.push(
        `p5 particle life alpha ceiling ${lifeAlphaCeiling} is too low for a near-black canvas — particles stay dim/translucent; raise the alpha floor (RGB ≥140 or HSB alpha ≥70) and keep soft glow so the field reads luminous`,
      );
    }

    return errors;
  }

  /** Near-black ground: background(0), low RGB triple, or HSB with very low brightness. */
  private static hasNearBlackBackground(code: string): boolean {
    if (/\bbackground\s*\(\s*0\s*\)/.test(code)) return true;
    if (/\bbackground\s*\(\s*([0-9]|1[0-9]|2[0-4])\s*\)/.test(code)) return true;

    for (const match of code.matchAll(/\bbackground\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)/g)) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      if (r <= 24 && g <= 24 && b <= 30) return true;
    }

    // HSB: background(h, s, bri) with bri < 12 on a 0–100 scale (campaign run3: bri 7)
    if (/\bcolorMode\s*\(\s*HSB\b/.test(code)) {
      for (const match of code.matchAll(/\bbackground\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)/g)) {
        if (Number(match[1]) < 12) return true;
      }
    }

    // Palette object / const with near-black RGB array used as background
    if (/background\s*\(\s*(?:PALETTE\.)?bg\s*\)/.test(code) || /background\s*\(\s*BG\s*\)/.test(code)) {
      if (/bg\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.test(code)
        || /(?:const|let)\s+BG\s*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.test(code)) {
        const paletteBg = code.match(/(?:bg\s*:\s*|BG\s*=\s*)\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/);
        if (paletteBg) {
          const r = Number(paletteBg[1]);
          const g = Number(paletteBg[2]);
          const b = Number(paletteBg[3]);
          if (r <= 24 && g <= 24 && b <= 30) return true;
        }
      }
    }
    // background(...PALETTE.bg) / background(BG[0], BG[1], BG[2]) / background(...BG)
    if (/background\s*\(\s*\.\.\.(?:PALETTE\.)?bg\s*\)/.test(code)
      || /background\s*\(\s*\.\.\.BG\s*\)/.test(code)
      || /background\s*\(\s*BG\[\s*0\s*\]\s*,\s*BG\[\s*1\s*\]\s*,\s*BG\[\s*2\s*\]\s*\)/.test(code)
      || /background\s*\(\s*PALETTE\.bg\[\s*0\s*\]/.test(code)) {
      const paletteBg = code.match(/(?:bg\s*:\s*|BG\s*=\s*)\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/);
      if (paletteBg) {
        const r = Number(paletteBg[1]);
        const g = Number(paletteBg[2]);
        const b = Number(paletteBg[3]);
        if (r <= 24 && g <= 24 && b <= 30) return true;
      }
    }

    return false;
  }

  private static hasParticleLuminosityTechnique(code: string): boolean {
    if (/\bblendMode\s*\(\s*ADD\s*\)/.test(code)) return true;
    if (/\bshadowBlur\b/.test(code)) return true;
    if (/\bfilter\s*\(\s*BLUR\b/.test(code)) return true;
    // Soft halo: larger ellipse/circle scaled from particle size (size * 1.5+)
    // White cores alone do not count — campaign run1 had tiny white cores and still read sparse.
    if (/\b(?:ellipse|circle)\s*\([^;]*\*\s*(?:1\.[5-9]\d*|[2-9](?:\.\d+)?)\s*[,)]/.test(code)) return true;
    // Explicit high alpha floor via map(..., low, high) with low >= 140
    if (/\balpha\s*=\s*map\s*\([^)]*?,\s*(?:1[4-9]\d|[2-9]\d{2})\s*,/.test(code)) return true;
    // Constant high alpha assignment
    if (/\bthis\.alpha\s*=\s*(?:1[4-9]\d|[2-9]\d{2})\b/.test(code)) return true;
    return false;
  }

  /** Ceiling of map(life, start, stop, 0, ceiling) when used for particle fade. */
  private static findLifeAlphaCeiling(code: string): number | null {
    const match = code.match(
      /\bmap\s*\(\s*(?:this\.)?life\b\s*,\s*[^,]+,\s*[^,]+,\s*0\s*,\s*(\d+(?:\.\d+)?)\s*\)/,
    );
    if (!match) return null;
    const ceiling = Number(match[1]);
    return Number.isFinite(ceiling) ? ceiling : null;
  }

  /**
   * Get minimum size requirement for p5 code
   */
  static getMinSize(): number {
    return 120; // p5 simple sketch: setup + draw + canvas (min valid sketch)
  }
}
