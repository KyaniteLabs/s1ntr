import { describe, it, expect } from 'vitest';
import { Domain, isValidDomain, normalizeDomain, canonicalDomainId, REMOVED_ART_DOMAIN_ALIASES, legacyDomainId, VIDEO_DOMAINS } from '../../src/types/domains.js';
import { generatorRegistry } from '../../src/generators/GeneratorRegistry.js';
import { registerAllGenerators } from '../../src/generators/registerGenerators.js';
import { inferCreativeDomain, buildCreativeDomainPlan } from '../../src/tui-bridge/CreativeDomainRouting.js';
import { entryNameForDomain } from '../../src/core/GenerationOrchestrator.js';
import { isLiminalProductionDomain } from '../../src/runtime-core/LiminalProductionEffects.js';

// Simon 2026-11-19: hyperframes is a code-defined video timeline (KinoCut territory), not an art domain.
describe('hyperframes is not a generatable domain', () => {
  it('has no HYPERFRAMES enum member', () => {
    expect(Object.keys(Domain)).not.toContain('HYPERFRAMES');
    expect(isValidDomain('hyperframes')).toBe(false);
    expect(VIDEO_DOMAINS).toEqual([]);
    expect(isLiminalProductionDomain('hyperframes')).toBe(false);
  });
  it('old stored runs load as custom', () => {
    expect(REMOVED_ART_DOMAIN_ALIASES.hyperframes).toBe(Domain.CUSTOM);
    expect(normalizeDomain('hyperframes')).toBe(Domain.CUSTOM);
    expect(legacyDomainId('HyperFrames')).toBe('custom');
    expect(canonicalDomainId('hyperframes')).toBe('hyperframes'); // engine id untouched
    expect(entryNameForDomain('hyperframes')).toBe('custom');
  });
  it('registers no hyperframes generator', async () => {
    await registerAllGenerators();
    expect(generatorRegistry.hasDomain('hyperframes')).toBe(false);
  });
  it('HyperFrames prompts no longer route to a hyperframes domain', () => {
    for (const p of ['Create a HyperFrames promo slideshow with image clips and GSAP timeline.', 'a title card with captions']) {
      expect(inferCreativeDomain(p) as string).not.toBe('hyperframes');
      expect(buildCreativeDomainPlan(p).map(String)).not.toContain('hyperframes');
    }
  });
  it('keeps the HyperFramesRenderer export engine', async () => {
    const mod = await import('../../src/render/HyperFramesRenderer.js');
    expect(mod.HyperFramesRenderer).toBeTypeOf('function');
  });
});
