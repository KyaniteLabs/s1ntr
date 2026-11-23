/**
 * ThreeValidator - Three.js-specific validation logic
 *
 * Extracted from CodeValidator.ts using Strangler Fig pattern.
 * Handles validation of Three.js code including ES modules and global THREE.
 */

import { parse } from '@babel/parser';
import { findUndeclaredIdentifiers } from './undeclaredIdentifiers.js';
import traverseModule from '@babel/traverse';
import type { Node } from '@babel/types';
import { THREE_CLASSES, THREE_EXPORTS } from './threeApi.generated.js';

const traverse = ((traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule);
const EXPORTS = new Set(THREE_EXPORTS);
const OBJECT_MEMBERS = new Set(Object.getOwnPropertyNames(Object.prototype));
const THREE_SOURCE = /^(?:three|https:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net)\/(?:npm\/)?three@0\.160\.0\/build\/three\.module\.js)$/;

function classMembers(name: string): Set<string> | null {
  const out = new Set(OBJECT_MEMBERS);
  type ThreeClass = (typeof THREE_CLASSES)[string] | undefined;
  for (let cls: ThreeClass = THREE_CLASSES[name]; cls; cls = cls.parent ? THREE_CLASSES[cls.parent] : undefined) {
    if (!cls.built) return null;
    for (const m of cls.members) out.add(m);
  }
  return out;
}

/**
 * Names the served three build (0.160 core, no addons) does not have:
 * THREE.EffectComposer / THREE.DecalGeometry, a named import of one, or a
 * method call on an instance of a core class that the class lacks
 * (listener.getGainNode()). Each throws "is not a constructor / function" at
 * render. Lists come from scripts/generate-three-api.mjs.
 */
export function findUnknownThreeApi(code: string): string[] {
  let ast: Node;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
  } catch {
    return [];
  }
  const namespaces = new Set<string>();
  const classOf = new Map<string, string>();
  let importsThree = false;
  const errors = new Set<string>();
  for (const stmt of (ast as unknown as { program: { body: Node[] } }).program.body) {
    if (stmt.type !== 'ImportDeclaration' || !THREE_SOURCE.test(stmt.source.value)) continue;
    importsThree = true;
    for (const spec of stmt.specifiers) {
      if (spec.type === 'ImportNamespaceSpecifier') namespaces.add(spec.local.name);
      else if (spec.type === 'ImportSpecifier') {
        const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
        if (!EXPORTS.has(imported)) errors.add(`three 0.160 core does not export '${imported}' (addons are not served); it is undefined at render`);
        else classOf.set(spec.local.name, imported);
      }
    }
  }
  if (!importsThree) namespaces.add('THREE');

  const threeName = (node: Node): string | null => {
    if (node.type === 'Identifier' && classOf.has(node.name)) return classOf.get(node.name)!;
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier'
      && namespaces.has(node.object.name) && node.property.type === 'Identifier') return node.property.name;
    return null;
  };

  const instances = new Map<unknown, string>();
  const tainted = new Set<unknown>();
  traverse(ast, {
    MemberExpression(path) {
      const { node } = path;
      if (node.computed || node.object.type !== 'Identifier' || !namespaces.has(node.object.name)) return;
      const binding = path.scope.getBinding(node.object.name);
      if (importsThree ? binding?.kind !== 'module' : binding) return;
      if (node.property.type === 'Identifier' && !EXPORTS.has(node.property.name)) {
        errors.add(`THREE.${node.property.name} is not in three 0.160 core (addons such as EffectComposer are not served); it is undefined at render`);
      }
    },
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (id.type !== 'Identifier' || init?.type !== 'NewExpression') return;
      const cls = threeName(init.callee);
      const binding = path.scope.getBinding(id.name);
      if (cls && EXPORTS.has(cls) && binding && binding.constantViolations.length === 0) instances.set(binding, cls);
    },
    AssignmentExpression(path) {
      const left = path.node.left;
      if (left.type === 'MemberExpression' && left.object.type === 'Identifier') tainted.add(path.scope.getBinding(left.object.name));
    },
  });
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') return;
      const binding = path.scope.getBinding(callee.object.name);
      const cls = instances.get(binding);
      if (!cls || tainted.has(binding)) return;
      const members = classMembers(cls);
      if (members && !members.has(callee.property.name)) {
        errors.add(`THREE.${cls} has no method '${callee.property.name}()' in three 0.160; ${callee.object.name}.${callee.property.name}() throws at render`);
      }
    },
  });
  return [...errors];
}

export interface ThreeValidationResult {
  valid: boolean;
  errors: string[];
}

export class ThreeValidator {
  /**
   * Validate Three.js code structure
   */
  static validate(code: string): ThreeValidationResult {
    const errors: string[] = [];
    const trimmed = code.trim();

    if (!trimmed) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    errors.push(...this.validateJavaScriptSyntax(trimmed));

    // Basic structure validation
    errors.push(...this.validateStructure(trimmed));

    // Quality checks
    errors.push(...this.validateQuality(trimmed));

    // Semantic checks
    errors.push(...this.validateSemantics(trimmed));
    errors.push(...findUnknownThreeApi(trimmed));

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate Three.js structure
   */
  private static validateStructure(code: string): string[] {
    const errors: string[] = [];

    const hasTHREE = /THREE\.|import.*from\s+['"]three['"]|from\s+['"]three['"]/.test(code);

    if (!hasTHREE) {
      errors.push('Three.js code must reference THREE object or import from "three"');
    }

    const threeImportCount = (code.match(/\bimport\s+\*\s+as\s+THREE\s+from\s+['"][^'"]+['"]/g) || []).length;
    if (threeImportCount > 1) {
      errors.push('Three.js code must not declare multiple THREE imports');
    }

    if (!/^<!DOCTYPE|^<html/i.test(code.trim())) {
      // ThreeWrapper runs raw code as a module and binds only THREE (#1756).
      for (const name of findUndeclaredIdentifiers(code, { module: true, provided: ['THREE'] })) {
        errors.push(`Three.js code uses '${name}' but never declares it; the page provides only THREE, so this throws ReferenceError at render`);
      }
    }

    if (/scene\.add\s*\(\s*renderer\.domElement\s*\)/.test(code)) {
      errors.push('Three.js scene.add() must receive Object3D instances, not renderer.domElement');
    }

    return errors;
  }

  private static validateJavaScriptSyntax(code: string): string[] {
    if (/^<!DOCTYPE|^<html/i.test(code.trim())) return [];

    try {
      parse(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: false,
        plugins: ['jsx'],
      });
      return [];
    } catch (error) {
      return [`Three.js code has invalid JavaScript syntax: ${this.formatParseError(error)}`];
    }
  }

  private static formatParseError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /**
   * Validate Three.js quality checks
   */
  private static validateQuality(code: string): string[] {
    const errors: string[] = [];

    // Check for ES module issues (from AUDIT: CDNs use global, code uses imports)
    const usesImportMap = /<script\s+type="importmap">/.test(code);
    const usesGlobalTHREE = /new\s+THREE\./.test(code) && !/import.*three/.test(code);

    if (usesImportMap && usesGlobalTHREE) {
      errors.push('Three.js code mixing importmap with global THREE - use one style consistently');
    }

    // A lit material with no light source renders dark/murky. Unlit
    // (MeshBasicMaterial) and points/lines don't need a light, so only flag the
    // guaranteed-dark case: a lit material present but no light added.
    const usesLitMaterial = /THREE\.Mesh(?:Standard|Physical|Phong|Lambert|Toon)Material\b/.test(code);
    const hasLight = /THREE\.(?:Ambient|Directional|Point|Spot|Hemisphere|RectArea)Light\b/.test(code);
    // holospot lights its objects with studio.preset; three.js lights do nothing
    // to them, and the kit's own recipes use lit-material stand-ins with no lights.
    // Demanding lights here pushed repairs into breaking the holospot card's rules.
    const usesHolospot = /\bholo\.(?:apply|card)\s*\(/.test(code) && /\bholospot\b|\/vendor\/holospot\//.test(code);
    if (usesLitMaterial && !hasLight && !usesHolospot) {
      errors.push('Three.js scene uses a lit material (MeshStandard/Physical/Phong/Lambert/Toon) but adds no light — it will render dark; add a THREE.AmbientLight plus a DirectionalLight/PointLight');
    }

    // Physically-correct lighting (r152+) without tone mapping + high intensities
    // clips MeshStandardMaterial to blown white (W6a beauty-campaign failure).
    errors.push(...this.validateExposure(code, usesLitMaterial, hasLight));

    // holospot paints its own (black) background and replaces the stand-in mesh's
    // material, so neither literal says anything about what is rendered.
    const darkBackground = usesHolospot ? null : this.findDarkBackgroundColor(code);
    if (darkBackground) {
      errors.push(`Three.js scene background/clear color ${darkBackground} is too dark for image proof; use a deep mid-tone background so the lit subject reads and mean luminance passes render validation`);
    }

    const brightBackground = this.findBrightBackgroundColor(code);
    if (brightBackground) {
      errors.push(`Three.js scene background/clear color ${brightBackground} is too near-white; a pale background washes the whole frame out and fails the washout render check. Use a deep mid-tone background/clear color instead`);
    }

    // Lights and a bright background are not enough when the SUBJECT itself is
    // near-black: the audit's "visible lighting" proof rendered an almost-black
    // cube on white (investor-audit F11). Only flag the guaranteed-invisible
    // case — every material color literal in the scene is dark. A mix of dark
    // and bright materials is a legitimate palette.
    const darkMaterials = usesHolospot ? null : this.findUniformlyDarkMaterialColors(code);
    if (darkMaterials) {
      errors.push(`Three.js scene's material colors (${darkMaterials.join(', ')}) are all near-black — the subject will be invisible regardless of lighting; use mid-tone or bright material colors for the primary geometry`);
    }

    return errors;
  }

  /**
   * Exposure guard for physically-correct Three.js lighting.
   *
   * W6a evidence: generators were told to use Ambient ~Math.PI and key lights
   * 3–10 with no tone mapping; all three beauty-campaign renders blew the floor
   * plane to white and lost the subject. Reject that static pattern so repair
   * happens before any screenshot ships.
   */
  private static validateExposure(code: string, usesLitMaterial: boolean, hasLight: boolean): string[] {
    const errors: string[] = [];
    if (!usesLitMaterial || !hasLight) return errors;

    const hasToneMapping = /\.toneMapping\s*=/.test(code)
      || /\btoneMappingExposure\b/.test(code)
      || /\bACESFilmicToneMapping\b/.test(code)
      || /\bReinhardToneMapping\b/.test(code)
      || /\bCineonToneMapping\b/.test(code)
      || /\bNeutralToneMapping\b/.test(code);

    if (!hasToneMapping) {
      errors.push(
        'Three.js lit MeshStandard/Physical scene must set renderer.toneMapping (e.g. THREE.ACESFilmicToneMapping) and a moderate toneMappingExposure (~1.0); without tone mapping, physically-correct lights overexpose the frame to white',
      );
    }

    const maxIntensity = this.findMaxLightIntensity(code);
    if (maxIntensity !== null) {
      // Absolute ceiling: intensities > 3 blow MeshStandardMaterial even with
      // ACES (campaign keys hit 6–7). Exclusive so the canonical three.js sun
      // DirectionalLight intensity of 3.0 with ACES remains valid.
      if (maxIntensity > 3) {
        errors.push(
          `Three.js light intensity ${maxIntensity} is overexposed; keep key lights at 0.8-2.0 and ambient at 0.25-0.6 with ACESFilmicToneMapping (never > 3.0)`,
        );
      } else if (!hasToneMapping && maxIntensity > 1.5) {
        errors.push(
          `Three.js light intensity ${maxIntensity} without toneMapping is overexposed; either set renderer.toneMapping = THREE.ACESFilmicToneMapping or keep intensities ≤ 1.5`,
        );
      }
    }

    // Math.PI ambient (~3.14) without tone mapping is the exact campaign pattern.
    if (!hasToneMapping && /THREE\.AmbientLight\s*\([^)]*Math\.PI/.test(code)) {
      errors.push(
        'Three.js AmbientLight uses Math.PI intensity without toneMapping — that overexposes physically-correct materials; use ambient 0.25-0.6 and set ACESFilmicToneMapping',
      );
    }

    return errors;
  }

  /**
   * Highest numeric light intensity found in common Light constructors and
   * `.intensity = N` assignments. Resolves simple `Math.PI * k` / `Math.PI` forms.
   */
  private static findMaxLightIntensity(code: string): number | null {
    const values: number[] = [];

    // HemisphereLight is handled separately: (skyColor, groundColor, intensity)
    // — arg 2 is a color hex, not intensity (false overexposure rejects).
    const ctorPattern = /new\s+THREE\.(Ambient|Directional|Point|Spot|RectArea)Light\s*\(([^)]*)\)/g;
    for (const match of code.matchAll(ctorPattern)) {
      const args = match[2];
      // intensity is typically the 2nd arg (color, intensity, …) for these lights.
      const parts = this.splitTopLevelArgs(args);
      if (parts.length >= 2) {
        const intensity = this.parseIntensityExpression(parts[1]);
        if (intensity !== null) values.push(intensity);
      }
    }

    const hemiPattern = /new\s+THREE\.HemisphereLight\s*\(([^)]*)\)/g;
    for (const match of code.matchAll(hemiPattern)) {
      const parts = this.splitTopLevelArgs(match[1]);
      // HemisphereLight(skyColor, groundColor, intensity) — intensity is arg 3.
      if (parts.length >= 3) {
        const intensity = this.parseIntensityExpression(parts[2]);
        if (intensity !== null) values.push(intensity);
      }
    }

    for (const match of code.matchAll(/\.intensity\s*=\s*([^;,\n]+)/g)) {
      const intensity = this.parseIntensityExpression(match[1]);
      if (intensity !== null) values.push(intensity);
    }

    if (values.length === 0) return null;
    return Math.max(...values);
  }

  private static splitTopLevelArgs(args: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of args) {
      if (char === '(' || char === '[' || char === '{') depth++;
      if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  private static parseIntensityExpression(expr: string): number | null {
    const cleaned = expr.trim().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').trim();
    if (!cleaned) return null;

    const plain = Number(cleaned);
    if (Number.isFinite(plain)) return plain;

    // Math.PI or Math.PI * k / k * Math.PI
    if (/^Math\.PI$/.test(cleaned)) return Math.PI;
    const mulRight = cleaned.match(/^Math\.PI\s*\*\s*([0-9]*\.?[0-9]+)$/);
    if (mulRight) return Math.PI * Number(mulRight[1]);
    const mulLeft = cleaned.match(/^([0-9]*\.?[0-9]+)\s*\*\s*Math\.PI$/);
    if (mulLeft) return Number(mulLeft[1]) * Math.PI;

    return null;
  }

  /**
   * Material color literals from Mesh*Material({ color: … }) constructions and
   * material.color.set(…) calls. Returns the literals only when EVERY one is
   * dark (luminance < 48); null when none found or any is bright enough.
   */
  private static findUniformlyDarkMaterialColors(code: string): string[] | null {
    const patterns = [
      /THREE\.Mesh\w*Material\s*\(\s*\{[^}]*?\bcolor\s*:\s*(['"]?)(#?[0-9a-f]{6}|0x[0-9a-f]{6})\1/gi,
      /\.color\.set\s*\(\s*(['"]?)(#?[0-9a-f]{6}|0x[0-9a-f]{6})\1\s*\)/gi,
    ];
    const literals: string[] = [];
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        literals.push(match[2]);
      }
    }
    if (literals.length === 0) return null;
    const allDark = literals.every((literal) => {
      const luminance = this.hexLuminance(literal);
      return luminance !== null && luminance < 48;
    });
    return allDark ? literals : null;
  }

  private static findDarkBackgroundColor(code: string): string | null {
    const patterns = [
      /scene\.background\s*=\s*new\s+THREE\.Color\s*\(\s*(['"]?)(#?[0-9a-f]{6}|0x[0-9a-f]{6})\1\s*\)/gi,
      /renderer\.setClearColor\s*\(\s*(['"]?)(#?[0-9a-f]{6}|0x[0-9a-f]{6})\1/gi,
    ];

    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        const literal = match[2];
        const luminance = this.hexLuminance(literal);
        if (luminance !== null && luminance < 48) return literal;
      }
    }

    return null;
  }

  // Symmetric upper bound for the dark-background check. A near-white background
  // (luminance > 210 on a 0-255 scale) passes the too-dark guard but fills most
  // of the frame with near-white pixels, which trips the washout render check
  // (whiteFraction > 0.7). Squeezing both bounds steers generation into the
  // deep mid-tone band [48, 210] that reads as finished art.
  private static findBrightBackgroundColor(code: string): string | null {
    const patterns = [
      /scene\.background\s*=\s*new\s+THREE\.Color\s*\(\s*(['"]?)(#?[0-9a-f]{6}|0x[0-9a-f]{6})\1\s*\)/gi,
      /renderer\.setClearColor\s*\(\s*(['"]?)(#?[0-9a-f]{6}|0x[0-9a-f]{6})\1/gi,
    ];

    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        const literal = match[2];
        const luminance = this.hexLuminance(literal);
        if (luminance !== null && luminance > 210) return literal;
      }
    }

    return null;
  }

  private static hexLuminance(literal: string): number | null {
    const hex = literal.replace(/^#|^0x/i, '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;

    const value = Number.parseInt(hex, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  private static validateSemantics(code: string): string[] {
    const errors: string[] = [];

    // Modern canonical start idioms count as starting the loop — the old check
    // only accepted a bare `animate();` statement and false-rejected every
    // `renderer.setAnimationLoop(animate)` / `requestAnimationFrame(animate)` piece.
    const animateStarted = /\banimate\s*\(\s*\)\s*;/.test(code)
      || /setAnimationLoop\s*\(\s*animate\b/.test(code)
      || /requestAnimationFrame\s*\(\s*animate\b/.test(code);
    if (/function\s+animate\s*\(/.test(code) && !animateStarted) {
      errors.push('Three.js animation loop is defined but never started with animate()');
    }

    const animateBody = this.extractFunctionBody(code, 'animate');
    if (animateBody && !this.mutatesSceneState(animateBody) && !this.callsProjectHelper(animateBody, code)) {
      errors.push('Three.js animation loop should mutate scene state before rendering');
    }

    return errors;
  }

  private static mutatesSceneState(animateBody: string): boolean {
    return /\.(?:rotation|position|scale)\.[xyz]\s*[+\-*/]?=|\.material\.|\.lookAt\s*\(/.test(animateBody);
  }

  /**
   * The inline mutation heuristic can't see through helper calls — when the
   * animate body delegates to functions the piece itself defines (updateX(),
   * applyMotion(), …), assume mutation happens there instead of false-rejecting.
   */
  private static callsProjectHelper(animateBody: string, code: string): boolean {
    const helperNames = new Set<string>();
    for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (match[1] !== 'animate') helperNames.add(match[1]);
    }
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|function\b)/g)) {
      helperNames.add(match[1]);
    }
    for (const match of animateBody.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (helperNames.has(match[1])) return true;
    }
    return false;
  }

  private static extractFunctionBody(code: string, name: string): string | null {
    const match = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(code);
    if (!match) return null;

    let depth = 1;
    const start = match.index + match[0].length;
    for (let i = start; i < code.length; i++) {
      const char = code[i];
      if (char === '{') depth++;
      if (char === '}') depth--;
      if (depth === 0) {
        return code.slice(start, i);
      }
    }

    return null;
  }

  /**
   * Validate HTML-wrapped Three.js
   */
  static validateHTMLWrapped(code: string): string[] {
    const errors: string[] = [];

    if (!/three\.js|three\.module\.js|from\s+['"]three['"]|importmap/.test(code)) {
      errors.push('HTML-wrapped Three.js must include Three.js CDN or importmap');
    }

    return errors;
  }

  /**
   * Detect if code uses ES modules (importmap) vs global THREE
   */
  static detectModuleStyle(code: string): 'module' | 'global' | 'unknown' {
    const hasImportMap = /<script\s+type="importmap">/.test(code);
    const hasImport = /import.*from\s+['"]three['"]/.test(code);
    const hasGlobalTHREE = /new\s+THREE\./.test(code) && !hasImport;

    if (hasImportMap || hasImport) return 'module';
    if (hasGlobalTHREE) return 'global';
    return 'unknown';
  }

  /**
   * Get minimum size requirement for Three.js code
   */
  static getMinSize(): number {
    return 800; // Three.js needs scene setup, objects, camera, renderer, and animation loop
  }
}
