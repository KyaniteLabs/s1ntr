import { describe, it, expect } from 'vitest';
import {
  Domain, isValidDomain, normalizeDomain, canonicalDomainId, VIDEO_DOMAINS, REMOVED_ART_DOMAIN_ALIASES, legacyDomainId,
} from '../../src/types/domains.js';
import { generatorRegistry } from '../../src/generators/GeneratorRegistry.js';
import { registerAllGenerators } from '../../src/generators/registerGenerators.js';
import { inferCreativeDomain, buildCreativeDomainPlan } from '../../src/tui-bridge/CreativeDomainRouting.js';
import { entryNameForDomain } from '../../src/core/GenerationOrchestrator.js';

// Simon 2026-11-19: revideo is a KinoCut video-assembly export engine, not an S1NTR art domain.
describe('revideo is not a generatable domain', () => {
  it('has no REVIDEO enum member and is not a valid domain', () => {
    expect(Object.keys(Domain)).not.toContain('REVIDEO');
    expect(Object.values(Domain) as string[]).not.toContain('revideo');
    expect(isValidDomain('revideo')).toBe(false);
    expect(VIDEO_DOMAINS).toEqual([]);
  });

  it('old stored runs with domain "revideo" load as custom instead of crashing', () => {
    expect(REMOVED_ART_DOMAIN_ALIASES.revideo).toBe(Domain.CUSTOM);
    expect(normalizeDomain('revideo')).toBe(Domain.CUSTOM);
    expect(normalizeDomain('Revideo ')).toBe(Domain.CUSTOM);
    expect(legacyDomainId('revideo')).toBe('custom');
    // the engine id itself is untouched, so validators/renderers still see 'revideo'
    expect(canonicalDomainId('revideo')).toBe('revideo');
    expect(entryNameForDomain('revideo')).toBe('custom');
  });

  it('has no revideo generator registered', async () => {
    await registerAllGenerators();
    expect(generatorRegistry.hasDomain('revideo')).toBe(false);
  });

  it('prompts that mention Revideo never route to a revideo domain', () => {
    const prompt = 'Create a Revideo composition: a 4-second title card.';
    expect(inferCreativeDomain(prompt) as string).not.toBe('revideo');
    expect(buildCreativeDomainPlan(prompt).map(String)).not.toContain('revideo');
  });

  it('keeps the RevideoRenderer export engine', async () => {
    const mod = await import('../../src/render/RevideoRenderer.js');
    expect(mod.RevideoRenderer).toBeTypeOf('function');
  });
});
