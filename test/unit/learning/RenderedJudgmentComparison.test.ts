import { describe, expect, it, vi } from 'vitest';
import type { LLMClient } from '../../../src/llm/LLMClient.js';
import { compareRenderedJudgment } from '../../../src/learning/RenderedJudgmentComparison.js';

const candidate = (id: string) => ({
  id,
  evidenceDigest: id.toLowerCase().repeat(64),
  early: { mimeType: 'image/png', dataBase64: `${id}-early`, width: 2, height: 2 },
  late: { mimeType: 'image/png', dataBase64: `${id}-late`, width: 2, height: 2 },
});

describe('compareRenderedJudgment', () => {
  it('judges a digest-bound set together with labeled temporal frames', async () => {
    const generateWithImages = vi.fn().mockResolvedValue({
      code: '{"ranking":["B","A","C"],"reasoning":"B is cohesive; A is embodied; C is flat."}',
    });
    const result = await compareRenderedJudgment(
      [candidate('A'), candidate('B'), candidate('C')],
      { generateWithImages } as unknown as LLMClient,
    );

    expect(result.ranking).toEqual(['B', 'A', 'C']);
    expect(result.comparisonDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(generateWithImages.mock.calls[0][2].map((image: { label: string }) => image.label))
      .toEqual(['candidate-A-early', 'candidate-A-late', 'candidate-B-early',
        'candidate-B-late', 'candidate-C-early', 'candidate-C-late']);
    expect(generateWithImages.mock.calls[0][5]).toEqual({ jsonMode: true, requireVision: true });
  });

  it('rejects incomplete rankings', async () => {
    const llm = { generateWithImages: vi.fn().mockResolvedValue({
      code: '{"ranking":["A"],"reasoning":"incomplete"}',
    }) } as unknown as LLMClient;
    await expect(compareRenderedJudgment([candidate('A'), candidate('B')], llm))
      .rejects.toThrow('RENDERED_COMPARISON_RANKING_INVALID');
  });
});
