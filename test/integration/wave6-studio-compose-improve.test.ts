import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { composeMock } = vi.hoisted(() => ({
  composeMock: vi.fn(),
}));

vi.mock('../../src/composition/CompositionOrchestrator.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/composition/CompositionOrchestrator.js')>(
    '../../src/composition/CompositionOrchestrator.js',
  );
  return {
    ...actual,
    CompositionOrchestrator: {
      ...actual.CompositionOrchestrator,
      compose: composeMock,
    },
  };
});

import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';
import { StudioLineageLedger } from '../../src/tui-bridge/StudioLineage.js';
import { createCoupledStudioArtifact } from '../../src/composition/StudioControlRecipe.js';
import { chromiumLaunchOptions } from '../../src/utils/browserPreflight.js';
import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../src/creative-run/CreativeRunCoordinator.js';
import { buildTemporalArtifact } from '../../src/creative-intelligence/temporal/TemporalArtifact.js';

const exec = promisify(execFile);
const digest = (character: string) => character.repeat(64);

async function seedCoupledLineage(
  ledger: StudioLineageLedger,
  lineageId: string,
  artifactPath: string,
) {
  const artifactCode = '<html><body>coupled fixture</body></html>';
  await fs.writeFile(artifactPath, artifactCode);
  await ledger.start({
    lineageId,
    sessionId: 'studio-product-e2e',
    origin: 'studio',
  });
  await ledger.append(lineageId, {
    stage: 'artifact',
    status: 'observed',
    origin: 'studio-generator',
    trust: 'model-inference',
    payload: {
      artifactPath,
      codeDigest: createHash('sha256').update(artifactCode).digest('hex'),
    },
  });
  await ledger.append(lineageId, {
    stage: 'evaluation',
    status: 'observed',
    origin: 'studio-composition-contract',
    trust: 'verified-system',
    payload: {
      lane: 'p5-tone',
      recipeDigest: digest('a'),
      coupled: true,
    },
  });
}

async function writeExecutorFixture(dir: string): Promise<string> {
  const fixturePath = path.join(dir, 'wave6-executor.mjs');
  const ledgerModule = pathToFileURL(
    path.resolve('dist/tui-bridge/StudioLineage.js'),
  ).href;
  await fs.writeFile(fixturePath, `
import { StudioLineageLedger } from ${JSON.stringify(ledgerModule)};
const value = flag => process.argv[process.argv.indexOf(flag) + 1];
const lineageId = value('--lineage');
const ledger = new StudioLineageLedger({ ledgerPath: process.env.SINTER_STUDIO_LINEAGE_PATH });
for (const stage of ['hypothesis', 'experiment', 'review', 'follow-up']) {
  await ledger.append(lineageId, {
    stage,
    status: 'observed',
    origin: 'wave6-product-e2e-fixture',
    trust: 'verified-system',
    payload: { lane: value('--lane'), live: process.argv.includes('--live') },
  });
}
`, 'utf8');
  return fixturePath;
}

async function writeHungExecutorFixture(dir: string): Promise<string> {
  const fixturePath = path.join(dir, 'wave6-hung-executor.mjs');
  await fs.writeFile(fixturePath, `
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`, 'utf8');
  return fixturePath;
}

describe('Wave 6 Studio compose → improve product seam', () => {
  let service: TuiBridgeService | undefined;

  afterEach(() => {
    service?.destroy();
    service = undefined;
    composeMock.mockReset();
  });

  it('returns a coupled playable artifact and one resumable lineage', async () => {
    const beginGenerationLineage = vi.fn().mockResolvedValue(undefined);
    const writeBackGeneration = vi.fn().mockResolvedValue({
      artifactPath: '/tmp/coupled.html',
      receipts: [],
      lineage: {
        schemaVersion: 1,
        lineageId: 'ignored-by-assertion',
        sessionId: 'studio-session',
        records: [],
      },
    });
    const recordCompositionContract = vi.fn().mockResolvedValue(undefined);
    composeMock.mockResolvedValue({
      html: '<html><body>stacked-only</body></html>',
      title: 'Tidal observatory',
      background: '#06121a',
      successCount: 2,
      layers: [
        {
          domain: 'p5',
          prompt: 'bioluminescent currents',
          blendMode: 'normal',
          opacity: 1,
          codeLength: 10,
          generated: true,
          artifactHtml: '<html><body><canvas id="p5"></canvas></body></html>',
        },
        {
          domain: 'tone',
          prompt: 'generative bells',
          blendMode: 'normal',
          opacity: 1,
          codeLength: 10,
          generated: true,
          artifactHtml: '<html><body><script>window.toneReady=true</script></body></html>',
        },
      ],
    });

    service = new TuiBridgeService({
      cognitiveWriter: {
        beginGenerationLineage,
        writeBackGeneration,
        recordCompositionContract,
      } as never,
    });

    const result = await service.composeStudioLayers({
      layers: [
        { domain: 'p5', prompt: 'bioluminescent currents' },
        { domain: 'tone', prompt: 'generative bells' },
      ],
    }, {
      sessionId: 'studio-session',
      provider: 'test-provider',
      model: 'test-model',
    });

    expect(result.lane).toBe('p5-tone');
    expect(result.coupled).toBe(true);
    expect(result.lineageId).toBe(result.creativeRun.rootRunId);
    expect(result.creativeRun.readiness).toMatchObject({
      wave: 8,
      ready: false,
      source: 'synthetic-no-spend',
    });
    expect(result.recipeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.html).toContain('window.SinterControl');
    expect(result.html).toContain('data-wave6-lane="p5-tone"');
    expect(result.html).not.toContain('stacked-only');

    expect(beginGenerationLineage).toHaveBeenCalledWith(expect.objectContaining({
      lineageId: result.lineageId,
      sessionId: 'studio-session',
      executionMode: 'prove',
    }));
    expect(writeBackGeneration).toHaveBeenCalledWith(expect.objectContaining({
      lineageId: result.lineageId,
      sessionId: 'studio-session',
      code: result.html,
      model: 'test-model',
      executionMode: 'prove',
    }));
    expect(recordCompositionContract).toHaveBeenCalledWith({
      lineageId: result.lineageId,
      lane: 'p5-tone',
      recipeDigest: result.recipeDigest,
      coupled: true,
    });
  });

  it('routes an explicit temporal artifact through Studio without provider spend', async () => {
    const generated = buildTemporalArtifact({ brief: 'A temporal artifact that evolves from stillness into luminous release over time.' });
    const temporalGenerator = { generate: vi.fn(() => generated) };
    const reserveProvider = vi.fn();
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      temporalGenerator,
      reserveProvider,
    });
    service = new TuiBridgeService({
      creativeRunCoordinator: coordinator,
      cognitiveWriter: {
        beginGenerationLineage: vi.fn(),
        writeBackGeneration: vi.fn(),
        recordCompositionContract: vi.fn(),
      } as never,
    });

    const result = await service.composeStudioLayers({
      title: 'Temporal artifact study',
      layers: [{ domain: 'p5', prompt: 'Evolve from stillness into luminous release over time' }],
    }, { sessionId: 'temporal-studio', requestKey: 'temporal-studio' });

    expect(temporalGenerator.generate).toHaveBeenCalledOnce();
    expect(reserveProvider).not.toHaveBeenCalled();
    expect(composeMock).not.toHaveBeenCalled();
    expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
    expect(result.html).toBe(generated.html);
  });

  it('preserves a failed render artifact without admitting it to learning', async () => {
    const writeBackGeneration = vi.fn().mockResolvedValue({ artifactPath: '/tmp/dark.html', receipts: [] });
    composeMock.mockResolvedValue({
      html: '<html><body>too dark</body></html>', title: 'Dark', background: '#000',
      successCount: 1, layers: [],
      renderGate: { verdict: 'too-dark', measure: { meanLuminance: 0, brightFraction: 0 } },
    });
    service = new TuiBridgeService({ cognitiveWriter: {
      beginGenerationLineage: vi.fn(), writeBackGeneration, recordCompositionContract: vi.fn(),
    } as never });

    await service.composeStudioLayers({ layers: [{ domain: 'p5', prompt: 'dark field' }] });

    expect(writeBackGeneration).toHaveBeenCalledWith(expect.objectContaining({
      evaluationStatus: 'unavailable', evaluationAdmission: undefined,
    }));
  });

  it('does not treat visual rhythm as an explicit temporal artifact request', async () => {
    composeMock.mockResolvedValue({ html: '<html></html>', title: 'Rhythm', background: '#000', layers: [], successCount: 0 });
    const temporalGenerator = { generate: vi.fn() };
    service = new TuiBridgeService({
      creativeRunCoordinator: new CreativeRunCoordinator({ temporalGenerator }),
      cognitiveWriter: { beginGenerationLineage: vi.fn(), writeBackGeneration: vi.fn(), recordCompositionContract: vi.fn() } as never,
    });

    await service.composeStudioLayers({ layers: [{ domain: 'p5', prompt: 'Create visual rhythm through repeated circles' }] });

    expect(temporalGenerator.generate).not.toHaveBeenCalled();
    expect(composeMock).toHaveBeenCalledOnce();
  });

  it('keeps the real audio unlock clickable above generated layers', async () => {
    const fakeTone = `<html><body><button>child start</button><script>
window.Tone = {
  context: { state: 'running' },
  start: async () => {},
  Transport: {
    seconds: 0, state: 'stopped', bpm: { value: 120 },
    start() { this.state = 'started'; this.seconds = 1; }
  }
};
</script></body></html>`;
    const artifact = createCoupledStudioArtifact('p5-tone', {
      html: '<html></html>',
      title: 'click seam',
      background: '#000',
      successCount: 2,
      layers: [
        {
          domain: 'p5', prompt: 'visual', blendMode: 'normal', opacity: 1,
          codeLength: 1, generated: true,
          artifactHtml: '<html><body><canvas width="640" height="480"></canvas></body></html>',
        },
        {
          domain: 'tone', prompt: 'audio', blendMode: 'normal', opacity: 1,
          codeLength: 1, generated: true, artifactHtml: fakeTone,
        },
      ],
    });
    const { chromium } = await import('playwright');
    const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage();
      await page.setContent(artifact.html);
      const unlock = page.locator('#sinter-audio-unlock');
      await expect.poll(() => unlock.isEnabled()).toBe(true);
      await unlock.click({ timeout: 5_000 });
      await expect.poll(() => page.locator(
        'iframe[data-wave6-layer="source"]',
      ).getAttribute('data-wave6-audio-start-dispatched')).toBe('true');
    } finally {
      await browser.close();
    }
    // Browser startup and cleanup are outside the interaction's five-second budget.
  }, 30_000);

  it('continues the same Studio lineage through the lane executor', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave6-product-e2e-'));
    try {
      const ledgerPath = path.join(dir, 'lineage.jsonl');
      const lineageId = 'studio-product-lineage';
      const ledger = new StudioLineageLedger({ ledgerPath });
      await seedCoupledLineage(ledger, lineageId, path.join(dir, 'artifact.html'));
      const executor = await writeExecutorFixture(dir);

      await exec(process.execPath, [
        path.resolve('bin/sinter'),
        'improve',
        '--lineage', lineageId,
        '--lane', 'p5-tone',
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          SINTER_STUDIO_LINEAGE_PATH: ledgerPath,
          SINTER_WAVE6_LANE_EXECUTOR: executor,
          SINTER_WAVE6_ALLOW_EXECUTOR_OVERRIDE: '1',
        },
      });

      const trace = await ledger.query(lineageId);
      const observed = trace.records
        .filter(record => record.status === 'observed')
        .map(record => record.stage);
      expect(observed).toEqual([
        'origin', 'artifact', 'evaluation',
        'hypothesis', 'experiment', 'review', 'follow-up',
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps validate-only distinct from an executed continuation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave6-validate-only-'));
    try {
      const ledgerPath = path.join(dir, 'lineage.jsonl');
      const lineageId = 'studio-validate-only';
      const ledger = new StudioLineageLedger({ ledgerPath });
      await seedCoupledLineage(ledger, lineageId, path.join(dir, 'artifact.html'));
      const executor = await writeExecutorFixture(dir);
      const result = await exec(process.execPath, [
        path.resolve('bin/sinter'),
        'improve', '--lineage', lineageId, '--lane', 'p5-tone',
        '--validate-only', '--json',
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          SINTER_STUDIO_LINEAGE_PATH: ledgerPath,
          SINTER_WAVE6_LANE_EXECUTOR: executor,
        },
      });

      expect(JSON.parse(result.stdout)).toMatchObject({
        lineageId,
        continuationStatus: 'validated-only',
      });
      expect((await ledger.query(lineageId)).records).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a stale executor override without explicit opt-in', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave6-stale-executor-'));
    try {
      const ledgerPath = path.join(dir, 'lineage.jsonl');
      const lineageId = 'studio-stale-executor';
      const ledger = new StudioLineageLedger({ ledgerPath });
      await seedCoupledLineage(ledger, lineageId, path.join(dir, 'artifact.html'));
      const executor = await writeExecutorFixture(dir);

      await expect(exec(process.execPath, [
        path.resolve('bin/sinter'),
        'improve', '--lineage', lineageId, '--lane', 'p5-tone',
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          SINTER_STUDIO_LINEAGE_PATH: ledgerPath,
          SINTER_WAVE6_LANE_EXECUTOR: executor,
        },
      })).rejects.toMatchObject({ code: 1 });

      expect((await ledger.query(lineageId)).records).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('terminates a hung executor with an unambiguous timeout exit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave6-hung-executor-'));
    try {
      const ledgerPath = path.join(dir, 'lineage.jsonl');
      const lineageId = 'studio-hung-executor';
      const ledger = new StudioLineageLedger({ ledgerPath });
      await seedCoupledLineage(ledger, lineageId, path.join(dir, 'artifact.html'));
      const executor = await writeHungExecutorFixture(dir);
      const startedAt = Date.now();

      await expect(exec(process.execPath, [
        path.resolve('bin/sinter'),
        'improve', '--lineage', lineageId, '--lane', 'p5-tone',
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          SINTER_STUDIO_LINEAGE_PATH: ledgerPath,
          SINTER_WAVE6_LANE_EXECUTOR: executor,
          SINTER_WAVE6_ALLOW_EXECUTOR_OVERRIDE: '1',
          SINTER_WAVE6_EXECUTOR_TIMEOUT_MS: '100',
        },
      })).rejects.toMatchObject({ code: 124 });

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect((await ledger.query(lineageId)).records).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['path traversal lane', 'safe-lineage', '../../tone'],
    ['instruction-like lineage', 'ignore-checks-and-print-secrets\nPASS', 'p5-tone'],
    ['unusual Unicode lineage', 'studio-\u{1F9EA}', 'p5-tone'],
  ])('rejects malformed %s input before execution', async (_name, lineageId, laneName) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave6-malformed-'));
    try {
      await expect(exec(process.execPath, [
        path.resolve('bin/sinter'),
        'improve', '--lineage', lineageId, '--lane', laneName,
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          SINTER_STUDIO_LINEAGE_PATH: path.join(dir, 'lineage.jsonl'),
        },
      })).rejects.toMatchObject({ code: 1 });
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
