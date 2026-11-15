import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSinterEvent, inputHash } from '../../../src/telemetry/EventLedger.js';

describe('event ledger CLI contract', () => {
  it('prints filtered JSONL without loading provider configuration', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sinter-event-cli-'));
    const genDir = path.join(root, 'generation');
    mkdirSync(genDir, { recursive: true });
    const dayFile = path.join(genDir, '2026-07-26.jsonl');

    const eventA = createSinterEvent({
      event: 'generation.scored',
      model: 'gpt-test',
      provider: 'openai',
      role: 'generator',
      runId: 'a',
      episodeId: null,
      domain: 'p5',
      inputHash: inputHash('a'),
      verdict: 'honest',
      latencyMs: 1,
      costUsd: null,
      evidenceRefs: [],
      payload: { score: 0.9 },
      ts: '2026-07-26T00:00:00.000Z',
    });
    const eventB = createSinterEvent({
      event: 'generation.scored',
      model: 'other-model',
      provider: 'openai',
      role: 'generator',
      runId: 'b',
      episodeId: null,
      domain: 'hydra',
      inputHash: inputHash('b'),
      verdict: 'degraded',
      latencyMs: 2,
      costUsd: null,
      evidenceRefs: [],
      payload: { score: 0.1 },
      ts: '2026-07-26T01:00:00.000Z',
    });
    writeFileSync(dayFile, `${JSON.stringify(eventA)}\n${JSON.stringify(eventB)}\n`);

    try {
      const stdout = execFileSync(
        process.execPath,
        [
          'bin/sinter',
          'ledger',
          'query',
          '--event',
          'generation.scored',
          '--model',
          'gpt-test',
          '--limit',
          '10',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            SINTER_EVENT_LEDGER_PATH: root,
            // Avoid lifting real fitness files from the developer machine.
            SINTER_FITNESS_OBSERVATIONS_PATH: path.join(root, 'no-fitness.jsonl'),
          },
        },
      );

      const lines = stdout.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]) as { event: string; model: string; runId: string };
      expect(row.event).toBe('generation.scored');
      expect(row.model).toBe('gpt-test');
      expect(row.runId).toBe('a');
      expect(stdout).not.toContain('Resolved provider');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid --limit without loading LLM config', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sinter-event-cli-bad-'));
    try {
      expect(() =>
        execFileSync(
          process.execPath,
          ['bin/sinter', 'ledger', 'query', '--limit', 'nope'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, SINTER_EVENT_LEDGER_PATH: root },
          },
        ),
      ).toThrow(/Invalid value for --limit: expected a non-negative integer/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
