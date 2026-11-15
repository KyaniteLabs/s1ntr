/**
 * GeneratedCodeGuard - the single place where LLM-generated browser code is
 * compiled and executed (Tone, Three, Hydra, p5 adapters).
 *
 * The old guard was a per-adapter regex denylist, which string concatenation,
 * unicode escapes, `[].constructor.constructor(...)`, `globalThis['fe'+'tch']`
 * and friends walked straight past. This module replaces it with structure:
 *
 *  1. Parse with @babel/parser. Unparseable code is rejected.
 *  2. Walk the AST (scope-aware): reject free references to dangerous globals,
 *     dangerous property names (`constructor`, `prototype`, `window`, ...),
 *     dynamic `import()`, `with`, and string-literal timers.
 *  3. Instrument every non-literal computed member access `a[k]` as
 *     `a[guard(k)]`, so keys built at runtime ('con'+'structor') are checked
 *     when they are used, and coerced to a primitive once (no toString race).
 *  4. Execute as strict-mode code in a function with `this === undefined`,
 *     so a plain-call `this` can never be the global object. Timers are
 *     shadowed by wrappers that refuse non-function callbacks, and free
 *     names that are neither globals nor env bindings live on a scope object,
 *     so sloppy-style `x = 0` works without writing to `window`.
 *
 * This remains a denylist over a language with many reachability paths (DOM
 * objects reach `window` through `event.view`, for one). It is defence in
 * depth, not a sandbox; see the PR notes on running generated code in a
 * sandboxed Worker/iframe.
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type { Node } from '@babel/types';

/** Free (unshadowed) identifiers generated code may never reference. */
const BLOCKED_GLOBALS = new Set([
  'eval', 'Function', 'globalThis', 'window', 'self', 'top', 'parent', 'frames', 'opener',
  'document', 'location', 'history', 'navigator', 'open', 'postMessage', 'importScripts',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'Worker',
  'SharedWorker', 'ServiceWorker', 'BroadcastChannel', 'Notification', 'WebAssembly',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore',
  'process', 'require', 'module', 'exports', 'global', 'Buffer', 'Deno', 'Bun',
  '__dirname', '__filename', 'Reflect', 'execScript',
]);

/** Timer functions take a function, never a string; compiled code gets checking wrappers. */
const TIMER_GLOBALS = new Set(['setTimeout', 'setInterval', 'setImmediate']);

/** Property names that reach Function, the prototype chain, or window/document. */
const BLOCKED_PROPERTIES = new Set([
  'constructor', '__proto__', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
  'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors', 'defineProperty', 'defineProperties',
  'ownerDocument', 'defaultView', 'contentWindow', 'contentDocument',
  'getRootNode', 'parentNode', 'cookie', 'sendBeacon', 'fetch',
  // Any alias of a builtin (`const O = Object; O.prototype.x = 1`) can pollute.
  'prototype',
  // Window/global capabilities reachable as properties of env or DOM objects
  // (`e.view`, `e.composedPath()` end at window). `top` and `parent` stay
  // allowed: they are common art-code names (rect.top, mesh.parent).
  'window', 'document', 'globalThis', 'self', 'frames', 'opener', 'eval', 'Function',
  'view', 'composedPath',
]);

export class GeneratedCodeViolation extends Error {
  constructor(public readonly violations: string[]) {
    super(`Blocked unsafe generated code: ${violations.join('; ')}`);
    this.name = 'GeneratedCodeViolation';
  }
}

function guardKey(key: unknown): unknown {
  if (typeof key === 'number' || typeof key === 'symbol') return key;
  const text = String(key);
  if (BLOCKED_PROPERTIES.has(text)) {
    throw new GeneratedCodeViolation([`computed access to "${text}"`]);
  }
  return text;
}

interface Inspection {
  violations: string[];
  /** Source with computed member keys wrapped in the runtime guard. */
  instrumented: string;
}

function isStaticKey(node: Node): string | undefined {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function guardTimer(name: string) {
  return (callback: unknown, ...args: unknown[]): unknown => {
    if (typeof callback !== 'function') {
      throw new GeneratedCodeViolation([`${name} without a function argument`]);
    }
    const timer = (globalThis as Record<string, unknown>)[name];
    return (timer as (...a: unknown[]) => unknown)(callback, ...args);
  };
}

/**
 * @param scopeName when set, free identifiers that are neither globals nor in
 *   `envNames` are rewritten to `scopeName.id` (see compileGeneratedCode).
 */
function inspect(
  source: string,
  guardName: string,
  scopeName?: string,
  envNames: ReadonlySet<string> = new Set(),
): Inspection {
  const violations: string[] = [];
  const add = (message: string) => {
    if (!violations.includes(message)) violations.push(message);
  };

  let ast;
  try {
    ast = parse(source, { sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (error) {
    return {
      violations: [`unparseable code: ${error instanceof Error ? error.message : String(error)}`],
      instrumented: source,
    };
  }

  if (source.includes(guardName) || (scopeName && source.includes(scopeName))) {
    add('reserved guard identifier in source');
  }

  const inserts: Array<{ at: number; text: string }> = [];

  const checkPropertyName = (name: string, node: Node) => {
    if (BLOCKED_PROPERTIES.has(name)) add(`property "${name}"`);
    void node;
  };

  traverse(ast, {
    ImportDeclaration() { add('import declaration'); },
    ExportNamedDeclaration() { add('export declaration'); },
    ExportDefaultDeclaration() { add('export declaration'); },
    WithStatement() { add('with statement'); },
    Import() { add('dynamic import()'); },
    MetaProperty(path) {
      if (path.node.meta.name === 'import') add('import.meta');
    },

    Identifier(path) {
      const { node, parent } = path;
      const name = node.name;
      // Property position (`a.fetch`, `{ fetch: 1 }`) is not a variable reference.
      if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression')
        && parent.property === node && !parent.computed) return;
      if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod'
        || parent.type === 'ClassMethod' || parent.type === 'ClassProperty')
        && parent.key === node && !parent.computed
        && !(parent.type === 'ObjectProperty' && parent.shorthand)) return;
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement'
        || parent.type === 'ContinueStatement') return;
      if (path.scope.getBinding(name)) return;

      // Free `constructor`/`__proto__` resolve through the global object's prototype chain.
      if (BLOCKED_GLOBALS.has(name) || BLOCKED_PROPERTIES.has(name)) {
        add(`global "${name}"`);
        return;
      }
      if (TIMER_GLOBALS.has(name)) {
        // Early, readable rejection for the literal case; the runtime wrapper
        // catches strings that arrive through variables or aliases.
        const call = parent.type === 'CallExpression' && parent.callee === node ? parent : undefined;
        const first = call?.arguments[0];
        if (first && (first.type === 'StringLiteral' || first.type === 'TemplateLiteral')) {
          add(`${name} without a function argument`);
        }
        return;
      }
      if (scopeName && !envNames.has(name) && name !== 'arguments' && name !== 'undefined'
        && !(name in globalThis) && node.start != null && node.end != null) {
        if (parent.type === 'ObjectProperty' && parent.shorthand) {
          // `{ x }` -> `{ x: scope.x }`; key and value are separate nodes at the same span.
          if (parent.value === node) inserts.push({ at: node.end, text: `: ${scopeName}.${name}` });
          return;
        }
        inserts.push({ at: node.start, text: `${scopeName}.` });
      }
    },

    ThisExpression() { /* strict-mode wrapper makes plain-call `this` undefined */ },

    MemberExpression(path) { member(path.node); },
    OptionalMemberExpression(path) { member(path.node); },

    ObjectProperty(path) {
      const { node } = path;
      if (path.parentPath.isObjectExpression()) {
        // `{ __proto__: x }` sets the prototype; other literal keys are inert.
        const key = node.key.type === 'Identifier' ? node.key.name
          : node.key.type === 'StringLiteral' ? node.key.value : undefined;
        if (!node.computed && key === '__proto__') add('property "__proto__"');
        return;
      }
      if (!path.parentPath.isObjectPattern()) return;
      if (node.computed) {
        // Destructuring read: `const { ['con'+'structor']: C } = x`.
        const staticKey = isStaticKey(node.key);
        if (staticKey !== undefined) checkPropertyName(staticKey, node);
        else wrapKey(node.key);
      } else if (node.key.type === 'Identifier') {
        checkPropertyName(node.key.name, node);
      } else if (node.key.type === 'StringLiteral') {
        checkPropertyName(node.key.value, node);
      }
    },
  });

  function wrapKey(key: Node) {
    if (key.start == null || key.end == null) return;
    if (key.type === 'NumericLiteral') return;
    inserts.push({ at: key.start, text: `${guardName}((` });
    inserts.push({ at: key.end, text: '))' });
  }

  function member(node: Node) {
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return;
    const { property } = node;
    if (!node.computed) {
      if (property.type === 'Identifier') checkPropertyName(property.name, node);
      return;
    }
    const staticKey = isStaticKey(property);
    if (staticKey !== undefined) {
      checkPropertyName(staticKey, node);
      return;
    }
    wrapKey(property);
  }

  // Apply insertions back to front so earlier offsets stay valid.
  let instrumented = source;
  inserts
    .map((insert, index) => ({ ...insert, index }))
    .sort((a, b) => (b.at - a.at) || (b.index - a.index))
    .forEach(({ at, text }) => {
      instrumented = instrumented.slice(0, at) + text + instrumented.slice(at);
    });

  return { violations, instrumented };
}

/** Violations for `source`, or an empty list when it passes the structural guard. */
export function findGeneratedCodeViolations(source: string): string[] {
  return inspect(source, '__gcg_probe__').violations;
}

/** Holds sloppy-style variables (`x = 0`) for compiled code; prototype-free. */
export type GeneratedCodeScope = Record<string, unknown>;

/** A fresh scope; pass the same one to several compiles to share variables between them. */
export function createGeneratedCodeScope(): GeneratedCodeScope {
  return Object.create(null) as GeneratedCodeScope;
}

let compileCounter = 0;

/**
 * Validate and compile generated code into a callable. Names in `env` become
 * variables visible to the code (they may be redeclared by it). Free names that
 * are neither globals nor env names (`x = 0` with no declaration) are read and
 * written on `scope`, so strict mode does not break them and they never land on
 * `window`. Throws GeneratedCodeViolation on rejection; the returned function
 * throws whatever the generated code throws.
 */
export function compileGeneratedCode(
  source: string,
  env: Record<string, unknown> = {},
  scope: GeneratedCodeScope = createGeneratedCodeScope(),
): () => unknown {
  compileCounter += 1;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${compileCounter}`;
  const guardName = `__gcg_${suffix}`;
  const envName = `__gce_${suffix}`;
  const scopeName = `__gcs_${suffix}`;

  const timers: Record<string, unknown> = {};
  for (const name of TIMER_GLOBALS) {
    if (name in globalThis) timers[name] = guardTimer(name);
  }
  const fullEnv: Record<string, unknown> = { ...timers, ...env };
  const names = Object.keys(fullEnv).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));

  const { violations, instrumented } = inspect(source, guardName, scopeName, new Set(names));
  if (violations.length > 0) throw new GeneratedCodeViolation(violations);
  if (Object.getPrototypeOf(scope) !== null) {
    throw new TypeError('compileGeneratedCode: scope must come from createGeneratedCodeScope()');
  }

  const destructure = names.length > 0 ? `const { ${names.join(', ')} } = ${envName};` : '';
  // The user code sits in a nested non-arrow function so it may redeclare env
  // names and its `arguments` is its own (empty), not the wrapper's. It was
  // already parsed standalone above, so it cannot close the wrapper early.
  const body = `"use strict";${destructure}\nreturn (function () {\n${instrumented}\n}).call(undefined);`;
  // eslint-disable-next-line no-new-func -- sole generated-code execution site; guarded by the AST checks and runtime key guard above
  const run = new Function(envName, guardName, scopeName, body) as (e: unknown, g: unknown, s: unknown) => unknown;
  return () => run.call(undefined, fullEnv, guardKey, scope);
}
