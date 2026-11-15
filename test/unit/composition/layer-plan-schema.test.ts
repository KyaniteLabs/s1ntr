import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Rule = {
  const?: string;
  enum?: string[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  properties?: Record<string, Rule>;
};

type Layer = {
  id: string;
  name: string;
  sourceIndex: number;
  domain: string;
  role: string;
  opacity: number;
  zIndex: number;
  bounds: { x: number; y: number; width: number; height: number };
  alpha: { mode: string };
  artifact: { path: string; mimeType: string; sha256: string };
};

type Manifest = {
  schema: string;
  schemaVersion: string;
  id: string;
  canvas: { width: number; height: number; backgroundColor: string };
  layers: Layer[];
};

const root = join(import.meta.dirname, '../../..');
const schema = JSON.parse(readFileSync(
  join(root, 'docs/schemas/composition-layer-plan-v1.schema.json'),
  'utf8',
)) as {
  properties: { schema: Rule; schemaVersion: Rule; id: Rule };
  $defs: { layer: { required: string[]; properties: Record<string, Rule> } };
};
const fixture = JSON.parse(readFileSync(
  join(root, 'test/fixtures/composition/layer-plan-v1.golden.json'),
  'utf8',
)) as Manifest;

function validLayer(layer: Layer): boolean {
  const rules = schema.$defs.layer.properties;
  return schema.$defs.layer.required.every(key => key in layer)
    && new RegExp(rules.id.pattern!).test(layer.id)
    && layer.name.length > 0
    && Number.isInteger(layer.sourceIndex) && layer.sourceIndex >= rules.sourceIndex.minimum!
    && rules.domain.enum!.includes(layer.domain)
    && rules.role.enum!.includes(layer.role)
    && Number.isInteger(layer.zIndex)
    && Object.values(layer.bounds).every(value => value >= 0 && value <= 1)
    && rules.alpha.properties!.mode.enum!.includes(layer.alpha.mode)
    && layer.opacity >= rules.opacity.minimum!
    && layer.opacity <= rules.opacity.maximum!
    && (layer.alpha.mode !== 'opaque' || layer.role === 'background');
}

describe('composition layer manifest v1 schema', () => {
  it('validates the golden fixture and stable identity fields', () => {
    expect(fixture.schema).toBe(schema.properties.schema.const);
    expect(fixture.schemaVersion).toBe(schema.properties.schemaVersion.const);
    expect(new RegExp(schema.properties.id.pattern!).test(fixture.id)).toBe(true);
    expect(fixture.canvas).toEqual({ width: 800, height: 600, backgroundColor: '#05070f' });
    expect(fixture.layers.every(validLayer)).toBe(true);
    expect(new Set(fixture.layers.map(layer => layer.id)).size).toBe(fixture.layers.length);
    expect(new Set(fixture.layers.map(layer => layer.sourceIndex)).size).toBe(fixture.layers.length);
    for (const layer of fixture.layers) {
      const artifact = layer.artifact;
      const bytes = readFileSync(join(root, 'test/fixtures/composition', artifact.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    }
  });

  it('rejects invalid IDs, bounds, domains, and alpha policy', () => {
    const valid = fixture.layers[1]!;
    expect(validLayer({ ...valid, id: 'Orbit Lines' })).toBe(false);
    expect(validLayer({ ...valid, domain: 'unknown' })).toBe(false);
    expect(validLayer({ ...valid, bounds: { ...valid.bounds, width: 1.1 } })).toBe(false);
    expect(validLayer({ ...valid, opacity: 1.1 })).toBe(false);
    expect(validLayer({ ...valid, alpha: { mode: 'opaque' } })).toBe(false);
  });

  it('constrains additive artifact paths and hashes for regeneration bundles', () => {
    const artifact = schema.$defs.layer.properties.artifact.properties!;
    const alpha = schema.$defs.layer.properties.alpha.properties!;
    expect(alpha.mode.enum).toEqual(['embedded', 'matte', 'opaque']);
    expect(new RegExp(artifact.path.pattern!).test('layers/layer-1.html')).toBe(true);
    expect(new RegExp(artifact.path.pattern!).test('../outside.html')).toBe(false);
    expect(new RegExp(artifact.path.pattern!).test('/absolute.html')).toBe(false);
    expect(new RegExp(artifact.path.pattern!).test('https://example.test/layer.html')).toBe(false);
    expect(new RegExp(artifact.sha256.pattern!).test('a'.repeat(64))).toBe(true);
    expect(new RegExp(artifact.sha256.pattern!).test('not-a-hash')).toBe(false);
  });
});
