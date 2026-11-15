import { describe, it, expect } from 'vitest';

import { assertGenerativeModel } from '../../../src/llm/LLMClient.js';

describe('assertGenerativeModel', () => {
  it('refuses decision models on the token-generation path', () => {
    expect(() => assertGenerativeModel('LiquidAI/d1-2B')).toThrow(
      'DECISION_MODEL_NOT_GENERATIVE: LiquidAI/d1-2B answers typed questions only; route it through DecisionModelClient');
    expect(() => assertGenerativeModel('LiquidAI/d1-Omni-2B')).toThrow(/^DECISION_MODEL_NOT_GENERATIVE/);
  });

  it.each(['LiquidAI/LFM3-1.7B', 'LiquidAI/LFM3-VL-2B', 'claude-sonnet-4-20250514', '', 'unknown-model'])(
    'lets generative or unknown model %j through', model => {
      expect(assertGenerativeModel(model)).toBe(undefined);
    });
});
