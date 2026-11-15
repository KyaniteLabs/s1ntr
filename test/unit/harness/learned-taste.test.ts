import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Learned-taste flywheel reaches generation. StudioReflection writes
 * `session-taste` feedback episodes tagged with what the user favored;
 * getLearnedTasteLikes reads them and promptForCreativeDomain folds them into
 * the prompt BOTH Studio paths build — so pins/rejects bias the next Generate.
 * HarnessMemory is mocked so the real ~/.sinter memory is never read or polluted.
 */
const { getRecentEpisodes } = vi.hoisted(() => ({ getRecentEpisodes: vi.fn() }));

vi.mock('../../../src/harness/HarnessMemory.js', () => ({
  harnessMemory: { getRecentEpisodes },
}));

const { getLearnedTasteLikes, buildLearnedTasteLine } = await import('../../../src/harness/learnedTaste.js');
const { promptForCreativeDomain } = await import('../../../src/tui-bridge/CreativeIntentHelpers.js');
const { Domain } = await import('../../../src/types/domains.js');

const tasteEpisode = (...tags: string[]) => ({ type: 'feedback', tags: ['session-taste', ...tags] });

beforeEach(() => {
  getRecentEpisodes.mockReset();
});

describe('getLearnedTasteLikes', () => {
  it('extracts favored tags from session-taste feedback episodes, deduped', () => {
    getRecentEpisodes.mockReturnValue([
      tasteEpisode('restraint', 'calm slow motion'),
      tasteEpisode('restraint', 'dim highlights'),
    ]);
    expect(getLearnedTasteLikes()).toEqual(['restraint', 'calm slow motion', 'dim highlights']);
  });

  it('drops the meta tags (session-taste, studio-reflection)', () => {
    getRecentEpisodes.mockReturnValue([{ type: 'feedback', tags: ['session-taste', 'studio-reflection', 'bold contrast'] }]);
    expect(getLearnedTasteLikes()).toEqual(['bold contrast']);
  });

  it('ignores non-feedback and non-tagged episodes', () => {
    getRecentEpisodes.mockReturnValue([
      { type: 'generation', tags: ['session-taste', 'should-not-appear'] },
      { type: 'feedback', tags: ['other'] },
    ]);
    expect(getLearnedTasteLikes()).toEqual([]);
  });

  it('caps the number of likes', () => {
    getRecentEpisodes.mockReturnValue([tasteEpisode('a', 'b', 'c', 'd', 'e', 'f', 'g')]);
    expect(getLearnedTasteLikes(3)).toEqual(['a', 'b', 'c']);
  });

  it('degrades to [] when the memory read throws', () => {
    getRecentEpisodes.mockImplementation(() => { throw new Error('memory unavailable'); });
    expect(getLearnedTasteLikes()).toEqual([]);
  });
});

describe('buildLearnedTasteLine', () => {
  it('renders a single bias line from the likes', () => {
    getRecentEpisodes.mockReturnValue([tasteEpisode('restraint', 'dim highlights')]);
    expect(buildLearnedTasteLine()).toBe("Lean toward the artist's learned taste from past sessions: restraint, dim highlights.");
  });

  it('returns an empty string when there is no learned taste', () => {
    getRecentEpisodes.mockReturnValue([]);
    expect(buildLearnedTasteLine()).toBe('');
  });
});

describe('promptForCreativeDomain — taste line reaches the prompt', () => {
  it('folds the learned taste into the generation prompt while keeping the raw-code contract', () => {
    getRecentEpisodes.mockReturnValue([tasteEpisode('restraint', 'calm slow motion')]);
    const prompt = promptForCreativeDomain('a glowing shader', Domain.GLSL, false);
    expect(prompt).toContain("Lean toward the artist's learned taste from past sessions: restraint, calm slow motion.");
    expect(prompt).toContain('Return raw GLSL fragment shader code only');
  });

  it('adds no taste line when there is no learned taste', () => {
    getRecentEpisodes.mockReturnValue([]);
    const prompt = promptForCreativeDomain('a glowing shader', Domain.GLSL, false);
    expect(prompt).not.toContain('learned taste');
  });
});
