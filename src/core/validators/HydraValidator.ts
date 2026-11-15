/**
 * HydraValidator - Hydra video synth validation logic
 *
 * Hydra is a live coding video synth language.
 * It uses functions like osc(), src(), noise(), shape(), gradient(), solid()
 * chained with modifiers and ending with .out()
 */

import { parse } from '@babel/parser';

export interface HydraValidationResult {
  valid: boolean;
  errors: string[];
}

export class HydraValidator {
  /**
   * Validate Hydra video synth code structure
   */
  static validate(code: string): HydraValidationResult {
    const errors: string[] = [];
    const trimmed = code.trim();

    if (!trimmed) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    // Syntax gate: compile without executing — malformed code must be rejected
    // at validation so the escalation seat can retry, never shipped to the player.
    try {
      // Static parse only; nothing is evaluated (same gate as ToneValidator).
      parse(trimmed, { sourceType: 'script', allowReturnOutsideFunction: true });
    } catch (error) {
      errors.push(`Hydra code has a syntax error and cannot run: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Basic structure validation
    errors.push(...this.validateStructure(trimmed));

    // Quality checks
    errors.push(...this.validateQuality(trimmed));

    // Semantic validation
    errors.push(...this.validateSemantics(trimmed));

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate Hydra structure - must have source and output
   */
  private static validateStructure(code: string): string[] {
    const errors: string[] = [];

    // Must end with .out() to render
    if (!/\.out\(/.test(code)) {
      errors.push('Hydra code MUST end with .out() to render');
    }

    // Must have a source function
    const hasSource = /\b(osc|src|noise|shape|gradient|solid|voronoi)\s*\(/.test(code);
    if (!hasSource) {
      errors.push('Hydra code should use a source function: osc(), src(), noise(), shape(), gradient(), solid(), voronoi()');
    }

    errors.push(...this.validateHeadlessSources(code));
    errors.push(...this.validateRenderTarget(code));
    errors.push(...this.validateDegenerateTransforms(code));
    errors.push(...this.validateIdentifiers(code));

    return errors;
  }

  /**
   * Hallucinated-helper gate: a bare identifier call that is neither a hydra
   * global nor defined in the piece throws ReferenceError at runtime and
   * kills the whole chain before .out() (live evidence: `flow is not defined`
   * shipped as a scored artifact). The contract bans helpers; this enforces
   * it statically.
   */
  private static validateIdentifiers(code: string): string[] {
    const errors: string[] = [];
    const HYDRA_GLOBALS = new Set([
      'osc', 'noise', 'shape', 'gradient', 'solid', 'voronoi', 'src', 'render',
      's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9',
      'o0', 'o1', 'o2', 'o3', 'a', 'synth', 'time', 'mouse', 'fft', 'speed',
      'width', 'height', 'setResolution', 'hush', 'setFunction', 'pb',
      'Math', 'Array', 'Object', 'Number', 'String', 'Boolean', 'JSON',
      'Date', 'window', 'document', 'console', 'Promise', 'Number',
      'requestAnimationFrame', 'setTimeout', 'setInterval',
    ]);
    const defined = new Set<string>();
    for (const match of code.matchAll(/\b(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)|let\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/g)) {
      defined.add(match[1] ?? match[2] ?? match[3] ?? match[4] as string);
    }
    const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'delete', 'instanceof', 'await', 'yield', 'function']);
    for (const match of code.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      if (JS_KEYWORDS.has(name) || HYDRA_GLOBALS.has(name) || defined.has(name)) continue;
      errors.push(`Hydra code calls '${name}(...)' which is neither a hydra function nor defined in the piece — hallucinated helpers throw ReferenceError and kill the chain`);
    }
    return errors;
  }

  /**
   * A zero multiplier in scale() collapses an axis to nothing and renders a
   * black frame (W5 campaign run2: scale(1.02, 0, 0.08) → blank output).
   * Flag literal-zero arguments in scale() calls so degenerate chains route
   * to repair instead of shipping as black frames.
   */
  private static validateDegenerateTransforms(code: string): string[] {
    const errors: string[] = [];
    const scaleCall = /\.scale\s*\(\s*([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = scaleCall.exec(code)) !== null) {
      const args = match[1].split(',').map((arg) => arg.trim());
      if (args.some((arg) => /^-?0(?:\.0+)?$/.test(arg))) {
        errors.push(`Hydra scale() with a zero multiplier (${match[0]}) collapses an axis and renders black — use a non-zero value`);
      }
    }
    return errors;
  }

  /**
   * Headless gallery/gauntlet previews cannot grant camera/screen/media input,
   * so source buffers like s0 render blank even when the Hydra syntax is valid.
   */
  private static validateHeadlessSources(code: string): string[] {
    const errors: string[] = [];

    if (/\bs\d+\.init(?:Cam|Screen|Video|Image)\s*\(/.test(code) || /\bsrc\s*\(\s*s\d+\s*\)/.test(code)) {
      errors.push('Hydra headless preview must use generated sources, not camera/screen/video/image input buffers like s0.initCam(), s0.initScreen(), or src(s0)');
    }

    return errors;
  }

  /**
   * Bare render()/render(all) asks Hydra to display the multi-output grid. If
   * any output buffer is unwritten, the unused quadrant renders black; require
   * render(oN) unless all four outputs are intentionally populated.
   */
  private static validateRenderTarget(code: string): string[] {
    const errors: string[] = [];
    const writtenOutputs = this.collectWrittenOutputs(code);

    for (const match of code.matchAll(/\brender\s*\(\s*([^)]*)\s*\)/g)) {
      const target = match[1].trim();
      if (target === '' || /^all$/i.test(target)) {
        const missing = ['o0', 'o1', 'o2', 'o3'].filter(output => !writtenOutputs.has(output));
        if (missing.length > 0) {
          errors.push('Hydra code uses render()/render(all) with unwritten output buffers; use render(o0) or write all o0-o3 outputs to avoid black grid quadrants');
        }
        continue;
      }

      if (/^o[0-3]$/.test(target) && !writtenOutputs.has(target)) {
        errors.push(`Hydra code renders ${target} but never writes .out(${target}); render a written output buffer to avoid blank frames`);
      }
    }

    return errors;
  }

  private static collectWrittenOutputs(code: string): Set<string> {
    const outputs = new Set<string>();
    for (const match of code.matchAll(/\.out\s*\(\s*(o[0-3])?\s*\)/g)) {
      outputs.add(match[1] || 'o0');
    }
    return outputs;
  }

  /**
   * Validate Hydra quality
   */
  private static validateQuality(code: string): string[] {
    const errors: string[] = [];

    // Check for invalid method chains
    const invalidMethods = [
      '.sin(',
      '.cos(',
      '.tan(',
      '.sqrt(',
      '.abs(',
      '.pow(',
      '.saturation(',
      '.feedback(',
      '.kaleidoscope(',
      '.colorShift(',
      '.post(',
      '.screen(',
      '.output(',
    ];
    for (const method of invalidMethods) {
      // Math.* inside time-callback arguments is legitimate Hydra animation
      // (e.g. .rotate(()=>Math.sin(a.time))) — only bare calls ON SOURCES are
      // invalid. Strip Math.* forms before the substring check.
      const stripped = code.replace(/Math\.(sin|cos|tan|sqrt|abs|pow)\s*\(/g, 'M_$1(');
      if (stripped.includes(method)) {
        errors.push(`Hydra code contains invalid method: ${method} - use math functions differently in Hydra`);
      }
    }

    // Check for multiple outputs (valid in Hydra but warn if conflicting)
    const outCalls = (code.match(/\.out\(/g) || []).length;
    if (outCalls === 0) {
      errors.push('Hydra code must have at least one .out() call');
    }
    if (/\bloop\s*\(/.test(code)) {
      errors.push('Hydra code contains invalid function: loop() - use Hydra chains and .out(), not p5-style loop control');
    }
    if (/\bs0\.(?:osc|noise|shape|voronoi|gradient|solid)\s*\(/.test(code)) {
      errors.push('Hydra code contains invalid s0 source method - use osc(), noise(), shape(), voronoi(), gradient(), or solid() directly');
    }
    if (/\.(?:osc|noise|shape|voronoi|gradient|solid)\s*\(/.test(code)) {
      errors.push('Hydra code contains invalid chained source method - use .add(osc(...)), .blend(noise(...)), or start a new source chain');
    }

    return errors;
  }

  /**
   * Validate Hydra semantics
   */
  private static validateSemantics(code: string): string[] {
    const errors: string[] = [];

    // Valid Hydra source functions
    const validSources = new Set([
      'osc', 'solid', 'gradient', 'noise', 'shape', 'voronoi',
      'src', 'srcO0', 'srcO1', 'srcO2', 'srcO3'
    ]);

    // Valid Hydra transform/modulation functions
    const validTransforms = new Set([
      'color', 'colorama', 'invert', 'contrast', 'brightness', 'luma',
      'thresh', 'posterize', 'saturate', 'hue',
      'rotate', 'scale', 'scrollX', 'scrollY', 'repeat', 'repeatX', 'repeatY',
      'kaleid', 'pixelate', 'modulate', 'modulateHue',
      'blend', 'add', 'sub', 'layer', 'mask', 'mult',
      'diff', 'o0', 'o1', 'o2', 'o3'
    ]);

    // Check for potential typos in function calls
    const funcCalls = code.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
    for (const match of funcCalls) {
      const funcName = match[1];
      const isValid = validSources.has(funcName) || 
                      validTransforms.has(funcName) ||
                      this.isJavaScriptBuiltin(funcName) ||
                      funcName === 'render' || funcName === 'setResolution' ||
                      funcName === 'initCam' || funcName === 'initScreen' ||
                      funcName === 'initVideo' || funcName === 'initImage';
      
      if (!isValid) {
        // Could be a custom variable - don't error but could warn
      }
    }

    // Check for s0.initCam() pattern (valid)
    if (/s\d+\.init(Cam|Screen|Video|Image)/.test(code)) {
      // Valid Hydra initialization pattern
    }

    // Check for proper chain syntax
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//')) continue;

      // Lines should end with semicolon or be a valid chain
      if (!line.endsWith(';') && !line.endsWith(')') && !line.includes('.out(')) {
        // This is a style preference, not necessarily an error
      }
    }

    return errors;
  }

  /**
   * Check if a name is a JavaScript builtin
   */
  private static isJavaScriptBuiltin(name: string): boolean {
    const builtins = new Set([
      'Array', 'Object', 'String', 'Number', 'Math', 'console', 'log',
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'parseInt', 'parseFloat', 'JSON', 'Date'
    ]);
    return builtins.has(name);
  }

  /**
   * Get minimum size requirement for Hydra code
   */
  static getMinSize(): number {
    return 150; // Hydra needs at least source + output
  }
}
