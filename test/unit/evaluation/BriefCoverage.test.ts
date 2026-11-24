import { describe, expect, it, vi } from 'vitest';
import {
  applyBriefCoveragePenalty,
  extractBriefElements,
  formatBriefCoveragePrompt,
  parseBriefCoverage,
} from '../../../src/evaluation/BriefCoverage.js';
import { analyzeWithLLMJudge, type LLMClientLike } from '../../../src/aesthetic/critics/LLMJudgeCritic.js';
import { DEFAULT_DESIGN_CONSTRAINTS } from '../../../src/aesthetic/types.js';

describe('BriefCoverage (#1853)', () => {
  it('extracts concrete named elements from Simon VHS feedback tunnel brief and strips boilerplate', () => {
    const brief = [
      'CANONICAL CREATIVE INTELLIGENCE CONTRACT',
      'Return only raw code with no markdown.',
      'USER BRIEF: VHS feedback tunnel with sci-fi film grain and CRT scanlines in neon cyan and magenta',
    ].join('\n');

    const elements = extractBriefElements(brief);
    const labels = elements.map(e => e.label.toLowerCase());

    expect(elements.length).toBeGreaterThanOrEqual(3);
    expect(labels.some(l => l.includes('vhs'))).toBe(true);
    expect(labels.some(l => l.includes('tunnel'))).toBe(true);
    expect(labels.some(l => l.includes('scanline'))).toBe(true);
    expect(labels.some(l => l.includes('contract'))).toBe(false);
  });

  it('caps judge score and lists missing elements when only palette colors are present', () => {
    const elements = extractBriefElements('VHS feedback tunnel with sci-fi film and scanlines');
    const promptBlock = formatBriefCoveragePrompt(elements);
    expect(promptBlock).toContain('Brief coverage checklist');
    expect(promptBlock).toContain('briefCoverage');

    const response = JSON.stringify({
      score: 0.84,
      reasoning: 'Pretty neon palette kaleidoscope, no VHS or scanlines.',
      briefCoverage: elements.map((el, i) => ({ element: el.label, present: i === 0 })),
    });

    const report = parseBriefCoverage(response, elements);
    expect(report.parsedFromResponse).toBe(true);
    expect(report.presentElements.length).toBe(1);
    expect(report.missingElements.length).toBe(elements.length - 1);
    expect(report.coverageRatio).toBeLessThan(0.5);
    expect(report.scoreCap).toBeLessThan(0.6);
    expect(report.repairAdvice).toContain('Missing brief elements');

    const penalized = applyBriefCoveragePenalty(0.84, report);
    expect(penalized.capped).toBe(true);
    expect(penalized.score).toBe(report.scoreCap);
    expect(penalized.missingElements).toEqual(report.missingElements);
  });

  it('preserves score when all extracted brief elements are present', () => {
    const elements = extractBriefElements('glowing nebula with obsidian pillars');
    const response = `SCORE: 0.88\nREASONING: Full brief realized.\nVIOLATIONS: none\nBRIEF_COVERAGE: ${elements.map(e => `${e.label}=present`).join(', ')}`;

    const report = parseBriefCoverage(response, elements);
    expect(report.parsedFromResponse).toBe(true);
    expect(report.missingElements).toEqual([]);
    expect(report.coverageRatio).toBe(1);
    expect(report.scoreCap).toBe(1);

    const penalized = applyBriefCoveragePenalty(0.88, report);
    expect(penalized.capped).toBe(false);
    expect(penalized.score).toBe(0.88);
  });

  it('integrates with analyzeWithLLMJudge when brief is provided while staying backward-compatible when omitted', async () => {
    const prompts: string[] = [];
    const llmWithMissing: LLMClientLike = {
      async generate(_sys, user) {
        prompts.push(user);
        return {
          success: true,
          code: JSON.stringify({
            score: 0.82,
            color: 0.9,
            layout: 0.8,
            creativity: 0.7,
            coherence: 0.8,
            reasoning: 'Colors match but missing VHS and scanlines.',
            violations: [],
            briefCoverage: [
              { element: 'VHS', present: false },
              { element: 'feedback tunnel', present: false },
              { element: 'scanlines', present: false },
            ],
          }),
        };
      },
      getConfig: () => ({ model: 'claude-sonnet-4-5', provider: 'anthropic' }),
    };

    const withBrief = await analyzeWithLLMJudge(
      'osc(10).color(0,1,1).out()',
      'hydra',
      llmWithMissing,
      DEFAULT_DESIGN_CONSTRAINTS,
      { brief: 'VHS feedback tunnel with scanlines' },
    );

    expect(prompts[0]).toContain('Brief coverage checklist');
    expect(withBrief.briefCoverage?.parsedFromResponse).toBe(true);
    expect(withBrief.briefCoverage?.missingElements.length).toBeGreaterThanOrEqual(2);
    expect(withBrief.score).toBeLessThan(0.6);
    expect(withBrief.passed).toBe(false);
    expect(withBrief.violations.some(v => v.rule === 'brief-coverage')).toBe(true);

    const generateSpy = vi.fn(async () => ({
      success: true,
      code: 'SCORE: 0.82\nDIMENSIONS: color=0.8 layout=0.8\nREASONING: Clean.\nVIOLATIONS: none',
    }));
    const legacy = await analyzeWithLLMJudge(
      'function setup(){ createCanvas(400,400); }',
      'p5',
      { generate: generateSpy, getConfig: () => ({ model: 'claude-sonnet-4-5', provider: 'anthropic' }) },
      DEFAULT_DESIGN_CONSTRAINTS,
    );
    expect(legacy.briefCoverage).toBeUndefined();
    expect(legacy.score).toBe(0.82);
    expect(legacy.passed).toBe(true);
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });
});
