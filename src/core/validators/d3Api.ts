import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { D3_EXPORTS } from './d3Api.generated.js';

const traverse = (
  typeof traverseModule === 'function'
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default
) as typeof traverseModule;

const D3_SCRIPT = /\bd3(?:-(contour|delaunay|geo))?(?:@|\.min|\.v\d|[/.])/i;

/** The d3 bundles a page's <script src> tags load ('d3', 'd3-geo', ...). */
export function d3BundlesLoaded(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const hit = m[1].match(D3_SCRIPT);
    if (hit) out.add(hit[1] ? `d3-${hit[1].toLowerCase()}` : 'd3');
  }
  return [...out].filter((id) => id in D3_EXPORTS);
}

/**
 * `d3.x` reads that none of the loaded bundles export. Each one is undefined
 * at runtime, so `.interpolate(d3.interpolateOklch)` throws "e is not a
 * function" inside d3 when the scale first runs. A page that binds its own
 * `d3` (an ESM import, a local) is skipped; so is unparseable code, which the
 * syntax check reports.
 */
export function unknownD3Members(code: string, bundles: readonly string[], sourceType: 'script' | 'module' = 'script'): string[] {
  if (bundles.length === 0) return [];
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(code, { sourceType, allowReturnOutsideFunction: sourceType === 'script' });
  } catch {
    return [];
  }
  const known = new Set(bundles.flatMap((id) => D3_EXPORTS[id] ?? []));
  const reads = new Set<string>();
  const visit = (path: { node: { object: unknown; property: unknown; computed: boolean }; scope: { hasBinding(n: string): boolean }; parentPath: { node: unknown } | null }) => {
    const { object, property, computed } = path.node as { object: { type: string; name?: string }; property: { type: string; name?: string }; computed: boolean };
    if (computed || object.type !== 'Identifier' || object.name !== 'd3' || property.type !== 'Identifier') return;
    if (path.scope.hasBinding('d3')) return;
    const parent = path.parentPath?.node as { type?: string; left?: unknown } | undefined;
    // `d3.myHelper = ...` adds a member the page then reads.
    if (parent?.type === 'AssignmentExpression' && parent.left === path.node) known.add(property.name!);
    else reads.add(property.name!);
  };
  traverse(ast, { MemberExpression: visit as never, OptionalMemberExpression: visit as never });
  return [...reads].filter((name) => !known.has(name)).sort();
}

/** Up to two real exports spelled closest to `name`, for the retry hint. */
export function nearestD3Exports(name: string, bundles: readonly string[]): string[] {
  const lower = name.toLowerCase();
  const dist = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[b.length];
  };
  return [...new Set(bundles.flatMap((id) => D3_EXPORTS[id] ?? []))]
    .map((n) => [n, dist(lower, n.toLowerCase())] as const)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, 2).map(([n]) => n);
}
