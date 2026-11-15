import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { consumeLayerPlan } from '../../scripts/quality/reference-layer-plan-consumer.mjs';

const repoRoot = join(import.meta.dirname, '../..');
const tempDirs: string[] = [];
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromiumOverride = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (existsSync(localChrome) ? localChrome : undefined);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('compose CLI layer-plan export', () => {
  it.each([1, 3, 8, 12])('executes a %i-node graph through the packed CLI', (size) => {
    const dir = mkdtempSync(join(tmpdir(), `sinter-compose-graph-${size}-`));
    tempDirs.push(dir);
    const specPath = join(dir, 'graph.json');
    const outDir = join(dir, 'output');
    const nodes = Array.from({ length: size }, (_, index) => ({
      id: `layer-${index}`, type: 'layer',
      layer: { domain: 'p5', prompt: `layer ${index}`, code: `function draw(){circle(${index},0,1);}` },
    }));
    writeFileSync(specPath, JSON.stringify({
      schema: 'sinter.composition-graph', schemaVersion: '2.0', status: 'ready', id: `graph-${size}`,
      title: `Graph ${size}`, budgets: { maxNodes: size, maxEdges: Math.max(0, size - 1), maxProviderCalls: 0 },
      nodes: [...nodes].reverse(),
      edges: nodes.slice(1).map((node, index) => ({
        id: `edge-${index}`, type: 'before', from: nodes[index].id, to: node.id,
      })),
    }));
    const run = spawnSync(process.execPath, [
      'bin/sinter', 'compose', '--spec', specPath, '--output', outDir, '--gallery', join(dir, 'gallery'),
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: dir, SINTER_COMPOSITE_GATE: '0' } });
    expect(run.status, run.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(outDir, 'composition.layers.json'), 'utf8'));
    expect(plan.layers.map((layer: { sourceIndex: number }) => layer.sourceIndex))
      .toEqual(Array.from({ length: size }, (_, index) => index));
  }, 30_000);

  it('writes a consumer-readable plan beside composition.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sinter-compose-plan-'));
    tempDirs.push(dir);
    const specPath = join(dir, 'spec.json');
    const outDir = join(dir, 'output');
    writeFileSync(specPath, JSON.stringify({
      title: 'CLI Orbit',
      layers: [
        { domain: 'p5', prompt: 'base', code: 'function setup(){createCanvas(8,8);}' },
        { domain: 'shader', prompt: 'lines', code: 'void main(){gl_FragColor=vec4(1.0);}' },
      ],
    }));

    const run = spawnSync(
      process.execPath,
      ['bin/sinter', 'compose', '--spec', specPath, '--output', outDir, '--gallery', join(dir, 'gallery')],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HOME: dir, SINTER_COMPOSITE_GATE: '0' },
      },
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('Layer plan:');
    expect(readFileSync(join(outDir, 'composition.html'), 'utf8')).toContain('sinter-layer');
    const plan = JSON.parse(readFileSync(join(outDir, 'composition.layers.json'), 'utf8'));
    expect(plan.schema).toBe('sinter.layer-plan');
    expect(plan.schemaVersion).toBe('1.0');
    expect(plan.id).toBe('cli-orbit');
    expect(plan.layers.map((layer: { zIndex: number }) => layer.zIndex)).toEqual([0, 1]);
    expect(plan.layers.map((layer: { sourceIndex: number }) => layer.sourceIndex)).toEqual([0, 1]);
    expect(plan.layers.map((layer: { domain: string }) => layer.domain)).toEqual(['p5', 'glsl']);
    expect(plan.layers[1].generation.generator).toBe('shader');
    expect(plan.layers[0].artifact.path).toBe('layers/layer-0-p5.html');
    expect(plan.layers[0].artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(outDir, plan.layers[0].artifact.path), 'utf8')).toContain('createCanvas');
  }, 30_000);

  it('proves alpha export and regenerates one layer without changing its sibling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sinter-compose-regen-'));
    tempDirs.push(dir);
    const specPath = join(dir, 'spec.json');
    const outDir = join(dir, 'output');
    const run = (extra: string[]) => spawnSync(process.execPath, [
      'bin/sinter', 'compose', '--spec', specPath, '--output', outDir,
      '--gallery', join(dir, 'gallery'), ...extra,
    ], {
      cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env,
        HOME: dir,
        SINTER_COMPOSITE_GATE: '0',
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chromiumOverride,
      },
    });
    writeFileSync(specPath, JSON.stringify({ title: 'Selective', layers: [
      { domain: 'p5', prompt: 'base', code: 'function setup(){createCanvas(8,8);}' },
      {
        domain: 'p5',
        prompt: 'foreground',
        code: 'function setup(){createCanvas(64,64);clear();fill(255);rect(20,20,24,24);}',
      },
    ] }));
    const initial = run(['--export-layer', '1']);
    expect(initial.status, initial.stderr).toBe(0);
    const before = JSON.parse(readFileSync(join(outDir, 'composition.layers.json'), 'utf8'));
    const siblingPath = join(outDir, before.layers[1].artifact.path);
    const siblingBytes = readFileSync(siblingPath, 'utf8');
    const pngBytes = readFileSync(join(outDir, 'layer-1.png'));
    const oldTargetBytes = readFileSync(join(outDir, before.layers[0].artifact.path), 'utf8');
    const { data, info } = await sharp(pngBytes).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = Array.from(
      { length: info.width * info.height },
      (_, index) => data[(index * info.channels) + 3],
    );
    expect(alpha).toContain(0);
    expect(alpha.some(value => value > 0)).toBe(true);
    expect((await consumeLayerPlan(join(outDir, 'composition.layers.json'))).order)
      .toEqual(['layer-0-p5', 'layer-1-p5']);

    writeFileSync(specPath, JSON.stringify({ title: 'Selective', layers: [
      {
        domain: 'p5', prompt: 'new base', blendMode: 'lighten', opacity: 0.35,
        code: 'function setup(){createCanvas(8,8);background(9);}',
      },
      { domain: 'p5', prompt: 'MUST NOT REPLACE SIBLING', code: 'throw new Error("unused")' },
    ] }));
    const regenerated = run(['--regenerate-layer', 'layer-0-p5']);
    expect(regenerated.status, regenerated.stderr).toBe(0);
    const after = JSON.parse(readFileSync(join(outDir, 'composition.layers.json'), 'utf8'));
    expect(after.layers[1]).toEqual(before.layers[1]);
    expect(readFileSync(siblingPath, 'utf8')).toBe(siblingBytes);
    expect(readFileSync(join(outDir, 'layer-1.png'))).toEqual(pngBytes);
    expect(after.layers[0].id).toBe(before.layers[0].id);
    expect(after.layers[0].artifact.path).toBe(before.layers[0].artifact.path);
    expect(after.layers[0].artifact.sha256).not.toBe(before.layers[0].artifact.sha256);
    const newTargetBytes = readFileSync(join(outDir, after.layers[0].artifact.path), 'utf8');
    expect(newTargetBytes).toContain('background(9)');
    const composite = readFileSync(join(outDir, 'composition.html'), 'utf8');
    expect(composite).toContain(Buffer.from(newTargetBytes).toString('base64'));
    expect(composite).not.toContain(Buffer.from(oldTargetBytes).toString('base64'));
    expect(composite).toContain('mix-blend-mode:lighten;opacity:0.35;');
    expect((await consumeLayerPlan(join(outDir, 'composition.layers.json'))).order)
      .toEqual(['layer-0-p5', 'layer-1-p5']);
  }, 30_000);
});
