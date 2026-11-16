import { describe, expect, it, vi } from 'vitest';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';
import { scoreRenderedEvidence, scoreRenderedEvidenceWithDecisionModel } from '../../src/core/ScoringEngine.js';
import { DecisionModelClient } from '../../src/llm/DecisionModelClient.js';
import { HTMLWrapper } from '../../src/utils/htmlWrapper.js';

const source = 'import { makeScene } from "@revideo/core"; export default makeScene("x", function* () {});';
const decision = new DecisionModelClient({ baseUrl: 'http://127.0.0.1:9931', model: 'LiquidAI/d1-2B', fetchImpl: vi.fn() });

describe('Revideo wrapper evidence', () => {
  // #1628: an explicit revideo domain with real scene source now renders in the
  // contained harness (see HeadlessRenderer.revideo.test.ts). The HTML preview
  // wrapper, and scene code that only looks like Revideo, are still refused.
  it('marks a Revideo wrapper, and an unlabelled scene, as not rendered without launching a browser', async () => {
    const renderer = new HeadlessRenderer();
    const wrapped = HTMLWrapper.wrap(source, 'revideo');
    for (const [code, domain] of [[wrapped, 'revideo'], [wrapped, 'html'], [source, 'unknown']] as const) {
      const result = await renderer.renderWithEvidence(code, { domain });
      expect(result).toMatchObject({ rendered: false, candidateFailure: false, infraUnavailable: false });
      expect(result.screenshot).toBeUndefined();
      expect(result.errors).toContain('Revideo scene not rendered: wrapper is an approximation');
    }
  });

  it('excludes wrapper evidence from both judges, even if it contains a screenshot', async () => {
    const evidence = { rendered: false, timingMs: 1, infraUnavailable: false, candidateFailure: false,
      screenshot: { mimeType: 'image/png', dataBase64: 'ZmFrZQ==' } };
    for (const result of [await scoreRenderedEvidence(evidence, source, '', undefined, 'revideo'),
      await scoreRenderedEvidenceWithDecisionModel(evidence, '', decision, 'revideo')]) {
      expect(result).toMatchObject({ score: 0, confidence: 0, failureClass: 'render', reasoning: expect.stringContaining('not rendered') });
    }
  });

  it('fails closed for unmarked Revideo evidence even on a render error', async () => {
    const evidence = { timingMs: 1, infraUnavailable: false, candidateFailure: true, errors: ['capture failed'] };
    const result = await scoreRenderedEvidenceWithDecisionModel(evidence, '', decision, 'revideo');
    expect(result).toMatchObject({ score: 0, confidence: 0, failureClass: 'render', reasoning: expect.stringContaining('not rendered') });
  });
});

describe('standalone visual judges', () => {
  it('excludes a Revideo audition screenshot', async () => {
    const path = '../../scripts/audition-379.mjs';
    const { judgeBankItem } = await import(path);
    const result = await judgeBankItem({ item: { id: 'video', domain: 'revideo' }, modelSpec: { id: 'judge' } });
    expect(result).toMatchObject({ score: null, visionUsed: false, visionAccepted: false,
      reasoning: 'Revideo scene not rendered; visual scoring excluded.' });
  });

  it('rejects a wrapper screenshot at the audition render and nonblank gates', async () => {
    const path = '../../scripts/audition-379.mjs';
    const { runDeterministicGates, maybeScreenshot } = await import(path);
    const gates = await runDeterministicGates({ domain: 'revideo', code: source,
      screenshotPath: 'package.json', varianceFn: async () => 100 });
    expect(gates.render).toEqual({ pass: false, errors: ['Revideo scene not rendered'] });
    expect(gates.nonblank).toEqual({ pass: false, errors: ['Revideo scene not rendered'], variance: null });
    expect(await maybeScreenshot({ domain: 'revideo' })).toMatchObject({ path: null, skipped: true });
  });

  it('excludes a Revideo rotation evaluator fixture before opening it', async () => {
    const path = '../../scripts/rotation/batteries.mjs';
    const { runLiveTask } = await import(path);
    const result = await runLiveTask('evaluator', { domain: 'revideo' }, {});
    expect(result.findings).toContain('Revideo scene not rendered; visual scoring excluded');
  });
});
