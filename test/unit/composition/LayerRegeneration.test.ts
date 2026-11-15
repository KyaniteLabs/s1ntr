import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ register: vi.fn(async () => {}), generate: vi.fn(async () => 'must not generate') }));
vi.mock('../../../src/generators/registerGenerators.js', () => ({ registerAllGenerators: calls.register }));
vi.mock('../../../src/generators/GeneratorRegistry.js', () => ({
  generatorRegistry: { getAll: () => [{ name: 'tone', generate: calls.generate }, { name: 'strudel', generate: calls.generate }] },
}));
import { regenerateLayerBundle } from '../../../src/composition/LayerRegeneration.js';
import { compileCreativeThesis, creativeThesisIdentity } from '../../../src/creative-intelligence/CreativeIntelligence.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('targeted layer regeneration guardrails', () => {
  it.each(['music', 'tone', 'strudel'] as const)(
    'makes zero registration or generator calls for an unsupported %s bundle override',
    async (domain) => {
      calls.register.mockClear(); calls.generate.mockClear();
      const dir = await mkdtemp(join(tmpdir(), `sinter-regen-${domain}-`));
      tempDirs.push(dir);
      const artifact = '<html>audio</html>';
      const thesis = compileCreativeThesis('Music with expressive dynamics.', { requestedPrinciples: ['music-dynamics'] });
      const identity = creativeThesisIdentity(thesis);
      await writeFile(join(dir, 'layer.html'), artifact);
      await writeFile(join(dir, 'composition.html'), '<iframe data-layer-index="0" src="old"></iframe>');
      await writeFile(join(dir, 'composition.layers.json'), JSON.stringify({
        schema: 'sinter.layer-plan', schemaVersion: '1.0', id: 'audio', title: 'Audio',
        canvas: { width: 800, height: 600, backgroundColor: '#000' },
        provenance: { generatedAt: '2026-07-26T00:00:00.000Z', sinterVersion: '2.2.0',
          creativeThesis: thesis, creativeIntelligence: identity },
        layers: [{ id: `layer-0-${domain}`, name: 'audio', sourceIndex: 0, domain, role: 'audio',
          blendMode: 'normal', opacity: 0, zIndex: 0, bounds: { x: 0, y: 0, width: 1, height: 1 },
          alpha: { mode: 'embedded' }, artifact: { path: 'layer.html', mimeType: 'text/html', sha256: createHash('sha256').update(artifact).digest('hex') },
          generation: { prompt: 'expressive dynamics', generator: domain, generatedAt: '2026-07-26T00:00:00.000Z' } }],
      }));

      await expect(regenerateLayerBundle(join(dir, 'composition.layers.json'), `layer-0-${domain}`,
        { domain, prompt: 'Use Sample Manipulation for this music artifact.' }))
        .rejects.toThrow(`Unsupported music/sound layer prompt for ${domain}`);
      expect(calls.register).not.toHaveBeenCalled();
      expect(calls.generate).not.toHaveBeenCalled();
    },
  );

  it('rejects a governed plan whose recorded thesis identity was deleted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sinter-regen-missing-identity-'));
    tempDirs.push(dir);
    const artifact = '<html>governed</html>';
    await writeFile(join(dir, 'layer.html'), artifact);
    await writeFile(join(dir, 'composition.html'), '<iframe data-layer-index="0" src="old"></iframe>');
    await writeFile(join(dir, 'composition.layers.json'), JSON.stringify({
      schema: 'sinter.layer-plan', schemaVersion: '1.0', id: 'governed', title: 'Governed',
      canvas: { width: 800, height: 600, backgroundColor: '#000' },
      provenance: {
        generatedAt: '2026-07-26T00:00:00.000Z', sinterVersion: '2.2.0',
        creativeThesis: compileCreativeThesis('A restrained field opens into luminous release.'),
      },
      layers: [{ id: 'layer-0-p5', name: 'base', sourceIndex: 0, domain: 'p5', role: 'background',
        blendMode: 'normal', opacity: 1, zIndex: 0, bounds: { x: 0, y: 0, width: 1, height: 1 },
        alpha: { mode: 'opaque' }, artifact: { path: 'layer.html', mimeType: 'text/html', sha256: createHash('sha256').update(artifact).digest('hex') },
        generation: { prompt: 'base', generator: 'p5', generatedAt: '2026-07-26T00:00:00.000Z' } }],
    }));

    await expect(regenerateLayerBundle(join(dir, 'composition.layers.json'), 'layer-0-p5'))
      .rejects.toThrow(/identity mismatch|re-export/i);
  });

  it('keeps legacy plans readable but blocks ungoverned regeneration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sinter-regen-legacy-thesis-'));
    tempDirs.push(dir);
    const artifact = '<html>legacy</html>';
    await writeFile(join(dir, 'layer.html'), artifact);
    await writeFile(join(dir, 'composition.html'), '<iframe data-layer-index="0" src="old"></iframe>');
    await writeFile(join(dir, 'composition.layers.json'), JSON.stringify({
      schema: 'sinter.layer-plan', schemaVersion: '1.0', id: 'legacy', title: 'Legacy',
      canvas: { width: 800, height: 600, backgroundColor: '#000' },
      provenance: { generatedAt: '2026-07-26T00:00:00.000Z', sinterVersion: '2.2.0' },
      layers: [{ id: 'layer-0-p5', name: 'base', sourceIndex: 0, domain: 'p5', role: 'background',
        blendMode: 'normal', opacity: 1, zIndex: 0, bounds: { x: 0, y: 0, width: 1, height: 1 },
        alpha: { mode: 'opaque' }, artifact: { path: 'layer.html', mimeType: 'text/html', sha256: createHash('sha256').update(artifact).digest('hex') },
        generation: { prompt: 'base', generator: 'p5', generatedAt: '2026-07-26T00:00:00.000Z' } }],
    }));
    await expect(regenerateLayerBundle(join(dir, 'composition.layers.json'), 'layer-0-p5'))
      .rejects.toThrow(/legacy|thesis|re-export/i);
  });

  it('requires short-lived layer-manifest bundles to be re-exported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sinter-regen-legacy-'));
    tempDirs.push(dir);
    const planPath = join(dir, 'composition.layers.json');
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 'sinter.layer-manifest/v1', compositionId: 'legacy', layers: [],
    }));

    await expect(regenerateLayerBundle(planPath, 'layer-0-p5'))
      .rejects.toThrow(/re-export the bundle/);
  });

  it('rejects a stale sibling hash before generating or writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sinter-regen-guard-'));
    tempDirs.push(dir);
    const artifactPath = join(dir, 'layer.html');
    const original = '<html>original</html>';
    await writeFile(artifactPath, original);
    await writeFile(join(dir, 'composition.html'), '<iframe data-layer-index="0" src="old"></iframe>');
    await writeFile(join(dir, 'composition.layers.json'), JSON.stringify({
      schema: 'sinter.layer-plan',
      schemaVersion: '1.0',
      id: 'guard',
      title: 'Guard',
      canvas: { width: 800, height: 600, backgroundColor: '#000' },
      provenance: { generatedAt: '2026-07-26T00:00:00.000Z', sinterVersion: '2.2.0' },
      layers: [{
        id: 'layer-0-p5', name: 'base', sourceIndex: 0, domain: 'p5',
        role: 'background', blendMode: 'normal', opacity: 1, zIndex: 0,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        alpha: { mode: 'opaque' },
        artifact: { path: 'layer.html', mimeType: 'text/html', sha256: '0'.repeat(64) },
        generation: {
          prompt: 'base', generator: 'p5', generatedAt: '2026-07-26T00:00:00.000Z',
        },
      }],
    }));

    await expect(regenerateLayerBundle(
      join(dir, 'composition.layers.json'),
      'layer-0-p5',
      { domain: 'p5', prompt: 'new', code: 'new code' },
    )).rejects.toThrow(/hash mismatch/);
    expect(await readFile(artifactPath, 'utf8')).toBe(original);
  });

  it('rejects artifact traversal before reading outside the bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sinter-regen-traversal-'));
    tempDirs.push(dir);
    const planPath = join(dir, 'composition.layers.json');
    await writeFile(planPath, JSON.stringify({
      schema: 'sinter.layer-plan',
      schemaVersion: '1.0',
      id: 'guard',
      title: 'Guard',
      canvas: { width: 800, height: 600, backgroundColor: '#000' },
      provenance: { generatedAt: '2026-07-26T00:00:00.000Z', sinterVersion: '2.2.0' },
      layers: [{
        id: 'layer-0-p5', name: 'base', sourceIndex: 0, domain: 'p5',
        role: 'background', blendMode: 'normal', opacity: 1, zIndex: 0,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        alpha: { mode: 'opaque' },
        artifact: { path: '../outside.html', mimeType: 'text/html', sha256: '0'.repeat(64) },
        generation: {
          prompt: 'base', generator: 'p5', generatedAt: '2026-07-26T00:00:00.000Z',
        },
      }],
    }));

    await expect(regenerateLayerBundle(
      planPath,
      'layer-0-p5',
      { domain: 'p5', prompt: 'new', code: 'new code' },
    )).rejects.toThrow(/escapes bundle/);
  });
});
