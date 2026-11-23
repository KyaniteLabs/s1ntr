/**
 * CodeValidator — structural validation gate for generated code.
 *
 * STRANGLER FIG PATTERN: Delegates to domain-specific validators:
 * - P5Validator: src/core/validators/P5Validator.ts
 * - GLSLValidator: src/core/validators/GLSLValidator.ts
 * - ThreeValidator: src/core/validators/ThreeValidator.ts
 * - StrudelValidator: src/core/validators/StrudelValidator.ts
 * - HydraValidator: src/core/validators/HydraValidator.ts
 * - ToneValidator: src/core/validators/ToneValidator.ts
 * - KineticValidator: src/core/validators/KineticValidator.ts
 * - HTMLValidator: src/core/validators/HTMLValidator.ts
 * - ASCIIValidator: src/core/validators/ASCIIValidator.ts
 */

import { parseMoshPlan } from '../render/DatamoshPlan.js';
import { FootageLibrary } from '../footage/FootageLibrary.js';
import { repairRejected } from './recovery/DeterministicRepair.js';
import path from 'path';
import { P5Validator } from './validators/P5Validator.js';
import { GLSLValidator } from './validators/GLSLValidator.js';
import { ThreeValidator } from './validators/ThreeValidator.js';
import { StrudelValidator } from './validators/StrudelValidator.js';
import { HydraValidator } from './validators/HydraValidator.js';
import { ToneValidator } from './validators/ToneValidator.js';
import { RevideoValidator } from './validators/RevideoValidator.js';
import { KineticValidator } from './validators/KineticValidator.js';
import { HTMLValidator } from './validators/HTMLValidator.js';
import { ASCIIValidator } from './validators/ASCIIValidator.js';
import { HyperFramesValidator } from './validators/HyperFramesValidator.js';
import { TextGenValidator } from './validators/TextGenValidator.js';
import { LibraryRulesValidator } from './validators/LibraryRulesValidator.js';
import { findForbiddenBlenderConstruct } from '../render/BlenderRenderer.js';
import { validateSVG } from '../generators/svg/SVGValidator.js';
import { stripLeadingMetaDescriptor } from './validators/MetaDescriptor.js';
import { canonicalDomainId } from '../types/domains.js';
import { validateImportPath, ImportValidationError } from '../security/ImportValidator.js';
import {
  type ValidationResult,
  type Domain,
  stripContamination,
  stripReasoningText,
  isAlreadyWrapped,
  detectContamination,
  REASONING_PATTERNS,
} from './validators/types.js';

// -----------------------------------------------------------------------------
// Executable-JS security screen
//
// The HTMLValidator screens the 'html' domain for dangerous JS patterns, but
// p5/three/hydra/shader/tone/kinetic/strudel code also runs in a browser and
// was never screened. These domains share the same threat surface, so apply
// the same dangerous-pattern checks to every executable JS art domain.
// -----------------------------------------------------------------------------
const EXECUTABLE_JS_DOMAINS: ReadonlySet<Domain> = new Set<Domain>([
  'p5', 'three', 'hydra', 'tone', 'kinetic', 'strudel', 'shader', 'glsl', 'nbe',
]);

// Always-dangerous in raw JS regardless of markup context.
const DANGEROUS_JS_PATTERNS: ReadonlyArray<{ pattern: RegExp; msg: string }> = [
  { pattern: /\beval\s*\(/i, msg: 'Dangerous eval() detected' },
  { pattern: /new\s+Function\s*\(/i, msg: 'Dangerous new Function() detected' },
  { pattern: /document\.write\s*\(/i, msg: 'document.write() is discouraged' },
];

// HTML-attribute injection sinks. Only meaningful when the artifact contains
// markup (HTML-wrapped); flagging ` one = 5` style raw-JS would be a false
// positive, so these only run against wrapped artifacts.
const DANGEROUS_MARKUP_PATTERNS: ReadonlyArray<{ pattern: RegExp; msg: string }> = [
  { pattern: /\son\w+\s*=\s*["']/i, msg: 'Event handler attributes (on*) are not allowed' },
  { pattern: /javascript:/i, msg: 'javascript: URLs are not allowed' },
];

// Node-only / non-browser module specifiers must never appear in browser art
// code. A generated sketch that imports these is either malicious or broken.
const FORBIDDEN_IMPORT_SPECIFIERS: ReadonlyArray<RegExp> = [
  /^node:/i,
  /^(?:fs|path|child_process|os|net|http|https|crypto|process|vm|module|worker_threads|cluster|dgram|tls|repl)$/i,
];

function validateJSSecurity(code: string, domain: Domain): string[] {
  if (!EXECUTABLE_JS_DOMAINS.has(domain)) return [];

  const errors: string[] = [];
  for (const { pattern, msg } of DANGEROUS_JS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`JS Security: ${msg}`);
    }
  }
  if (isAlreadyWrapped(code)) {
    for (const { pattern, msg } of DANGEROUS_MARKUP_PATTERNS) {
      if (pattern.test(code)) {
        errors.push(`JS Security: ${msg}`);
      }
    }
  }
  errors.push(...validateImportSources(code));
  return errors;
}

/**
 * Reject disallowed imports in generated art code. Wires the ImportValidator
 * (filesystem path-traversal control) into the live validation path: any
 * relative/local import specifier is resolved against a virtual artifact root
 * and rejected if it escapes that root (e.g. ../../../etc/passwd). Bare
 * node-builtin specifiers are rejected outright.
 */
function validateImportSources(code: string): string[] {
  const errors: string[] = [];
  // Match both `import ... from 'x'` and bare `import 'x'` / dynamic import('x').
  const specifierRe = /\bimport\s*(?:[^'";]*?\bfrom\s*)?\(?\s*['"]([^'"]+)['"]/g;
  const ARTIFACT_ROOT = '/__sinter_artifact_root__';
  let match: RegExpExecArray | null;
  while ((match = specifierRe.exec(code)) !== null) {
    const spec = match[1].trim();
    if (!spec) continue;

    if (FORBIDDEN_IMPORT_SPECIFIERS.some(p => p.test(spec))) {
      errors.push(`Import Security: disallowed module import "${spec}" - node/runtime modules are not available in browser art`);
      continue;
    }

    // Only local/relative/absolute filesystem-style specifiers are traversal
    // candidates. Bare package names and URLs (http(s)://, //cdn) are not.
    const isLocal = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
    if (!isLocal || /^\/\//.test(spec) || /^[a-z]+:\/\//i.test(spec)) continue;

    try {
      validateImportPath(path.join(ARTIFACT_ROOT, spec), ARTIFACT_ROOT);
    } catch (error) {
      if (error instanceof ImportValidationError) {
        errors.push(`Import Security: import path "${spec}" escapes the artifact root`);
      } else {
        throw error;
      }
    }
  }
  return errors;
}

// -----------------------------------------------------------------------------
// Size validation
// -----------------------------------------------------------------------------
const MIN_SIZE_REQUIREMENTS: Record<Domain, number> = {
  'p5': P5Validator.getMinSize(),
  'shader': GLSLValidator.getMinSize(),
  'glsl': GLSLValidator.getMinSize(),
  'three': ThreeValidator.getMinSize(),
  'strudel': StrudelValidator.getMinSize(),
  'hydra': HydraValidator.getMinSize(),
  'tone': ToneValidator.getMinSize(),
  'svg': 40,
  'revideo': RevideoValidator.getMinSize(),
  'hyperframes': HyperFramesValidator.getMinSize(),
  'html': HTMLValidator.getMinSize(),
  'dataviz': HTMLValidator.getMinSize(),
  'custom': HTMLValidator.getMinSize(),
  'ascii': ASCIIValidator.getMinSize(),
  'kinetic': KineticValidator.getMinSize(),
  'music': 100,
  'textgen': TextGenValidator.getMinSize(),
  'blender': 40,
  'nbe': HTMLValidator.getMinSize(),
  'unknown': 100,
};

// -----------------------------------------------------------------------------
// Domain detection
// -----------------------------------------------------------------------------
function detectDomain(code: string): Domain {
  // A bpy script is Python: detect it before any JS/HTML heuristic (`def draw()`
  // would otherwise read as p5).
  if (/^\s*(?:import\s+bpy\b|from\s+bpy\b)/m.test(code)) return 'blender';
  // The meta (custom-domain) generator stamps its artifacts with a leading
  // SINTER-META-DESCRIPTOR comment. Detect that marker FIRST so a domain-less
  // validation pass (e.g. Exporter.exportHTML) routes to the meta case — which
  // strips the descriptor before the HTML structural check — instead of falling
  // through to plain 'html' and failing on the pre-doctype comment.
  if (/<!--SINTER-META-DESCRIPTOR\b/.test(code)) return 'custom';
  if (/data-composition-id/i.test(code) && (/gsap\.(?:timeline|from|to)\s*\(/.test(code) || /window\.__timelines/.test(code))) return 'hyperframes';
  if (/window\.__timelines/.test(code) && /class\s*=\s*["'][^"']*\bclip\b[^"']*["']/i.test(code)) return 'hyperframes';

  if (isAlreadyWrapped(code)) {
    // Check for HTML-specific domains first
    const hasThreeImport = code.includes('import * as THREE') ||
                           code.includes('from "three"') ||
                           code.includes('from \'three\'') ||
                           /<script\s+type="importmap"[^>]*>[\s\S]*?"three"[\s\S]*?<\/script>/.test(code);
    if (hasThreeImport) return 'three';

    const hasToneImport = /from\s+['"]tone['"]/.test(code) || /\bTone\./.test(code);
    if (hasToneImport) return 'tone';

    const hasP5Import = /p5\.js|p5\.min\.js/.test(code);
    if (hasP5Import) return 'p5';

    const hasWebGL = /getContext\(['"]webgl/.test(code);
    if (hasWebGL) return 'shader';

    // Generic HTML
    return 'html';
  }

  // Check for HTML document
  if (/^<svg\b/i.test(code.trim())) return 'svg';

  // Check for HTML document
  const hasDoctype = code.trim().toUpperCase().startsWith('<!DOCTYPE');
  const hasHTMLTag = /<html[^>]*>/i.test(code);
  if (hasDoctype || hasHTMLTag) return 'html';

  // Check for GLSL
  const hasVoidMain = /void\s+main\s*\(/.test(code);
  const hasMainImage = /void\s+mainImage\s*\(/.test(code);
  const hasFragColor = /gl_FragColor|out\s+vec4\s+fragColor/.test(code);
  const hasUniforms = /uniform\s+(vec2|vec3|vec4|float|int|mat)/.test(code);
  const hasPrecision = /\bprecision\s+(?:lowp|mediump|highp)\s+float\s*;/.test(code);
  const hasShaderBuiltins = /\b(?:gl_FragCoord|iResolution|iTime|fragCoord|fragColor)\b/.test(code);
  const glslCount = [hasVoidMain, hasMainImage, hasFragColor, hasUniforms, hasPrecision, hasShaderBuiltins].filter(Boolean).length;
  if (glslCount >= 2 && !code.includes('function setup()') && !code.includes('function draw()')) return 'shader';

  // Check for Revideo
  if (/\bmakeScene|@revideo\/core/.test(code)) return 'revideo';

  // Check for Strudel before Hydra: Strudel audio chains can use .shape()/.out().
  if (
    /\bbpm\s*\(/.test(code) ||
    /\bsetcp[ms]\s*\(/.test(code) ||
    /\bs\s*\(\s*["']/.test(code) ||
    /\b(?:sound|note|n|seq|stack)\s*\(/.test(code) ||
    /\$:\s*s\(|\.stack\(|\.slow\(|\.fast\(/.test(code)
  ) {
    return 'strudel';
  }

  // Check for Hydra
  if (/\b(osc|src|noise|shape|gradient|solid|voronoi)\s*\(/.test(code) && /\.out\(/.test(code) && !/\$:/.test(code)) {
    return 'hydra';
  }

  // Check for Tone.js
  if (/\bTone\./.test(code) || /from\s+['"]tone['"]/.test(code)) return 'tone';

  // Check for Three.js before broad music fallback: Three render() is not audio.
  if (/\bTHREE\.|import.*three|new\s+THREE\./.test(code)) return 'three';

  // Check for general music patterns
  if (/\$:\s*s\(/.test(code) || /\bosc\(|\bsrc\(|\brender\(/.test(code) || /strudel|hydra/i.test(code)) return 'music';

  // Check for ASCII art after code/music domains. Multi-line Hydra/Strudel
  // chains are plain ASCII too, so ASCII must not preempt executable domains.
  if (ASCIIValidator.detectASCII(code)) return 'ascii';

  // Default to p5
  return 'p5';
}

function stripCommentsAndStringLiterals(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[\s\S])*\1/g, ' ');
}

function validateNoGuaranteedRuntimeThrow(code: string, domain: Domain): string[] {
  if (domain === 'shader' || domain === 'glsl' || domain === 'svg' || domain === 'ascii') {
    return [];
  }

  const executableSurface = stripCommentsAndStringLiterals(code);
  if (/\bthrow\b/.test(executableSurface)) {
    return ['Generated code contains an explicit throw statement that would fail at runtime'];
  }

  return [];
}

// -----------------------------------------------------------------------------
// Domain-specific validation
// -----------------------------------------------------------------------------
function validateStructure(code: string, domain: Domain): { errors: string[]; theoryAssessment?: readonly string[] } {
  const errors: string[] = [];
  // S4 completion (2026-09-01): carried out of the domain switch so the
  // caller can persist it (the theory engine had zero consumers until now).
  let theoryAssessment: readonly string[] | undefined;
  const trimmed = code.trim();

  if (!trimmed) {
    errors.push('Code is empty after stripping reasoning text');
    return { errors };
  }

  errors.push(...detectContamination(trimmed));
  errors.push(...validateNoGuaranteedRuntimeThrow(trimmed, domain));
  errors.push(...validateJSSecurity(trimmed, domain));
  errors.push(...LibraryRulesValidator.validate(trimmed, domain).errors);

  switch (domain) {
    case 'p5': {
      const result = P5Validator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'shader':
    case 'glsl': {
      if (!isAlreadyWrapped(trimmed)) {
        const result = GLSLValidator.validate(trimmed);
        errors.push(...result.errors);
      }
      break;
    }
    case 'three': {
      const result = ThreeValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'strudel': {
      const result = StrudelValidator.validate(trimmed);
      errors.push(...result.errors);
      if (result.theoryAssessment && result.theoryAssessment.length > 0) {
        theoryAssessment = result.theoryAssessment;
      }
      break;
    }
    case 'hydra': {
      const result = HydraValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'tone': {
      const result = ToneValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'svg': {
      const result = validateSVG(trimmed);
      if (!result.valid && result.error) errors.push(result.error);
      break;
    }
    case 'revideo': {
      const result = RevideoValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'hyperframes': {
      const result = HyperFramesValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'kinetic': {
      const result = KineticValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'html': {
      const result = HTMLValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'dataviz': {
      // DataViz output is a complete HTML page that loads D3 and renders a viz:
      // validate the HTML structure, then require both a D3 reference and an
      // svg/canvas mount so a plain HTML page is not silently accepted as dataviz.
      const result = HTMLValidator.validate(trimmed);
      errors.push(...result.errors);
      if (!/\bd3\b/i.test(trimmed)) {
        errors.push('dataviz code must load D3.js or use the d3 global');
      }
      if (!/<svg\b/i.test(trimmed) && !/<canvas\b/i.test(trimmed) && !/\.append\s*\(\s*["']svg["']\s*\)/.test(trimmed)) {
        errors.push("dataviz code must include an <svg> or <canvas> visualization mount: selecting a <div> is not enough, create the svg in it, like d3.select('#chart').append('svg').attr('viewBox', '0 0 800 500'), then draw the marks into that svg");
      }
      break;
    }
    case 'custom': {
      // Meta is the custom-domain catch-all: output is a complete HTML page that
      // renders an arbitrary medium. Validate HTML structure and require a render
      // mount, but stay OPEN-ENDED — do NOT pin a library/runtime (the medium is
      // whatever the user described). The artifact may carry a leading
      // SINTER-META-DESCRIPTOR comment before <!DOCTYPE html>; strip it for the
      // structural check (it is metadata, not part of the HTML grammar).
      const result = HTMLValidator.validate(stripLeadingMetaDescriptor(trimmed));
      errors.push(...result.errors);
      if (
        !/<svg\b/i.test(trimmed) &&
        !/<canvas\b/i.test(trimmed) &&
        !/getContext\s*\(\s*["'](?:webgl2?|2d)["']/i.test(trimmed) &&
        !/\.append\s*\(\s*["'](?:svg|canvas)["']\s*\)/i.test(trimmed) &&
        !/createElement\s*\(\s*["'](?:canvas|svg)["']\s*\)/i.test(trimmed)
      ) {
        errors.push('meta code must include a <canvas>, <svg>, WebGL, or render mount for the custom medium');
      }
      break;
    }
    case 'ascii': {
      const result = ASCIIValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'music': {
      // Music domain is a fallback - check for strudel or hydra patterns
      const hasStrudel = /\$:\s*s\(/.test(trimmed);
      const hasHydra = /\bosc\(|\bsrc\(|\brender\(/.test(trimmed);
      if (!hasStrudel && !hasHydra) {
        errors.push('Music code must contain Strudel or Hydra patterns');
      }
      break;
    }
    case 'textgen': {
      const result = TextGenValidator.validate(trimmed);
      errors.push(...result.errors);
      break;
    }
    case 'blender': {
      if (!/^\s*(?:import\s+bpy\b|from\s+bpy\b)/m.test(trimmed)) {
        errors.push('blender code must be a Python script that imports bpy');
      }
      const forbidden = findForbiddenBlenderConstruct(trimmed);
      if (forbidden) {
        errors.push(`blender script uses "${forbidden}", which is not allowed in the sandboxed render (no network, subprocess, shell or dynamic code)`);
      }
      break;
    }
    case 'nbe': {
      // NBE output is a complete self-contained HTML page (see NbeGenerator):
      // validate the HTML structure, then require the canvas the cascade
      // neural-field paints and the convergence signal screenshot capture
      // waits on, so a plain HTML page is not silently accepted as nbe.
      const result = HTMLValidator.validate(trimmed);
      errors.push(...result.errors);
      if (!/<canvas\b/i.test(trimmed)) {
        errors.push('nbe code must include a <canvas> for the cascade neural-field simulation');
      }
      if (!/postMessage\s*\(\s*['"]nbe:converged['"]/.test(trimmed)) {
        errors.push('nbe code must post the "nbe:converged" signal via window.postMessage once the field has evolved');
      }
      break;
    }
  }

  return { errors, ...(theoryAssessment ? { theoryAssessment } : {}) };
}

function validateSelfContained(code: string, domain: Domain): string[] {
  const errors: string[] = [];
  if (!isAlreadyWrapped(code)) return errors;

  switch (domain) {
    case 'p5': {
      if (!/p5\.js|p5\.min\.js/.test(code)) errors.push('HTML-wrapped p5.js must include p5.js CDN');
      break;
    }
    case 'three': {
      errors.push(...ThreeValidator.validateHTMLWrapped(code));
      break;
    }
    case 'shader':
    case 'glsl': {
      errors.push(...GLSLValidator.validateHTMLWrapped(code));
      break;
    }
    case 'tone': {
      // Tone.js should have its CDN or import
      if (!/tone(?:\.min)?\.js|\/tone\/|from\s+['"]tone['"]/i.test(code)) {
        errors.push('HTML-wrapped Tone.js should include Tone.js CDN or module import');
      }
      errors.push(...HTMLValidator.validate(code).errors);
      break;
    }
    case 'revideo': {
      // Revideo is JSX source, not HTML-wrapped
      break;
    }
    case 'hyperframes': {
      // HyperFrames is standalone HTML+GSAP, self-contained by design
      break;
    }
    case 'html': {
      // HTML validation already checks structure
      break;
    }
    case 'dataviz': {
      // Self-contained D3 page: require the D3 CDN/global reference; HTML
      // structure is checked by HTMLValidator on the main validation pass.
      if (!/\bd3\b/i.test(code)) {
        errors.push('HTML-wrapped dataviz must include D3.js (CDN script or d3 global)');
      }
      break;
    }
    case 'custom': {
      // Self-contained custom-medium page: HTML structure + render mount are
      // checked on the main validation pass. Open-ended catch-all, so no library
      // requirement here (the medium may be vanilla with no external dependency).
      break;
    }
  }
  return errors;
}

function validateSize(code: string, domain: Domain): string[] {
  const size = code.length;
  const minSize = MIN_SIZE_REQUIREMENTS[domain] || MIN_SIZE_REQUIREMENTS['unknown'];
  if (size < minSize) {
    return [`${domain} code is too small (${size}b) - minimum is ${minSize}b`];
  }
  return [];
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
function validateDatamoshPlan(code: string): ValidationResult {
  try {
    const { plan } = parseMoshPlan(code);
    const known = new Set(new FootageLibrary().list().map((m) => m.id));
    const unknown = plan.segments.find((seg) => !known.has(seg.clip));
    if (unknown) {
      return { valid: false, cleanedCode: code, errors: [`datamosh plan names footage "${unknown.clip}" which is not in the library (${[...known].join(', ') || 'library is empty'})`] };
    }
    return { valid: true, cleanedCode: JSON.stringify(plan), errors: [] };
  } catch (error) {
    return { valid: false, cleanedCode: code, errors: [`datamosh plan invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export class CodeValidator {
  static validate(code: string, domain?: string): ValidationResult {
    if (domain !== undefined) domain = canonicalDomainId(domain);
    if (!code || typeof code !== 'string') {
      return { valid: false, cleanedCode: '', errors: ['No code provided'] };
    }
    // Next-release domain (flag-gated): the artifact is a JSON plan, not code.
    if (domain === 'datamosh') return validateDatamoshPlan(code);

    const explicitTextOutput = domain === 'textgen' || domain === 'ascii';
    const decontaminated = stripContamination(code, explicitTextOutput);
    const firstContentLine = decontaminated.split('\n').find(line => line.trim().length > 0)?.trim() ?? '';
    const explicitDomain = domain as Domain | undefined;
    const preserveTextOutput = explicitDomain === 'textgen' ||
      ((explicitTextOutput || ASCIIValidator.detectASCII(decontaminated))
        && !REASONING_PATTERNS.some(pattern => pattern.test(firstContentLine)));
    let cleaned = preserveTextOutput
      ? explicitTextOutput ? decontaminated : decontaminated.replace(/^\s*\n/, '').trimEnd()
      : stripReasoningText(decontaminated);
    if (!cleaned.trim()) {
      // Safety net: the code-oriented stripper emptied the content. When a
      // generation's domain is misattributed (e.g. a concrete poem validated
      // under the RalphLoop 'p5' fallback), stripReasoningText treats the prose
      // as reasoning and nukes the whole legitimate output. Preserve the original
      // text ONLY when it does not look like reasoning — a real poem/text-art has
      // no reasoning markers, whereas "The user wants…"/"We need to…" does. This
      // rescues misjudged text output while still rejecting reasoning-only
      // responses (which then have no valid artifact). Uses the same
      // first-content-line heuristic as preserveTextOutput above.
      const preserved = decontaminated.replace(/^\s*\n/, '').trimEnd();
      const looksLikeReasoning = REASONING_PATTERNS.some(pattern => pattern.test(firstContentLine));
      if (!preserved.trim() || looksLikeReasoning) {
        return { valid: false, cleanedCode: '', errors: ['Code is empty after stripping LLM reasoning text'] };
      }
      cleaned = preserved;
    }

    const detectedDomain = explicitDomain || detectDomain(cleaned);

    // Balance GLSL preprocessor conditionals: reasoning models (Grok 4.6) emit
    // orphan #endif / unclosed #if that fail WebGL compile. Fixing here (before
    // finalCode) covers both validation AND the saved cleanedCode.
    if (detectedDomain === 'glsl' || detectedDomain === 'shader') {
      cleaned = GLSLValidator.balancePreprocessor(cleaned);
    }

    // ASCII sanitation must live HERE, not only in ASCIIArtGenerator: RalphLoop's
    // LLM-revised candidates reach validation without passing the generator's
    // formatASCII (a sanitized first draft failed again within hours on a revised
    // candidate's U+25C9/U+25AE glyphs). Sanitized text flows out as cleanedCode.
    const finalCode = detectedDomain === 'ascii' ? ASCIIValidator.sanitize(cleaned) : cleaned;

    const check = (candidate: string) => {
      const structure = validateStructure(candidate, detectedDomain);
      return {
        errors: [
          ...structure.errors,
          ...validateSelfContained(candidate, detectedDomain),
          ...validateSize(candidate, detectedDomain),
        ],
        // S4 completion (2026-09-01): the strudel theory assessment was produced
        // by StrudelValidator and dropped on the floor — a producer with zero
        // consumers. Carry it on the validation result so the spine can persist
        // it into provenance.
        theoryAssessment: structure.theoryAssessment,
      };
    };
    const withTheory = (t: readonly string[] | undefined) => (t && t.length > 0 ? { theoryAssessment: t } : {});

    const first = check(finalCode);
    if (first.errors.length > 0) {
      // Rejected over a known mechanical slip? Repair deterministically and keep the
      // result only if it now passes every check; otherwise the original verdict stands.
      const repair = repairRejected(finalCode, detectedDomain);
      if (repair) {
        const second = check(repair.code);
        if (second.errors.length === 0) {
          return { valid: true, cleanedCode: repair.code, errors: [], repairs: repair.repairs,
            ...withTheory(second.theoryAssessment) };
        }
      }
    }

    return { valid: first.errors.length === 0, cleanedCode: finalCode, errors: first.errors,
      ...withTheory(first.theoryAssessment) };
  }

  static detectDomain(code: string): string {
    return detectDomain(code);
  }

  static getMinSize(domain: Domain): number {
    return MIN_SIZE_REQUIREMENTS[domain] || MIN_SIZE_REQUIREMENTS['unknown'];
  }
}
