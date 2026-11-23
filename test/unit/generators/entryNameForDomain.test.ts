import { describe, expect, it } from 'vitest';
import { entryNameForDomain } from '../../../src/core/GenerationOrchestrator.js';
import { registerAllGenerators } from '../../../src/generators/registerGenerators.js';
import { generatorRegistry } from '../../../src/generators/GeneratorRegistry.js';
import { Domain } from '../../../src/types/domains.js';

describe('entryNameForDomain', () => {
  it('routes an explicit textgen request to the registered textgen generator', () => {
    expect(entryNameForDomain('textgen')).toBe('textgen');
  });

  it('maps every art domain that has a registered generator to that generator', async () => {
    await registerAllGenerators();
    const names = new Set(generatorRegistry.getAll().map((entry) => entry.name));
    const artDomains = Object.values(Domain).filter((d) =>
      !['', 'unknown', 'generic', 'music', 'code', 'webgl', 'glsl'].includes(d));
    for (const domain of artDomains) {
      const entry = entryNameForDomain(domain);
      expect(typeof entry, `domain ${domain}`).toBe('string');
      expect(names.has(entry as string), `${domain} -> ${entry}`).toBe(true);
    }
    expect(entryNameForDomain('glsl')).toBe('shader');
    expect(entryNameForDomain('webgl')).toBe('shader');
  });
});
