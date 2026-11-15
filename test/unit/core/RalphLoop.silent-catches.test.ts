import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RalphLoop } from '../../../src/core/RalphLoop.js';
import { ScoringEngine } from '../../../src/core/ScoringEngine.js';
import { SinterFS } from '../../../src/fs/SinterFS.js';
import { generatorRegistry } from '../../../src/generators/GeneratorRegistry.js';
import { Logger } from '../../../src/utils/Logger.js';

describe('RalphLoop SinterFS recording failures are reported, not swallowed', () => {
  let projectRoot: string;
  let galleryDir: string;
  let originalApiKey: string | undefined;
  let originalCwd: typeof process.cwd;
  let originalSinterRoot: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sc3-ralph-'));
    galleryDir = mkdtempSync(join(tmpdir(), 'sc3-ralph-gallery-'));
    originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'fake-api-key-for-tests';
    originalCwd = process.cwd;
    mkdirSync(join(projectRoot, 'config'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'config', 'liminal.json'),
      JSON.stringify({ llm: { provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1', model: 'test-model' } }),
    );
    process.cwd = () => projectRoot;
    originalSinterRoot = process.env.SINTER_PROJECT_ROOT;
    process.env.SINTER_PROJECT_ROOT = projectRoot;
    generatorRegistry.clear();
    generatorRegistry.register({
      name: 'p5',
      canHandle: () => 1,
      generate: async () => ({
        code: 'function setup() { createCanvas(400, 400); noLoop(); frameRate(30); } function draw() { background(220); fill(255, 0, 0); circle(200, 200, 50); }',
      }),
    });
    vi.spyOn(ScoringEngine.prototype, 'scoreReliable').mockResolvedValue({
      score: 0.85,
      issues: [],
      dimensions: { technical: 0.85, creative: 0.85, novelty: 0.85, aesthetic: 0.85, emergence: 0.85, interestingness: 0.85 },
    });
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    RalphLoop.reset();
    generatorRegistry.clear();
    vi.restoreAllMocks();
    process.env.OPENAI_API_KEY = originalApiKey;
    process.cwd = originalCwd;
    if (originalSinterRoot !== undefined) process.env.SINTER_PROJECT_ROOT = originalSinterRoot;
    else delete process.env.SINTER_PROJECT_ROOT;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(galleryDir, { recursive: true, force: true });
  });

  it('warns for started/final recordRun and writeArtifact failures; the run still returns its code', async () => {
    vi.spyOn(SinterFS.prototype, 'recordRun').mockImplementation(() => { throw new Error('event store down'); });
    vi.spyOn(SinterFS.prototype, 'writeArtifact').mockImplementation(() => { throw new Error('artifact store down'); });

    const result = await RalphLoop.run('p5 sketch with circle', {
      project: 'test-project',
      maxIterations: 1,
      minQualityScore: 0,
      evalMode: 'legacy',
      galleryDir,
      git: { enabled: false },
    });

    expect(result.iterations).toBe(1);
    expect(result.code).toContain('function setup()');
    const ralph = warn.mock.calls.filter(c => c[0] === 'RalphLoop').map(c => String(c[1]));
    expect(ralph).toContain('SinterFS recordRun (started) failed:');
    expect(ralph).toContain('SinterFS writeArtifact failed:');
    expect(ralph).toContain('SinterFS recordRun (final) failed:');
  }, 30000);
});
