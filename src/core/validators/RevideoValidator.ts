/**
 * RevideoValidator - Revideo video composition validation logic
 *
 * Revideo is the active programmatic video framework. The supported contract is
 * canonical makeScene2D("SceneName", function* (view) { ... }) scenes with @revideo/2d
 * components and @revideo/core animation helpers. Legacy makeScene(name, ...)
 * scenes remain accepted for compatibility. It must not use @revideo/react,
 * React.FC, or useCurrentFrame/AbsoluteFill/Composition API.
 */

import { parse } from '@babel/parser';
import traverseModule, { type NodePath } from '@babel/traverse';
import type { Node } from '@babel/types';

import { hasFence } from '../../llm/ModelOutput.js';

const traverse = typeof traverseModule === 'function'
  ? traverseModule
  : (traverseModule as unknown as { default: typeof traverseModule }).default;

/** Wrappers that do not change which value an expression holds: a!, a as T, (a). */
const TRANSPARENT = new Set(['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);

type RefUse = 'call' | 'bind' | 'add' | 'read' | 'inert';

/** What one reference to a createRef() name does with the ref. */
function refUse(reference: NodePath): { use: RefUse; property?: string } {
  let path: NodePath = reference;
  while (path.parentPath && TRANSPARENT.has(path.parentPath.node.type)) path = path.parentPath;
  const node = path.node;
  const parent = path.parentPath?.node;
  if (!parent || parent.type === 'TSTypeQuery') return { use: 'inert' };
  if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && parent.callee === node) {
    return { use: parent.arguments.length > 0 ? 'bind' : 'call' };
  }
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node) {
    return { use: 'read', property: parent.property.type === 'Identifier' && !parent.computed ? parent.property.name : '[...]' };
  }
  if (parent.type === 'JSXExpressionContainer') {
    const attribute = path.parentPath?.parentPath?.node;
    return { use: attribute?.type === 'JSXAttribute' && attribute.name.name === 'ref' ? 'bind' : 'inert' };
  }
  if (parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression') {
    const { object, property } = parent.callee;
    if (property.type === 'Identifier' && property.name === 'add') return { use: 'add' };
    if (object.type === 'Identifier' && object.name === 'console') return { use: 'inert' };
  }
  // { ref: x }, x handed to a helper, a constructor, an array or an alias: a node may be attached there.
  return { use: 'bind' };
}

export interface RevideoValidationResult {
  valid: boolean;
  errors: string[];
}

export class RevideoValidator {
  // Commonly-generated @revideo/core exports. The full surface is large; this
  // covers what generators actually emit. The easing family (ease*) is matched
  // by EASING_PATTERN below instead of being enumerated here.
  private static readonly VALID_REVIDEO_CORE_IMPORTS = new Set([
    'makeScene', 'useTime', 'useScene', 'usePlayback', 'useLogger', 'useDuration', 'useRandom',
    'createSignal', 'createRef', 'createRefArray', 'createRefMap', 'createComputed', 'makeRef', 'makeRefs',
    'waitFor', 'waitUntil', 'all', 'any', 'chain', 'delay', 'loop', 'loopFor', 'sequence', 'run', 'every', 'join', 'cancel',
    'interpolate', 'spring', 'tween', 'map', 'remap', 'clamp', 'clampRemap', 'linear', 'Easing',
    'Vector2', 'Color', 'Spacing', 'BBox', 'Matrix2D', 'Random', 'Logger', 'DEFAULT',
    'fadeTransition', 'OffthreadVideo', 'staticFile', 'loadImage', 'loadAnimation'
  ]);

  private static readonly VALID_REVIDEO_2D_IMPORTS = new Set([
    'makeScene2D', 'View2D', 'Scene2D', 'Node', 'Shape', 'Layout',
    'Circle', 'Rect', 'Txt', 'Img', 'Video', 'Audio', 'Line', 'Path', 'Ray', 'Spline', 'Polygon', 'Curve',
    'Bezier', 'CubicBezier', 'QuadBezier', 'Knot', 'Grid', 'Code', 'Latex', 'Icon', 'SVG',
    'Gradient', 'LinearGradient', 'RadialGradient', 'Pattern', 'Filter'
  ]);

  // The @revideo/core easing family (easeInCubic, easeOutExpo, easeInOutBack, …)
  // is a stable, large set — match by shape rather than enumerating all ~30.
  private static readonly EASING_PATTERN = /^ease(In|Out|InOut)[A-Z][A-Za-z]+$/;

  static validate(code: string): RevideoValidationResult {
    const errors: string[] = [];
    const trimmed = code.trim();

    if (!trimmed) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    errors.push(...this.validateStructure(trimmed));
    errors.push(...this.validateImports(trimmed));
    errors.push(...this.validateSemantics(trimmed));
    errors.push(...this.validateRefs(trimmed));

    return { valid: errors.length === 0, errors };
  }

  private static validateStructure(code: string): string[] {
    const errors: string[] = [];

    const hasRevideo = /@revideo\/(core|2d)/.test(code) ||
                       /\b(makeScene2D|makeScene|useTime|createSignal)\b/.test(code);

    if (!hasRevideo) {
      errors.push('Revideo code must use @revideo/2d or @revideo/core APIs (makeScene2D, createRef, waitFor)');
    }

    const hasMakeScene2D = /\bmakeScene2D\s*\(/.test(code);
    const hasLegacyMakeScene = /\bmakeScene\s*\(/.test(code);
    if (!hasMakeScene2D && !hasLegacyMakeScene) {
      errors.push('Revideo composition must export makeScene2D(...) or makeScene(...)');
    }

    if (/makeScene\s*\(\s*\{/.test(code)) {
      errors.push('Revideo makeScene must use makeScene("SceneName", function* (view) { ... }), not makeScene({ render: ... })');
    }

    const hasNamedCanonicalScene = /makeScene2D\s*\(\s*['"][^'"]+['"]\s*,\s*function\*/.test(code);
    const hasSingleArgCanonicalScene = /makeScene2D\s*\(\s*function\*/.test(code);
    const hasCanonicalScene = hasNamedCanonicalScene || hasSingleArgCanonicalScene;
    const hasLegacyScene = /makeScene\s*\(\s*['"][^'"]+['"]\s*,\s*function\*/.test(code);
    if (!hasCanonicalScene && !hasLegacyScene) {
      errors.push('Revideo composition must use makeScene2D("SceneName", function* (view) { ... }), makeScene2D(function* (view) { ... }), or makeScene("SceneName", function* (view) { ... })');
    }

    return errors;
  }

  private static validateImports(code: string): string[] {
    const errors: string[] = [];
    if (/@revideo\/react/.test(code)) {
      errors.push('Revideo code must not import @revideo/react; use @revideo/core and @revideo/2d');
    }
    if (/\bremotion\b|from\s+['"]remotion['"]/.test(code)) {
      errors.push('Revideo code must not import or reference the remotion package');
    }
    if (/\b(useFrame|useCurrentFrame|React\.FC)\b/.test(code)) {
      errors.push('Revideo code must not use React hooks like useFrame/useCurrentFrame or React.FC');
    }
    if (/\bcreateCanvas\b|function\s+setup\s*\(|function\s+draw\s*\(|\bp5\b|p5\.js/i.test(code)) {
      errors.push('Revideo code must not use p5.js APIs such as createCanvas, setup(), or draw()');
    }
    errors.push(
      ...this.validateNamedImports(
        code,
        /import\s+\{([^}]+)\}\s+from\s+['"]@revideo\/core['"]/g,
        this.VALID_REVIDEO_CORE_IMPORTS
      )
    );
    errors.push(
      ...this.validateNamedImports(
        code,
        /import\s+\{([^}]+)\}\s+from\s+['"]@revideo\/2d['"]/g,
        this.VALID_REVIDEO_2D_IMPORTS
      )
    );
    if (!/@revideo\/2d/.test(code)) {
      errors.push('Revideo scene should import visual components such as Txt/Rect from @revideo/2d');
    }
    return errors;
  }

  private static validateNamedImports(code: string, pattern: RegExp, allowed: Set<string>): string[] {
    const errors: string[] = [];
    for (const match of code.matchAll(pattern)) {
      const imports = match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim());
      for (const imp of imports) {
        if (imp && !allowed.has(imp) && !this.EASING_PATTERN.test(imp)) {
          errors.push(`Unknown Revideo import: ${imp}`);
        }
      }
    }
    return errors;
  }

  private static validateSemantics(code: string): string[] {
    const errors: string[] = [];

    const hasMakeScene = /\b(makeScene2D|makeScene)\b/.test(code);
    const hasSignalOrRef = /createSignal|createRef/.test(code);
    const hasJSX = /<[A-Z][A-Za-z0-9]*/.test(code) || /<[a-z]+/.test(code);
    const hasViewAdd = /\bview\.add\s*\(/.test(code);
    const hasYield = /\byield\*/.test(code);

    if (!hasMakeScene) {
      errors.push('Revideo code must define a makeScene2D or makeScene function');
    }

    if (!hasSignalOrRef && !hasJSX) {
      errors.push('Revideo composition should use createSignal, createRef, or contain JSX');
    }

    if (!hasViewAdd) {
      errors.push('Revideo scene should add elements with view.add(...)');
    }

    if (!hasYield) {
      errors.push('Revideo animation should use generator/yield* animation steps');
    }

    const hasDefaultMakeSceneExport = /export\s+default\s+makeScene2D\s*\(/.test(code) ||
      /export\s+default\s+makeScene\s*\(/.test(code);
    if (!hasDefaultMakeSceneExport) {
      errors.push('Revideo code should export default makeScene2D("SceneName", ...) or makeScene(...)');
    }

    return errors;
  }

  /**
   * Ref gate. createRef() returns a function that holds nothing until a node
   * binds it with ref={name}; name() then returns the node. A ref that is
   * never bound, built with arguments, or read without the call
   * (name.opacity) is undefined at render, and the scene dies with
   * "Cannot read properties of undefined" after validation passed (both
   * LFM3 revideo renders in Kaggle shard v7).
   */
  private static validateRefs(code: string): string[] {
    if (hasFence(code)) {
      return ['Revideo scene is wrapped in a markdown fence: return the TSX source only, with no ``` lines'];
    }
    let ast: ReturnType<typeof parse>;
    try {
      ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    } catch (error) {
      return [`Revideo scene has a syntax error and cannot render: ${error instanceof Error ? error.message : String(error)}`];
    }
    const errors: string[] = [];
    traverse(ast as unknown as Node, {
      VariableDeclarator(path) {
        const { id, init } = path.node;
        if (id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'Identifier' || init.callee.name !== 'createRef') return;
        const name = id.name;
        const binding = path.scope.getBinding(name);
        if (!binding) return;
        const uses = binding.referencePaths.map(refUse);
        const bound = binding.constantViolations.length > 0 || uses.some(({ use }) => use === 'bind');
        if (init.arguments.length > 0) {
          errors.push(`Revideo createRef() takes no arguments (${name} = createRef(...)): declare it empty and bind a node with <Rect ref={${name}} ... />`);
        }
        if (uses.some(({ use }) => use === 'add')) {
          errors.push(`Revideo .add(${name}) adds the ref, not a node: add the element with ref={${name}} on it, like view.add(<Rect ref={${name}} ... />)`);
        }
        for (const property of new Set(uses.filter(({ use }) => use === 'read').map(({ property: p }) => p))) {
          errors.push(`Revideo ${name} is a ref, so ${name}.${property} is undefined: call it to get the node, ${name}().${property}`);
        }
        if (!bound && uses.some(({ use }) => use === 'call' || use === 'read')) {
          errors.push(`Revideo ref ${name} is never bound to a node, so ${name}() is undefined at render: add ref={${name}} to the JSX element it should hold`);
        }
      },
    });
    return errors;
  }

  static getMinSize(): number {
    return 500;
  }
}
