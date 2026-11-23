import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exemplarSection, EXEMPLAR_FILE_ENV } from '../../../src/learning/ExemplarContext.js';

const file = (body: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'exemplars-'));
  const path = join(dir, 'e.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
};

describe('exemplar retrieval arm', () => {
  it('is empty unless the arm is configured', () => {
    expect(exemplarSection('html', {})).toBe('');
  });
  it('injects only domain-matched exemplars with score and like provenance, at most three', () => {
    const exemplars = [1, 2, 3, 4].map(i => ({ domain: 'html', score: 0.9 - i / 100, liked: i === 1, code: `<html>${i}</html>` }))
      .concat([{ domain: 'svg', score: 0.99, liked: false, code: '<svg/>' }]);
    const text = exemplarSection('html', { [EXEMPLAR_FILE_ENV]: file({ exemplars }) });
    expect(text).toContain('liked by the owner');
    expect(text).toContain('<html>3</html>');
    expect(text).not.toContain('<html>4</html>');
    expect(text).not.toContain('<svg/>');
  });
  it('throws when configured but broken, so an arm never silently becomes no teaching', () => {
    expect(() => exemplarSection('html', { [EXEMPLAR_FILE_ENV]: '/nonexistent.json' })).toThrow('EXEMPLARS_FILE_UNREADABLE');
    expect(() => exemplarSection('html', { [EXEMPLAR_FILE_ENV]: file('{}') })).toThrow('EXEMPLARS_FILE_INVALID');
    expect(() => exemplarSection('svg', { [EXEMPLAR_FILE_ENV]: file({ exemplars: [] }) })).toThrow('EXEMPLARS_NONE_FOR_DOMAIN');
  });
});
