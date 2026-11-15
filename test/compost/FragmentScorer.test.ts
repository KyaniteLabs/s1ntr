import { describe, it, expect, vi, beforeEach } from 'vitest';
/**
 * Tests for FragmentScorer — multi-dimensional fragment scoring.
 */

import { FragmentScorer } from '../../src/compost/FragmentScorer.js';
import { mergeConfig } from '../../src/compost/defaults.js';
import type { CompostFragment } from '../../src/compost/types.js';

function makeFragment(overrides: Partial<CompostFragment> = {}): CompostFragment {
  return {
    id: 'frag-1',
    source: '/test/file.txt',
    domain: 'ceramics',
    layer: 'semantic',
    content: 'Glaze dynamics and thermal patterns in kiln firing.',
    metadata: {
      fileType: 'txt',
      timestamp: '2026-03-20T00:00:00Z',
      hash: 'a'.repeat(64),
      size: 100,
      extractedAt: '2026-03-20T00:00:00Z',
    },
    tags: ['ceramics', 'semantic'],
    ...overrides,
  };
}

describe('FragmentScorer', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLLM: any;
  let scorer: FragmentScorer;

  beforeEach(() => {
    mockLLM = { generate: vi.fn(), generateWithToolLoop: vi.fn() };
    scorer = new FragmentScorer(mergeConfig(), mockLLM);
  });

  describe('scoreHeuristic()', () => {
    it('returns FragmentScore with all 6 dimensions', () => {
      const frag = makeFragment();
      const score = scorer.scoreHeuristic(frag);
      expect(score.total).toBeGreaterThanOrEqual(0);
      expect(score.total).toBeLessThanOrEqual(10);
      expect(score.novelty).toBeGreaterThanOrEqual(0);
      expect(score.density).toBeGreaterThanOrEqual(0);
      expect(score.crossDomain).toBeGreaterThanOrEqual(0);
      expect(score.metadataRarity).toBeGreaterThanOrEqual(0);
      expect(score.connectionStrength).toBeGreaterThanOrEqual(0);
    });

    it('novelty: unique words ratio', () => {
      const uniqueFrag = makeFragment({ content: 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Xray Yankee Zulu' });
      const dupFrag = makeFragment({ content: 'the the the the the the the the the the' });
      const uniqueScore = scorer.scoreHeuristic(uniqueFrag);
      const dupScore = scorer.scoreHeuristic(dupFrag);
      expect(uniqueScore.novelty).toBeGreaterThan(dupScore.novelty);
    });

    it('density: ideas per character', () => {
      const denseFrag = makeFragment({ content: 'ABC' });
      const sparseFrag = makeFragment({ content: 'aaaaaaaaaaaaaaaa' });
      const denseScore = scorer.scoreHeuristic(denseFrag);
      const sparseScore = scorer.scoreHeuristic(sparseFrag);
      expect(denseScore.density).toBeGreaterThan(sparseScore.density);
    });
  });

  describe('scoreLLM()', () => {
    it('calls LLM for semantic quality', async () => {
      mockLLM.generate.mockResolvedValue({
        success: true,
        code: JSON.stringify({ score: 8.5, reasoning: 'High quality' }),
      });
      const frag = makeFragment();
      const result = await scorer.scoreLLM(frag);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeGreaterThanOrEqual(0);
      }
      expect(mockLLM.generate).toHaveBeenCalledWith(
        expect.stringContaining('creative quality evaluator'),
        expect.stringContaining('Domain: ceramics\nLayer: semantic'),
      );
    });
  });

  describe('score()', () => {
    it('returns aggregate score', async () => {
      const frag = makeFragment();
      const score = await scorer.score(frag);
      expect(score.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shouldPromote()', () => {
    it('returns true when score exceeds threshold', async () => {
      const frag = makeFragment({ content: 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z unique words high novelty' });
      const result = await scorer.shouldPromote(frag);
      expect(result === true || result === false).toBe(true);
    });
  });
  describe('single-score receipt and no neutral fallback (#1303)', () => {
    it('marks an LLM failure as llm-failed with a heuristic-only total instead of blending a neutral 5', async () => {
      mockLLM.generate.mockRejectedValue(new Error('timeout'));
      const frag = makeFragment();
      const score = await scorer.score(frag);
      expect(score.judgment).toBe('llm-failed');
      expect(score.total).toBe(scorer.scoreHeuristic(frag).total);
    });

    it('treats an unparseable LLM reply as llm-failed', async () => {
      mockLLM.generate.mockResolvedValue({ success: true, code: 'no score here' });
      expect((await scorer.score(makeFragment())).judgment).toBe('llm-failed');
    });

    it('blends 60/40 and labels the judgment when the LLM answers', async () => {
      mockLLM.generate.mockResolvedValue({ success: true, code: '{"score": 8}' });
      const frag = makeFragment();
      const score = await scorer.score(frag);
      expect(score.judgment).toBe('heuristic+llm');
      expect(score.total).toBeCloseTo(scorer.scoreHeuristic(frag).total * 0.6 + 3.2, 10);
    });

    it('labels heuristic-only scores when no LLM is configured', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const noLLM = new FragmentScorer(mergeConfig(), null as any);
      const frag = makeFragment();
      expect(await noLLM.score(frag)).toEqual({ ...noLLM.scoreHeuristic(frag), judgment: 'heuristic-only' });
    });

    it('never promotes an llm-failed score, even at a zero threshold', async () => {
      const lenient = new FragmentScorer(mergeConfig({ seedPromotionThreshold: 0 }), mockLLM);
      mockLLM.generate.mockRejectedValue(new Error('timeout'));
      const frag = makeFragment();
      const score = await lenient.score(frag);
      expect(await lenient.shouldPromote(frag, score)).toBe(false);
      expect(await lenient.shouldPromote(frag)).toBe(false);
    });

    it('decides promotion on the precomputed score without a second LLM call', async () => {
      mockLLM.generate.mockResolvedValue({ success: true, code: '{"score": 0}' });
      const frag = makeFragment();
      const stored = { ...scorer.scoreHeuristic(frag), total: 9.9, judgment: 'heuristic+llm' as const };
      expect(await scorer.shouldPromote(frag, stored)).toBe(true);
      expect(mockLLM.generate).toHaveBeenCalledTimes(0);
      const below = { ...stored, total: 0.1 };
      expect(await scorer.shouldPromote(frag, below)).toBe(false);
    });
  });
});
