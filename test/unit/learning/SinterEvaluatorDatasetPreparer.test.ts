import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareEvaluatorDataset } from '../../../src/learning/SinterEvaluatorDatasetPreparer.js';
import { createHash } from 'node:crypto';
import { createCreativeLabelAdmission } from
  '../../../src/learning/CreativeLabelAdmission.js';

const tempDirs: string[] = [];

function admitted(id: string) {
  const artifactDigest = createHash('sha256').update(id).digest('hex');
  return { artifactDigest, creativeLabel: createCreativeLabelAdmission({
    trustKind: 'universal-criterion', allowedUses: ['evaluator-training'],
    artifactDigest, evidenceDigest: 'b'.repeat(64), decisionDigest: 'c'.repeat(64),
    rendered: true, identityValid: true, digestMatched: true, degraded: false,
  }) };
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `sinter-evaluator-prep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SinterEvaluatorDatasetPreparer', () => {
  it('quarantines unsafe positive render labels and writes train/val/test splits', async () => {
    const root = makeTempDir();
    const input = join(root, 'role-export', 'bundles', 'evaluator_system_quality_v0.jsonl');
    const out = join(root, 'prepared');
    const badSvg = admitted('bad_svg_positive');
    const infra = admitted('infra_positive');
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => {
        const evidence = admitted(`good_${i}`);
        return { artifact_id: `good_${i}`, source: 'quality_archive',
          input: { domain: 'p5', artifact_sha256: evidence.artifactDigest,
            render_measure: { verdict: 'ok', meanLuminance: 0.4,
              brightFraction: 0.2, brightnessStd: 22 } },
          label: { kind: 'quality_score', score: 0.86, bucket: 'excellent',
            failure_class: 'none', provenance: 'quality_archive',
            creative_label: evidence.creativeLabel } };
      }),
      {
        artifact_id: 'bad_svg_positive',
        source: 'quality_archive',
        input: { domain: 'svg', artifact_sha256: badSvg.artifactDigest,
          render_measure: { verdict: 'ok', meanLuminance: 0.03,
            brightFraction: 0, brightnessStd: 0 } },
        label: { kind: 'quality_score', score: 0.88, bucket: 'excellent',
          failure_class: 'none', provenance: 'quality_archive',
          creative_label: badSvg.creativeLabel },
      },
      {
        artifact_id: 'infra_positive',
        source: 'quality_archive',
        input: { domain: 'hydra', artifact_sha256: infra.artifactDigest },
        label: { kind: 'quality_score', score: 0.75, bucket: 'good',
          failure_class: 'infra', provenance: 'quality_archive',
          creative_label: infra.creativeLabel },
      },
    ];
    writeJsonl(input, rows);

    const summary = await prepareEvaluatorDataset({ inputJsonl: input, outputDir: out, seed: 'fixed', now: '2026-07-06T00:00:00Z' });

    expect(summary.counts.total).toBe(10);
    expect(summary.counts.quarantined).toBe(2);
    expect(summary.counts.included).toBe(8);
    expect(summary.counts.primaryIncluded).toBe(8);
    expect(summary.counts.proxyIncluded).toBe(0);
    expect(summary.counts.train).toBeGreaterThan(0);
    expect(summary.counts.val).toBeGreaterThan(0);
    expect(summary.counts.test).toBeGreaterThan(0);
    expect(summary.quarantineReasons.positive_label_too_dark_render_stats).toBe(1);
    expect(summary.quarantineReasons['positive_label_with_degraded_failure_class:infra']).toBe(1);

    const card = readFileSync(join(out, 'dataset-card.md'), 'utf8');
    expect(card).toContain('SINTER evaluator dataset card');
    expect(card).toContain('This is not a Simon preference model');
    expect(card).toContain('Primary clean rows');
    expect(card).toContain('Routing labels are proxy rows');
    const primaryTrain = readFileSync(join(out, 'primary-train.jsonl'), 'utf8');
    expect(primaryTrain).toContain('labelWeight');
    const quarantine = readFileSync(join(out, 'quarantine.jsonl'), 'utf8');
    expect(quarantine).toContain('bad_svg_positive');
    expect(quarantine).toContain('infra_positive');
  });

  it('keeps tiny groups in train instead of fabricating empty validation semantics', async () => {
    const root = makeTempDir();
    const input = join(root, 'evaluator.jsonl');
    const out = join(root, 'prepared');
    const rescore = admitted('two');
    writeJsonl(input, [
      { event_id: 'one', source: 'routing', input: { domain: 'p5' }, label: { kind: 'routing_quality_score', score: 0.6, bucket: 'marginal', provenance: 'routing' } },
      { event_id: 'two', source: 'rescore', input: { domain: 'p5',
        artifact_sha256: rescore.artifactDigest }, label: { kind: 'rescore_quality_score',
        score: 0.9, bucket: 'excellent', provenance: 'rescore',
        creative_label: rescore.creativeLabel } },
    ]);

    const summary = await prepareEvaluatorDataset({ inputJsonl: input, outputDir: out });

    expect(summary.counts.train).toBe(2);
    expect(summary.counts.val).toBe(0);
    expect(summary.counts.test).toBe(0);
  });

  it('separates proxy routing rows and canonicalizes duplicate artifact labels to rescore', async () => {
    const root = makeTempDir();
    const input = join(root, 'evaluator.jsonl');
    const out = join(root, 'prepared');
    const same = admitted('same_artifact');
    const archiveOnly = admitted('archive_only');
    writeJsonl(input, [
      { artifact_id: 'same_artifact', source: 'quality_archive', input: { domain: 'p5',
        artifact_sha256: same.artifactDigest }, label: { kind: 'quality_score',
        score: 0.7, bucket: 'good', provenance: 'quality_archive',
        creative_label: same.creativeLabel } },
      { artifact_id: 'same_artifact', source: 'rescore', input: { domain: 'p5',
        artifact_sha256: same.artifactDigest }, label: { kind: 'rescore_quality_score',
        score: 0.55, bucket: 'marginal', provenance: 'rescore',
        creative_label: same.creativeLabel } },
      { event_id: 'route_1', source: 'routing', input: { domain: 'p5', model: 'local' }, label: { kind: 'routing_quality_score', score: 0.8, bucket: 'good', provenance: 'routing' } },
      { event_id: 'route_2', source: 'routing', input: { domain: 'svg', model: 'local' }, label: { kind: 'routing_quality_score', score: 0.4, bucket: 'poor', provenance: 'routing' } },
      { artifact_id: 'archive_only', source: 'quality_archive', input: { domain: 'svg',
        artifact_sha256: archiveOnly.artifactDigest }, label: { kind: 'quality_score',
        score: 0.9, bucket: 'excellent', provenance: 'quality_archive',
        creative_label: archiveOnly.creativeLabel } },
    ]);

    const summary = await prepareEvaluatorDataset({ inputJsonl: input, outputDir: out, seed: 'fixed' });

    expect(summary.counts.total).toBe(5);
    expect(summary.counts.quarantined).toBe(1);
    expect(summary.quarantineReasons.duplicate_superseded_by_higher_trust_label).toBe(1);
    expect(summary.counts.primaryIncluded).toBe(2);
    expect(summary.counts.proxyIncluded).toBe(2);
    expect(summary.byTrainingUse.primary).toBe(2);
    expect(summary.byTrainingUse.proxy).toBe(2);
    expect(summary.byTrainingUse.quarantine).toBe(1);

    const primaryRows = readFileSync(join(out, 'primary-train.jsonl'), 'utf8') + readFileSync(join(out, 'primary-val.jsonl'), 'utf8') + readFileSync(join(out, 'primary-test.jsonl'), 'utf8');
    expect(primaryRows).toContain('rescore_quality_score');
    expect(primaryRows).not.toContain('routing_quality_score');
    const proxyRows = readFileSync(join(out, 'proxy-train.jsonl'), 'utf8') + readFileSync(join(out, 'proxy-val.jsonl'), 'utf8') + readFileSync(join(out, 'proxy-test.jsonl'), 'utf8');
    expect(proxyRows).toContain('routing_quality_score');
    expect(proxyRows).toContain('"labelWeight":0.35');
  });

  it('quarantines static archive scores without exact rendered label admission', async () => {
    const root = makeTempDir();
    const input = join(root, 'evaluator.jsonl');
    const out = join(root, 'prepared');
    writeJsonl(input, [{ artifact_id: 'legacy-static', source: 'quality_archive',
      input: { domain: 'p5', artifact_sha256: 'a'.repeat(64) },
      label: { kind: 'quality_score', score: 0.99, bucket: 'excellent',
        provenance: 'legacy-static-internal' } }]);
    const summary = await prepareEvaluatorDataset({ inputJsonl: input, outputDir: out });
    expect(summary.counts.quarantined).toBe(1);
    expect(summary.quarantineReasons.creative_label_admission_missing_or_invalid).toBe(1);
    expect(readFileSync(join(out, 'primary-train.jsonl'), 'utf8')).toBe('');
  });
});
