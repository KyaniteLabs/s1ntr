/**
 * Aesthetic LLM judge — pixel forwarding.
 *
 * The aesthetic judge previously called `llm.generate(..., undefined, ...)`
 * and never saw the rendered screenshot. When render evidence exists, the
 * caller passes the screenshot as imageInputs and it MUST reach the LLM call,
 * with a prompt note telling the judge to evaluate the visible artifact.
 * Without images, the call shape is unchanged (text-only, no regression).
 */

import { describe, it, expect, vi } from 'vitest';
import { analyzeWithLLMJudge } from '../../../src/aesthetic/critics/LLMJudgeCritic.js';
import { AestheticCritic } from '../../../src/aesthetic/AestheticCritic.js';
import { DEFAULT_DESIGN_CONSTRAINTS } from '../../../src/aesthetic/types.js';

const IMAGE = {
  mimeType: 'image/png',
  dataBase64: 'ZmFrZS1wbmc=',
  width: 400,
  height: 400,
  label: 'rendered-artifact',
};

const JUDGE_RESPONSE = `SCORE: 0.85
DIMENSIONS: color=0.9 layout=0.8 creativity=0.85 coherence=0.8
REASONING: Strong rendered composition.
VIOLATIONS: none`;

describe('analyzeWithLLMJudge — image forwarding', () => {
  it('forwards imageInputs to llm.generate and notes the attached screenshot in the prompt', async () => {
    const generate = vi.fn(async () => ({ code: JUDGE_RESPONSE, success: true }));
    const mockLLM = {
      generate,
      getConfig: () => ({ model: 'glm-5v', provider: 'glm', baseUrl: '' }),
    };

    const result = await analyzeWithLLMJudge(
      'function setup() {}',
      'p5',
      mockLLM,
      DEFAULT_DESIGN_CONSTRAINTS,
      {},
      [IMAGE],
    );

    expect(result.usedLLM).toBe(true);
    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('rendered screenshot of the artifact is attached'),
      undefined,
      true,
      [IMAGE],
      { jsonMode: false },
    );
  });

  it('passes undefined imageInputs and adds no screenshot note when no render evidence exists', async () => {
    const generate = vi.fn(async () => ({ code: JUDGE_RESPONSE, success: true }));
    const mockLLM = {
      generate,
      getConfig: () => ({ model: 'glm-5v', provider: 'glm', baseUrl: '' }),
    };

    await analyzeWithLLMJudge('function setup() {}', 'p5', mockLLM, DEFAULT_DESIGN_CONSTRAINTS);

    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.stringContaining('rendered screenshot'),
      undefined,
      true,
      undefined,
      { jsonMode: false },
    );
  });
});

describe('AestheticCritic.critiqueWithLLM — image forwarding', () => {
  it('passes imageInputs through to the LLM judge', async () => {
    const generate = vi.fn(async () => ({ code: JUDGE_RESPONSE, success: true }));
    const critic = new AestheticCritic();
    critic.setLLMClient({
      generate,
      getConfig: () => ({ model: 'glm-5v', provider: 'glm', baseUrl: '' }),
    });

    const report = await critic.critiqueWithLLM('function setup() {}', 'p5', undefined, [IMAGE]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[4]).toEqual([IMAGE]);
    expect((report as { usedLLM?: boolean }).usedLLM).toBe(true);
  });

  it('falls back to the heuristic path when no LLM client is wired', async () => {
    const critic = new AestheticCritic();

    const report = await critic.critiqueWithLLM('function setup() {}', 'p5', undefined, [IMAGE]);

    expect((report as { usedLLM?: boolean }).usedLLM).toBeUndefined();
    expect(typeof report.score).toBe('number');
  });
});

describe('AestheticCritic.critiqueWithLLM — brief coverage (#1853)', () => {
  const judgeWith = (code: string) => {
    const generate = vi.fn(async () => ({ code, success: true }));
    const critic = new AestheticCritic();
    critic.setLLMClient({ generate, getConfig: () => ({ model: 'glm-5v', provider: 'glm', baseUrl: '' }) });
    return { critic, generate };
  };

  it('puts every element the brief names into the judge prompt and turns a missing one into a warning', async () => {
    const { critic, generate } = judgeWith(`${JUDGE_RESPONSE}\nBRIEF_COVERAGE: VHS=absent, feedback tunnel=present, scanlines=absent`);
    const report = await critic.critiqueWithLLM('function setup() {}', 'p5', undefined, [IMAGE],
      'VHS feedback tunnel with scanlines');
    const prompt = String(generate.mock.calls[0]?.[1]);
    expect(prompt).toContain('Brief coverage checklist');
    expect(prompt).toContain('1. VHS');
    expect(prompt).toContain('scanlines');
    const briefWarnings = report.violations.filter(v => v.rule === 'brief-coverage').map(v => v.message);
    expect(briefWarnings).toEqual(['Missing brief element: VHS', 'Missing brief element: scanlines']);
  });

  it('sends the same prompt as before when no brief is given', async () => {
    const withNone = judgeWith(JUDGE_RESPONSE);
    const withBlank = judgeWith(JUDGE_RESPONSE);
    await withNone.critic.critiqueWithLLM('function setup() {}', 'p5', undefined, [IMAGE]);
    await withBlank.critic.critiqueWithLLM('function setup() {}', 'p5', undefined, [IMAGE], '   ');
    const prompt = String(withNone.generate.mock.calls[0]?.[1]);
    expect(prompt.includes('Brief coverage checklist')).toBe(false);
    expect(String(withBlank.generate.mock.calls[0]?.[1])).toBe(prompt);
  });
});
