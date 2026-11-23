import { describe, it, expect } from 'vitest';
import { Domain, normalizeDomain, isValidDomain, canonicalDomainId } from '../../../src/types/domains.js';

describe('normalizeDomain', () => {
  it('returns the canonical Domain for a valid label', () => {
    expect(normalizeDomain('p5')).toBe(Domain.P5);
    expect(normalizeDomain('hydra')).toBe(Domain.HYDRA);
  });

  it('resolves the webgl synonym to WEBGL and fragment to GLSL', () => {
    expect(normalizeDomain('webgl')).toBe(Domain.WEBGL);
    expect(normalizeDomain('fragment')).toBe(Domain.GLSL);
  });

  it('recognizes the newly-canonical svg/html/textgen domains', () => {
    expect(normalizeDomain('svg')).toBe(Domain.SVG);
    expect(normalizeDomain('html')).toBe(Domain.HTML);
    expect(normalizeDomain('textgen')).toBe(Domain.TEXTGEN);
  });

  it('resolves custom, and its deprecated meta alias, to the CUSTOM catch-all domain', () => {
    expect(normalizeDomain('custom')).toBe(Domain.CUSTOM);
    expect(normalizeDomain('meta')).toBe(Domain.CUSTOM);
    expect(normalizeDomain('META')).toBe(Domain.CUSTOM);
    expect(Domain.CUSTOM).toBe('custom');
  });

  it('canonicalDomainId maps deprecated meta to custom, notifies once, and leaves other ids alone', () => {
    const seen: Array<[string, string]> = [];
    expect(canonicalDomainId('meta', (from, to) => seen.push([from, to]))).toBe('custom');
    expect(canonicalDomainId(' Meta ')).toBe('custom');
    expect(seen).toEqual([['meta', 'custom']]);
    expect(canonicalDomainId('custom', () => seen.push(['x', 'x']))).toBe('custom');
    expect(canonicalDomainId('p5')).toBe('p5');
    expect(canonicalDomainId('')).toBe('');
    expect(seen).toHaveLength(1);
  });

  it('resolves blender and its bpy synonym to the BLENDER domain', () => {
    expect(normalizeDomain('blender')).toBe(Domain.BLENDER);
    expect(normalizeDomain(' BPY ')).toBe(Domain.BLENDER);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeDomain('  P5 ')).toBe(Domain.P5);
    expect(normalizeDomain('HYDRA')).toBe(Domain.HYDRA);
  });

  it('returns UNKNOWN for unrecognized labels instead of lying', () => {
    expect(normalizeDomain('not-a-domain')).toBe(Domain.UNKNOWN);
    expect(normalizeDomain('')).toBe(Domain.UNKNOWN);
    expect(normalizeDomain(undefined)).toBe(Domain.UNKNOWN);
    expect(normalizeDomain(null)).toBe(Domain.UNKNOWN);
  });

  it('keeps tone and strudel distinct (both music, different generators)', () => {
    expect(normalizeDomain('tone')).toBe(Domain.TONE);
    expect(normalizeDomain('strudel')).toBe(Domain.STRUDEL);
    expect(Domain.TONE).not.toBe(Domain.STRUDEL);
  });

  it('svg/html/textgen are now valid canonical domains', () => {
    expect(isValidDomain('svg')).toBe(true);
    expect(isValidDomain('html')).toBe(true);
    expect(isValidDomain('textgen')).toBe(true);
  });
});
