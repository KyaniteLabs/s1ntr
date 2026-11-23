/**
 * GLSLNormalizer — deterministic dialect repair that runs BEFORE validation.
 *
 * Local models (LFM3-1.7B sweep, 2026-11-16: 0/34 runs passed the GLSL gate)
 * write desktop-flavored GLSL: `#version 330 core` headers, `in`/`out`
 * qualifiers, C math names (fabs/fminf), `1e6.0` literals and uTime/U_Time
 * uniform spellings. None of these reach the WebGL compiler — every one is a
 * guaranteed compile error or a dead uniform. This module fixes only the
 * mechanically-safe cases; semantic breakage stays for the repair turn.
 *
 * The renderer chain prefers WebGL2 (the gallery harness tries webgl2 before
 * webgl; the compile check picks webgl2 for `#version 300 es`), so the
 * default is to emit a CONSISTENT `#version 300 es` shader when ES3-only
 * syntax is present. Callers on a WebGL1-only surface can pass
 * `{ webgl2: false }` to downgrade in/out to varying/gl_FragColor instead.
 */

export interface GLSLNormalizerResult {
  code: string;
  /** Human-readable rewrite labels, e.g. "c-math: fabs->abs" (empty = untouched). */
  fixes: string[];
}

export interface GLSLNormalizerOptions {
  /** Emit `#version 300 es` for ES3 syntax (default: true — the renderer prefers WebGL2). */
  webgl2?: boolean;
}

// C library names LLMs reach for that do not exist in GLSL. `fmin`/`fmax` are
// ES 3.00-only; rewriting them to min/max keeps the shader valid on both.
const C_MATH_RENAMES: Array<readonly [string, string]> = [
  ['fabs', 'abs'], ['fabsf', 'abs'], ['fmin', 'min'], ['fminf', 'min'],
  ['fmax', 'max'], ['fmaxf', 'max'], ['fmodf', 'mod'], ['sqrtf', 'sqrt'],
  ['powf', 'pow'], ['floorf', 'floor'], ['ceilf', 'ceil'], ['expf', 'exp'],
  ['logf', 'log'], ['exp2f', 'exp2'], ['log2f', 'log2'], ['sinf', 'sin'],
  ['cosf', 'cos'], ['tanf', 'tan'], ['asinf', 'asin'], ['acosf', 'acos'],
  ['atanf', 'atan'], ['atan2f', 'atan'],
];

// Uniform spellings that canonically map onto a host-supplied uniform. Keys
// are the lowercase, underscore-stripped form of the declared name.
const HOST_UNIFORM_CANONICAL: Record<string, string> = {
  utime: 'u_time',
  uresolution: 'u_resolution',
  umouse: 'u_mouse',
};

const GLOBAL_IN_OUT =
  /^[ \t]*(?:(?:flat|smooth|noperspective|centroid|invariant)[ \t]+)?(in|out)[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?(?:[iu]?vec[234]|mat[234]|float|int|uint)\b[^;()]*;/gm;

// Fragment derivatives. ES 3.00 has them in core; ES 1.00 needs the
// GL_OES_standard_derivatives extension (live probe, Chrome/ANGLE: a WebGL2
// context rejects the extension for ES 1.00 sources, so a versionless shader
// that reaches the gallery's webgl2-first harness must be upgraded instead).
const DERIVATIVE_CALLS = /\b(?:dFdx|dFdy|fwidth)\s*\(/;
const DERIVATIVES_EXTENSION = /^[ \t]*#[ \t]*extension[ \t]+GL_OES_standard_derivatives\b[^\n]*\r?\n?/gm;

const ES3_TEXTURE_CALLS = /\b(?:texture|texelFetch|textureSize|textureLod|textureProj)\s*\(/;

function stripCommentsForDetection(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function rewriteCMathNames(code: string, fixes: string[]): string {
  for (const [from, to] of C_MATH_RENAMES) {
    // A shader that defines its own helper with the C name keeps it — the
    // rewrite is only for calls into the missing builtin.
    const definedByUser = new RegExp(`\\b(?:float|vec[234]|int|void|mat[234])\\s+${from}\\s*\\(`).test(code);
    if (definedByUser) continue;
    const callSites = new RegExp(`\\b${from}\\s*\\(`, 'g');
    if (!callSites.test(code)) continue;
    callSites.lastIndex = 0;
    code = code.replace(callSites, `${to}(`);
    fixes.push(`c-math: ${from}->${to}`);
  }
  return code;
}

function rewriteHostUniformAliases(code: string, fixes: string[]): string {
  const declaredNames = new Set<string>();
  for (const match of code.matchAll(/\buniform\s+\w+\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?;/g)) {
    declaredNames.add(match[1]);
  }
  // A local variable sharing the alias name makes the rename ambiguous (it
  // could mint `float u_time = u_time * 2.0;` self-initializers) — skip.
  const nonUniformSurface = code
    .split('\n')
    .filter((line) => !/^\s*uniform\b/.test(line))
    .join('\n');

  for (const name of declaredNames) {
    const target = HOST_UNIFORM_CANONICAL[name.toLowerCase().replace(/_/g, '')];
    if (!target || name === target) continue;
    const localCollision = new RegExp(`\\b(?:float|vec[234]|int|mat[234])\\s+${name}\\b`).test(nonUniformSurface);
    if (localCollision) continue;
    code = code.replace(new RegExp(`\\b${name}\\b`, 'g'), target);
    fixes.push(`uniform-alias: ${name}->${target}`);
  }
  return code;
}

function rewriteExponentLiterals(code: string, fixes: string[]): string {
  return code.replace(
    /((?:\d+\.\d+|\d+)[eE][+-]?\d+)\.0+(?![\d.])/g,
    (match, literal: string) => {
      fixes.push(`literal: ${match}->${literal}`);
      return literal;
    },
  );
}

const PRECISION = '(?:(?:highp|mediump|lowp)\\s+)?';
const FLOAT_LITERAL = '(?:\\d+\\.\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?f?';

// `float a = 4;` and `const float N = 4;`: ES has no implicit int->float
// conversion, so an int literal under a float declaration is a compile error.
function rewriteIntLiteralFloatInits(code: string, fixes: string[]): string {
  return code.replace(
    new RegExp(`\\b(float\\s+\\w+\\s*=\\s*)([-+]?\\d+)(\\s*;)`, 'g'),
    (match, head: string, value: string, tail: string) => {
      fixes.push(`literal: ${match.trim()}->${value}.0`);
      return `${head}${value}.0${tail}`;
    },
  );
}

// `-N / 2.0` with `const int N`: the int identifier meets a float literal
// with no conversion in ES. Wrap the identifier in float(); a loop bound
// (`i < N`) or an int-only expression is untouched.
function rewriteConstIntFloatMix(code: string, fixes: string[]): string {
  const names = [...code.matchAll(new RegExp(`\\bconst\\s+${PRECISION}int\\s+(\\w+)\\s*=`, 'g'))].map((m) => m[1]);
  for (const name of new Set(names)) {
    const after = new RegExp(`(?<!float\\(\\s*)\\b${name}\\b(?=\\s*[-+*/]\\s*${FLOAT_LITERAL}(?![\\w.]))`, 'g');
    const before = new RegExp(`(?<![\\w.])(${FLOAT_LITERAL}\\s*[-+*/]\\s*)${name}\\b`, 'g');
    const next = code.replace(after, `float(${name})`).replace(before, `$1float(${name})`);
    if (next !== code) {
      fixes.push(`types: const int ${name} -> float(${name}) beside float literals`);
      code = next;
    }
  }
  return code;
}

// `float xs[5] = {1.0, 2.0};` is C; ES 3.00 spells it `float[5](1.0, 2.0)`.
function rewriteBraceArrayInits(code: string, fixes: string[]): string {
  return code.replace(
    new RegExp(`\\b(${PRECISION})(float|int|uint|bool|[iu]?vec[234]|mat[234])(\\s+\\w+\\s*)\\[\\s*(\\w*)\\s*\\](\\s*=\\s*)\\{([^{};]*)\\}(\\s*;)`, 'g'),
    (_match, prec: string, type: string, name: string, size: string, eq: string, items: string, tail: string) => {
      fixes.push(`syntax: ${type}${name.trimEnd()}[${size}] = {...} -> ${type}[${size}](...)`);
      return `${prec}${type}${name}[${size}]${eq}${type}[${size}](${items.trim().replace(/,\s*$/, '')})${tail}`;
    },
  );
}

const GLOBAL_DECL = new RegExp(`^([ \\t]*)(${PRECISION}(?:float|int|uint|bool|[iu]?vec[234]|mat[234])\\s+(\\w+)\\s*=\\s*([^;]*);)`);
const GLSL_WORDS = new Set([
  'float', 'int', 'uint', 'bool', 'true', 'false', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pow', 'exp', 'log', 'exp2', 'log2',
  'sqrt', 'inversesqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
  'length', 'distance', 'dot', 'cross', 'normalize', 'reflect', 'x', 'y', 'z', 'w', 'r', 'g', 'b', 'a', 'xy', 'xyz', 'rgb',
]);

// A global with a non-constant initializer (`vec3 c = mix(a, b, 0.5);` where
// a and b are plain globals) is an ES compile error. When the global is never
// written and its initializer only reads literals, built-ins and consts, it
// is a constant: mark it `const`. Repeats until no more globals qualify.
function constifyGlobalInitializers(code: string, fixes: string[]): string {
  const lines = code.split('\n');
  const topLevel: number[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (depth === 0) topLevel.push(i);
    for (const ch of lines[i].replace(/\/\/.*$/, '')) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  }
  const consts = new Set([...code.matchAll(/\bconst\s+[^=;]*?(\w+)\s*(?:\[[^\]]*\])?\s*=/g)].map((m) => m[1]));
  const body = stripCommentsForDetection(code);
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of topLevel) {
      const m = GLOBAL_DECL.exec(lines[i]);
      if (!m || /\b(?:const|uniform|in|out|attribute|varying)\b/.test(lines[i].slice(0, m.index + m[1].length))) continue;
      const [, , decl, name, init] = m;
      const written = new RegExp(`(?:\\b${name}(?:\\.\\w+|\\[[^\\]]*\\])?\\s*(?:[-+*/]?=(?!=)|\\+\\+|--)|(?:\\+\\+|--)\\s*${name}\\b)`);
      const writes = body.split('\n').filter((line) => written.test(line)).length;
      if (writes > 1) continue;
      const reads = init.replace(/(?:\b\d|\.\d)[\w.]*/g, ' ').match(/[A-Za-z_]\w*/g) ?? [];
      if (!reads.every((word) => GLSL_WORDS.has(word) || consts.has(word))) continue;
      lines[i] = lines[i].replace(decl, `const ${decl}`);
      consts.add(name);
      fixes.push(`globals: ${name} -> const (constant initializer, never written)`);
      changed = true;
    }
  }
  return lines.join('\n');
}

interface VersionLine {
  /** Full matched line text (trimmed). */
  text: string;
  number: number;
  profile: string;
  isEs: boolean;
}

function parseVersionLine(code: string): VersionLine | null {
  const match = code.match(/^[ \t]*#[ \t]*version[ \t]+(\d+)(?:[ \t]+([A-Za-z_]+))?[ \t]*\r?$/m);
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  const profile = match[2] ?? '';
  return { text: match[0].trim(), number, profile, isEs: profile === 'es' };
}

function findDeclaredFragmentOutput(code: string): string | null {
  const match = code.match(
    /^[ \t]*(?:layout\s*\([^)]*\)[ \t]*)?(?:(?:flat|smooth|noperspective|centroid)[ \t]+)?out[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?vec4[ \t]+([A-Za-z_]\w*)[ \t]*;/m,
  );
  return match?.[1] ?? null;
}

/**
 * Ensure a `#version 300 es` shader is internally consistent: float precision
 * declared, legacy ES1 tokens upgraded, and the removed `gl_FragColor`
 * builtin routed through a declared `out vec4`.
 */
function ensureEs300Consistency(code: string, fixes: string[]): string {
  if (!/\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/.test(code)) {
    code = code.replace(/(^#[ \t]*version[ \t]+300[ \t]+es[ \t]*\r?$)/m, '$1\nprecision highp float;');
    fixes.push('dialect: +precision highp float;');
  }

  if (/\b(?:varying|attribute)\b/.test(code)) {
    code = code
      .replace(/^[ \t]*attribute\b/gm, 'in')
      .replace(/^[ \t]*varying\b/gm, 'in');
    fixes.push('dialect: attribute/varying->in');
  }

  if (/\btexture2D\s*\(/.test(code)) {
    code = code.replace(/\btexture2D\s*\(/g, 'texture(');
    fixes.push('dialect: texture2D->texture');
  }

  if (/\bgl_FragColor\b/.test(code)) {
    let outputName = findDeclaredFragmentOutput(code);
    if (!outputName) {
      outputName = 'fragColor';
      code = code.replace(
        /(^#[ \t]*version[ \t]+300[ \t]+es[ \t]*\r?$\n(?:precision[^\n]*\n)?)/m,
        `$1out vec4 ${outputName};\n`,
      );
    }
    code = code.replace(/\bgl_FragColor\b/g, outputName);
    fixes.push(`dialect: gl_FragColor->${outputName}`);
  }

  return code;
}

/**
 * Downgrade ES3 syntax to WebGL1 forms (the "renderer cannot run WebGL2"
 * branch): strip the 300 es header, map fragment `in` to `varying`, route the
 * `out vec4` through `gl_FragColor`, and map texture() back to texture2D().
 */
function downgradeToWebGl1(code: string, fixes: string[]): string {
  const version = parseVersionLine(code);
  if (version && version.number === 300) {
    code = code.replace(/^[ \t]*#[ \t]*version[ \t]+300(?:[ \t]+es)?[ \t]*\r?\n?/m, '');
    fixes.push(`dialect: strip ${version.text} (WebGL1)`);
  }

  const stripped = stripCommentsForDetection(code);
  if (GLOBAL_IN_OUT.test(stripped)) {
    GLOBAL_IN_OUT.lastIndex = 0;
    code = code.replace(
      new RegExp(GLOBAL_IN_OUT.source, 'gm'),
      (line, qualifier: string) => {
        const rest = line.replace(/^[ \t]*(?:(?:flat|smooth|noperspective|centroid|invariant)[ \t]+)?(?:in|out)[ \t]+/, '');
        // A fragment-stage global `out` is the color output; `in` is a varying.
        return qualifier === 'out' ? '' : `varying ${rest.replace(/^\s*/, '')}`;
      },
    );
    fixes.push('dialect: in/out->varying (WebGL1)');
  }
  GLOBAL_IN_OUT.lastIndex = 0;

  for (const match of stripped.matchAll(
    /^[ \t]*(?:(?:flat|smooth|noperspective|centroid|invariant)[ \t]+)?out[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?vec4[ \t]+([A-Za-z_]\w*)[ \t]*;/gm,
  )) {
    const name = match[1];
    // Statement-initial assignments only (after '{', ';' or a newline), so an
    // expression reading the old output name is never rewritten.
    code = code.replace(new RegExp(`([{;\\n])[ \\t]*${name}[ \\t]*=`, 'g'), '$1gl_FragColor =');
    fixes.push(`dialect: out ${name}->gl_FragColor`);
  }

  if (/\btexture\s*\(/.test(code) && !/\btexture2D\s*\(/.test(code)) {
    code = code.replace(/\btexture\s*\(/g, 'texture2D(');
    fixes.push('dialect: texture->texture2D');
  }

  return code;
}

/**
 * ES 1.00 path: declare GL_OES_standard_derivatives (idempotent) in the only
 * legal position — after `#version`, before every non-preprocessor token.
 */
function ensureDerivativesExtension(code: string, fixes: string[]): string {
  DERIVATIVES_EXTENSION.lastIndex = 0;
  const present = DERIVATIVES_EXTENSION.test(code);
  DERIVATIVES_EXTENSION.lastIndex = 0;
  if (present) return code;
  const directive = '#extension GL_OES_standard_derivatives : enable\n';
  const versionLine = code.match(/^[ \t]*#[ \t]*version[^\n]*\n/m);
  fixes.push('dialect: +#extension GL_OES_standard_derivatives');
  if (!versionLine || versionLine.index === undefined) return `${directive}${code}`;
  const at = versionLine.index + versionLine[0].length;
  return `${code.slice(0, at)}${directive}${code.slice(at)}`;
}

/**
 * Split the leading-position directives (`#version`, `#extension`) from the
 * body so a caller can prepend its own declarations AFTER them. GLSL requires
 * `#version` first and, in ES 1.00, `#extension` before any other token.
 */
export function hoistGLSLDirectives(code: string): { header: string; body: string } {
  const header: string[] = [];
  const body: string[] = [];
  for (const line of code.split('\n')) {
    (/^[ \t]*#[ \t]*(?:version|extension)\b/.test(line) ? header : body).push(line);
  }
  header.sort((a, b) => Number(/version/.test(b)) - Number(/version/.test(a)));
  return { header: header.join('\n'), body: body.join('\n') };
}

/**
 * Rewrite the shader into one consistent GLSL ES dialect. Safe by
 * construction: every rule is an identifier-preserving rewrite of a token
 * that is either illegal or dead in the target dialect.
 */
export function normalizeGLSLDialect(code: string, options: GLSLNormalizerOptions = {}): GLSLNormalizerResult {
  const webgl2 = options.webgl2 ?? true;
  const fixes: string[] = [];

  code = rewriteCMathNames(code, fixes);
  code = rewriteHostUniformAliases(code, fixes);
  code = rewriteExponentLiterals(code, fixes);
  code = rewriteIntLiteralFloatInits(code, fixes);
  code = rewriteConstIntFloatMix(code, fixes);

  const stripped = stripCommentsForDetection(code);
  GLOBAL_IN_OUT.lastIndex = 0;
  const usesDerivatives = DERIVATIVE_CALLS.test(stripped);
  const es3OnlySyntax = GLOBAL_IN_OUT.test(stripped) || ES3_TEXTURE_CALLS.test(stripped);
  GLOBAL_IN_OUT.lastIndex = 0;

  const version = parseVersionLine(code);
  const isEs300Header = version !== null && version.number === 300 && version.isEs;
  const isEs100Header = version !== null && version.number === 100;
  const isDesktopHeader = version !== null && !isEs300Header && !isEs100Header;

  if (webgl2) {
    if (isEs100Header && usesDerivatives) {
      code = code.replace(/^[ \t]*#[ \t]*version[ \t]+100\b[^\n]*$/m, '#version 300 es');
      fixes.push('dialect: #version 100->#version 300 es (derivatives)');
    } else if (isDesktopHeader && (es3OnlySyntax || usesDerivatives)) {
      code = code.replace(/^[ \t]*#[ \t]*version[ \t]+\d+(?:[ \t]+[A-Za-z_]+)?[ \t]*\r?$/m, '#version 300 es');
      fixes.push(`dialect: ${version.text}->#version 300 es`);
    } else if (isDesktopHeader) {
      // WebGL1-shaped body under a desktop header: drop the header so the
      // shader compiles as the ES 1.00 default.
      code = code.replace(/^[ \t]*#[ \t]*version[ \t]+\d+(?:[ \t]+[A-Za-z_]+)?[ \t]*\r?\n?/m, '');
      fixes.push(`dialect: strip ${version.text} (WebGL1 default)`);
    } else if (!version && (es3OnlySyntax || usesDerivatives)) {
      code = `#version 300 es\n${code}`;
      fixes.push('dialect: +#version 300 es');
    }

    const nowEs300 = isEs300Header || fixes.some((f) => f.includes('#version 300 es'));
    if (nowEs300) {
      // Derivatives are core in ES 3.00; the ES 1.00 extension line is moot.
      DERIVATIVES_EXTENSION.lastIndex = 0;
      if (DERIVATIVES_EXTENSION.test(code)) {
        DERIVATIVES_EXTENSION.lastIndex = 0;
        code = code.replace(DERIVATIVES_EXTENSION, '');
        fixes.push('dialect: -#extension GL_OES_standard_derivatives (core in 300 es)');
      }
      DERIVATIVES_EXTENSION.lastIndex = 0;
      code = ensureEs300Consistency(code, fixes);
      code = rewriteBraceArrayInits(code, fixes);
    }
  } else {
    code = downgradeToWebGl1(code, fixes);
    if (usesDerivatives && !/^[ \t]*#[ \t]*version[ \t]+(?!100\b)\d+/m.test(code)) {
      code = ensureDerivativesExtension(code, fixes);
    }
  }

  code = constifyGlobalInitializers(code, fixes);
  return { code, fixes };
}
