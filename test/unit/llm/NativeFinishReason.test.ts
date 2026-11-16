import { describe, expect, it } from 'vitest';
import { mapNativeFinishReason } from '../../../src/llm/providers/BaseProvider.js';
import { raisedOutputBudget, truncationCheck, TRUNCATION_BUDGET_CEILING }
  from '../../../src/runtime-core/LiminalProductionEffects.js';

// #1643: Kilo/OpenRouter/Google erased an output-cap stop into 'stop', so a
// cut-off reply looked finished and failed later as a syntax error.
describe('mapNativeFinishReason', () => {
  it.each([
    ['length', 'length'], ['LENGTH', 'length'],
    ['max_tokens', 'length'], ['MAX_TOKENS', 'length'], ['max_output_tokens', 'length'],
    ['stop', 'stop'], ['end_turn', 'stop'], ['STOP', 'stop'], [undefined, 'stop'], [42, 'stop'],
  ])('maps native %s to %s', (native, expected) => {
    expect(mapNativeFinishReason(native, false)).toBe(expected);
  });

  it('keeps tool_calls ahead of any native reason', () => {
    expect(mapNativeFinishReason('length', true)).toBe('tool_calls');
  });
});

describe('raisedOutputBudget', () => {
  it.each([
    [4096, 8192], [2000, 4000], [20_000, TRUNCATION_BUDGET_CEILING], [40_000, 40_000],
  ])('cap %i earns %i', (cap, expected) => {
    expect(raisedOutputBudget(cap)).toBe(expected);
  });

  it('names the cap in the truncation check', () => {
    expect(truncationCheck(4096)).toMatch(/^GENERATION_TRUNCATED: the reply stopped at the 4096-token output cap/);
  });
});
