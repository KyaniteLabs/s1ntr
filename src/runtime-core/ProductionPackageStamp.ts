import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * An npm install has no TypeScript sources and no git checkout, so the two
 * runtime proofs a checkout gives (entrypoint authority census, source refs)
 * are recorded at pack time from the real tree and read back here. A missing
 * stamp is absent authority: callers fail closed, never invent a value.
 */
export const PRODUCTION_AUTHORITY_STAMP = 'dist/production-authority.json';

/** Every entrypoint that runs the authority census at runtime. */
export const PRODUCTION_AUTHORITY_ENTRYPOINTS = Object.freeze([
  'src/cli/LiminalAuthoritativeCreate.ts',
  'src/cli/LiminalProductionCompose.ts',
  'src/cli/LiminalProductionGenerate.ts',
  'src/runtime-core/LiminalProductCommandPort.ts',
]);

export interface ProductionAuthorityStamp {
  readonly schema: 'sinter.production-authority-stamp';
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly sourceHeadSha: string;
  readonly canonicalMainSha: string;
  /** sha256 over every shipped dist script, so a stale stamp never vouches for rebuilt code. */
  readonly distSha256: string;
  readonly entrypoints: Readonly<Record<string, readonly string[]>>;
}

const SHA = /^[0-9a-f]{40}$/;
const SCRIPT = /\.[cm]?js$/;

/** Digest of the dist scripts as shipped: sorted relative paths bound to their content hashes. */
export function productionDistDigest(root: string): string {
  const dist = path.join(root, 'dist');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SCRIPT.test(entry.name)) files.push(full);
    }
  };
  walk(dist);
  const digest = createHash('sha256');
  for (const file of files.map(full => path.relative(dist, full).split(path.sep).join('/')).sort()) {
    digest.update(`${file}\0${createHash('sha256').update(readFileSync(path.join(dist, file))).digest('hex')}\n`);
  }
  return digest.digest('hex');
}

function packageVersion(root: string): string {
  const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as
    { version?: unknown }).version;
  if (typeof version !== 'string' || !version) throw new Error('PRODUCTION_AUTHORITY_STAMP_INVALID:version');
  return version;
}

export function buildProductionAuthorityStamp(root: string, input: {
  sourceHeadSha: string; canonicalMainSha: string;
  entrypoints: Readonly<Record<string, readonly string[]>>;
}): ProductionAuthorityStamp {
  const stamp: ProductionAuthorityStamp = {
    schema: 'sinter.production-authority-stamp', schemaVersion: 1,
    packageVersion: packageVersion(root),
    sourceHeadSha: input.sourceHeadSha, canonicalMainSha: input.canonicalMainSha,
    distSha256: productionDistDigest(root),
    entrypoints: input.entrypoints,
  };
  validate(stamp, stamp.packageVersion);
  return stamp;
}

function validate(value: unknown, version: string): asserts value is ProductionAuthorityStamp {
  const stamp = value as Partial<ProductionAuthorityStamp> | null;
  const fail = (why: string): never => { throw new Error(`PRODUCTION_AUTHORITY_STAMP_INVALID:${why}`); };
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) fail('shape');
  if (stamp!.schema !== 'sinter.production-authority-stamp' || stamp!.schemaVersion !== 1) fail('schema');
  if (stamp!.packageVersion !== version) fail('version');
  if (!SHA.test(stamp!.sourceHeadSha ?? '') || !SHA.test(stamp!.canonicalMainSha ?? '')) fail('refs');
  if (!/^[0-9a-f]{64}$/.test(stamp!.distSha256 ?? '')) fail('dist');
  const entries = stamp!.entrypoints;
  if (!entries || typeof entries !== 'object') fail('entrypoints');
  for (const entry of PRODUCTION_AUTHORITY_ENTRYPOINTS) {
    const locators = entries![entry];
    if (!Array.isArray(locators) || !locators.every(item => typeof item === 'string')) {
      fail(`entrypoint:${entry}`);
    }
  }
}

/** Read the pack-time stamp; null only when the file is absent. */
export function readProductionAuthorityStamp(root: string): ProductionAuthorityStamp | null {
  let text: string;
  try {
    text = readFileSync(path.join(root, PRODUCTION_AUTHORITY_STAMP), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('PRODUCTION_AUTHORITY_STAMP_INVALID:json'); }
  validate(parsed, packageVersion(root));
  if (parsed.distSha256 !== productionDistDigest(root)) {
    throw new Error('PRODUCTION_AUTHORITY_STAMP_INVALID:dist');
  }
  return Object.freeze(parsed);
}
