/**
 * W1-F03 host-per-call parse + disposition (no live LLM).
 */
import { describe, expect, it } from 'vitest';
import {
  parseHostPerCallLines,
  analyzeGenerateHostCalls,
} from '../../../scripts/rotation/reprobe-operator-generate.mjs';

describe('F03 reprobe host-per-call', () => {
  it('parses role@host lines', () => {
    const text = `
[02:31:01.466] LLMClient         llm:response          generator@api.x.ai openai/grok-4.5 1200ms ok
[02:31:20.000] LLMClient         llm:response          evaluator@api.kilo.ai kilo/moonshotai/kimi-k3 18000ms ok
`;
    const calls = parseHostPerCallLines(text);
    expect(calls.length).toBe(2);
    expect(calls[0].role).toBe('generator');
    expect(calls[0].host).toBe('api.x.ai');
    expect(calls[1].role).toBe('evaluator');
    expect(calls[1].host).toContain('kilo');
  });

  it('routing-ok when generator on xAI and evaluator on Kilo', () => {
    const analysis = analyzeGenerateHostCalls([
      { role: 'generator', host: 'api.x.ai', provider: 'openai', model: 'grok-4.5' },
      { role: 'evaluator', host: 'api.kilo.ai', provider: 'kilo', model: 'moonshotai/kimi-k3' },
    ]);
    expect(analysis.disposition).toBe('routing-ok-product-or-syntax');
    expect(analysis.genOnKilo).toBe(0);
    expect(analysis.genOnExpected).toBe(1);
  });

  it('product-routing when generator on Kilo', () => {
    const analysis = analyzeGenerateHostCalls([
      { role: 'generator', host: 'api.kilo.ai', provider: 'kilo', model: 'moonshotai/kimi-k3' },
    ]);
    expect(analysis.disposition).toBe('product-routing');
    expect(analysis.genOnKilo).toBe(1);
  });

  it('instrument-ambiguous when only evaluator lines', () => {
    const analysis = analyzeGenerateHostCalls([
      { role: 'evaluator', host: 'api.kilo.ai', provider: 'kilo', model: 'moonshotai/kimi-k3' },
    ]);
    expect(analysis.disposition).toBe('instrument-ambiguous');
  });

  it('instrument-ambiguous for untagged legacy K3 lines', () => {
    const analysis = analyzeGenerateHostCalls([
      { role: null, host: 'kilo', provider: 'moonshotai', model: 'kimi-k3' },
    ]);
    expect(analysis.disposition).toBe('instrument-ambiguous');
    expect(analysis.untaggedCalls).toBe(1);
  });
});
