import { describe, expect, it } from 'vitest';
import { revideoConfidence } from '../../../src/generators/revideo/revideoConfidence.js';

describe('revideoConfidence', () => {
  it('scores an explicit revideo request at 0.95', () => {
    expect(revideoConfidence('Make a Revideo title card')).toBe(0.95);
  });

  it('scores an explicit remotion request at 0.55', () => {
    expect(revideoConfidence('a remotion composition of waves')).toBe(0.55);
  });

  it('scores generic video wording at 0.8', () => {
    expect(revideoConfidence('an intro video for a podcast')).toBe(0.8);
    expect(revideoConfidence('motion graphics for a logo')).toBe(0.8);
  });

  it('returns 0 for prompts with no video intent', () => {
    expect(revideoConfidence('a static poster of mountains')).toBe(0);
    expect(revideoConfidence('')).toBe(0);
  });

  it('returns 0 when the user explicitly rules the tool out', () => {
    expect(revideoConfidence('video, but do not use revideo')).toBe(0);
    expect(revideoConfidence("animation, don't use remotion")).toBe(0);
    expect(revideoConfidence('never revideo please')).toBe(0);
  });
});
