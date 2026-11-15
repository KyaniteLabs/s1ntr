import { describe, expect, it } from 'vitest';
import { classifyActivatedKnowledgeInput, classifyDoctrineInput,
  classifyTaintedExplorationInput, formatClassifiedCreativeInput } from
  '../../../src/runtime-core/CreativeInputClassification.js';

const digest = (char: string) => char.repeat(64);

describe('creative input classification', () => {
  it('permits exactly doctrine, activated knowledge, or tainted exploration', () => {
    const inputs = [classifyDoctrineInput('symbol', digest('a')),
      classifyActivatedKnowledgeInput('principle', digest('b')),
      classifyTaintedExplorationInput('winner', [digest('c')], 'rejected')];
    expect(inputs.map(input => input.category)).toEqual([
      'doctrine', 'activated-knowledge', 'tainted-exploration']);
    for (const input of inputs) {
      expect(formatClassifiedCreativeInput(input)).toContain(`creative-input:${input.category}`);
    }
  });

  it('rejects unbound authority and ancestor identities', () => {
    expect(() => classifyDoctrineInput('symbol', 'hard-coded-winner'))
      .toThrow('CREATIVE_INPUT_DIGEST_INVALID');
    expect(() => classifyTaintedExplorationInput('seed', ['score-10']))
      .toThrow('CREATIVE_INPUT_DIGEST_INVALID');
  });
});
