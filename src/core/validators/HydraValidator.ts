/**
 * HydraValidator - Hydra video synth validation logic
 *
 * Hydra is a live coding video synth language.
 * It uses functions like osc(), src(), noise(), shape(), gradient(), solid()
 * chained with modifiers and ending with .out()
 */

import { parse } from '@babel/parser';
import { HYDRA_PIECE_PRELUDE } from '../wrappers/GenericWrapper.js';
import type { CallExpression, Expression, MemberExpression, Node } from '@babel/types';
import { HYDRA_GLOBALS } from './browserGlobals.generated.js';
import { findUndeclaredIdentifiers } from './undeclaredIdentifiers.js';

/**
 * Everything in scope where GenericWrapper.wrapHydra pastes the piece: what
 * `new Hydra({ detectAudio: false })` puts on window, plus the shell's own
 * consts. No `a`: audio is off, so `a.fft` throws.
 */
const HYDRA_SHELL_NAMES = [...HYDRA_GLOBALS, 'canvas', 'errorDiv', 'hydraWidth', 'hydraHeight', 'hydra', 'go', 'o'];

/** Every hydra-synth 1.3.10 transform and its kind, from the vendored
 *  bundle's own table (a test keeps them equal). A combine or combineCoord
 *  transform takes a source first and numbers after it; every other
 *  transform takes only numbers, except src (a buffer) and sum (a vec4). */
export type HydraTransformKind = 'src' | 'coord' | 'color' | 'combine' | 'combineCoord';

export const HYDRA_TRANSFORMS: Readonly<Record<string, HydraTransformKind>> = {
  noise: 'src', voronoi: 'src', osc: 'src', shape: 'src', gradient: 'src', src: 'src', solid: 'src', prev: 'src',
  rotate: 'coord', scale: 'coord', pixelate: 'coord', repeat: 'coord', repeatX: 'coord', repeatY: 'coord',
  kaleid: 'coord', scroll: 'coord', scrollX: 'coord', scrollY: 'coord',
  posterize: 'color', shift: 'color', invert: 'color', contrast: 'color', brightness: 'color', luma: 'color',
  thresh: 'color', color: 'color', saturate: 'color', hue: 'color', colorama: 'color', sum: 'color',
  r: 'color', g: 'color', b: 'color', a: 'color',
  add: 'combine', sub: 'combine', layer: 'combine', blend: 'combine', mult: 'combine', diff: 'combine', mask: 'combine',
  modulateRepeat: 'combineCoord', modulateRepeatX: 'combineCoord', modulateRepeatY: 'combineCoord',
  modulateKaleid: 'combineCoord', modulateScrollX: 'combineCoord', modulateScrollY: 'combineCoord',
  modulate: 'combineCoord', modulateScale: 'combineCoord', modulatePixelate: 'combineCoord',
  modulateRotate: 'combineCoord', modulateHue: 'combineCoord',
};

const NUMBERS_ONLY_EXCEPT = new Set(['src', 'sum']);
const BUFFER = /^[os]\d$/;
const HYDRA_TRANSFORMS_SRC = new Set(Object.keys(HYDRA_TRANSFORMS).filter((name) => HYDRA_TRANSFORMS[name] === 'src'));

/** Depth-first walk over a Babel AST, calling visit on every node. */
function walk(node: Node | null | undefined, visit: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const child = node[key] as unknown;
    if (Array.isArray(child)) child.forEach((item) => walk(item as Node, visit));
    else if (child && typeof child === 'object' && 'type' in child) walk(child as Node, visit);
  }
}

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
    let program: Node | undefined;
    try {
      // Static parse only; nothing is evaluated. The shell runs the piece in a
      // try block of a classic <script>, after its prelude on the same line:
      // no top-level return, and declaring go or o is a redeclaration.
      parse(`${HYDRA_PIECE_PRELUDE} ${trimmed}`, { sourceType: 'script' });
      program = parse(trimmed, { sourceType: 'script', allowReturnOutsideFunction: true }).program;
    } catch (error) {
      errors.push(`Hydra code has a syntax error and cannot run: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (program) errors.push(...this.validateArgumentTypes(program), ...this.validateChainShape(program));

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
   * Argument-type gate. hydra-synth 1.3.10 cannot build a shader from a
   * source given to a number slot (.kaleid(shape(4)) compiles a vec4 into a
   * float) or a number given to a source slot (.blend(0.5) compiles, .add()
   * throws). .out() only logs a compile error, so the frame stays black and
   * the gate times out 45 s later with no cause. Every blank hydra render in
   * the Kaggle shard runs had one of these.
   */
  private static validateArgumentTypes(program: Node): string[] {
    const scope = this.collectNames(program);
    const kindOf = (name: string): HydraTransformKind | undefined =>
      Object.hasOwn(HYDRA_TRANSFORMS, name) ? HYDRA_TRANSFORMS[name] : undefined;
    const isSource = (node: Node | null | undefined): boolean => {
      if (!node) return false;
      if (node.type === 'Identifier') return BUFFER.test(node.name) || scope.sources.has(node.name);
      if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
      const callee = node.callee;
      if (callee.type === 'Identifier') return kindOf(callee.name) === 'src' && !scope.shadowed.has(callee.name);
      return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
        && callee.property.type === 'Identifier' && kindOf(callee.property.name) !== undefined && isSource(callee.object);
    };
    // A source on either side of a ternary or && / || still reaches the slot.
    const mayBeSource = (node: Node): boolean => isSource(node)
      || (node.type === 'ConditionalExpression' && (mayBeSource(node.consequent) || mayBeSource(node.alternate)))
      || (node.type === 'LogicalExpression' && (mayBeSource(node.left) || mayBeSource(node.right)));
    // What hydra cannot use as a combine source. An array is fine there:
    // hydra turns it into a vec4 uniform. A function must return an array too,
    // since hydra calls .slice() on its result every frame; `.mult(() => 0.9)`
    // throws `arr.slice is not a function` and the frame never draws.
    // Only flag what is plainly a number, so a function returning a variable
    // that might hold an array still passes.
    const plainNumber = (expr: Node | null | undefined): boolean => !!expr && (
      expr.type === 'NumericLiteral' || expr.type === 'BinaryExpression'
      || (expr.type === 'UnaryExpression' && expr.operator === '-')
      || (expr.type === 'CallExpression' && expr.callee.type === 'MemberExpression'
        && expr.callee.object.type === 'Identifier' && expr.callee.object.name === 'Math'));
    const returnsNumber = (fn: Node): boolean => {
      if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return false;
      if (fn.body.type !== 'BlockStatement') return plainNumber(fn.body);
      const returned: (Node | null | undefined)[] = [];
      walk(fn.body, (inner) => { if (inner.type === 'ReturnStatement') returned.push(inner.argument); });
      return returned.length > 0 && returned.every(plainNumber);
    };
    const notASource = (node: Node | undefined): boolean => !node
      || node.type === 'NumericLiteral' || node.type === 'StringLiteral' || node.type === 'BooleanLiteral'
      || returnsNumber(node)
      || (node.type === 'UnaryExpression' && node.argument.type === 'NumericLiteral')
      || (node.type === 'Identifier' && scope.numbers.has(node.name));
    const describe = (node: Node): string => {
      if (node.type === 'ConditionalExpression') return describe(isSource(node.consequent) ? node.consequent : node.alternate);
      if (node.type === 'LogicalExpression') return describe(isSource(node.left) ? node.left : node.right);
      if (node.type === 'Identifier') return node.name;
      let root: Node = node;
      while ((root.type === 'CallExpression' || root.type === 'OptionalCallExpression')
        && (root.callee.type === 'MemberExpression' || root.callee.type === 'OptionalMemberExpression')) root = root.callee.object;
      return (root.type === 'CallExpression' || root.type === 'OptionalCallExpression') && root.callee.type === 'Identifier'
        ? `${root.callee.name}(...)` : 'a value';
    };

    const found: { at: number; message: string }[] = [];
    walk(program, (node) => {
      if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
      const callee = node.callee;
      const isMember = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression';
      const name = callee.type === 'Identifier' ? callee.name
        : isMember && callee.property.type === 'Identifier' ? callee.property.name : '';
      const kind = kindOf(name);
      if (!kind || NUMBERS_ONLY_EXCEPT.has(name)) return;
      // A bare call is hydra only for a source the piece has not redefined.
      if (callee.type === 'Identifier' && (kind !== 'src' || scope.shadowed.has(name))) return;
      if (isMember && !isSource(callee.object)) return;
      const label = isMember ? `.${name}()` : `${name}()`;
      const args = node.arguments as Expression[];
      const at = callee.end ?? 0;
      let firstNumberSlot = 0;
      if (kind === 'combine' || kind === 'combineCoord') {
        firstNumberSlot = 1;
        if (args[0] && returnsNumber(args[0])) {
          found.push({ at, message: kind === 'combineCoord'
            ? `Hydra ${label} argument 1 is a function returning a number, but ${label} takes a source there, like .${name}(noise(3), 0.1) (the source distorts the picture, the number is how much): hydra throws "arr.slice is not a function" every frame and nothing draws. To animate a plain number use .scale(() => ...) or .rotate(() => ...), or put the function in the amount: .${name}(noise(3), () => ...)`
            : `Hydra ${label} argument 1 is a function returning a number, but ${label} takes a source there, like .${name}(osc(10), () => ...): hydra throws "arr.slice is not a function" every frame and nothing draws. To scale brightness use .color(r, g, b) or .brightness(() => ...)` });
        } else if (notASource(args[0])) {
          found.push({ at, message: kind === 'combineCoord'
            ? `Hydra ${label} needs a source as argument 1, like .${name}(noise(3), 0.1) or .${name}(o1, 0.1) (the source distorts the picture, the number is how much): without one hydra cannot build the shader and the frame renders black. A plain number is not a source; to move or resize the picture by a number use .scale(...), .rotate(...) or .scrollX(...)`
            : `Hydra ${label} needs a source as argument 1, like .${name}(osc(10)) or .${name}(o1): without one hydra cannot build the shader and the frame renders black` });
        }
      }
      args.slice(firstNumberSlot).forEach((arg, index) => {
        if (!mayBeSource(arg)) return;
        found.push({ at, message: `Hydra ${label} argument ${firstNumberSlot + index + 1} is a source (${describe(arg)}), but ${label} takes numbers: hydra compiles it into a float slot and the frame renders black. Use a number, an array, or () => ...` });
      });
    });
    return [...new Set(found.sort((x, y) => x.at - y.at).map((entry) => entry.message))];
  }

  /**
   * Chain shapes that throw at the first frame. Hydra chain methods push a
   * transform and `return this`, so `core = comp.color(...)` makes core the
   * same object as comp; feeding any of them back into that chain recurses
   * until the shader compile dies ("Invalid string length", "Maximum call
   * stack size exceeded"). Outputs (o0-o3) have no chain methods, and bare
   * `src()` has no texture to read (`x.getTexture is not a function`).
   */
  private static validateChainShape(program: Node): string[] {
    const errors = new Set<string>();
    const { shadowed } = this.collectNames(program);
    const isTransform = (name: string): boolean => Object.hasOwn(HYDRA_TRANSFORMS, name);
    const memberCall = (node: Node): node is CallExpression & { callee: MemberExpression } =>
      node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.property.type === 'Identifier' && isTransform(node.callee.property.name);
    const chainBase = (node: Node): Node => {
      let current = node;
      while (memberCall(current)) current = current.callee.object;
      return current;
    };
    const isSourceCall = (node: Node): boolean => node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && HYDRA_TRANSFORMS_SRC.has(node.callee.name) && !shadowed.has(node.callee.name);
    // variable -> the chain object it points at, named by the first variable that held it
    const chainOf = new Map<string, string>();
    const rootOf = (expr: Node): string | undefined => {
      const base = chainBase(expr);
      return base.type === 'Identifier' ? chainOf.get(base.name) : undefined;
    };
    const refs = (node: Node | null | undefined, out: string[] = []): string[] => {
      if (!node) return out;
      if (node.type === 'Identifier') out.push(node.name);
      else if (node.type === 'MemberExpression') { refs(node.object, out); if (node.computed) refs(node.property, out); }
      else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return out;
      else for (const key of Object.keys(node) as (keyof typeof node)[]) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
        const child = node[key] as unknown;
        if (Array.isArray(child)) child.forEach((c) => c && typeof c === 'object' && 'type' in c && refs(c as Node, out));
        else if (child && typeof child === 'object' && 'type' in child) refs(child as Node, out);
      }
      return out;
    };
    const bindChain = (name: string, init: Node | null | undefined): void => {
      if (!init) return;
      const base = chainBase(init);
      if (isSourceCall(base)) chainOf.set(name, name);
      else if (base.type === 'Identifier' && chainOf.has(base.name)) chainOf.set(name, chainOf.get(base.name) as string);
      else chainOf.delete(name);
    };
    walk(program, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') bindChain(node.id.name, node.init);
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') bindChain(node.left.name, node.right);
      if (node.type !== 'CallExpression') return;
      if (node.callee.type === 'Identifier' && node.callee.name === 'src' && !shadowed.has('src') && node.arguments.length === 0) {
        errors.add('Hydra src() needs a buffer to read: src(o0) for feedback, src(s0) for an input. Bare src() throws at the first frame');
      }
      if (!memberCall(node)) return;
      const receiver = node.callee.object;
      const method = (node.callee.property as { name: string }).name;
      if (receiver.type === 'Identifier' && /^o\d$/.test(receiver.name) && !shadowed.has(receiver.name)) {
        errors.add(`Hydra '${receiver.name}.${method}(...)': an output has no chain methods and throws; read it with src(${receiver.name}).${method}(...)`);
      }
      const root = rootOf(receiver);
      if (!root) return;
      const alias = node.arguments.flatMap((arg) => refs(arg)).find((name) => chainOf.get(name) === root);
      if (alias) {
        errors.add(`Hydra chain '${root}' is fed into itself through '${alias}': chain methods change a chain in place, so every variable made from '${root}' is the same object and the shader compile recurses until it crashes. Start each branch from its own source call`);
      }
    });
    return [...errors];
  }

  /**
   * Names the piece binds. A source variable (const field = noise(3)) is a
   * source; a function, parameter or non-source variable shadows any hydra
   * source of the same name; a const bound to a plain number is a number.
   */
  private static collectNames(program: Node): { sources: Set<string>; shadowed: Set<string>; numbers: Set<string> } {
    const sources = new Set<string>();
    const shadowed = new Set<string>();
    const numbers = new Set<string>();
    const bind = (pattern: Node | null | undefined): void => {
      if (!pattern) return;
      if (pattern.type === 'Identifier') shadowed.add(pattern.name);
      else if (pattern.type === 'AssignmentPattern') bind(pattern.left);
      else if (pattern.type === 'RestElement') bind(pattern.argument);
      else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(bind);
      else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((prop) => bind(prop.type === 'RestElement' ? prop : prop.value));
    };
    const bindParams = (params: Node[]): void => params.forEach(bind);
    // Shadowing first, so `const noise = (x) => x; const field = noise(3)` does not make field a source.
    walk(program, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id) shadowed.add(node.id.name);
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') bindParams(node.params);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && HYDRA_TRANSFORMS_SRC.has(node.id.name)) shadowed.add(node.id.name);
    });
    const callsSource = (node: Node | null | undefined): boolean => {
      if (!node) return false;
      if (node.type === 'Identifier') return BUFFER.test(node.name) || sources.has(node.name);
      if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
      const callee = node.callee;
      if (callee.type === 'Identifier') return HYDRA_TRANSFORMS_SRC.has(callee.name) && !shadowed.has(callee.name);
      return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
        && callee.property.type === 'Identifier' && Object.hasOwn(HYDRA_TRANSFORMS, callee.property.name) && callsSource(callee.object);
    };
    walk(program, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        const init = node.init;
        if (callsSource(init)) sources.add(node.id.name);
        else if (init && (init.type === 'NumericLiteral' || (init.type === 'UnaryExpression' && init.argument.type === 'NumericLiteral'))) numbers.add(node.id.name);
      }
    });
    // A source name that is also a parameter or gets reassigned is not reliably a source.
    walk(program, (node) => {
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && !callsSource(node.right)) sources.delete(node.left.name);
    });
    for (const name of shadowed) sources.delete(name);
    return { sources, shadowed, numbers };
  }

  /**
   * Hallucinated-name gate: a name that is neither a hydra global nor defined
   * in the piece throws ReferenceError at runtime and kills the whole chain
   * before .out() (live evidence: `flow is not defined` shipped as a scored
   * artifact; #1756 `mx`, `a.fft` with audio off).
   */
  private static validateIdentifiers(code: string): string[] {
    const errors: string[] = [];
    for (const name of findUndeclaredIdentifiers(code, { provided: HYDRA_SHELL_NAMES })) {
      errors.push(`Hydra code uses '${name}' which is neither a hydra global nor defined in the piece — it throws ReferenceError and kills the chain`);
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
