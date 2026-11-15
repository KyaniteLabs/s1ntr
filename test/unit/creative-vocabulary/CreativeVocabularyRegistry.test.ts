import { describe, expect, it } from 'vitest';
import {
  buildCreativePromptHints,
  collectCreativeQuestions,
  getCreativeVocabularyEngine,
  inferCreativePreferences,
  listCreativeVocabularyEngines,
} from '../../../src/creative-vocabulary/CreativeVocabularyRegistry.js';

describe('CreativeVocabularyRegistry', () => {
  it('lists the five engines in fixed order', () => {
    expect(listCreativeVocabularyEngines().map(e => e.domain)).toEqual(
      ['color', 'music', 'motion', 'cinematic', 'creative-writing'],
    );
  });

  it('returns a copy so callers cannot mutate the registry', () => {
    const list = listCreativeVocabularyEngines();
    list.length = 0;
    expect(listCreativeVocabularyEngines()).toHaveLength(5);
  });

  it('looks engines up by domain', () => {
    expect(getCreativeVocabularyEngine('music')?.domain).toBe('music');
    expect(getCreativeVocabularyEngine('nope' as never)).toBeUndefined();
  });

  it('scopes questions to one engine when the context names a known domain', () => {
    const music = getCreativeVocabularyEngine('music')!;
    expect(collectCreativeQuestions({ domain: 'music' })).toEqual(music.suggestQuestions({ domain: 'music' }));
  });

  it('collects from every engine when the domain is missing or unknown', () => {
    const expected = listCreativeVocabularyEngines().flatMap(e => e.suggestQuestions(undefined)).length;
    expect(collectCreativeQuestions()).toHaveLength(expected);
    expect(collectCreativeQuestions({ domain: 'unknown' }).length).toBe(
      listCreativeVocabularyEngines().flatMap(e => e.suggestQuestions({ domain: 'unknown' })).length,
    );
  });

  it('infers a preference entry for every domain, even for text that matches nothing', () => {
    const prefs = inferCreativePreferences('zzz qqq');
    expect(Object.keys(prefs).sort()).toEqual(['cinematic', 'color', 'creative-writing', 'motion', 'music']);
    for (const value of Object.values(prefs)) expect(typeof value).toBe('object');
  });

  it('builds no hints from an empty preference map and hints only for supplied domains', () => {
    expect(buildCreativePromptHints({})).toEqual(
      listCreativeVocabularyEngines().flatMap(e => e.buildPromptHints({})),
    );
    const color = getCreativeVocabularyEngine('color')!;
    const prefs = color.inferPreferences('warm golden sunset palette');
    expect(buildCreativePromptHints({ color: prefs as Record<string, unknown> })).toEqual(
      [
        ...color.buildPromptHints(prefs),
        ...listCreativeVocabularyEngines().filter(e => e.domain !== 'color').flatMap(e => e.buildPromptHints({})),
      ],
    );
  });
});
