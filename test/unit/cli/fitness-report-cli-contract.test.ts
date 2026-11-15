import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('fitness report CLI contract', () => {
  it('prints a machine-readable aggregate without loading provider configuration', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sinter-fitness-cli-'));
    const filePath = path.join(root, 'fitness-observations.jsonl');
    writeFileSync(filePath, `${JSON.stringify({
      schemaVersion: 1,
      timestamp: '2026-07-26T00:00:00.000Z',
      runId: 'cli-test',
      episodeId: 'cli-test',
      domain: 'p5',
      provider: 'openai',
      model: 'gpt-test',
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      score: 0.8,
      confidence: 1,
      failureClass: 'none',
      honest: true,
      graduationEligible: true,
      activeAdaptationIds: [],
      cohort: 'control',
    })}\n`);
    try {
      const stdout = execFileSync(process.execPath, ['bin/sinter', 'report', 'fitness', '--json'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, SINTER_FITNESS_OBSERVATIONS_PATH: filePath },
      });
      const report = JSON.parse(stdout) as { count: number; byDomain: Record<string, { count: number }> };
      expect(report.count).toBe(1);
      expect(report.byDomain.p5.count).toBe(1);
      expect(stdout).not.toContain('Resolved provider');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
