/**
 * Headless GLSL compile check using puppeteer.
 *
 * Catches undeclared variables, functions, type mismatches, and other compile-time
 * errors that static analysis cannot detect.
 */

import { spawnSync } from 'node:child_process';
import { prepareBrowserScratch } from './scratchSpace.js';

export type CompileCheckStatus = 'pass' | 'compile-error' | 'infra-unavailable';

export interface CompileCheckResult {


  success: boolean;
  status: CompileCheckStatus;
  error?: string;
}

export interface ShaderSources {
  isGlsl300: boolean;
  vertexShaderSrc: string;
  fragmentShaderSrc: string;
}

/**
 * Pure source-building for the compile check, exported for direct unit testing.
 * ES 3.00 (#version 300 es): #version stays first — no preamble injection, and
 * the vertex shader carries its own #version 300 es directive (a versionless
 * vertex compiles as ES 1.00 where `in` is invalid). WebGL1: injects
 * `precision mediump float` plus u_resolution/u_time only when absent.
 */
export function buildShaderSources(shaderCode: string): ShaderSources {
  const isGlsl300 = /^#version\s+300\s+es\b/m.test(shaderCode);
  const hasMain = /\bvoid\s+main\s*\(/.test(shaderCode);

  let source: string;
  if (isGlsl300) {
    // ES 3.00: #version must stay first — skip all preamble injection.
    source = shaderCode;
  } else {
    // WebGL1: inject precision + common uniforms only when absent.
    // Word-boundary regex prevents "u_resolution2" from blocking injection.
    let preamble = 'precision mediump float;\n';
    if (!/\bu_resolution\b/.test(shaderCode)) {
      preamble += 'uniform vec2 u_resolution;\n';
    }
    if (!/\bu_time\b/.test(shaderCode)) {
      preamble += 'uniform float u_time;\n';
    }
    // `#version` / `#extension` lines must stay ahead of the injected preamble.
    const directives: string[] = [];
    const rest: string[] = [];
    for (const line of shaderCode.split('\n')) {
      (/^[ \t]*#[ \t]*(?:version|extension)\b/.test(line) ? directives : rest).push(line);
    }
    source = (directives.length ? directives.join('\n') + '\n' : '') + preamble + rest.join('\n');
  }

  const vertexShaderSrc = isGlsl300
    ? '#version 300 es\nin vec2 a_position; void main() { gl_Position = vec4(a_position, 0.0, 1.0); }'
    : 'attribute vec2 a_position; void main() { gl_Position = vec4(a_position, 0.0, 1.0); }';

  const fragmentShaderSrc = (isGlsl300 || hasMain)
    ? source
    : `${source}\nvoid main(){main();}`;

  return { isGlsl300, vertexShaderSrc, fragmentShaderSrc };
}

let browserInstance: import('puppeteer').Browser | null = null;
let browserInitPromise: Promise<import('puppeteer').Browser | null> | null = null;

const LAUNCH_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 15_000;

/**
 * Lazily acquire a reusable headless browser instance.
 * Exported for use in shutdown hooks; call browserShutdown() to release.
 */
export async function getOrCreateBrowser(): Promise<import('puppeteer').Browser | null> {
  if (browserInstance !== null) return browserInstance;
  if (browserInitPromise !== null) return browserInitPromise;

  const disableSandbox = process.env.LIMINAL_DISABLE_SANDBOX === 'true';

  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : null,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : null,
  ].filter(Boolean) as string[];

  let chromeExecutablePath: string | undefined;
  for (const path of chromePaths) {
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(path)) {
        chromeExecutablePath = path;
        break;
      }
    } catch {
      // Continue checking other paths
    }
  }

  browserInitPromise = (async () => {
    try {
      const puppeteer = await import('puppeteer');
      const { getChromeArgs } = await import('../security/SandboxConfig.js');
      prepareBrowserScratch();   // profile dir off the data volume + free-space check
      browserInstance = await puppeteer.launch({
        headless: true,
        executablePath: chromeExecutablePath,
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          ...getChromeArgs({ forceDisableSandbox: disableSandbox }),
          '--enable-webgl',
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
          '--ignore-gpu-blocklist',
        ],
      });
      return browserInstance;
    } catch {
      browserInstance = null;
      browserInitPromise = null;
      return null;
    }
  })();

  return browserInitPromise;
}

/**
 * Release the shared browser instance. Call during process shutdown.
 */
export async function browserShutdown(): Promise<void> {
  const browser = browserInstance;
  browserInstance = null;
  browserInitPromise = null;
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Ignore close errors
    }
  }
}

type HarnessResult = { error: string | null; infra?: boolean };

/**
 * Check if a GLSL fragment shader compiles successfully using headless WebGL.
 *
 * @param fragmentShader - The fragment shader source code to check
 * @returns CompileCheckResult with explicit tri-state: pass / compile-error / infra-unavailable
 */
export async function checkGLSLCompile(fragmentShader: string): Promise<CompileCheckResult> {
  const browser = await getOrCreateBrowser();

  if (!browser) {
    return {
      success: false,
      status: 'infra-unavailable',
      error: 'Chrome/Chromium unavailable',
    };
  }

  let page: import('puppeteer').Page | null = null;
  try {
    page = await browser.newPage();
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });

    // Race the evaluate against PAGE_TIMEOUT_MS so a wedged page cannot stall indefinitely.
    const result = await new Promise<HarnessResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Shader evaluation timed out')), PAGE_TIMEOUT_MS);
      // page.evaluate serializes the callback for the browser — module-scope
      // bindings do NOT exist there. Pass the shared source builder as a
      // string and rebuild it in-page so Node and browser run the SAME logic.
      page!.evaluate((shaderCode: string, sourcesFnSource: string) => {
        // eslint-disable-next-line no-eval -- trusted input: sourcesFnSource is buildShaderSources.toString() from this module (never LLM output); the shader text is passed as data to it, not evaluated
        const buildShaderSources = eval(`(${sourcesFnSource})`) as (code: string) => { vertexShaderSrc: string; fragmentShaderSrc: string; isGlsl300: boolean };
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;

        // ES 3.00 requires webgl2; otherwise try webgl then experimental-webgl
        const isGlsl300 = /^#version\s+300\s+es\b/m.test(shaderCode);
        let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
        if (isGlsl300) {
          gl = (canvas.getContext('webgl2') as WebGL2RenderingContext | null);
        }
        if (!gl) {
          gl = (canvas.getContext('webgl') ||
            (canvas as HTMLCanvasElement & { getContext(x: string): WebGLRenderingContext | null }).getContext('experimental-webgl')) as WebGLRenderingContext | null;
        }

        // Null context = infra condition, not a shader defect
        if (!gl) {
          return { error: 'WebGL not available', infra: true };
        }

        // WebGL1 only honors `#extension GL_OES_standard_derivatives` once the
        // extension has been requested; WebGL2 returns null (derivatives are core).
        gl.getExtension('OES_standard_derivatives');

        const { vertexShaderSrc, fragmentShaderSrc } = buildShaderSources(shaderCode);

        // Compile vertex shader
        const vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) return { error: 'Failed to create vertex shader' };
        gl.shaderSource(vs, vertexShaderSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(vs) || 'Unknown vertex shader error';
          gl.deleteShader(vs);
          return { error: `Vertex: ${log}` };
        }

        // Compile fragment shader
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) { gl.deleteShader(vs); return { error: 'Failed to create fragment shader' }; }
        gl.shaderSource(fs, fragmentShaderSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(fs) || 'Unknown fragment shader error';
          gl.deleteShader(vs);
          gl.deleteShader(fs);
          return { error: `Fragment: ${log}` };
        }

        // Link program
        const program = gl.createProgram();
        if (!program) { gl.deleteShader(vs); gl.deleteShader(fs); return { error: 'Failed to create program' }; }
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          const log = gl.getProgramInfoLog(program) || 'Unknown link error';
          gl.deleteShader(vs);
          gl.deleteShader(fs);
          gl.deleteProgram(program);
          return { error: `Link: ${log}` };
        }

        gl.deleteProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return { error: null };
      }, fragmentShader, buildShaderSources.toString()).then(resolve).catch(reject).finally(() => clearTimeout(timer));
    });

    if (result.infra) {
      return { success: false, status: 'infra-unavailable', error: result.error ?? undefined };
    }
    if (result.error) {
      // Driver logs can contain NUL/control bytes; keep diagnostic whitespace and Unicode.
      // eslint-disable-next-line no-control-regex -- intentionally match non-printing diagnostic bytes
      const error = result.error.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      return { success: false, status: 'compile-error', error };
    }
    return { success: true, status: 'pass' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, status: 'infra-unavailable', error: `Browser error: ${message}` };
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Synchronous compile check that returns a Promise (for use in async contexts).
 * This is the same as checkGLSLCompile but with a clearer name for the validator.
 */
export async function glslCompileCheck(fragmentShader: string): Promise<CompileCheckResult> {
  const browserResult = await checkGLSLCompile(fragmentShader);
  if (browserResult.status !== 'infra-unavailable') return browserResult;
  // No browser WebGL (CI runners, Kaggle, some headless hosts). A static pass
  // is not a compile: fall back to the Khronos reference compiler so an
  // undeclared identifier or orphan #endif still fails instead of passing open.
  const reference = glslangCompileCheck(fragmentShader);
  if (reference) return reference;
  return browserResult;
}

/**
 * Compile the fragment shader with glslangValidator (the Khronos reference
 * front end) when it is on PATH. Uses the same sources as the WebGL check.
 * Returns null when glslangValidator is not installed.
 */
export function glslangCompileCheck(fragmentShader: string): CompileCheckResult | null {
  const { fragmentShaderSrc } = buildShaderSources(fragmentShader);
  const run = spawnSync('glslangValidator', ['--stdin', '-S', 'frag'], {
    input: fragmentShaderSrc,
    encoding: 'utf8',
    timeout: PAGE_TIMEOUT_MS,
  });
  if (run.error) return null;
  if (run.status === 0) return { success: true, status: 'pass' };
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const errors = log.split('\n').filter((l) => /^ERROR:/.test(l) && !/compilation errors/.test(l));
  return {
    success: false,
    status: 'compile-error',
    error: `Fragment (glslang): ${(errors.length ? errors.join('\n') : log).trim().slice(0, 2000)}`,
  };
}
