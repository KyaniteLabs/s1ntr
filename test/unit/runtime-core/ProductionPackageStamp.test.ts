import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProductionEntrypointAuthorityLocators } from '../../../src/runtime-core/ProductionAuthorityScanner.js';
import { enforceProductionAuthorityEntrypoints } from '../../../src/runtime-core/ProductionAuthorityRegistry.js';
import { resolveProductionSourceRefs } from '../../../src/runtime-core/ProductionLiminalRuntime.js';
import {
  PRODUCTION_AUTHORITY_ENTRYPOINTS, PRODUCTION_AUTHORITY_STAMP, buildProductionAuthorityStamp,
  productionDistDigest,
} from '../../../src/runtime-core/ProductionPackageStamp.js';

// #1590: an npm install ships dist only, with no src/ and no git checkout.

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
let pkg: string;

async function stamp(root: string, overrides: Record<string, unknown> = {}) {
  const entrypoints: Record<string, string[]> = {};
  for (const entry of PRODUCTION_AUTHORITY_ENTRYPOINTS) {
    entrypoints[entry] = [...await scanProductionEntrypointAuthorityLocators(process.cwd(), [entry])];
  }
  await mkdir(path.join(root, 'dist', 'cli'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'cli', 'index.js'), 'export {};\n');
  const value = { ...buildProductionAuthorityStamp(process.cwd(), {
    sourceHeadSha: HEAD, canonicalMainSha: MAIN, entrypoints }),
  distSha256: productionDistDigest(root), ...overrides };
  const version = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version;
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
  await writeFile(path.join(root, PRODUCTION_AUTHORITY_STAMP), JSON.stringify(value));
}

beforeEach(async () => { pkg = await mkdtemp(path.join(os.tmpdir(), 'sinter-packed-')); });
afterEach(async () => { await rm(pkg, { recursive: true, force: true }); });

describe('packed install authority census', () => {
  it('stamps exactly the entrypoints that run the census', async () => {
    const callers = new Set<string>();
    for (const file of ['src/cli/LiminalProductionGenerate.ts', 'src/cli/LiminalProductionCompose.ts',
      'src/cli/LiminalAuthoritativeCreate.ts', 'src/runtime-core/LiminalProductCommandPort.ts']) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/scanProductionEntrypointAuthorityLocators\(\s*packageRoot,\s*\['([^']+)'\]/g)) {
        callers.add(match[1]!);
      }
    }
    expect([...callers].sort()).toEqual([...PRODUCTION_AUTHORITY_ENTRYPOINTS]);
  });

  it('reads the pack-time census when src is absent, and it passes the registry', async () => {
    await stamp(pkg);
    for (const entry of PRODUCTION_AUTHORITY_ENTRYPOINTS) {
      const packed = await scanProductionEntrypointAuthorityLocators(pkg, [entry]);
      expect(packed).toEqual(await scanProductionEntrypointAuthorityLocators(process.cwd(), [entry]));
      expect(() => enforceProductionAuthorityEntrypoints(packed)).not.toThrow();
    }
  });

  it('fails closed with no stamp, a stale version or a bad file', async () => {
    await expect(scanProductionEntrypointAuthorityLocators(pkg, [PRODUCTION_AUTHORITY_ENTRYPOINTS[0]!]))
      .rejects.toThrow('PRODUCTION_AUTHORITY_STAMP_MISSING');
    await stamp(pkg, { packageVersion: '0.0.0-stale' });
    await expect(scanProductionEntrypointAuthorityLocators(pkg, [PRODUCTION_AUTHORITY_ENTRYPOINTS[0]!]))
      .rejects.toThrow('PRODUCTION_AUTHORITY_STAMP_INVALID:version');
    await writeFile(path.join(pkg, PRODUCTION_AUTHORITY_STAMP), '{');
    await expect(scanProductionEntrypointAuthorityLocators(pkg, [PRODUCTION_AUTHORITY_ENTRYPOINTS[0]!]))
      .rejects.toThrow('PRODUCTION_AUTHORITY_STAMP_INVALID:json');
  });

  it('refuses a stamp left over from different dist bytes', async () => {
    await stamp(pkg);
    await writeFile(path.join(pkg, 'dist', 'cli', 'index.js'), 'export const rebuilt = 1;\n');
    await expect(scanProductionEntrypointAuthorityLocators(pkg, [PRODUCTION_AUTHORITY_ENTRYPOINTS[0]!]))
      .rejects.toThrow('PRODUCTION_AUTHORITY_STAMP_INVALID:dist');
    await writeFile(path.join(pkg, 'dist', 'cli', 'index.js'), 'export {};\n');
    await writeFile(path.join(pkg, 'dist', 'cli', 'extra.js'), 'export {};\n');
    await expect(scanProductionEntrypointAuthorityLocators(pkg, [PRODUCTION_AUTHORITY_ENTRYPOINTS[0]!]))
      .rejects.toThrow('PRODUCTION_AUTHORITY_STAMP_INVALID:dist');
  });

  it('never trusts a stamp inside a git checkout that lost src', async () => {
    await stamp(pkg);
    await mkdir(path.join(pkg, '.git'));
    await writeFile(path.join(pkg, '.git', 'HEAD'), `${HEAD}\n`);
    await expect(scanProductionEntrypointAuthorityLocators(pkg, [PRODUCTION_AUTHORITY_ENTRYPOINTS[0]!]))
      .rejects.not.toThrow(/PRODUCTION_AUTHORITY_STAMP/);
  });

  it('refuses an entrypoint the stamp does not cover', async () => {
    await stamp(pkg);
    await expect(scanProductionEntrypointAuthorityLocators(pkg, ['src/cli/Unknown.ts']))
      .rejects.toThrow('PRODUCTION_AUTHORITY_STAMP_INVALID:entrypoint:src/cli/Unknown.ts');
  });
});

describe('packed install source refs', () => {
  const saved = process.env.FORGEJO_ACTIONS;
  beforeEach(() => { delete process.env.FORGEJO_ACTIONS; });
  afterEach(() => { if (saved === undefined) delete process.env.FORGEJO_ACTIONS; else process.env.FORGEJO_ACTIONS = saved; });

  it('binds to the stamped refs, labelled as a package stamp', async () => {
    await stamp(pkg);
    expect(resolveProductionSourceRefs({ repoRoot: pkg })).toEqual({ sourceHeadSha: HEAD,
      canonicalMainSha: MAIN, sourceKind: 'package-stamp', sourceHeadSource: 'package-stamp',
      canonicalMainSource: 'package-stamp' });
  });

  it('never uses a stamp inside a source tree, and fails with no stamp', async () => {
    await stamp(pkg);
    await mkdir(path.join(pkg, 'src'));
    expect(() => resolveProductionSourceRefs({ repoRoot: pkg })).toThrow('LIMINAL_PRODUCTION_SOURCE_REFS_UNRESOLVED');
    await rm(path.join(pkg, 'src'), { recursive: true });
    await rm(path.join(pkg, PRODUCTION_AUTHORITY_STAMP));
    expect(() => resolveProductionSourceRefs({ repoRoot: pkg })).toThrow('LIMINAL_PRODUCTION_SOURCE_REFS_UNRESOLVED');
  });

  it('rejects a stamp whose refs are not full commit shas', async () => {
    await stamp(pkg, { sourceHeadSha: 'HEAD' });
    expect(() => resolveProductionSourceRefs({ repoRoot: pkg })).toThrow('PRODUCTION_AUTHORITY_STAMP_INVALID:refs');
  });
});
