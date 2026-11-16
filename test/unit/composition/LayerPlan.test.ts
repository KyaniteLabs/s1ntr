import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompositionResult } from '../../../src/composition/CompositionOrchestrator.js';
import { buildLayerPlan, compositionOutcomeLines, writeLayerPlan } from '../../../src/composition/LayerPlan.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const result: CompositionResult = {
  html: '<html></html>',
  title: 'Calm Orbit',
  background: '#000',
  successCount: 3,
  creativeThesis: compileCreativeThesis('A restrained field opens into luminous release.'),
  layers: [
    {
      domain: 'p5', prompt: 'Background field', blendMode: 'normal',
      opacity: 1, codeLength: 10, generated: true, artifactHtml: '<html>base</html>',
    },
    {
      domain: 'p5', prompt: 'Failed dust', blendMode: 'screen',
      opacity: 0.7, codeLength: 0, generated: false, error: 'offline',
    },
    {
      domain: 'tone', prompt: 'Ambient bed', blendMode: 'normal',
      opacity: 1, codeLength: 10, generated: true, artifactHtml: '<html>audio</html>',
    },
    {
      domain: 'shader', prompt: 'Orbit lines', blendMode: 'screen',
      opacity: 0.8, codeLength: 10, generated: true, artifactHtml: '<html>lines</html>',
    },
  ],
};

describe('composition layer-plan export', () => {
  it('preserves source indices and rendered z-depth across failed and audio layers', () => {
    const plan = buildLayerPlan(result);
    expect(plan.schema).toBe('sinter.layer-plan');
    expect(plan.schemaVersion).toBe('1.0');
    expect(plan.id).toBe('calm-orbit');
    expect(plan.provenance.sinterVersion).toBe('2.5.0');
    expect(plan.provenance.creativeThesis?.thesisId).toBe(result.creativeThesis?.thesisId);
    expect(Number.isNaN(Date.parse(plan.provenance.generatedAt))).toBe(false);
    expect(plan.layers.map(layer => layer.sourceIndex)).toEqual([0, 2, 3]);
    expect(plan.layers.map(layer => layer.zIndex)).toEqual([0, 1, 2]);
    expect(plan.layers.map(layer => layer.id)).toEqual([
      'layer-0-p5', 'layer-2-tone', 'layer-3-shader',
    ]);
    expect(plan.layers[0]!.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(plan.layers[1]!.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(plan.layers.map(layer => layer.alpha)).toEqual([
      { mode: 'opaque' },
      { mode: 'embedded' },
      { mode: 'embedded' },
    ]);
    expect(plan.layers.map(layer => layer.domain)).toEqual(['p5', 'tone', 'glsl']);
    expect(plan.layers.map(layer => layer.generation.generator)).toEqual(['p5', 'tone', 'shader']);
  });

  it('atomically writes JSON that consumers can read back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sinter-layer-plan-'));
    tempDirs.push(dir);
    const path = join(dir, 'composition.layers.json');

    const written = await writeLayerPlan(path, result);
    const readBack = JSON.parse(await readFile(path, 'utf8'));

    expect(readBack).toEqual(written);
    expect(await readdir(dir)).toEqual(['composition.layers.json', 'layers']);
    expect(await readFile(join(dir, written.layers[0]!.artifact!.path), 'utf8'))
      .toBe('<html>base</html>');
    expect(written.layers[0]!.artifact!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not produce an invalid empty plan', () => {
    expect(() => buildLayerPlan({
      html: '', title: 'Empty', background: '#000', layers: [], successCount: 0,
    })).toThrow(/without a generated layer/);
  });

  it('always emits a schema-valid composition ID', () => {
    const plan = buildLayerPlan({ ...result, title: '123' });
    expect(plan.id).toBe('composition-123');
  });

  it('uses a stable fallback ID for a title without letters or numbers', () => {
    const plan = buildLayerPlan({ ...result, title: '---' });
    expect(plan.id).toBe('composition');
  });

  it('rejects generated layers that lack a runnable artifact', () => {
    expect(() => buildLayerPlan({
      ...result,
      layers: [{ ...result.layers[0]!, artifactHtml: undefined }],
      successCount: 1,
    })).toThrow(/missing runtime artifact/i);
  });

  it('keeps external spec opacity inside the manifest schema range', () => {
    const plan = buildLayerPlan({
      ...result,
      layers: [{ ...result.layers[0]!, opacity: 2 }],
      successCount: 1,
    });
    expect(plan.layers[0]!.opacity).toBe(1);
  });

  it('rejects a tampered canonical thesis instead of packing an unbound plan', () => {
    const tampered = structuredClone(result.creativeThesis!);
    tampered.hardFloors[0] = 'tampered floor';
    expect(() => buildLayerPlan({ ...result, creativeThesis: tampered })).toThrow(/canonical|thesis|correspondence/i);
  });
});

describe('compositionOutcomeLines', () => {
  it('reports a composition with no layers as a failure, not a green tick', () => {
    expect(compositionOutcomeLines(0, 3, '/out/composition.html')).toEqual([
      '❌ 0/3 layers composed',
      '⚠️  Saved an empty page for inspection: /out/composition.html',
    ]);
  });

  it('warns when only some layers composed and ticks when all did', () => {
    expect(compositionOutcomeLines(2, 3, '/out/c.html')).toEqual(['⚠️  2/3 layers composed', '✅ Saved: /out/c.html']);
    expect(compositionOutcomeLines(3, 3, '/out/c.html')).toEqual(['✅ 3/3 layers composed', '✅ Saved: /out/c.html']);
  });
});
