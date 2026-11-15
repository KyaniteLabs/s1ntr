import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeValidator } from '../../../src/core/CodeValidator.js';

const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }));

vi.mock('../../../src/core/RalphLoop.js', () => ({
  RalphLoop: { run: mockRun },
}));

import { run } from '../../../src/index.js';

const freshCode = `
const zipFreshMarker = 'fresh-zip-payload-vx7q92';
let particles = [];
function setup() {
  createCanvas(400, 400);
  for (let i = 0; i < 40; i++) {
    particles.push({ x: random(width), y: random(height), s: random(4, 18) });
  }
}
function draw() {
  background(18, 24, 34);
  fill(120, 220, 255);
  noStroke();
  for (const p of particles) {
    circle(p.x, p.y, p.s);
    p.x = (p.x + 0.7) % width;
    p.y = (p.y + 0.4) % height;
  }
  text(zipFreshMarker, 20, height - 20);
}
// ${'fresh zip payload texture '.repeat(30)}
`;

const staleCode = `
const zipStaleMarker = 'stale-gallery-payload-not-this-run';
function setup() { createCanvas(400, 400); }
function draw() {
  background(250, 220, 180);
  fill(80, 20, 20);
  text(zipStaleMarker, 20, 40);
}
// ${'stale gallery payload texture '.repeat(30)}
`;

describe('run() zip export payload', () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sinter-run-zip-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    mockRun.mockReset();
    mockRun.mockResolvedValue({
      code: freshCode,
      iterations: 1,
      completed: true,
      reason: 'Quality threshold met',
      timestamp: new Date().toISOString(),
      duration: 100,
      finalScore: 0.91,
      project: 'zip-test',
    });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('builds the runnable zip payload from this run, not stale higher-version gallery history', async () => {
    const galleryDir = join(tempDir, '.sinter', 'gallery');
    const staleProjectDir = join(galleryDir, '2026-06-16--zip-test');
    mkdirSync(staleProjectDir, { recursive: true });
    const stalePath = join(staleProjectDir, 'v6.js');
    writeFileSync(stalePath, staleCode);
    const staleTime = new Date('2026-06-16T00:00:00.000Z');
    utimesSync(stalePath, staleTime, staleTime);

    const result = await run('fresh zip payload regression', {
      output: join(tempDir, '.sinter', 'out'),
      galleryDir,
      project: 'zip-test',
      maxIterations: 1,
    });

    const sketch = execFileSync('unzip', ['-p', result.zipPath!, 'sketch.js'], { encoding: 'utf8' });
    const projectJson = JSON.parse(execFileSync('unzip', ['-p', result.zipPath!, 'project.json'], { encoding: 'utf8' })) as { iterationsCount: number };

    expect(sketch).toContain('fresh-zip-payload-vx7q92');
    expect(sketch).not.toContain('stale-gallery-payload-not-this-run');
    expect(projectJson.iterationsCount).toBe(1);
  });

  it('persists source, playable, and digest manifest before the loop evaluates', async () => {
    let persistedBeforeReturn = false;
    const validatedCode = CodeValidator.validate(freshCode, 'p5').cleanedCode;
    mockRun.mockImplementationOnce(async (_prompt, options) => {
      await options.onCandidateGenerated({
        iteration: 1,
        candidateIndex: 0,
        kind: 'initial',
        code: validatedCode,
      });
      await options.onRenderedEvidence({
        iteration: 1, candidateIndex: 0, kind: 'initial', code: validatedCode,
        evidence: {
          timingMs: 10, infraUnavailable: false, candidateFailure: false,
          screenshot: { mimeType: 'image/png', dataBase64: Buffer.from('early').toString('base64') },
          lateScreenshot: { mimeType: 'image/png', dataBase64: Buffer.from('late').toString('base64') },
          errors: [],
        },
      });
      persistedBeforeReturn = true;
      return {
        code: freshCode,
        iterations: 1,
        completed: true,
        reason: 'Quality threshold met',
        timestamp: new Date().toISOString(),
        duration: 100,
        finalScore: 0.91,
        evaluationConfidence: 0.88,
        evaluationFailureClass: 'none',
        evaluation: {
          score: 0.91, confidence: 0.88, failureClass: 'none',
          reasoning: 'Rendered hierarchy is coherent.',
          dimensionScores: { cohesion: 0.92, finish: 0.9 },
          repairAdvice: { issue: 'Finish is soft.', fix: 'Sharpen focal detail.', constraint: 'Preserve hierarchy.' },
          renderMeasure: { verdict: 'ok', meanLuminance: 0.4, brightFraction: 0.2, darkFraction: 0.3 },
          calibrationDigest: 'a'.repeat(64),
        },
      };
    });

    const result = await run('persist before rendered evaluation', {
      output: join(tempDir, '.sinter', 'out'),
      galleryDir: join(tempDir, '.sinter', 'gallery'),
      project: 'pre-eval-test',
      maxIterations: 1,
      requirePreEvaluationPersistence: true,
    });

    expect(persistedBeforeReturn).toBe(true);
    expect(result.preEvaluationArtifact).toMatchObject({ sourcePath: expect.any(String), playablePath: expect.any(String), manifestPath: expect.any(String) });
    expect(existsSync(result.preEvaluationArtifact!.sourcePath)).toBe(true);
    expect(existsSync(result.preEvaluationArtifact!.playablePath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.preEvaluationArtifact!.manifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      artifactDigest: result.artifactDigest,
      sourceDigest: result.preEvaluationArtifact!.sourceDigest,
      playableDigest: result.preEvaluationArtifact!.playableDigest,
    });
    expect(result.renderedEvidenceArtifact).toMatchObject({ earlyFramePath: expect.any(String), lateFramePath: expect.any(String), receiptPath: expect.any(String) });
    expect(existsSync(result.renderedEvidenceArtifact!.earlyFramePath)).toBe(true);
    expect(existsSync(result.renderedEvidenceArtifact!.lateFramePath)).toBe(true);
    expect(existsSync(result.renderedEvidenceArtifact!.receiptPath)).toBe(true);
    expect(existsSync(result.renderedEvidenceArtifact!.evaluationReceiptPath!)).toBe(true);
    const evaluationReceipt = JSON.parse(readFileSync(
      result.renderedEvidenceArtifact!.evaluationReceiptPath!, 'utf8'));
    expect(evaluationReceipt).toMatchObject({
      reasoning: 'Rendered hierarchy is coherent.',
      dimensionScores: { cohesion: 0.92, finish: 0.9 },
      repairAdvice: { issue: 'Finish is soft.' },
      renderMeasure: { verdict: 'ok', meanLuminance: 0.4 },
      calibrationDigest: 'a'.repeat(64),
    });
  });
});
