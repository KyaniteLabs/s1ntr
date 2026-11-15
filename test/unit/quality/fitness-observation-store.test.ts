import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendFitnessObservation,
  buildFitnessObservationReport,
  createFitnessObservation,
  readFitnessObservations,
  resolveFitnessObservationPath,
  type FitnessFailureClass,
  type FitnessObservationInput,
} from '../../../src/quality/FitnessObservationStore.js';

const roots: string[] = [];

async function tempPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinter-fitness-'));
  roots.push(root);
  return path.join(root, 'fitness-observations.jsonl');
}

function input(
  runId: string,
  failureClass: FitnessFailureClass = 'none',
  overrides: Partial<FitnessObservationInput> = {},
): FitnessObservationInput {
  return {
    runId,
    domain: 'p5',
    provider: 'openai',
    model: 'gpt-test',
    sourceCode: `function draw() { circle(${runId.length}, 2, 3); }`,
    score: 0.8,
    confidence: 1,
    failureClass,
    timestamp: `2026-07-26T00:00:${runId.padStart(2, '0')}Z`,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('fitness observation schema', () => {
  it('derives honest and graduation decisions only from canonical evidence plus attribution', () => {
    const healthy = createFitnessObservation(input('1'));
    const degraded = createFitnessObservation(input('2', 'scorer', { confidence: 0 }));
    const validator = createFitnessObservation(input('3', 'validator'));
    const legacy = createFitnessObservation(input('4', 'legacy'));
    const missingModel = createFitnessObservation(input('5', 'none', { model: undefined }));

    expect(healthy).toMatchObject({ honest: true, graduationEligible: true });
    expect(degraded).toMatchObject({ honest: false, graduationEligible: false });
    expect(validator).toMatchObject({ honest: false, graduationEligible: false });
    expect(legacy).toMatchObject({ honest: false, graduationEligible: false });
    expect(missingModel).toMatchObject({
      model: null,
      honest: true,
      graduationEligible: false,
    });
  });

  it('marks an evaluation that produced no evidence as unscored, never as a scored zero or pass (#709)', async () => {
    const timedOut = createFitnessObservation(input('7', 'scorer', { score: 0.5, confidence: 0 }));
    const parseFail = createFitnessObservation(input('8', 'parse', { confidence: 0.4 }));
    const noConfidence = createFitnessObservation(input('9', 'none', { confidence: 0 }));
    const healthy = createFitnessObservation(input('10'));
    const brokenButScored = createFitnessObservation(input('11', 'validator'));

    expect(timedOut).toMatchObject({ scoreState: 'unscored', honest: false, graduationEligible: false });
    expect(parseFail.scoreState).toBe('unscored');
    expect(noConfidence.scoreState).toBe('unscored');
    expect(healthy.scoreState).toBe('scored');
    expect(brokenButScored.scoreState).toBe('scored');

    const filePath = await tempPath();
    await appendFitnessObservation(input('12', 'scorer', { score: 0.5, confidence: 0 }), { filePath });
    const { observations, malformedCount } = await readFitnessObservations({ filePath });
    expect(malformedCount).toBe(0);
    expect(observations).toHaveLength(1);
    expect(observations[0].scoreState).toBe('unscored');
  });

  it('still reads rows written before scoreState existed, and rejects a row whose scoreState contradicts its evidence', async () => {
    const filePath = await tempPath();
    const legacyRow: Record<string, unknown> = { ...createFitnessObservation(input('13')) };
    delete legacyRow.scoreState;
    const lyingRow = { ...createFitnessObservation(input('14', 'scorer', { confidence: 0 })), scoreState: 'scored' };
    await writeFile(filePath, `${JSON.stringify(legacyRow)}\n${JSON.stringify(lyingRow)}\n`);
    const { observations, malformedCount } = await readFitnessObservations({ filePath });
    expect(observations.map(row => row.runId)).toEqual(['13']);
    expect(malformedCount).toBe(1);
  });

  it('stores source hashes and structured adaptation IDs without source code', () => {
    const observation = createFitnessObservation(input('6', 'render', {
      activeAdaptationIds: ['adapt-b', 'adapt-a', 'adapt-b'],
    }));
    const serialized = JSON.stringify(observation);

    expect(observation.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(observation.activeAdaptationIds).toEqual(['adapt-a', 'adapt-b']);
    expect(observation.cohort).toBe('treatment');
    expect(serialized).not.toContain('function draw');
  });
});

describe('fitness observation persistence', () => {
  it('defaults to the runtime quality directory and honors the explicit override', () => {
    const runtime = resolveFitnessObservationPath({
      home: '/tmp/sinter-home',
      cwd: '/tmp/repo',
      env: {},
    });
    const overridden = resolveFitnessObservationPath({
      cwd: '/tmp/repo',
      env: { SINTER_FITNESS_OBSERVATIONS_PATH: 'runtime/fitness.jsonl' },
    });

    expect(runtime).toBe('/tmp/sinter-home/.sinter/quality/fitness-observations.jsonl');
    expect(overridden).toBe('/tmp/repo/runtime/fitness.jsonl');
  });

  it('serializes concurrent appends without losing or corrupting observations', async () => {
    const filePath = await tempPath();
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      appendFitnessObservation(input(String(index)), { filePath })
    ));
    const { observations, malformedCount } = await readFitnessObservations({ filePath });

    expect(malformedCount).toBe(0);
    expect(observations).toHaveLength(40);
    expect(new Set(observations.map(row => row.runId)).size).toBe(40);
  });

  it('rotates atomically and bounds retained archives', async () => {
    const filePath = await tempPath();
    for (let index = 0; index < 6; index += 1) {
      await appendFitnessObservation(input(String(index)), {
        filePath,
        maxBytes: 450,
        maxArchives: 2,
      });
    }
    const { observations, malformedCount } = await readFitnessObservations({
      filePath,
      maxArchives: 2,
    });

    expect(malformedCount).toBe(0);
    expect(observations.map(row => row.runId)).toEqual(['3', '4', '5']);
    await expect(readFile(`${filePath}.3`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a single observation larger than the retention bound', async () => {
    const filePath = await tempPath();

    await expect(appendFitnessObservation(input('oversized'), {
      filePath,
      maxBytes: 32,
    })).rejects.toThrow('exceeds the configured retention size');
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports counts and spans by domain, model lane, and cohort', async () => {
    const filePath = await tempPath();
    await appendFitnessObservation(input('1'), { filePath });
    await appendFitnessObservation(input('2', 'scorer', {
      confidence: 0,
      domain: 'hydra',
      activeAdaptationIds: ['adapt-1'],
    }), { filePath });
    const report = await buildFitnessObservationReport({ filePath });

    expect(report).toMatchObject({ count: 2, honestCount: 1, graduationEligibleCount: 1 });
    expect(report.byDomain.p5.count).toBe(1);
    expect(report.byDomain.hydra.count).toBe(1);
    expect(report.byModel['openai/gpt-test'].count).toBe(2);
    expect(report.byCohort).toMatchObject({ control: { count: 1 }, treatment: { count: 1 } });
  });

  it('never treats or rewrites unversioned legacy rows as observations', async () => {
    const filePath = await tempPath();
    const legacy = '{"ts":"legacy","score":0.99}\n';
    await writeFile(filePath, legacy);

    const { observations, malformedCount } = await readFitnessObservations({ filePath });

    expect(observations).toEqual([]);
    expect(malformedCount).toBe(1);
    expect(await readFile(filePath, 'utf8')).toBe(legacy);
  });
});
