import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { BROWSER_GLOBALS } from './browserGlobals.generated.js';

const traverse = (
  typeof traverseModule === 'function'
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default
) as typeof traverseModule;

const BROWSER = new Set(BROWSER_GLOBALS);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

export interface UndeclaredOptions {
  /** Names the page's shell binds before the piece runs. */
  provided?: Iterable<string>;
  /** The shell runs the piece as a module: strict, so `x = 1` on an unbound name throws too. */
  module?: boolean;
}

/**
 * Names a script uses that nothing binds: not the script, not the page's
 * shell, not the browser. Each throws ReferenceError when the line runs
 * (#1756: `canvas.getContext` in a helper that never declared it).
 * Unparseable code returns [] because the syntax check reports it.
 */
export function findUndeclaredIdentifiers(code: string, options: UndeclaredOptions = {}): string[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(code, {
      sourceType: options.module ? 'module' : 'script',
      allowReturnOutsideFunction: !options.module,
    });
  } catch {
    return [];
  }
  const known = new Set<string>(options.provided ?? []);
  const reads = new Set<string>();
  traverse(ast, {
    AssignmentExpression(path) {
      const left = path.node.left;
      // `window.x = 1` creates a global; so does `x = 1`, but only in sloppy code.
      if (left.type === 'Identifier' && !path.scope.hasBinding(left.name) && !BROWSER.has(left.name)) {
        if (options.module) reads.add(left.name);
        else known.add(left.name);
      }
      if (left.type === 'MemberExpression' && !left.computed && left.object.type === 'Identifier'
        && GLOBAL_OBJECTS.has(left.object.name) && left.property.type === 'Identifier') {
        known.add(left.property.name);
      }
    },
    ReferencedIdentifier(path) {
      const name = (path.node as { name: string }).name;
      if (path.scope.hasBinding(name) || BROWSER.has(name)) return;
      // `typeof x` is the one read that is safe on an unbound name.
      if (path.parentPath?.isUnaryExpression({ operator: 'typeof' })) return;
      reads.add(name);
    },
  });
  return [...reads].filter((name) => !known.has(name)).sort();
}
