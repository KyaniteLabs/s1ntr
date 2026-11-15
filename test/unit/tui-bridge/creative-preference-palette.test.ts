import { describe, expect, it } from 'vitest';
import { buildCreativePreferenceLines } from '../../../src/tui-bridge/CreativeIntentHelpers.js';

/**
 * A chosen palette must reach the generation prompt LITERALLY. The inference
 * path maps recognized colour words to canned hints and never echoes the user's
 * exact palette string, so a value like "teal/rust" would otherwise be dropped.
 */
describe('buildCreativePreferenceLines — literal palette', () => {
  it('emits a literal "Preferred palette: <value>" line for a chosen palette', () => {
    const lines = buildCreativePreferenceLines('a slow wave', 'p5', {
      creativePreferences: { palette: 'teal/rust' },
    });
    expect(lines.some(line => line.includes('Preferred palette: teal/rust'))).toBe(true);
  });

  it('preserves an exact palette string the colour-word inference would not echo', () => {
    const lines = buildCreativePreferenceLines('a city at dusk', 'three', {
      creativePreferences: { palette: 'oxblood and brass, muted' },
    });
    expect(lines.join('\n')).toContain('Preferred palette: oxblood and brass, muted');
  });

  it('adds no palette line when none is set', () => {
    const lines = buildCreativePreferenceLines('a quiet forest', 'p5', { creativePreferences: {} });
    expect(lines.join('\n')).not.toContain('Preferred palette');
  });

  it('trims whitespace and ignores an all-whitespace palette', () => {
    const present = buildCreativePreferenceLines('x', 'p5', { creativePreferences: { palette: '  amber glow  ' } });
    expect(present.join('\n')).toContain('Preferred palette: amber glow');
    const blank = buildCreativePreferenceLines('x', 'p5', { creativePreferences: { palette: '   ' } });
    expect(blank.join('\n')).not.toContain('Preferred palette');
  });
});
