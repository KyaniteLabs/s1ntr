/**
 * Single source of truth for diagnose/harness read allowlist (IW-K05).
 * Consumed by harness tools and task-template preflight (IW-K01).
 */

export const DIAGNOSE_READ_ROOTS = [
  'src/',
  'test/',
  'docs/',
  'scripts/',
  'harness-tasks/',
  '.omx/',
  'output/',
  'gallery/',
  'tmp/',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
] as const;

/** Paths that must never be permanent allowlist (panel artifacts stage elsewhere). */
export const DIAGNOSE_FORBIDDEN_ROOTS = ['.quality/', 'node_modules/', '.git/'] as const;

export function isPathAllowlisted(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const bad of DIAGNOSE_FORBIDDEN_ROOTS) {
    if (n === bad.slice(0, -1) || n.startsWith(bad)) return false;
  }
  for (const root of DIAGNOSE_READ_ROOTS) {
    if (root.endsWith('/')) {
      if (n === root.slice(0, -1) || n.startsWith(root)) return true;
    } else if (n === root) {
      return true;
    }
  }
  return false;
}

export function assertPathAllowlisted(relPath: string): void {
  if (!isPathAllowlisted(relPath)) {
    throw new Error(
      `INPUT_UNREACHABLE: path not in diagnose allowlist: ${relPath}. ` +
        `Stage under docs/ or tmp/ (see IW-K01). Allowed: ${DIAGNOSE_READ_ROOTS.join(', ')}`,
    );
  }
}
