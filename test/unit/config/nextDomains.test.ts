import { describe, expect, it } from 'vitest';
import {
  NEXT_DOMAINS_ENV, NEXT_DOMAIN_IDS, assertNextDomainEnabled, isNextDomainId, nextDomainActive,
} from '../../../src/config/nextDomains.js';

describe('next-release domain flag', () => {
  it('is off by default: no domain is active with an empty environment', () => {
    for (const id of NEXT_DOMAIN_IDS) expect(nextDomainActive(id, {})).toBe(false);
  });

  it('"1" turns every next domain on, a comma list only the named ones', () => {
    expect(nextDomainActive('datamosh', { [NEXT_DOMAINS_ENV]: '1' })).toBe(true);
    expect(nextDomainActive('datamosh', { [NEXT_DOMAINS_ENV]: 'datamosh' })).toBe(true);
    expect(nextDomainActive('datamosh', { [NEXT_DOMAINS_ENV]: 'ambient' })).toBe(false);
    expect(nextDomainActive('datamosh', { [NEXT_DOMAINS_ENV]: '0' })).toBe(false);
  });

  it('only knows the shipped ids, and never claims a release domain', () => {
    expect(isNextDomainId('datamosh')).toBe(true);
    expect(isNextDomainId('p5')).toBe(false);
    expect(isNextDomainId('blender')).toBe(false);
  });

  it('assertNextDomainEnabled throws a message naming the env var when off', () => {
    expect(() => assertNextDomainEnabled('datamosh', {})).toThrow(/SINTER_NEXT_DOMAINS/);
    expect(() => assertNextDomainEnabled('datamosh', { [NEXT_DOMAINS_ENV]: '1' })).not.toThrow();
  });
});
