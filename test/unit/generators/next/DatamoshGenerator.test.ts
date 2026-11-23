import { describe, expect, it, vi } from 'vitest';
import { DatamoshGenerator, DATAMOSH_RULES } from '../../../../src/generators/next/DatamoshGenerator.js';
import { LLMClient } from '../../../../src/llm/LLMClient.js';
import { GenerationError } from '../../../../src/errors/GenerationError.js';
import { datamoshConfidence } from '../../../../src/generators/registerGenerators.js';

const PLAN = JSON.stringify({ segments: [{ clip: 'waves', start: 0, duration: 3 }], strip: 'all', holds: [{ at: 10, repeat: 12 }] });
const CLIPS = 'waves: Ocean surface waves, 6.4 s\nfire: Fire burning, 11 s';
const llm = () => new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'datamosh-test' });

describe('DatamoshGenerator', () => {
  it('puts the footage list and the rules in the prompt and returns the plan JSON without its fence', async () => {
    const client = llm();
    const complete = vi.spyOn(client, 'complete').mockResolvedValue({ text: 'Sure:\n```json\n' + PLAN + '\n```', success: true });
    const code = await new DatamoshGenerator(client, { footageContext: CLIPS }).generate('melt the waves');
    expect(JSON.parse(code)).toMatchObject({ segments: [{ clip: 'waves' }] });
    const prompt = complete.mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('melt the waves');
    expect(prompt).toContain('fire: Fire burning');
    expect(prompt).toContain(DATAMOSH_RULES);
  });

  it('retries once, then throws a GenerationError naming the plan problem', async () => {
    const client = llm();
    const complete = vi.spyOn(client, 'complete').mockResolvedValue({ text: 'make it glitchy', success: true });
    await expect(new DatamoshGenerator(client, { footageContext: CLIPS }).generate('x')).rejects.toBeInstanceOf(GenerationError);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('rejects a plan that names a clip outside the footage list', async () => {
    const client = llm();
    vi.spyOn(client, 'complete').mockResolvedValue({ text: JSON.stringify({ segments: [{ clip: 'invented', start: 0, duration: 2 }] }), success: true });
    await expect(new DatamoshGenerator(client, { footageContext: CLIPS }).generate('x')).rejects.toThrow(/invented/);
  });
});

describe('datamoshConfidence', () => {
  it('routes only on an explicit target domain, never on the word alone', () => {
    expect(datamoshConfidence('Target creative domain: datamosh. melt it')).toBe(0.99);
    expect(datamoshConfidence('a datamosh of waves')).toBe(0);
    expect(datamoshConfidence('')).toBe(0);
  });
});
