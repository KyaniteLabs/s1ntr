import { describe, expect, it } from 'vitest';
import { LIBRARY_CARDS, libraryCardFor } from '../../../src/creative-vocabulary/LibraryCards.js';

describe('LIBRARY_CARDS', () => {
  it('has 17 cards with unique, trimmed ids', () => {
    const ids = LIBRARY_CARDS.map(c => c.id);
    expect(ids).toHaveLength(17);
    expect(new Set(ids).size).toBe(17);
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
