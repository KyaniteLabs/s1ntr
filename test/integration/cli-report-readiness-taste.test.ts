import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SinterFS } from '../../src/fs/SinterFS.js';
import { ArchiveEntriesFSAdapter } from '../../src/fs/adapters/ArchiveEntries.js';
import type { TasteModelWeights } from '../../src/learning/TasteModelTrainer.js';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 120_000 });
let work: string; let fake: FakeProvider; let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-readiness-')); fake = await startFakeProvider();
  env = { ...fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') }), S1NTR_ART_HOME: path.join(work, 'no-art') };
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

const project = (name: string, evalJson?: object) => {
  const dir = path.join(work, name); mkdirSync(dir, { recursive: true });
  if (evalJson) writeFileSync(path.join(dir, 'beauty-eval.json'), JSON.stringify(evalJson));
  return dir;
};

describe('report readiness taste check', () => {
  it('uses a persisted archive and requires valid held-out taste weights', async () => {
    const dir = project('persisted-model', { rated_pieces_with_frames: 10, grouped_cv_auc_by_prompt_family: 0.88 });
    const cwd = project('separate-cwd');
    const readiness = () => runSinterAsync(['report', 'readiness'], { ...env, SINTER_PROJECT_ROOT: dir }, cwd);
    const fs = SinterFS.open(dir);
    const date = '2026-11-19T00:00:00Z';
    new ArchiveEntriesFSAdapter(fs).writeArchiveEntry({
      id: 'arc', artifactRef: { kind: 'generated-code', uri: 'sinter://artifact/arc', hash: 'a'.repeat(64) },
      descriptor: { values: [{ axis: 'order-chaos', value: 0.9 }], source: 'test', extractedAt: date },
      lineage: { artifactId: 'arc', parentIds: [], provenance: 'fresh-generation', createdAt: date },
      qualityScore: 0.9,
      signals: { novelty: 0.5, structure: 0.5, temporalRichness: 0.5, perturbationResilience: 0.5, fertility: 0.5, aesthetic: 0.9 },
      archivedAt: date,
    });
    const model: TasteModelWeights = { axisWeights: [1], qualityWeight: 0.5, pairCount: 4,
      trainedAt: date, trainingAgreement: 1, heldOutPairCount: 2, heldOutAgreement: 1, heldOutTieRate: 0 };
    function persist(weights: TasteModelWeights) {
      fs.writeRef('taste/model/latest', fs.writeArtifact({
        kind: 'taste-model', filename: 'taste-model-latest.json', content: JSON.stringify(weights),
      }));
    }
    try {
      persist({ ...model, heldOutPairCount: 0 });
      const noHoldout = await readiness();
      expect(noHoldout.out).toMatch(/FAIL Taste alignment: 0% of archive/);
      persist({ ...model, axisWeights: [Number.NaN] });
      const invalidWeights = await readiness();
      expect(invalidWeights.out).toMatch(/FAIL Taste alignment: 0% of archive/);
      persist({ ...model, heldOutAgreement: 0, heldOutTieRate: 1 });
      expect((await readiness()).out).toMatch(/FAIL Taste alignment: 0% of archive/);
      persist({ ...model, heldOutAgreement: 0.5, heldOutTieRate: 0 });
      expect((await readiness()).out).toMatch(/FAIL Taste alignment: 0% of archive/);
      persist(model);
      const heldOut = await readiness();
      expect(heldOut.out).toMatch(/PASS Taste alignment: 100% of archive.*wall AUC 0\.880 on 10 votes/);
    } finally { fs.close(); }
  });

  it('shows a measured AUC without authorizing the readiness check', async () => {
    const r = await runSinterAsync(['report', 'readiness'], env,
      project('with-eval', { rated_pieces_with_frames: 217, grouped_cv_auc_by_prompt_family: 0.866, cv_n: 217 }));
    expect(r.out).toMatch(/FAIL Taste alignment: 0% of archive \(min 30%\); wall AUC 0\.866 on 217 votes \(advisory\)/);
    expect(r.out).toContain('Taste alignment below threshold');
  });

  it('still fails when no wall taste report exists', async () => {
    const r = await runSinterAsync(['report', 'readiness'], env, project('no-eval'));
    expect(r.out).toMatch(/FAIL Taste alignment: 0% of archive \(min 30%\); no wall taste report found/);
    expect(r.out).toContain('Taste alignment below threshold');
  });

  it('still fails when the measured AUC is at chance', async () => {
    const r = await runSinterAsync(['report', 'readiness'], env,
      project('chance', { rated_pieces_with_frames: 40, grouped_cv_auc_by_prompt_family: 0.51 }));
    expect(r.out).toMatch(/FAIL Taste alignment: .*wall AUC 0\.510 on 40 votes/);
  });
});
