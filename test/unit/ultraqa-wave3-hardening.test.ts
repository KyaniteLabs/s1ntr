import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VideoExporter, PathSanitizationError } from '../../src/export/VideoExporter.js';
import { Exporter } from '../../src/export/Exporter.js';
import { sweepRejects } from '../../src/atelier/RejectRescue.js';
import { validateMatchedKnowledgeComparison } from '../../src/dreaming/research/DreamKnowledgeActivation.js';
import { QualityArchive } from '../../src/learning/QualityArchive.js';
import { Gallery } from '../../src/gallery/Gallery.js';
import { MapElites } from '../../src/evolution/MapElites.js';
import { NoveltyArchive } from '../../src/evolution/NoveltyArchive.js';
import { crossoverReasoning } from '../../src/evolution/CrossDomainCrossover.js';

describe('UltraQA Wave 3 hardening regressions', () => {
  it('VideoExporter blocks directory traversal, fixes GIF filtergraph syntax, and rejects invalid dimensions/fps', async () => {
    const exporter = new VideoExporter();
    await expect(exporter.extractFrames('in.mp4', '/etc/cron.d/frames', 24)).rejects.toThrow(PathSanitizationError);
    await expect(exporter.framesToVideo('/etc/cron.d/frames', 'out.mp4', 24)).rejects.toThrow(PathSanitizationError);

    const gifArgs = exporter.buildConvertArgs('in.mp4', 'out.gif', 'gif');
    expect(gifArgs).not.toContain('-palettegen');
    expect(gifArgs.join(' ')).toContain('[s0]palettegen[p];[s1][p]paletteuse');

    expect(() => exporter.buildResizeArgs('in.mp4', 'out.mp4', -1, 100)).toThrow(/Invalid video resize dimensions/);
    expect(() => exporter.buildExtractFramesArgs('in.mp4', 'frames', Number.NaN)).toThrow(/Invalid fps/);
    expect(() => new VideoExporter({ deadlineAt: Number.NaN })).toThrow(/finite epoch timestamp/);
  });

  it('Exporter.exportZIP rejects Zip Slip iteration versions and exportJS handles lowercase doctype', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's1ntr-w3-export-'));
    try {
      const exporter = new Exporter();
      await expect(exporter.exportZIP({
        name: 'proj',
        iterations: [{ version: '../../evil' as unknown as number, code: 'x', timestamp: '' }],
      }, path.join(dir, 'out.zip'))).rejects.toThrow(/Invalid iteration version/);

      const jsPath = path.join(dir, 'sketch.js');
      await exporter.exportJS(
        '<!doctype html><html><head><meta charset="utf-8"><title>test</title></head><body><canvas id="c"></canvas><script>function setup(){createCanvas(100,100);noFill();} function draw(){background(0);ellipse(50,50,20,20);}</script></body></html>',
        jsPath,
      );
      const { readFileSync } = await import('node:fs');
      const written = readFileSync(jsPath, 'utf8');
      expect(written).toContain('createCanvas(100,100)');
      expect(written).not.toContain('<!doctype');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RejectRescue.sweepRejects succeeds on fresh dirs and sanitizes traversal IDs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's1ntr-w3-rescue-'));
    try {
      const failuresDir = path.join(dir, 'failures');
      const poolDir = path.join(dir, 'pool');
      const lessonsDir = path.join(dir, 'fresh-lessons');
      mkdirSync(failuresDir, { recursive: true });
      writeFileSync(path.join(failuresDir, 'f1.json'), JSON.stringify({
        id: '../../../tmp/pwn',
        timestamp: '2026-11-23T00:00:00Z',
        domain: 'p5',
        code: 'function setup() { createCanvas(400, 400); }\nfunction draw() { background(10); ellipse(200, 200, 50, 50); }\n// padding to pass minimum length checks cleanly',
      }));
      const res = await sweepRejects(dir, {
        failuresDir,
        poolDir,
        watermarkPath: path.join(lessonsDir, 'watermark.txt'),
        patternsPath: path.join(lessonsDir, 'patterns.json'),
        stagingPath: path.join(lessonsDir, 'staging.json'),
      });
      expect(res.scanned).toBe(1);
      expect(res.salvaged).toHaveLength(1);
      expect(existsSync(path.join(lessonsDir, 'patterns.json'))).toBe(true);
      const poolFiles = readdirSync(poolDir);
      expect(poolFiles.length).toBe(2);
      expect(poolFiles.every(f => !f.includes('..') && !f.includes('/'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DreamKnowledgeActivation sign test does not overflow to p=0 at n=1024 and rejects duplicate taskIds', () => {
    const digest = 'a'.repeat(64);
    const trials = Array.from({ length: 1024 }, (_, i) => ({
      taskId: `task-${i}`,
      treatmentScore: i < 513 ? 0.9 : 0.4,
      controlScore: 0.6,
      receipt: {
        snapshotDigest: digest,
        prePlanDigest: 'b'.repeat(64),
        postPlanDigest: 'c'.repeat(64),
        transformationDelta: 'delta',
      },
    }));
    const res = validateMatchedKnowledgeComparison({
      snapshotDigest: digest,
      frozenAssignmentDigest: 'd'.repeat(64),
      trials,
    });
    expect(res.signTestPValue).toBeGreaterThan(0.4);
    expect(res.statisticallyConfirmed).toBe(false);

    // Duplicate taskId must be rejected
    expect(() => validateMatchedKnowledgeComparison({
      snapshotDigest: digest,
      frozenAssignmentDigest: 'd'.repeat(64),
      trials: [trials[0], trials[1], { ...trials[0] }],
    })).toThrow('KNOWLEDGE_MATCHED_MULTI_TASK_REQUIRED');
  });

  it('QualityArchive rejects NaN scores and filters teaching eligibility before slicing limit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's1ntr-w3-qa-'));
    try {
      const archive = new QualityArchive(path.join(dir, 'archive.json'));
      await expect(archive.add({
        id: 'bad',
        domain: 'p5',
        prompt: 'p',
        output: 'o',
        qualityScore: Number.NaN,
        createdAt: new Date().toISOString(),
        usedCount: 0,
      })).rejects.toThrow(/non-finite qualityScore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Gallery.loadHistory does not collide on suffix substrings and cleanupOldProjects enforces maxAgeDays', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's1ntr-w3-gal-'));
    try {
      const gallery = new Gallery(dir);
      await gallery.saveIteration('foo--art', 1, 'function setup() { createCanvas(100,100); } function draw() {}');
      await gallery.saveIteration('art', 1, 'function setup() { createCanvas(200,200); } function draw() {}');
      const artHistory = await gallery.loadHistory('art');
      expect(artHistory).toHaveLength(1);
      expect(artHistory[0].code).toContain('200,200');

      const oldDir = path.join(dir, '2020-01-01--ancient');
      mkdirSync(oldDir, { recursive: true });
      const oldTime = new Date('2020-01-01T00:00:00Z');
      utimesSync(oldDir, oldTime, oldTime);
      const archived = await gallery.cleanupOldProjects(100, 90);
      expect(archived).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MapElites rejects NaN and returns full count in getDiverseElite; NoveltyArchive guards k<=0; CrossDomainCrossover blocks prototype keys', () => {
    const grid = new MapElites([10, 10]);
    expect(grid.insert('nan-cell', [0.5, 0.5], Number.NaN)).toBe(false);
    for (let i = 0; i < 10; i++) {
      grid.insert(`c${i}`, [i / 10, i / 10], 0.5 + i * 0.04);
    }
    expect(grid.getDiverseElite(6)).toHaveLength(6);

    const novelty = new NoveltyArchive(0, 0);
    expect(novelty.add([0.2, 0.3])).toBe(true);
    expect(Number.isFinite(novelty.assess([0.4, 0.5]).score)).toBe(true);
    expect(novelty.retrieveNovelFromReference([], 3)).toEqual([]);

    const crossed = crossoverReasoning('music', 'visual', 'toString', { constructor: 'keep' });
    expect(crossed.transferredTechniques).toEqual(['toString_as_visual']);
    expect(crossed.adaptedDecisions.constructor).toBe('keep');
  });
});
