import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EXCLUDED_MEDIUMS, MEDIUM_LABELS, MEDIUM_NAME_ALIASES, PUBLIC_MEDIUMS, mediumCountWord, TAGLINE, mediumLabel, resolveMediumName,
} from '../../../src/types/mediumNames.js';
import { Domain, normalizeDomain, canonicalDomainId, legacyDomainId } from '../../../src/types/domains.js';

describe('medium names: one table', () => {
  it('public names resolve silently to the stored id, in any case', () => {
    const seen: string[] = [];
    for (const [name, id] of Object.entries(MEDIUM_NAME_ALIASES)) {
      expect(canonicalDomainId(name.toUpperCase(), (f) => seen.push(f))).toBe(id);
      expect(legacyDomainId(name)).toBe(id);
    }
    expect(seen).toEqual([]);
  });

  it('every old id and synonym still resolves exactly as before', () => {
    expect(normalizeDomain('glsl')).toBe(Domain.GLSL);
    expect(normalizeDomain('webgl')).toBe(Domain.WEBGL);
    expect(normalizeDomain('fragment')).toBe(Domain.GLSL);
    for (const id of ['html', 'textgen', 'nbe', 'custom']) expect(normalizeDomain(id)).toBe(id);
    expect(normalizeDomain('meta')).toBe(Domain.CUSTOM);
    expect(canonicalDomainId('html')).toBe('html');
  });

  it('new names normalise to the registered domain', () => {
    expect(normalizeDomain('webpage')).toBe(Domain.HTML);
    expect(normalizeDomain('concrete-poetry')).toBe(Domain.TEXTGEN);
    expect(normalizeDomain('poetry')).toBe(Domain.TEXTGEN);
    expect(normalizeDomain('fluid')).toBe(Domain.NBE);
    expect(normalizeDomain('invented')).toBe(Domain.CUSTOM);
    expect(normalizeDomain('not-a-medium')).toBe(Domain.UNKNOWN);
  });

  it('labels: shader ids share one label; no "neural"; unknown falls back to the id', () => {
    for (const id of ['shader', 'glsl', 'webgl', 'fragment']) expect(mediumLabel(id)).toBe('shader');
    expect(mediumLabel('nbe')).toBe('fluid light simulation');
    expect(mediumLabel('fluid')).toBe('fluid light simulation');
    expect(mediumLabel('custom')).toBe('invented medium');
    expect(mediumLabel('meta')).toBe('invented medium');
    expect(mediumLabel('html')).toBe('webpage');
    expect(mediumLabel('zzz')).toBe('zzz');
    expect(resolveMediumName('zzz')).toBe('zzz');
    expect(Object.values(MEDIUM_LABELS).join(' ')).not.toMatch(/neural/i);
  });

  it('bin/sinter help tagline equals the table tagline', () => {
    const bin = readFileSync(new URL('../../../bin/sinter', import.meta.url), 'utf8');
    expect(bin).toContain(`const TAGLINE = '${TAGLINE}';`);
  });

  it('public mediums: one list, labelled, none excluded, count derived', () => {
    expect(PUBLIC_MEDIUMS).toHaveLength(15);
    expect(mediumCountWord()).toBe('fifteen');
    expect(new Set(PUBLIC_MEDIUMS).size).toBe(PUBLIC_MEDIUMS.length);
    for (const id of PUBLIC_MEDIUMS) {
      expect(MEDIUM_LABELS[id]).toMatch(/\S/);
      expect(EXCLUDED_MEDIUMS[id]).toBeUndefined();
    }
    // every excluded id says why, and revideo/hyperframes are gone from the public list
    for (const why of Object.values(EXCLUDED_MEDIUMS)) expect(why.length).toBeGreaterThan(3);
    expect(PUBLIC_MEDIUMS).not.toContain('revideo');
    expect(PUBLIC_MEDIUMS).not.toContain('hyperframes');
  });
});
