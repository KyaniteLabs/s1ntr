import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exportSinterRoleDatasets } from '../../../src/learning/SinterRoleDatasetExporter.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `sinter-role-export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SinterRoleDatasetExporter', () => {
  it('keeps role bundles separate and recommends evaluator/harness before generator', async () => {
    const root = makeTempDir();
    const repoRoot = join(root, 'repo');
    const sinterHome = join(root, 'home', '.sinter');
    const out = join(root, 'out');

    writeJson(join(sinterHome, 'archive', 'quality_archive.json'), {
      archives: {
        p5: [
          { id: 'p5_good', domain: 'p5', prompt: 'draw a field', output: 'function setup(){}', qualityScore: 0.91, metadata: { renderMeasure: { verdict: 'ok' } } },
          { id: 'p5_bad', domain: 'p5', prompt: 'draw mud', output: 'function draw(){}', qualityScore: 0.48, metadata: { evaluationFailureClass: 'render' } },
        ],
      },
    });
    writeJson(join(sinterHome, 'routing', 'p5.json'), [
      { domain: 'p5', model: 'local', qualityScore: 0.8, timestamp: '2026-07-06T00:00:00Z' },
    ]);
    writeJson(join(sinterHome, 'failures', 'f1.json'), {
      id: 'f1', domain: 'p5', model: 'local', prompt: 'bad code', errorType: 'validation', error: 'missing setup', code: 'draw()',
    });
    writeJson(join(sinterHome, 'lineage', 'l1.json'), { artifactId: 'p5_good', provenance: 'fresh-generation', params: { domain: 'p5' } });
    writeJson(join(sinterHome, 'taste', 'taste-weights.json'), { pairCount: 2, trainingAgreement: 1 });
    writeJsonl(join(repoRoot, 'docs', 'validation', 'self-improve-ledger.jsonl'), [
      { ts: '2026-07-06T00:00:00Z', targetedDomains: ['p5'], meanScore: 0.72, completed: 1 },
    ]);
    writeJsonl(join(repoRoot, 'docs', 'validation', 'rescore', 'sample.jsonl'), [
      { id: 'p5_good', domain: 'p5', stored: 0.91, fresh: 0.88, delta: -0.03, prompt: 'draw a field again', scoreBand: 'excellent', targetBand: 'good', outputPath: 'attempts/p5' },
    ]);
    writeJson(join(repoRoot, '.sinter', 'refs', 'preference', 'p5_good', 'pin.json'), {
      uri: 'sinter:/artifact/p5_good', hash: 'abc', kind: 'preference-event', path: 'objects/abc.json',
    });

    const manifest = await exportSinterRoleDatasets({ repoRoot, sinterHome, outputDir: out, now: '2026-07-06T00:00:00Z' });

    expect(manifest.recommendation.firstLoraCandidate).toBe('evaluator_system_quality_v0');
    expect(manifest.recommendation.robustnessCandidate).toBe('failure_triage_v0');
    expect(manifest.bundles.find((bundle) => bundle.id === 'generator_sft_seed_v0')?.trainability).toBe('capture_first');
    expect(manifest.bundles.find((bundle) => bundle.id === 'simon_preference_v0')?.labelStrength).toBe('high_but_tiny');
    expect(manifest.sourceSummaries.quality_archive.records).toBe(2);
    expect(manifest.sourceSummaries.failures.records).toBe(1);
    expect(manifest.sourceSummaries.sinter_refs.labels.preference).toBe(1);

    const persisted = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { schemaVersion: number };
    expect(persisted.schemaVersion).toBe(1);
    const evaluatorRows = readFileSync(join(out, 'bundles', 'evaluator_system_quality_v0.jsonl'), 'utf8');
    expect(evaluatorRows).toContain('quality_score');
    expect(evaluatorRows).toContain('routing_quality_score');
    expect(evaluatorRows).toContain('rescore_quality_score');
    expect(evaluatorRows).toContain('draw a field again');
    expect(evaluatorRows).toContain('score_band');
    expect(evaluatorRows).not.toContain('function setup');
  });

  it('prefers the runtime self-improve ledger over the frozen legacy ledger', async () => {
    const root = makeTempDir();
    const repoRoot = join(root, 'repo');
    const sinterHome = join(root, 'home', '.sinter');
    const out = join(root, 'out');
    writeJson(join(sinterHome, 'archive', 'quality_archive.json'), { archives: {} });
    writeJsonl(join(repoRoot, 'docs', 'validation', 'self-improve-ledger.jsonl'), [
      { ts: 'legacy', targetedDomains: ['svg'], completed: 1 },
    ]);
    writeJsonl(join(sinterHome, 'quality', 'self-improve-ledger.jsonl'), [
      { ts: 'runtime', targetedDomains: ['p5'], completed: 1 },
      { ts: 'runtime-2', targetedDomains: ['three'], completed: 1 },
    ]);

    const manifest = await exportSinterRoleDatasets({ repoRoot, sinterHome, outputDir: out });

    expect(manifest.sourceSummaries.self_improve_ledger.records).toBe(2);
    expect(manifest.sourceSummaries.self_improve_ledger.displayPath).toBe(
      '~/.sinter/quality/self-improve-ledger.jsonl',
    );
  });

  it('can opt into artifact text for actual fine-tuning export', async () => {
    const root = makeTempDir();
    const repoRoot = join(root, 'repo');
    const sinterHome = join(root, 'home', '.sinter');
    const out = join(root, 'out');

    writeJson(join(sinterHome, 'archive', 'quality_archive.json'), {
      archives: { svg: [{ id: 'svg_1', domain: 'svg', prompt: 'circle', output: '<svg></svg>', qualityScore: 0.9, metadata: {} }] },
    });

    await exportSinterRoleDatasets({ repoRoot, sinterHome, outputDir: out, includeArtifactText: true });

    const evaluatorRows = readFileSync(join(out, 'bundles', 'evaluator_system_quality_v0.jsonl'), 'utf8');
    expect(evaluatorRows).toContain('<svg></svg>');
  });
});
