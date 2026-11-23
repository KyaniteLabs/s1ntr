/**
 * Wave 4 observed identity helper (no live LLM).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveObservedIdentity } from '../../../scripts/rotation/wave4-full-pipeline-dogfood.mjs';

const EXPECTED = {
  generator: { brain: 'K3', modelIncludes: ['kimi-k3', 'moonshotai/kimi-k3'] },
  evaluator: { brain: 'Grok', modelIncludes: ['grok-4.5', 'grok'] },
};

describe('resolveObservedIdentity', () => {
  it('accepts observed generator response matching freeze includes', () => {
    const r = resolveObservedIdentity(
      'generator',
      [{ role: 'generator', host: 'api.kilo.ai', provider: 'kilo', model: 'moonshotai/kimi-k3' }],
      EXPECTED.generator,
      'moonshotai/kimi-k3',
    );
    expect(r.observed).toBe(true);
    expect(r.cosplay).toBeNull();
    expect(r.model).toBe('moonshotai/kimi-k3');
  });

  it('fails closed when only requested label exists (no observed call)', () => {
    const r = resolveObservedIdentity('evaluator', [], EXPECTED.evaluator, 'grok-4.5');
    expect(r.observed).toBe(false);
    expect(r.cosplay).toMatch(/no observed llm:response/);
  });

  it('flags wrong observed model as cosplay', () => {
    const r = resolveObservedIdentity(
      'evaluator',
      [{ role: 'evaluator', host: 'api.x.ai', provider: 'xai', model: 'gpt-5.6-sol' }],
      EXPECTED.evaluator,
      'grok-4.5',
    );
    expect(r.observed).toBe(true);
    expect(r.cosplay).toMatch(/expected one of/);
  });

  it('does not let fixedJudge gemini steal Grok evaluator identity (gauge pollution)', () => {
    const r = resolveObservedIdentity(
      'evaluator',
      [
        {
          role: 'evaluator',
          host: 'localhost:8317',
          provider: 'custom',
          model: 'gemini-3.1-pro-low',
          raw: 'llm:response evaluator@localhost fixed-judge',
        },
        {
          role: 'evaluator',
          host: 'api.x.ai',
          provider: 'xai',
          model: 'grok-4.5',
          source: 'xai.chat.completions.response',
        },
      ],
      EXPECTED.evaluator,
      'grok-4.5',
    );
    expect(r.observed).toBe(true);
    expect(r.cosplay).toBeNull();
    expect(r.model).toBe('grok-4.5');
  });
});

it('binds contract stages to the requested wave and refuses incompatible live transports before bootstrap', async () => {
  const { resolvePipelineRoster } = await import('../../../scripts/rotation/wave4-full-pipeline-dogfood.mjs');
  const seats = { generator: 'visual', evaluator: 'visual', harness: 'text', chat: 'text' };
  const freeze = { wave11: seats, brains: { visual: { model: 'model-v' }, text: { model: 'model-t' } } };
  const roster = resolvePipelineRoster(freeze, 11, false);
  expect(roster.expected.evaluator).toEqual({ brain: 'visual', modelIncludes: ['model-v'] });
  expect(roster.expected.chat.modelIncludes).toEqual(['model-t']);
  expect(() => resolvePipelineRoster(freeze, 11, true)).toThrow(/live transports/);
  expect(() => resolvePipelineRoster(freeze, 12, false)).toThrow(/wave12/);
  const temp = mkdtempSync(path.join(tmpdir(), 'wave-contract-'));
  try {
    const file = path.join(temp, 'freeze.json');
    writeFileSync(file, JSON.stringify(freeze));
    const run = spawnSync(process.execPath, ['scripts/rotation/wave4-full-pipeline-dogfood.mjs',
      '--dry-run', '--wave', '11', '--freeze', file, '--out', temp], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(path.join(temp, 'pipeline-receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ wave: 11, seats, dryPass: true, livePass: false });
    expect(receipt.stages).toContainEqual(expect.objectContaining({ id: 'chat', model: 'model-t', observed: false }));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
