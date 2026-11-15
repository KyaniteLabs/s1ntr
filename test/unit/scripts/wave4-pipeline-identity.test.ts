/**
 * Wave 4 observed identity helper (no live LLM).
 */
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
