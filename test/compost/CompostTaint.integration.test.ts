import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SeedBank } from '../../src/compost/SeedBank.js';
import { beginDerivedCompostObservation, compostContentDigest,
  deriveCompostProvenance } from
  '../../src/compost/CompostProvenance.js';
import { mergeConfig } from '../../src/compost/defaults.js';
import type { CompostFragment } from '../../src/compost/types.js';

describe('Compost transitive taint', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('survives rejected artifact derivation, restart, and projection rebuild', async () => {
    dir = await mkdtemp(join(tmpdir(), 'compost-taint-'));
    const rejectedDigest = compostContentDigest('rejected artwork');
    const rejected: CompostFragment = { id: 'rejected', source: 'review', domain: 'p5',
      layer: 'semantic', content: 'rejected artwork', tags: [], score: 10,
      metadata: { fileType: 'html', timestamp: '', hash: rejectedDigest,
        size: 16, extractedAt: '' }, provenance: { ancestorDigests: [rejectedDigest],
        taint: 'rejected', qualityAuthority: false } };
    const neutral: CompostFragment = { ...rejected, id: 'neutral', content: 'neutral source',
      metadata: { ...rejected.metadata, hash: compostContentDigest('neutral source') },
      provenance: undefined };
    const derivativeContent = 'cross-domain derivative';
    const derivative: CompostFragment = { ...rejected, id: 'derivative',
      content: derivativeContent, metadata: { ...rejected.metadata,
        hash: compostContentDigest(derivativeContent) },
      provenance: deriveCompostProvenance([rejected, neutral]) };
    const config = mergeConfig({ seedDir: dir });
    const bank = new SeedBank(config);
    await bank.add({ id: 'seed', content: derivative.content, score: 10,
      source: { fragments: ['rejected', 'neutral'], collisionType: 'soup',
        domains: ['p5'] }, promotedAt: new Date().toISOString(), usedBy: [], useCount: 0,
      provenance: deriveCompostProvenance([derivative]) });

    const restarted = new SeedBank(config);
    const projected = (await restarted.getAll())[0]!;
    const rebuilt = deriveCompostProvenance([projected]);
    const observation = beginDerivedCompostObservation(projected);
    expect(rebuilt.taint).toBe('rejected');
    expect(rebuilt.qualityAuthority).toBe(false);
    expect(rebuilt.ancestorDigests).toEqual(expect.arrayContaining([
      rejectedDigest, neutral.metadata.hash, derivative.metadata.hash]));
    expect(observation).toMatchObject({ status: 'raw-observation',
      renderedEvidence: undefined, decisionEvidence: undefined });
  });
});
