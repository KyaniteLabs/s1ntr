import { describe, expect, it } from 'vitest';
import { LIBRARY_CARDS, libraryCardFor } from '../../../src/creative-vocabulary/LibraryCards.js';

describe('LIBRARY_CARDS', () => {
  it('has 24 cards with unique, trimmed ids', () => {
    const ids = LIBRARY_CARDS.map(c => c.id);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    expect(ids.filter(id => id !== id.trim() || id === '')).toEqual([]);
  });

  it('gives every card a summary, an access line and exactly 5 non-empty calls', () => {
    const bad = LIBRARY_CARDS.filter(c =>
      c.summary.trim() === '' || c.access.trim() === ''
      || c.highPayoffCalls.length !== 5 || c.highPayoffCalls.some(call => call.trim() === ''))
      .map(c => c.id);
    expect(bad).toEqual([]);
  });

  it('keeps the vocabulary the prompt organs rely on', () => {
    expect(LIBRARY_CARDS.map(c => c.id)).toEqual(expect.arrayContaining(['culori', 'tonaljs', 'matter-js', 'paper', 'roughjs']));
  });

  it('holospot card carries the kit\'s composition rules, compact (the card rides in every three prompt)', () => {
    const card = libraryCardFor('holospot');
    expect(card?.rules?.length ?? 0).toBeGreaterThanOrEqual(9);
    const joined = card!.rules!.join(' | ');
    for (const marker of [
      'hero', 'replace mode', 'background: "black"', 'shotCamera', 'shotRotation',
      'studio.preset', 'three.js lights do nothing', 'slow', 'never also', 'renderer.render',
      'iridescence', 'sizeMm',
    ]) {
      expect(joined).toContain(marker);
    }
    // the real lighting call and export names (v7 invented `import { studio }`)
    expect(joined).toContain('holo.setScene({"studio.preset"');
    expect(joined).toMatch(/no `?studio`? export/i);
    // compact: every rule fits in one prompt line
    expect(card!.rules!.every(r => r.length <= 160)).toBe(true);
  });
});

describe('libraryCardFor', () => {
  it('returns the card for a known id', () => {
    expect(libraryCardFor('matter-js')).toMatchObject({
      id: 'matter-js', access: 'global `Matter` (script)',
    });
    expect(libraryCardFor('matter-js')!.highPayoffCalls[0]).toBe('Matter.Engine.create()');
  });

  it('returns undefined for an unknown or empty id', () => {
    expect(libraryCardFor('nope')).toBeUndefined();
    expect(libraryCardFor('')).toBeUndefined();
  });

  it('returns the same object as the exported list', () => {
    expect(libraryCardFor('culori')).toBe(LIBRARY_CARDS.find(c => c.id === 'culori'));
  });
});
