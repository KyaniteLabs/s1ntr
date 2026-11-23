/**
 * ShaderGenerator - GLSL shader generation with tier-based prompts
 */

import { TierBasedGenerator, type TierBasedGeneratorOptions } from '../TierBasedGenerator.js';
import { Logger } from '../../utils/Logger.js';
import { GLSLValidator } from '../../core/validators/GLSLValidator.js';
import { answerCode, pickCodeBlock, splitThinking } from '../../llm/ModelOutput.js';
import { hoistGLSLDirectives, normalizeGLSLDialect } from './GLSLNormalizer.js';

// Common shader helper functions that LLMs idiomatically CALL without defining
// (e.g. rot/noise/fbm from shadertoy). The validator rejects these as undefined,
// so when a shader uses one without defining it we inject a vetted definition.
// `deps` are other helpers a definition itself calls. HELPER_ORDER lists every
// helper with its dependencies BEFORE its dependents so the emitted block compiles.
const GLSL_HELPER_RETURN_TYPES = '(?:float|vec2|vec3|vec4|int|void|mat2|mat3|mat4)';

const HELPER_PRELUDE: Record<string, { def: string; deps: string[] }> = {
  rot: { def: 'mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }', deps: [] },
  hash: {
    def: 'float hash(float n){ return fract(sin(n) * 43758.5453123); }\n'
      + 'float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    deps: [],
  },
  hash21: { def: 'float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }', deps: [] },
  noise: {
    def: 'float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);'
      + ' float a = hash21(i), b = hash21(i+vec2(1.0,0.0)), c = hash21(i+vec2(0.0,1.0)), d = hash21(i+vec2(1.0,1.0));'
      + ' return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }',
    deps: ['hash21'],
  },
  fbm: { def: 'float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }', deps: ['noise'] },
  palette: { def: 'vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b * cos(6.28318 * (c * t + d)); }', deps: [] },
};

// Dependency-safe emission order: hash21 before noise before fbm; others independent.
const HELPER_ORDER = ['rot', 'hash', 'hash21', 'noise', 'fbm', 'palette'];

/** Uniforms the GLSL host wrapper actually sets each frame. */
const HOST_UNIFORMS = new Set(['u_time', 'u_resolution', 'u_mouse']);

export class ShaderGenerator extends TierBasedGenerator {
  constructor(llmOrConfig?: ConstructorParameters<typeof TierBasedGenerator>[1]) {
    super('shader', llmOrConfig);
  }

  async generate(prompt: string, options?: TierBasedGeneratorOptions): Promise<string> {
    const shaderPrompt = [
      prompt,
      '',
      'Render LUMINOUS, high-contrast color: the final gl_FragColor must include genuinely BRIGHT focal regions (channel values reaching ~0.8-1.0) set against deeper tones, so the frame reads vivid and saturated — never a dim, muted, soft, or near-black wash where the whole frame stays below mid-grey. Drive a clear bright highlight or glow somewhere in the composition.',
      'UNIFORM CONTRACT — the host runtime sets ONLY these uniforms: uniform float u_time; uniform vec2 u_resolution; uniform vec2 u_mouse; (u_mouse = pixel coordinates, origin bottom-left, updated on pointer move). Declare and read exactly these. Do NOT invent or reference any other uniform (no u_pointer, u_sequence, u_sinterState, u_pointerDown, etc.) — the host never sets them so they stay dead at zero and silently break the effect. For pointer reactivity use u_mouse.',
    ].join('\n');
    try {
      const code = await super.generate(shaderPrompt, options);
      return this.sanitizeShaderCode(code);
    } catch (err) {
      if (!this.shouldUseProviderRecoveryShader(err, options?.signal)) throw err;
      Logger.warn('ShaderGenerator', 'Provider returned no GLSL artifact; rendering local recovery shader');
      const recovered = this.providerRecoveryShader();
      const validation = this.validateOutput(recovered);
      if (!validation.valid) throw err;
      return recovered;
    }
  }

  protected buildEmptyCodeRetrySystemPrompt(): string {
    return 'You write final GLSL fragment shader source code only. Start with GLSL code immediately; never include prose, markdown, hidden reasoning, or tool calls.';
  }

  protected buildEmptyCodeRetryPrompt(originalPrompt: string): string {
    return [
      'Write one complete GLSL fragment shader now.',
      'Output raw GLSL only. No markdown, prose, hidden reasoning, or comments about your plan.',
      'Required tokens: precision mediump float; uniform vec2 u_resolution; uniform float u_time; void main(); gl_FragColor.',
      'Use gl_FragCoord / u_resolution for uv coordinates and u_time for animation.',
      'Include either hash/noise/fbm or multiple vec3 color palettes so the shader is not a flat gradient.',
      `Creative brief: ${this.extractCreativeBrief(originalPrompt)}`,
    ].join('\n');
  }

  protected maxTokensForDirectRetry(maxTokens?: number): number | undefined {
    const configured = this.llm.getConfig().maxTokens;
    return Math.max(maxTokens ?? 0, configured ?? 0, 4096);
  }

  protected temperatureForDirectRetry(): number | undefined {
    return 0.2;
  }

  protected validateOutput(code: string): { valid: boolean; error?: string } {
    code = this.sanitizeShaderCode(code);
    const preprocessorError = this.validatePreprocessorDirectives(code);
    if (preprocessorError) {
      return { valid: false, error: preprocessorError };
    }

    if (/\.\.\./.test(code) || /\/\/\s*\.\.\./.test(code)) {
      return { valid: false, error: 'Generated shader contains placeholder ellipses; return complete executable GLSL' };
    }

    if (/\bvec4\s*\(\s*color\b/.test(code) && !/\b(?:vec[234]|float)\s+color\b/.test(code)) {
      return { valid: false, error: 'Generated shader references color without declaring it' };
    }

    // The host sets only these; any other uniform stays zero. A shader reading
    // `uniform vec2 resolution` divides by zero and renders a blank white frame
    // (live d1-2B cell, 2026-11-10). Reject so the repair turn renames it.
    const deadUniforms = [...code.matchAll(/\buniform\s+\w+\s+(\w+)/g)]
      .map((m) => m[1])
      .filter((name) => !HOST_UNIFORMS.has(name));
    if (deadUniforms.length > 0) {
      return {
        valid: false,
        error: `Shader declares uniforms the host never sets: ${[...new Set(deadUniforms)].join(', ')}. The host supplies exactly: uniform float u_time; uniform vec2 u_resolution; uniform vec2 u_mouse; — delete the dead declarations or fold their values into constants.`,
      };
    }

    if (this.isTruncated(code)) {
      if (!code.includes('void main') && !code.includes('gl_FragColor')) {
        return {
          valid: false,
          error: 'Generated code is critically incomplete (missing main or gl_FragColor)',
        };
      }
      Logger.warn('ShaderGenerator', 'Code may be truncated, attempting to use anyway');
    }
    const validation = GLSLValidator.validate(code);
    if (!validation.valid) {
      return { valid: false, error: validation.errors.join('; ') };
    }
    return { valid: true };
  }

  /**
   * Async validation with compile check.
   *
   * Runs synchronous static validation first (fast rejection), then performs
   * a headless WebGL compile check to catch undeclared variables/functions
   * that static analysis cannot detect.
   */
  protected async validateForGeneration(code: string): Promise<{ valid: boolean; error?: string }> {
    // First run synchronous validation for fast rejection
    const syncResult = this.validateOutput(code);
    if (!syncResult.valid) {
      return syncResult;
    }

    // Sanitize the code for compile check
    const sanitized = this.sanitizeShaderCode(code);

    // Run compile check using headless WebGL
    try {
      const compileResult = await GLSLValidator.compileCheck(sanitized);
      if (compileResult.status === 'infra-unavailable') {
        // Infrastructure unavailable — fall back to sync validation only
        // (this is expected in browserless CI environments)
        Logger.warn('ShaderGenerator', `Compile check unavailable: ${compileResult.error}. Proceeding with sync validation only.`);
        return { valid: true };
      }
      if (!compileResult.success) {
        return { valid: false, error: `GLSL compile error: ${compileResult.error}` };
      }
    } catch (err) {
      // If compile check throws (e.g., puppeteer unavailable), log and continue
      // so we don't block generation entirely
      const message = err instanceof Error ? err.message : String(err);
      Logger.warn('ShaderGenerator', `Compile check unavailable: ${message}. Proceeding with sync validation only.`);
    }

    return { valid: true };
  }

  private validatePreprocessorDirectives(code: string): string | null {
    let depth = 0;
    for (const line of code.split('\n')) {
      const trimmed = line.trim();
      if (/^#\s*(if|ifdef|ifndef)\b/.test(trimmed)) {
        depth++;
      } else if (/^#\s*(else|elif)\b/.test(trimmed)) {
        if (depth === 0) return `Orphan GLSL preprocessor directive: ${trimmed}`;
      } else if (/^#\s*endif\b/.test(trimmed)) {
        if (depth === 0) return `Orphan GLSL preprocessor directive: ${trimmed}`;
        depth--;
      }
    }
    return depth > 0 ? 'Unclosed GLSL preprocessor conditional' : null;
  }

  private isTruncated(code: string): boolean {
    const trimmed = code.trim();
    const lastChar = trimmed.slice(-1);
    const lastLine = trimmed.split('\n').pop() || '';
    if (!['}', ';', '\n'].includes(lastChar) && lastLine.length > 0) {
      if (!lastLine.trim().startsWith('//') && !lastLine.trim().startsWith('/*')) {
        return true;
      }
    }
    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    if (openBraces > closeBraces) return true;
    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    if (openParens > closeParens) return true;
    if (!code.includes('void main') || !code.includes('gl_FragColor')) return true;
    return false;
  }

  wrapForGallery(code: string): string {
    code = this.sanitizeShaderCode(code);
    const hasTime = /\buniform\s+float\s+(u_time|iTime)\s*;/.test(code);
    const hasResolution = /\buniform\s+vec2\s+(u_resolution|iResolution)\s*;/.test(code);
    const hasMain = /\bvoid\s+main\s*\(/.test(code);
    const hasMainImage = /\bvoid\s+mainImage\s*\(/.test(code);
    // `#version` must be the first token and an ES 1.00 `#extension` must precede
    // every other token, so the injected declarations go AFTER those lines.
    const { header, body } = hoistGLSLDirectives(code);
    const shaderSource = [
      header,
      // Always lead with a default float precision: the injected uniforms below
      // would otherwise precede the shader's own precision line and fail with
      // "No precision specified for (float)". A later redeclaration is legal.
      'precision mediump float;',
      hasTime ? '' : 'uniform float u_time;',
      hasResolution ? '' : 'uniform vec2 u_resolution;',
      body,
      hasMainImage && !hasMain ? 'void main(){mainImage(gl_FragColor,gl_FragCoord.xy);}' : '',
    ].filter(Boolean).join('\n');
    const usesGlsl300 = /^\s*#version\s+300\s+es/m.test(shaderSource);
    const encodedShader = JSON.stringify(shaderSource);
    const vertexShader = usesGlsl300
      ? '#version 300 es\nin vec2 a_pos;out vec2 v_uv;void main(){v_uv=a_pos*0.5+0.5;gl_Position=vec4(a_pos,0,1);}'
      : 'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0,1);}';
    const harness = '<!DOCTYPE html>\n' +
      '<html>\n' +
      '<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>GLSL Shader</title>\n' +
      '<style>\n' +
      '*{margin:0;padding:0;overflow:hidden}\n' +
      'body{background:#000}\n' +
      'canvas{display:block;width:100vw;height:100vh}\n' +
      '</style>\n' +
      '</head>\n' +
      '<body>\n' +
      '<canvas id="c"></canvas>\n' +
      '<script>\n' +
      'const canvas=document.getElementById("c");\n' +
      'const gl=canvas.getContext("webgl2")||canvas.getContext("webgl");\n' +
      'function resize(){canvas.width=innerWidth;canvas.height=innerHeight;gl&&gl.viewport(0,0,canvas.width,canvas.height)}\n' +
      'addEventListener("resize",resize);resize();\n' +
      'const vs=' + JSON.stringify(vertexShader) + ';\n' +
      'const fs=' + encodedShader + ';\n' +
      'function createShader(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){throw new Error(gl.getShaderInfoLog(s)||"shader compile failed")}return s;}\n' +
      'gl.getExtension("OES_standard_derivatives");\n' +
      'const v=createShader(gl.VERTEX_SHADER,vs);\n' +
      'const f=createShader(gl.FRAGMENT_SHADER,fs);\n' +
      'const prog=gl.createProgram();gl.attachShader(prog,v);gl.attachShader(prog,f);gl.linkProgram(prog);if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){throw new Error(gl.getProgramInfoLog(prog)||"shader link failed")}gl.useProgram(prog);\n' +
      'const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);\n' +
      'const loc=gl.getAttribLocation(prog,"a_pos");gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);\n' +
      'const uTime=gl.getUniformLocation(prog,"u_time");\n' +
      'const uRes=gl.getUniformLocation(prog,"u_resolution");\n' +
      'let t=0;\n' +
      'function render(){t+=0.016;gl.uniform1f(uTime,t);gl.uniform2f(uRes,canvas.width,canvas.height);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);requestAnimationFrame(render);}\n' +
      'render();\n' +
      '</script>\n' +
      '</body>\n' +
      '</html>';
    return harness;
  }

  private sanitizeShaderCode(code: string): string {
    // Some seats return the shader JSON-escaped (literal \n and \` around the
    // fence). GLSL has no strings or backticks, so unescaping is safe.
    const text = splitThinking(code.replace(/\\n/g, '\n').replace(/\\`/g, '`')).answer;
    const block = pickCodeBlock(text, ['glsl', 'frag', 'fragment', 'shader']);
    if (block?.body.trim() && !['html', 'htm', 'javascript', 'js'].includes(block.lang)) {
      return this.injectCommonHelpers(block.body.trim());
    }
    const htmlShader = text.match(/\b(?:const|let|var)\s+(?:fsSource|fragSrc|fs|fragmentShaderSource|fragmentSource|fragmentShader|shaderSource)\s*=\s*`([\s\S]*?)`/);
    if (htmlShader?.[1]) {
      return this.injectCommonHelpers(htmlShader[1].trim());
    }
    return this.injectCommonHelpers(answerCode(text));
  }

  private injectCommonHelpers(code: string): string {
    code = this.repairCommonLocalModelIssues(code);
    code = this.ensureMainEntrypoint(code);
    code = this.injectKnownHelperPrelude(code);
    return this.addKnownHelperForwardDeclarations(code);
  }

  /**
   * Inject vetted definitions for common shader helpers (rot/hash/noise/fbm/
   * palette) that the shader CALLS but does not DEFINE. This rescues the most
   * frequent `glsl_undefined_fn` generation failure: LLMs use these idioms from
   * shadertoy without including their definitions, and GLSLValidator rejects the
   * whole shader. Genuinely-unknown functions still fail validation (we only
   * inject from the known allowlist). Idempotent: a helper that is already
   * defined is never re-injected, so a shader with its own `rot` keeps it.
   */
  private injectKnownHelperPrelude(code: string): string {
    const isDefined = (name: string) => new RegExp(`\\b${GLSL_HELPER_RETURN_TYPES}\\s+${name}\\s*\\(`).test(code);
    const isCalled = (name: string) => new RegExp(`\\b${name}\\s*\\(`).test(code);

    // Collect called-but-undefined known helpers, then pull in transitive deps.
    const needed = new Set<string>();
    const queue: string[] = [];
    for (const name of HELPER_ORDER) {
      if (isCalled(name) && !isDefined(name)) {
        needed.add(name);
        queue.push(name);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      for (const dep of HELPER_PRELUDE[queue[i]].deps) {
        if (!isDefined(dep) && !needed.has(dep)) {
          needed.add(dep);
          queue.push(dep);
        }
      }
    }
    if (needed.size === 0) return code;

    // HELPER_ORDER lists deps before dependents, so filtering preserves a
    // compile-safe emission order.
    const block = HELPER_ORDER.filter((name) => needed.has(name)).map((name) => HELPER_PRELUDE[name].def).join('\n');

    // Insert after the leading preamble (version/precision/uniforms/comments) and
    // before the first real declaration or function — never above #version/precision.
    const lines = code.split('\n');
    const insertAt = this.shaderPreambleInsertIndex(lines);

    if (insertAt === lines.length) return `${code}\n${block}\n`;
    return [...lines.slice(0, insertAt), block, ...lines.slice(insertAt)].join('\n');
  }

  private addKnownHelperForwardDeclarations(code: string): string {
    const helperAlternation = HELPER_ORDER.join('|');
    const definitionPattern = new RegExp(`\\b(${GLSL_HELPER_RETURN_TYPES})\\s+(${helperAlternation})\\s*\\(([^)]*)\\)\\s*\\{`, 'g');
    const definitions = new Map<string, Array<{ index: number; signature: string }>>();
    for (const match of code.matchAll(definitionPattern)) {
      const index = match.index ?? 0;
      const returnType = match[1].trim().replace(/\s+/g, ' ');
      const name = match[2];
      const params = match[3].trim().replace(/\s+/g, ' ');
      const signature = `${returnType} ${name}(${params});`;
      const entries = definitions.get(name) ?? [];
      entries.push({ index, signature });
      definitions.set(name, entries);
    }

    const declarations: string[] = [];
    const seen = new Set<string>();
    for (const name of HELPER_ORDER) {
      const entries = definitions.get(name);
      if (!entries || entries.length === 0) continue;
      const firstDefinition = Math.min(...entries.map((entry) => entry.index));
      const callPattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
      let firstCallBeforeDefinition = Number.POSITIVE_INFINITY;
      for (const match of code.matchAll(callPattern)) {
        const callIndex = match.index ?? 0;
        if (callIndex < firstDefinition) {
          firstCallBeforeDefinition = callIndex;
          break;
        }
      }
      if (!Number.isFinite(firstCallBeforeDefinition)) continue;

      const prototypePattern = new RegExp(`\\b${GLSL_HELPER_RETURN_TYPES}\\s+${name}\\s*\\([^)]*\\)\\s*;`, 'g');
      const hasEarlierPrototype = [...code.matchAll(prototypePattern)]
        .some((match) => (match.index ?? 0) < firstCallBeforeDefinition);
      if (hasEarlierPrototype) continue;

      for (const entry of entries) {
        if (seen.has(entry.signature)) continue;
        seen.add(entry.signature);
        declarations.push(entry.signature);
      }
    }

    if (declarations.length === 0) return code;
    const lines = code.split('\n');
    const insertAt = this.shaderPreambleInsertIndex(lines);
    return [...lines.slice(0, insertAt), ...declarations, ...lines.slice(insertAt)].join('\n');
  }

  private shaderPreambleInsertIndex(lines: string[]): number {
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (trimmed === '') continue;
      if (trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        continue;
      }
      if (/^#version\b/.test(trimmed) || /^precision\b/.test(trimmed) || /^uniform\b/.test(trimmed)
        || /^varying\b/.test(trimmed) || /^attribute\b/.test(trimmed) || /^#define\b/.test(trimmed)) {
        continue;
      }
      return i;
    }
    return lines.length;
  }

  private ensureMainEntrypoint(code: string): string {
    if (/\bvoid\s+main\s*\(/.test(code)) return code;
    if (/\bvoid\s+mainImage\s*\(/.test(code)) {
      if (this.isGlsl300(code)) {
        const declaredOutput = this.findDeclaredFragmentOutput(code);
        const outputVariable = declaredOutput ?? 'liminalFragColor';
        const shader = declaredOutput ? code.trim() : this.insertGlsl300FragmentOutput(code, outputVariable);
        return `${shader}\nvoid main(){mainImage(${outputVariable},gl_FragCoord.xy);}`;
      }
      return `${code.trim()}\nvoid main(){mainImage(gl_FragColor,gl_FragCoord.xy);}`;
    }
    return code;
  }

  private isGlsl300(code: string): boolean {
    return /^\s*#version\s+300\s+es\b/m.test(code);
  }

  private findDeclaredFragmentOutput(code: string): string | null {
    const match = code.match(/^\s*(?:layout\s*\([^)]*\)\s*)?out\s+(?:(?:lowp|mediump|highp)\s+)?vec4\s+([A-Za-z_]\w*)\s*;/m);
    return match?.[1] ?? null;
  }

  private insertGlsl300FragmentOutput(code: string, outputVariable: string): string {
    const declaration = `out vec4 ${outputVariable};`;
    const trimmed = code.trim();
    const precisionMatch = trimmed.match(/^\s*precision\s+(?:lowp|mediump|highp)\s+float\s*;\s*/m);
    if (precisionMatch?.index !== undefined) {
      const insertAt = precisionMatch.index + precisionMatch[0].length;
      return `${trimmed.slice(0, insertAt)}\n${declaration}\n${trimmed.slice(insertAt)}`;
    }
    const versionMatch = trimmed.match(/^\s*#version\s+300\s+es[^\n]*\n?/m);
    if (versionMatch?.index !== undefined) {
      const insertAt = versionMatch.index + versionMatch[0].length;
      return `${trimmed.slice(0, insertAt)}${declaration}\n${trimmed.slice(insertAt)}`;
    }
    return `${declaration}\n${trimmed}`;
  }

  /**
   * Balance GLSL preprocessor conditionals so the shader compiles. Reasoning
   * models (Grok 4.6) occasionally emit an orphan `#endif` (a stray shadertoy
   * header remnant) or leave an `#if` unclosed — both are guaranteed WebGL
   * compile failures ("#endif without a matching #if"). Drop orphans and append
   * closers for stragglers. The GL_ES precision guard is already collapsed by
   * repairCommonLocalModelIssues; this catches everything else.
   */
  private balancePreprocessorDirectives(code: string): string {
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

  private repairCommonLocalModelIssues(code: string): string {
    // Dialect normalize FIRST: desktop #version headers, ES3/WebGL1 in/out
    // mismatches, C math names, 1e6.0 literals, uTime/U_Time spellings — the
    // deterministic layer of the LFM3 failure classes, fixed before any lint
    // gets to see the code.
    const normalized = normalizeGLSLDialect(code);
    if (normalized.fixes.length > 0) {
      Logger.debug('ShaderGenerator', `GLSL dialect normalized: ${normalized.fixes.join(', ')}`);
    }
    code = normalized.code;

    // The WebGL1 fragment-shader render harness embeds the shader source directly
    // and mishandles `#ifdef GL_ES ... #endif` precision guards: it strips the
    // opener and leaves the `#endif`, producing "unexpected #endif without a
    // matching #if" at compile. GLSL ES 1.00 only needs a bare precision
    // declaration, so collapse any GL_ES guard to the precision line it wraps
    // (or its inner content) before it can be orphaned downstream.
    code = code.replace(
      /#\s*if(?:def\s+GL_ES|\s+defined\s*\(\s*GL_ES\s*\))\b[^\n]*\n([\s\S]*?)\n?[^\S\n]*#\s*endif\b[^\n]*/gi,
      (_match, inner: string) => {
        const precision = inner.match(/precision\s+(?:low|medium|high)p\s+float\s*;/i);
        return precision ? precision[0] : inner.trim();
      },
    );

    // Balance any remaining preprocessor conditionals: reasoning models (Grok
    // 4.6) sometimes emit an orphan #endif (stray header remnant) or an unclosed
    // #if — both are guaranteed compile failures. Drop orphans, close stragglers.
    code = this.balancePreprocessorDirectives(code);

    code = code.replace(
      /\bvec2\s+u\s*=\s*f\s*\*\s*f\s*\*\s*\(\s*3\.0\s*-\s*2\.0\s*\*\s*u\s*\)\s*;/g,
      'vec2 u = f * f * (3.0 - 2.0 * f);',
    );

    code = this.liftDarkFinalColorPreview(code);

    const hasPaletteVec2Call = /\bpalette\s*\(\s*p\s*\)/.test(code);
    const paletteBodyUsesP = /\bvec3\s+palette\s*\(\s*float\s+\w+\s*\)\s*\{[\s\S]*?\bp\b[\s\S]*?\}/.test(code);
    if (!hasPaletteVec2Call || !paletteBodyUsesP) return code;

    return code.replace(/\bvec3\s+palette\s*\(\s*float\s+\w+\s*\)/, 'vec3 palette(vec2 p)');
  }

  private liftDarkFinalColorPreview(code: string): string {
    if (code.includes('sinterPreviewExposureLift')) return code;
    if (!/\bvec3\s+finalColor\b/.test(code)) return code;
    if (!/\bgl_FragColor\s*=\s*vec4\s*\(\s*finalColor\s*,\s*1\.0\s*\)\s*;/.test(code)) return code;
    const hasDarkeningPass = /\bfinalColor\s*\*=\s*vignette\b/.test(code)
      || /\bfinalColor\s*=\s*finalColor\s*\/\s*\(\s*finalColor\s*\+\s*vec3\s*\(\s*1\.0\s*\)\s*\)\s*;/.test(code);
    if (!hasDarkeningPass) return code;

    return code.replace(
      /^(\s*)gl_FragColor\s*=\s*vec4\s*\(\s*finalColor\s*,\s*1\.0\s*\)\s*;/m,
      '$1finalColor = clamp(finalColor * 1.6 + vec3(0.08), 0.0, 1.0); // sinterPreviewExposureLift\n$&',
    );
  }

  private shouldUseProviderRecoveryShader(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;
    const message = err instanceof Error ? err.message : String(err);
    return /(?:no usable content|LLM returned empty code|Generated code is too short \(0 chars\)|Code is empty after stripping)/i.test(message);
  }

  private extractCreativeBrief(prompt: string): string {
    const match = prompt.match(/(?:Primary request:|User request:|Original request:)\s*([^\n]+)/i);
    const brief = (match?.[1] ?? prompt).replace(/\s+/g, ' ').trim();
    return brief.slice(0, 500);
  }

  private providerRecoveryShader(): string {
    return [
      '/* Sinter provider recovery: local GLSL safety shader rendered after the model returned no artifact. */',
      'precision mediump float;',
      'uniform vec2 u_resolution;',
      'uniform float u_time;',
      '',
      'float hash(vec2 p) {',
      '  p = fract(p * vec2(127.1, 311.7));',
      '  p += dot(p, p + 34.17);',
      '  return fract(p.x * p.y);',
      '}',
      '',
      'float noise(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),',
      '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
      '}',
      '',
      'float fbm(vec2 p) {',
      '  float value = 0.0;',
      '  float amplitude = 0.5;',
      '  for (int i = 0; i < 5; i++) {',
      '    value += amplitude * noise(p);',
      '    p *= 2.05;',
      '    amplitude *= 0.52;',
      '  }',
      '  return value;',
      '}',
      '',
      'void main() {',
      '  vec2 safeResolution = max(u_resolution, vec2(1.0));',
      '  vec2 uv = gl_FragCoord.xy / safeResolution;',
      '  vec2 p = (uv - 0.5) * vec2(safeResolution.x / safeResolution.y, 1.0);',
      '  float t = u_time * 0.18;',
      '  float field = fbm(p * 3.0 + vec2(t, -t));',
      '  float cloud = fbm(p * 6.0 - vec2(t * 0.7, t * 0.4));',
      '  float radial = length(p);',
      '  float pulse = 0.5 + 0.5 * sin(radial * 18.0 - u_time * 2.0);',
      '  vec3 shadow = vec3(0.035, 0.015, 0.085);',
      '  vec3 violet = vec3(0.44, 0.12, 0.84);',
      '  vec3 orchid = vec3(0.80, 0.35, 1.00);',
      '  vec3 cyan = vec3(0.16, 0.70, 0.95);',
      '  vec3 color = mix(shadow, violet, smoothstep(0.18, 0.86, field));',
      '  color = mix(color, orchid, smoothstep(0.45, 0.95, cloud) * 0.55);',
      '  color += cyan * pow(pulse, 3.0) * smoothstep(0.65, 0.05, radial) * 0.35;',
      '  color += vec3(0.95, 0.82, 1.0) * smoothstep(0.82, 1.0, field) * 0.22;',
      '  gl_FragColor = vec4(color, 1.0);',
      '}',
    ].join('\n');
  }
}
