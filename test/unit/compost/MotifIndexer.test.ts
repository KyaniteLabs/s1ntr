import { describe, expect, it } from 'vitest';
import { MotifIndexer } from '../../../src/compost/MotifIndexer.js';
import type { CompostFragment } from '../../../src/compost/types.js';

function frag(id: string, domain: string, content: string): CompostFragment {
  return {
    id, source: `${id}.txt`, domain, layer: 'raw', content, tags: [],
    metadata: { fileType: 'txt', timestamp: '2026-11-14', hash: id, size: content.length, extractedAt: '2026-11-14' },
  };
}

describe('MotifIndexer.index', () => {
  it('normalises numbers and identifiers so differently named lines share one motif', () => {
    const idx = new MotifIndexer();
    const res = idx.index([frag('a', 'code', 'let alpha = 1;'), frag('b', 'code', 'let beta = 22;')]);
    expect(res.topPattern).toBe('ID ID = ID;');
    expect(res.motifs[0]).toMatchObject({ pattern: 'ID ID = ID;', frequency: 2, fragmentIds: ['a', 'b'], domains: ['code'] });
    expect(res.uniqueCount).toBe(1);
  });

  it('also indexes consecutive line pairs joined by a pipe', () => {
    const res = new MotifIndexer().index([frag('a', 'd', 'let alpha = 1;\nreturn alpha;')]);
    expect(res.motifs.map(m => m.pattern).sort()).toEqual(['ID ID = ID;', 'ID ID = ID;|ID ID;', 'ID ID;']);
  });

  it('skips lines shorter than minPatternLength, honouring a custom minimum', () => {
    expect(new MotifIndexer().index([frag('a', 'd', 'ab\nabc')]).uniqueCount).toBe(0);
    expect(new MotifIndexer({ minPatternLength: 2 }).index([frag('a', 'd', 'ab')]).uniqueCount).toBe(1);
  });

  it('stops adding new motifs at maxMotifs but still counts repeats of known ones', () => {
    const idx = new MotifIndexer({ maxMotifs: 1 });
    const res = idx.index([frag('a', 'd', 'foo bar'), frag('b', 'd', 'x = 1;'), frag('c', 'd', 'foo bar')]);
    expect(res.uniqueCount).toBe(1);
    expect(res.motifs[0]).toMatchObject({ pattern: 'ID ID', frequency: 2, fragmentIds: ['a', 'c'] });
  });

  it('returns an empty result for no fragments', () => {
    expect(new MotifIndexer().index([])).toEqual({ motifs: [], uniqueCount: 0, topPattern: null });
  });

  it('accumulates across calls and sorts by frequency', () => {
    const idx = new MotifIndexer();
    idx.index([frag('a', 'd', 'x = 1;')]);
    const res = idx.index([frag('b', 'd', 'foo bar'), frag('c', 'd', 'foo baz')]);
    expect(res.topPattern).toBe('ID ID');
    expect(res.motifs.map(m => m.frequency)).toEqual([2, 1]);
  });
});

describe('MotifIndexer queries', () => {
  const build = () => {
    const idx = new MotifIndexer();
    idx.index([
      frag('a', 'code', 'foo bar\nx = 1;'),
      frag('b', 'music', 'foo baz'),
      frag('c', 'music', 'foo baz'),
    ]);
    return idx;
  };

  it('search matches patterns either way round, most frequent first, with a limit', () => {
    const idx = build();
    expect(idx.search('ID ID').map(m => m.pattern)).toEqual(['ID ID', 'ID ID|ID = ID;']);
    expect(idx.search('id id', 1)).toHaveLength(1);
    expect(idx.search('zzz')).toEqual([]);
  });

  it('getCrossDomainMotifs returns only motifs seen in two or more domains', () => {
    const cross = build().getCrossDomainMotifs();
    expect(cross).toHaveLength(1);
    expect(cross[0]).toMatchObject({ pattern: 'ID ID', frequency: 3, domains: ['code', 'music'] });
  });

  it('classifies motifs from the raw line: failure, structural, or success', () => {
    const res = new MotifIndexer().index([frag('a', 'd', 'catch (error) {\nif (ready) {\nlet total = 5;')]);
    const kinds = Object.fromEntries(res.motifs.map(m => [m.pattern, m.kind]));
    expect(kinds['ID (ID) {']).toBe('failure');
    expect(kinds['ID ID = ID;']).toBe('success');
    expect(kinds['ID (ID) {|ID (ID) {']).toBe('failure');
  });

  it('getFailurePatterns returns failure motifs ordered by frequency', () => {
    const idx = new MotifIndexer();
    idx.index([
      frag('a', 'code', 'catch (err) {\nthrow new Error(x);'),
      frag('b', 'code', 'catch (err2) {\nlet value = 1;'),
    ]);
    const failures = idx.getFailurePatterns();
    expect(failures[0]).toMatchObject({ pattern: 'ID (ID) {', kind: 'failure', frequency: 2, fragmentIds: ['a', 'b'] });
    expect(failures.every(m => m.kind === 'failure')).toBe(true);
    expect(failures.map(m => m.frequency)).toEqual([...failures.map(m => m.frequency)].sort((x, y) => y - x));
  });

  it('does not flag failure words that only appear inside longer words', () => {
    const idx = new MotifIndexer();
    idx.index([frag('a', 'd', 'let banana = 1;\nlet nullable = 2;')]);
    expect(idx.getFailurePatterns()).toEqual([]);
  });

  it('flags error-named identifiers such as TypeError, errors and onError as failure', () => {
    for (const line of ['throw new TypeError(msg);', 'const errors = [];', 'el.onError = handler;']) {
      expect(new MotifIndexer().index([frag('a', 'd', line)]).motifs[0].kind).toBe('failure');
    }
  });

  it('marks control flow structural', () => {
    expect(new MotifIndexer().index([frag('a', 'd', 'for (const x of xs) {')]).motifs[0].kind).toBe('structural');
  });

  it('clear empties the index', () => {
    const idx = build();
    idx.clear();
    expect(idx.search('id')).toEqual([]);
    expect(idx.getCrossDomainMotifs()).toEqual([]);
  });
});
