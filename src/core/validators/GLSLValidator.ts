/**
 * GLSLValidator - GLSL shader-specific validation logic
 *
 * Extracted from CodeValidator.ts using Strangler Fig pattern.
 * Handles validation of GLSL shader code including fragment and vertex shaders.
 */

export interface GLSLValidationResult {
  valid: boolean;
  errors: string[];
}

export class GLSLValidator {
  /**
   * Validate GLSL shader code structure
   */
  static validate(code: string): GLSLValidationResult {
    const errors: string[] = [];
    const trimmed = code.trim();

    if (!trimmed) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    // Basic structure validation
    errors.push(...this.validateStructure(trimmed));

    // Preprocessor directive balance (#if/#endif) — an unbalanced conditional is a
    // guaranteed compile error ("unexpected #endif without a matching #if").
    errors.push(...this.validatePreprocessor(trimmed));

    // Quality checks
    errors.push(...this.validateQuality(trimmed));

    // Semantic validation
    errors.push(...this.validateGLSLSemantics(trimmed));

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate GLSL structure
   */
  private static validateStructure(code: string): string[] {
    const errors: string[] = [];

    const hasMain = /void\s+main\s*\(/.test(code);
    const hasFrag = /gl_FragColor|fragColor/.test(code);
    const hasGLPos = /gl_Position|gl_FragCoord/.test(code);
    // GLSL ES 3.0 declares its fragment output as `out vec4 <name>;` (any name,
    // not just `fragColor`). Recognize it as a valid output marker so a modern
    // #version 300 es shader is NOT false-rejected for lacking the legacy
    // gl_FragColor builtin.
    const hasOutVec4 = /\bout\s+(?:(?:lowp|mediump|highp)\s+)?vec4\s+\w+\s*;/.test(code);

    if (!hasMain && !hasFrag && !hasGLPos && !hasOutVec4) {
      errors.push('GLSL shader must contain void main(), gl_FragColor/fragColor, gl_Position/gl_FragCoord, or an out vec4 fragment output');
    }

    return errors;
  }

  /**
   * Validate preprocessor directive balance. An #endif without a matching
   * #if/#ifdef/#ifndef (or an unclosed conditional) is a guaranteed shader
   * compile error ("unexpected #endif without a matching #if").
   */
  private static validatePreprocessor(code: string): string[] {
    let depth = 0;
    for (const rawLine of code.split('\n')) {
      const line = rawLine.trim();
      if (/^#\s*(?:if|ifdef|ifndef)\b/.test(line)) {
        depth++;
      } else if (/^#\s*(?:else|elif)\b/.test(line)) {
        if (depth === 0) return ['GLSL preprocessor: #else/#elif without a matching #if'];
      } else if (/^#\s*endif\b/.test(line)) {
        if (depth === 0) return ['GLSL preprocessor: #endif without a matching #if'];
        depth--;
      }
    }
    return depth > 0 ? ['GLSL preprocessor: #if/#ifdef without a matching #endif'] : [];
  }

  /**
   * Balance GLSL preprocessor conditionals so the shader compiles. Reasoning
   * models (Grok 4.6) occasionally emit an orphan `#endif` (a stray shadertoy
   * header remnant) or leave an `#if` unclosed — both are guaranteed WebGL
   * compile failures. Drop orphans and append closers for stragglers. Shared so
   * every validation path (CodeValidator + ShaderGenerator sanitizer) stays
   * consistent.
   */
  static balancePreprocessor(code: string): string {
    const out: string[] = [];
    let depth = 0;
    for (const line of code.split('\n')) {
      const t = line.trim();
      if (/^#\s*if(?:n?def)?\b/.test(t)) {
        depth++;
        out.push(line);
      } else if (/^#\s*(?:else|elif)\b/.test(t)) {
        if (depth === 0) continue; // orphan — drop
        out.push(line);
      } else if (/^#\s*endif\b/.test(t)) {
        if (depth === 0) continue; // orphan — drop
        depth--;
        out.push(line);
      } else {
        out.push(line);
      }
    }
    while (depth > 0) { // close any unclosed conditional
      out.push('#endif');
      depth--;
    }
    return out.join('\n');
  }

  /**
   * Validate GLSL quality (complexity)
   */
  private static validateQuality(code: string): string[] {
    const errors: string[] = [];
    const uncommented = this.stripComments(code);

    // Check for complexity - simple gradients are not enough
    const hasNoise = /noise|hash|fbm|snoise|voronoi/.test(uncommented);
    const hasAnimation = /\b(?:u_time|time|iTime)\b/.test(uncommented);
    const vec3Constructors = (uncommented.match(/\bvec3\s*\(/g) ?? []).length;
    const hasMultipleColors = vec3Constructors >= 2 ||
      /vec3\s+\w+\s*=[\s\S]*vec3\s*\([\s\S]*?,[\s\S]*?,[\s\S]*?\)/.test(uncommented);

    if (!hasNoise && !hasMultipleColors) {
      errors.push('GLSL shader should use noise functions or multiple colors for complexity');
    }
    if (!hasAnimation) {
      errors.push('GLSL shader should animate using u_time');
    }

    return errors;
  }

  /**
   * Validate GLSL semantics (catches undefined functions, invalid operators)
   */
  private static validateGLSLSemantics(code: string): string[] {
    const errors: string[] = [];
    const trimmed = this.stripComments(code).trim();

    const returnTypes = '(?:float|vec2|vec3|vec4|int|void|mat2|mat3|mat4)';

    // Extract all function declarations/definitions. A prototype counts as a
    // declaration for forward calls; a later definition without one does not.
    const functionDefs = new Set<string>();
    const functionDeclarationIndex = new Map<string, number>();
    const functionDeclarationNameIndexes = new Set<number>();
    // Includes mat2/mat3/mat4 so matrix-returning helpers (e.g. `mat2 rot(...)`)
    // are recognized as local declarations, not flagged as undefined.
    const funcDefMatches = trimmed.matchAll(new RegExp(`\\b${returnTypes}\\s+(\\w+)\\s*\\([^)]*\\)\\s*(?:\\{|;)`, 'g'));
    for (const match of funcDefMatches) {
      const index = match.index ?? 0;
      functionDefs.add(match[1]);
      const currentIndex = functionDeclarationIndex.get(match[1]);
      if (currentIndex === undefined || index < currentIndex) {
        functionDeclarationIndex.set(match[1], index);
      }
      const nameOffset = match[0].indexOf(match[1]);
      if (nameOffset >= 0) functionDeclarationNameIndexes.add(index + nameOffset);
    }

    // GLSL built-in functions. Must cover the full ES 1.00/3.00 standard library
    // — an incomplete allowlist FALSE-rejects valid shaders (e.g. a runnable
    // shader using `radians`/`sinh`/`round`/`transpose` was flagged as calling
    // "undefined functions"). Sourced from the GLSL ES spec built-in function set.
    const builtInFunctions = new Set([
      // Angle & trigonometry
      'radians', 'degrees',
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
      'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
      // Exponential
      'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
      // Common
      'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'modf', 'min', 'max',
      'clamp', 'mix', 'step', 'smoothstep',
      'round', 'roundEven', 'trunc', 'isnan', 'isinf',
      // Floating-point bit manipulation (ES 3.0)
      'floatBitsToInt', 'floatBitsToUint', 'intBitsToFloat', 'uintBitsToFloat',
      // Geometric
      'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
      // Matrix
      'matrixCompMult', 'outerProduct', 'transpose', 'determinant', 'inverse',
      // Vector relational (return bvec / bool)
      'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
      'equal', 'notEqual', 'any', 'all', 'not',
      // Derivatives & fragment helpers (ES 3.0 / OES_standard_derivatives)
      'dFdx', 'dFdy', 'fwidth',
      // Texture lookup
      'texture2D', 'texture2DProj', 'texture2DLod', 'textureCube', 'textureCubeLod',
      'texture', 'textureProj', 'textureLod', 'textureGrad', 'textureProjLod',
      'textureOffset', 'texelFetch', 'textureSize',
      // Constructor-like (types usable as conversions)
      'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
      'uvec2', 'uvec3', 'uvec4', 'bvec2', 'bvec3', 'bvec4',
      'mat2', 'mat3', 'mat4', 'int', 'uint', 'float', 'bool'
    ]);

    // Extract all function calls (but not variable declarations like 'float x = ...')
    // Match: functionName( but exclude: void/return/if/for/while/variable declarations
    const funcCallPattern = /\b(?!(?:void|float|vec2|vec3|vec4|int|bool|return|if|for|while|switch|case|default)\b)(\w+)\s*(?=\()/g;
    const funcCallMatches = trimmed.matchAll(funcCallPattern);
    const forwardCallErrors = new Set<string>();
    for (const match of funcCallMatches) {
      const funcName = match[1];
      const callIndex = match.index ?? 0;
      if (functionDeclarationNameIndexes.has(callIndex)) continue;
      // Skip if it's a definition or a builtin
      if (!functionDefs.has(funcName) && !builtInFunctions.has(funcName)) {
        errors.push(`GLSL: Undefined function '${funcName}()' - must be defined before use or is a built-in`);
        continue;
      }
      const declarationIndex = functionDeclarationIndex.get(funcName);
      if (declarationIndex !== undefined && declarationIndex > callIndex && !builtInFunctions.has(funcName)) {
        forwardCallErrors.add(`GLSL: function '${funcName}()' is called before declaration`);
      }
    }
    errors.push(...forwardCallErrors);

    // Check for invalid % operator (GLSL uses mod() instead)
    // Match % that isn't inside a comment or string
    const lines = trimmed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Remove comments
      const cleanLine = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//, '');
      if (/[%]\s*[\d.]/.test(cleanLine)) {
        errors.push(`GLSL Line ${i + 1}: Invalid '%' operator - GLSL uses mod(x, y) instead of x % y`);
      }
    }

    // Check for undefined uniforms (if texture2D is used, a sampler2D must be declared)
    if (/texture2D\s*\(/.test(trimmed) && !/sampler2D\s+\w+/.test(trimmed)) {
      errors.push('GLSL: texture2D() used but no sampler2D uniform declared');
    }

    // Every u_* identifier used must be DECLARED as a uniform — the WebGL
    // compiler fails the whole shader on an undeclared identifier (live
    // evidence: scored artifacts died on 'u_time' : undeclared identifier).
    // The wrapper looks up locations but never injects declarations.
    const declaredUniforms = new Set<string>();
    for (const match of trimmed.matchAll(/\buniform\s+\w+\s+([A-Za-z_]\w*)\s*(?:,|;)/g)) {
      declaredUniforms.add(match[1]);
    }
    const usedUniformLike = new Set<string>();
    for (const match of trimmed.matchAll(/\b(u_[A-Za-z_]\w*)\b/g)) {
      usedUniformLike.add(match[1]);
    }
    for (const name of usedUniformLike) {
      if (!declaredUniforms.has(name)) {
        errors.push(`GLSL: '${name}' is used but never declared as a uniform — declare it (uniform float ${name};) or drop it`);
      }
    }

    for (const match of trimmed.matchAll(/\b(?:float|vec2|vec3|vec4)\s+(\w+)\s*\(([^)]*)\)\s*\{([\s\S]*?)\}/g)) {
      const [, funcName, params, body] = match;
      const receivesUv = /\bvec2\s+uv\b/.test(params);
      const declaresUv = /\bvec2\s+uv\b/.test(body);
      if (funcName !== 'mainImage' && funcName !== 'main' && /\buv\b/.test(body) && !receivesUv && !declaresUv) {
        errors.push(`GLSL: helper function '${funcName}' references uv without receiving or declaring it`);
      }
    }

    for (const match of trimmed.matchAll(/\b(?:const\s+)?(?:lowp\s+|mediump\s+|highp\s+)?(?:float|vec2|vec3|vec4|int|bool|mat2|mat3|mat4)\s+([A-Za-z_]\w*)\s*=\s*([^;{}]+);/g)) {
      const [, variable, initializer] = match;
      if (new RegExp(`\\b${variable}\\b`).test(initializer)) {
        errors.push(`GLSL: variable '${variable}' is used in its own initializer`);
      }
    }

    const floatNames = new Set<string>();
    for (const match of trimmed.matchAll(/\b(?:uniform\s+)?float\s+(\w+)\b/g)) {
      floatNames.add(match[1]);
    }
    for (const name of floatNames) {
      if (new RegExp(`\\b${name}\\.(?:xy|yx|rg|st)\\b`).test(trimmed)) {
        errors.push(`GLSL: float '${name}' cannot use vector field selection like .xy`);
      }
    }

    const vec3Variables = new Set<string>();
    for (const match of trimmed.matchAll(/\bvec3\s+(\w+)\s*=/g)) {
      vec3Variables.add(match[1]);
    }

    for (const variable of vec3Variables) {
      const directFragAssign = new RegExp(`\\b(?:gl_FragColor|fragColor)\\s*=\\s*${variable}\\s*;`);
      if (directFragAssign.test(trimmed)) {
        errors.push(`GLSL: Fragment output must be vec4; wrap vec3 '${variable}' as vec4(${variable}, 1.0)`);
      }
    }

    const vec2ToFloatPattern = /\bfloat\s+(\w+)\s*=\s*smoothstep\([^;]*\babs\s*\([^;]*\.(?:xy|yx|rg|st)\b[^;]*\)\s*[^;]*;/g;
    for (const match of trimmed.matchAll(vec2ToFloatPattern)) {
      errors.push(`GLSL: float '${match[1]}' is assigned a vec2 expression; reduce it with length(), .x, or .y`);
    }

    const vec2Vec3MultiplyPattern = /\b(\w+)\s*\+=\s*sin\([^;]*\buv\b[^;]*\)\s*\*\s*vec3\s*\(/g;
    for (const match of trimmed.matchAll(vec2Vec3MultiplyPattern)) {
      errors.push(`GLSL: '${match[1]}' adds a vec2 expression multiplied by vec3; convert the sine result to vec3 first`);
    }

    return errors;
  }

  private static stripComments(code: string): string {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  /**
   * Validate HTML-wrapped GLSL
   */
  static validateHTMLWrapped(code: string): string[] {
    const errors: string[] = [];

    if (!/getContext\(['"]webgl/.test(code) && !/<canvas/.test(code)) {
      errors.push('HTML-wrapped GLSL must include <canvas> and webgl context');
    }

    return errors;
  }

  /**
   * Get minimum size requirement for GLSL code
   */
  static getMinSize(): number {
    return 300; // GLSL can be compact while still runnable and visually non-trivial
  }

  /**
   * Compile-check the fragment shader using headless WebGL.
   *
   * This catches undeclared variables, functions, type mismatches, and other
   * compile-time errors that static analysis cannot detect (e.g. `warpedFlow`
   * used but never declared — static validator sees it as a valid identifier).
   *
   * @param fragmentShader - The fragment shader source code to check
   * @returns CompileCheckResult with success=true if compiled, or error message if failed
   */
  static async compileCheck(fragmentShader: string): Promise<{ success: boolean; status?: 'pass' | 'compile-error' | 'infra-unavailable'; error?: string }> {
    // Lazy import to avoid loading puppeteer at module load time
    const { glslCompileCheck } = await import('../../utils/glsl-compile-check.js');
    return glslCompileCheck(fragmentShader);
  }
}
