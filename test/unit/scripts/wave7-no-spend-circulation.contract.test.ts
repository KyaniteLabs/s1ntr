/**
 * Contract: Wave 8 deterministic UltraQA depends on wave7-no-spend-circulation
 * producing a real no-spend living-loop proof. Regression guard for
 * LIMINAL_PRODUCT_COMMAND_PORT_REQUIRED breaking that harness.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('wave7-no-spend-circulation proof script', () => {
  it('writes a passed no-spend circulation proof on the real script entrypoint', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wave7-proof-contract-'));
    const output = path.join(dir, 'wave7-reproof.json');
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('node_modules/tsx/dist/cli.mjs'),
          path.resolve('scripts/proof/wave7-no-spend-circulation.ts'),
          '--output',
          output,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env },
          timeout: 60_000,
        },
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const receipt = JSON.parse(await readFile(output, 'utf8')) as {
        passed?: boolean;
        noSpendCirculationProof?: boolean;
        evidenceClass?: string;
        gate?: string;
      };
      expect(receipt.gate).toBe('noSpendCirculationProof');
      expect(receipt.passed).toBe(true);
      expect(receipt.noSpendCirculationProof).toBe(true);
      expect(receipt.evidenceClass).toBe('deterministic-proof');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
