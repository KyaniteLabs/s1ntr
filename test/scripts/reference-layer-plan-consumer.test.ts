import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consumeLayerPlan } from '../../scripts/quality/reference-layer-plan-consumer.mjs';

const fixtureDir = join(import.meta.dirname, '../fixtures/composition');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function bundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sinter-layer-consumer-'));
  tempDirs.push(dir);
  await cp(fixtureDir, dir, { recursive: true });
  return join(dir, 'layer-plan-v1.golden.json');
}

describe('independent layer-plan reference consumer', () => {
  it('verifies assets and deterministically reconstructs the fixture', async () => {
    const result = await consumeLayerPlan(await bundle());
    expect(result.order).toEqual(['background-field', 'orbit-lines']);
    expect(result.html).toContain('data-layer-id="background-field"');
    expect(result.html).toContain('data-layer-id="orbit-lines"');
    expect(result.html.indexOf('background-field')).toBeLessThan(result.html.indexOf('orbit-lines'));
  });

  it('rejects traversal and hash mismatch without composition internals', async () => {
    const path = await bundle();
    const plan = JSON.parse(await readFile(path, 'utf8'));
    plan.layers[0].artifact.path = '../outside.html';
    await writeFile(path, JSON.stringify(plan));
    await expect(consumeLayerPlan(path)).rejects.toThrow(/escapes bundle/);

    const hashPath = await bundle();
    const hashPlan = JSON.parse(await readFile(hashPath, 'utf8'));
    hashPlan.layers[0].artifact.sha256 = '0'.repeat(64);
    await writeFile(hashPath, JSON.stringify(hashPlan));
    await expect(consumeLayerPlan(hashPath)).rejects.toThrow(/hash mismatch/);
  });
});
