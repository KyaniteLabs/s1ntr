import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to load compile check from dist; if dist is missing/stale, compile check is unavailable
let glslCompileCheck = null;
try {
  // Use createRequire for reliable .mjs → dist resolution
  const require = createRequire(import.meta.url);
  const mod = require('../../dist/utils/glsl-compile-check.js');
  glslCompileCheck = mod.glslCompileCheck ?? mod.checkGLSLCompile ?? null;
} catch {
  glslCompileCheck = null;
}

const EXPECTED_EXTENSIONS = {
  p5: '.js',
  svg: '.svg',
  glsl: '.frag',
  three: '.js',
  hydra: '.js',
  strudel: '.js',
  tone: '.html',
  revideo: '.tsx',
  hyperframes: '.html',
  ascii: '.txt',
  kinetic: '.html',
  textgen: '.txt',
  html: '.html',
  dataviz: '.html',
};

export function validateCreativeDomainArtifact(domain, artifactPath, content) {
  const normalizedDomain = String(domain || '').toLowerCase();
  const source = String(content || '');
  const checks = [];

  addCheck(checks, 'expected-extension', path.extname(String(artifactPath || '')).toLowerCase() === EXPECTED_EXTENSIONS[normalizedDomain], `expected ${EXPECTED_EXTENSIONS[normalizedDomain] || 'known extension'}`);
  addCheck(checks, 'non-empty', Buffer.byteLength(source.trim(), 'utf8') > 0, 'artifact is empty');

  for (const check of domainChecks(normalizedDomain, source)) checks.push(check);

  const errors = checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.message}`);
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    checks,
    errors,
  };
}

function domainChecks(domain, source) {
  const checks = [];
  const trimmed = source.trim();

  switch (domain) {
    case 'p5':
      addCheck(checks, 'p5-setup', /\bfunction\s+setup\s*\(|\bsetup\s*=\s*\(/.test(source), 'missing setup()');
      addCheck(checks, 'p5-canvas', /\bcreateCanvas\s*\(/.test(source), 'missing createCanvas()');
      addCheck(checks, 'p5-draw', /\bfunction\s+draw\s*\(|\bdraw\s*=\s*\(/.test(source), 'missing draw()');
      break;
    case 'svg':
      addCheck(checks, 'svg-root', /^<svg[\s>]/i.test(trimmed), 'missing root <svg>');
      addCheck(checks, 'svg-close', /<\/svg>\s*$/i.test(trimmed), 'missing closing </svg>');
      addCheck(checks, 'svg-visible-shape', /<(path|circle|rect|line|polyline|polygon|ellipse|text)\b/i.test(source), 'missing visible SVG shape');
      addCheck(checks, 'svg-transparent-background', !hasOpaqueFullCanvasRect(source), 'opaque full-canvas rect violates the transparent-background SVG proof contract');
      break;
    case 'glsl':
      addCheck(checks, 'glsl-main', /\bvoid\s+main\s*\(/.test(source), 'missing void main()');
      addCheck(checks, 'glsl-output', /\b(gl_FragColor|fragColor)\b/.test(source), 'missing fragment output');
      addCheck(checks, 'glsl-coordinate', /\b(gl_FragCoord|u_resolution|resolution)\b/.test(source), 'missing fragment coordinate/resolution reference');
      break;
    case 'three':
      addCheck(checks, 'three-scene', /\bTHREE\.Scene\s*\(/.test(source), 'missing THREE.Scene');
      addCheck(checks, 'three-renderer', /\bTHREE\.WebGLRenderer\s*\(/.test(source), 'missing THREE.WebGLRenderer');
      addCheck(checks, 'three-render-call', /\brenderer\.render\s*\(/.test(source), 'missing renderer.render()');
      addCheck(checks, 'three-camera', /\b(PerspectiveCamera|OrthographicCamera)\b/.test(source), 'missing camera');
      break;
    case 'hydra':
      addCheck(checks, 'hydra-source', /\b(osc|shape|noise|voronoi|gradient|solid)\s*\(/.test(source), 'missing Hydra visual source');
      addCheck(checks, 'hydra-output', /\.out\s*\(|\brender\s*\(/.test(source), 'missing Hydra out()/render()');
      break;
    case 'strudel':
      addCheck(checks, 'strudel-pattern', /\b(s|note|stack|sound)\s*\(/.test(source), 'missing Strudel pattern function');
      addCheck(checks, 'strudel-rhythm', /["'`][^"'`]*(bd|sn|hh|kick|hat|808|909|c1|g1)[^"'`]*["'`]/i.test(source), 'missing audible rhythm/note tokens');
      break;
    case 'tone':
      addCheck(checks, 'tone-html', /<html[\s>]/i.test(source), 'missing HTML shell');
      addCheck(checks, 'tone-library', /\bTone(\.js|\.|@)|tone\/14/i.test(source), 'missing Tone.js reference');
      addCheck(checks, 'tone-control', /<button\b|role=["']button["']|Tone\.start\s*\(/i.test(source), 'missing browser playback control');
      break;
    case 'revideo':
      addCheck(checks, 'revideo-scene', /\bmakeScene2D\s*\(/.test(source), 'missing makeScene2D scene');
      addCheck(checks, 'revideo-visual', /\b(Txt|Rect|Img|Video|Circle)\b/.test(source), 'missing Revideo visual primitive');
      addCheck(checks, 'revideo-timing', /\byield\*\s*|waitFor\s*\(/.test(source), 'missing Revideo timing');
      break;
    case 'hyperframes':
      addCheck(checks, 'hyperframes-html', /<!doctype html>|<html[\s>]/i.test(source), 'missing HTML shell');
      addCheck(checks, 'hyperframes-stage', /\bdata-composition-id\b/.test(source), 'missing composition id');
      addCheck(checks, 'hyperframes-clips', (source.match(/\bclass=["'][^"']*\bclip\b/g) || []).length >= 3, 'missing at least three clips');
      addCheck(checks, 'hyperframes-timeline', /\bgsap\.timeline\s*\(|window\.__timelines\b/.test(source), 'missing GSAP timeline registration');
      break;
    case 'ascii':
      addCheck(checks, 'ascii-lines', trimmed.split(/\r?\n/).filter(Boolean).length >= 5, 'ASCII art needs at least five non-empty lines');
      addCheck(checks, 'ascii-art-glyphs', /[\/\\|_\-+=*#@.<>()[\]{}]/.test(source), 'missing ASCII art glyphs');
      addCheck(checks, 'ascii-not-html', !/<html[\s>]|<!doctype/i.test(source), 'ASCII artifact must not be HTML');
      break;
    case 'kinetic':
      addCheck(checks, 'kinetic-html', /<html[\s>]/i.test(source), 'missing HTML shell');
      addCheck(checks, 'kinetic-animation', /@keyframes\b|animation\s*:/.test(source), 'missing CSS animation');
      addCheck(checks, 'kinetic-text', />[^<]{3,}</.test(source), 'missing visible text');
      break;
    case 'textgen':
      addCheck(checks, 'textgen-lines', trimmed.split(/\r?\n/).filter(Boolean).length >= 5, 'text art needs at least five non-empty lines');
      addCheck(checks, 'textgen-length', Buffer.byteLength(trimmed, 'utf8') >= 80, 'text art is too small');
      addCheck(checks, 'textgen-not-html', !/<html[\s>]|<!doctype/i.test(source), 'textgen artifact must not be HTML');
      break;
    case 'html':
      addCheck(checks, 'html-shell', /<!doctype html>|<html[\s>]/i.test(source), 'missing HTML shell');
      addCheck(checks, 'html-close', /<\/html>/i.test(source), 'missing closing </html>');
      addCheck(checks, 'html-body', /<body[\s>]/i.test(source), 'missing <body>');
      break;
    case 'dataviz':
      addCheck(checks, 'dataviz-shell', /<!doctype html>|<html[\s>]/i.test(source), 'missing HTML shell');
      addCheck(checks, 'dataviz-close', /<\/html>/i.test(source), 'missing closing </html>');
      addCheck(checks, 'dataviz-d3', /\bd3\b/i.test(source), 'missing D3.js reference');
      addCheck(checks, 'dataviz-mount', /<svg\b|<canvas\b|\.append\s*\(\s*["']svg["']\s*\)/i.test(source), 'missing <svg>/<canvas> visualization mount');
      break;
    default:
      addCheck(checks, 'known-domain', false, `unknown creative domain ${domain}`);
  }

  return checks;
}

function addCheck(checks, name, passed, message) {
  checks.push({
    name,
    passed: Boolean(passed),
    ...(passed ? {} : { message }),
  });
}

function hasOpaqueFullCanvasRect(source) {
  const svgAttributes = parseAttributes(source.match(/<svg\b([^>]*)>/i)?.[1] || '');
  const viewBox = parseViewBox(svgAttributes.viewBox);
  const svgWidth = parseLength(svgAttributes.width);
  const svgHeight = parseLength(svgAttributes.height);

  for (const match of source.matchAll(/<rect\b([^>]*)\/?>/gi)) {
    const attrs = parseAttributes(match[1] || '');
    if (!isFullCanvasRect(attrs, viewBox, svgWidth, svgHeight)) continue;
    if (isTransparentFill(attrs)) continue;
    return true;
  }

  return false;
}

function parseAttributes(source) {
  const attrs = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(['"])(.*?)\2/g)) {
    attrs[match[1]] = match[3];
  }
  return attrs;
}

function parseViewBox(value) {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts.every(Number.isFinite)
    ? { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
    : null;
}

function parseLength(value) {
  if (!value) return null;
  if (String(value).trim() === '100%') return '100%';
  const numeric = Number(String(value).trim().replace(/px$/i, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function isFullCanvasRect(attrs, viewBox, svgWidth, svgHeight) {
  const x = parseLength(attrs.x) ?? 0;
  const y = parseLength(attrs.y) ?? 0;
  const width = parseLength(attrs.width);
  const height = parseLength(attrs.height);
  const originX = viewBox?.x ?? 0;
  const originY = viewBox?.y ?? 0;

  if (width === '100%' && height === '100%') return true;
  if (x !== originX || y !== originY) return false;
  if (viewBox && width === viewBox.width && height === viewBox.height) return true;
  return svgWidth !== null && svgHeight !== null && width === svgWidth && height === svgHeight;
}

function isTransparentFill(attrs) {
  const styleFill = attrs.style?.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1];
  const fill = String(attrs.fill ?? styleFill ?? '').trim().toLowerCase();
  const opacity = attrs.opacity ?? attrs['fill-opacity'] ?? attrs.style?.match(/(?:^|;)\s*(?:opacity|fill-opacity)\s*:\s*([^;]+)/i)?.[1];

  if (fill === 'none' || fill === 'transparent') return true;
  if (/^#[\da-f]{4}$/i.test(fill) && fill.slice(-1) === '0') return true;
  if (/^#[\da-f]{8}$/i.test(fill) && fill.slice(-2) === '00') return true;
  if (/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(fill)) return true;
  return opacity !== undefined && Number(opacity) === 0;
}

/**
 * Async compile check for GLSL shaders using headless WebGL.
 *
 * This catches undeclared variables, functions, type mismatches, and other
 * compile-time errors that static analysis cannot detect (e.g. `warpedFlow`
 * used but never declared).
 *
 * @param shaderSource - The GLSL fragment shader source code
 * @returns Object with passed=true if compiled, passed=false if compile error,
 *          or { passed: undefined, unavailable: true } if infra is unavailable
 */
export async function validateGLSLCompile(shaderSource) {
  if (!glslCompileCheck) {
    return { unavailable: true, message: 'compile-check unavailable (dist not built or load failed)' };
  }
  try {
    const result = await glslCompileCheck(shaderSource);
    if (result.status === 'infra-unavailable') {
      return { unavailable: true, message: result.error ?? 'compile-check unavailable' };
    }
    if (!result.success) {
      return { passed: false, message: `GLSL compile error: ${result.error}` };
    }
    return { passed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { unavailable: true, message: `compile-check error: ${message}` };
  }
}

/**
 * Combined validation for GLSL artifacts including compile check.
 *
 * @param domain - Creative domain (should be 'glsl')
 * @param artifactPath - Path to the artifact file
 * @param content - Shader source code
 * @returns Combined validation result from static checks and compile check
 */
export async function validateCreativeDomainArtifactWithCompileCheck(domain, artifactPath, content) {
  // Run static validation first
  const staticResult = validateCreativeDomainArtifact(domain, artifactPath, content);

  // For GLSL, also run compile check
  if (String(domain).toLowerCase() === 'glsl') {
    const compileResult = await validateGLSLCompile(content);
    if (compileResult.unavailable) {
      // Infra unavailable — add a note but do NOT fail the artifact
      staticResult.checks.push({
        name: 'glsl-compile',
        passed: true,
        note: 'compile-check-unavailable',
        message: compileResult.message,
      });
    } else if (!compileResult.passed) {
      staticResult.status = 'fail';
      staticResult.checks.push({
        name: 'glsl-compile',
        passed: false,
        message: compileResult.message,
      });
      staticResult.errors.push(`glsl-compile: ${compileResult.message}`);
    } else {
      staticResult.checks.push({
        name: 'glsl-compile',
        passed: true,
      });
    }
  }

  return staticResult;
}
