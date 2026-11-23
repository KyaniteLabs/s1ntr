/**
 * PolicyManifestStore — the on-disk PolicyChangeManifest behind `sinter ship garden|rollback`.
 *
 * Every mutation is read-modify-write under a file lock and lands atomically,
 * so two `ship` calls cannot lose each other's change records.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../utils/fileLock.js';
import { PolicyChangeManifest } from './PolicyChangeManifest.js';

export function policyManifestPath(cwd: string = process.cwd()): string {
  return process.env.SINTER_GARDEN_MANIFEST_PATH
    || path.join(cwd, '.sinter', 'garden', 'policy-manifest.json');
}

async function readManifest(file: string): Promise<PolicyChangeManifest> {
  try {
    return PolicyChangeManifest.fromJSON(JSON.parse(await readFile(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new PolicyChangeManifest();
    throw err;
  }
}

export async function loadPolicyManifest(file: string = policyManifestPath()): Promise<PolicyChangeManifest> {
  return readManifest(file);
}

/** Run `fn` against the current manifest; persist the result when `fn` returns normally. */
export async function mutatePolicyManifest<T>(
  fn: (manifest: PolicyChangeManifest) => T | Promise<T>,
  file: string = policyManifestPath(),
): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, async () => {
    const manifest = await readManifest(file);
    const result = await fn(manifest);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(manifest.toJSON(), null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    return result;
  });
}
