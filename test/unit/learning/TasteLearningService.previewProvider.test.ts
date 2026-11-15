import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SinterFS } from '../../../src/fs/SinterFS.js';
import { resolveSinterProjectRoot } from '../../../src/fs/projectRoot.js';
import {
  TasteLearningService,
  createRenderedPreviewProvider,
  type NimaScorer,
} from '../../../src/learning/TasteLearningService.js';
import type { SinterObjectRef } from '../../../src/fs/types.js';
import type { ArchiveEntry } from '../../../src/emergence/types.js';

// ── Module mocks ────────────────────────────────────────────────────────────
// The default provider renders via HeadlessRenderer and logs through Logger.
// Both are mocked so the unit tests stay hermetic (no real browser, no console
// noise) while still exercising the provider's real control flow.

const { mockDetectDomain, mockRender, mockGetInstance } = vi.hoisted(() => ({
  mockDetectDomain: vi.fn(),
  mockRender: vi.fn(),
  mockGetInstance: vi.fn(),
}));

vi.mock('../../../src/render/HeadlessRenderer.js', () => ({
  HeadlessRenderer: {
    getInstance: mockGetInstance,
    detectDomain: mockDetectDomain,
  },
}));

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: {
    warn: mockWarn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Builds an in-memory NimaScorer stub. Default: available, returns score 7.5. */
function makeNimaStub(opts: { available?: boolean; score?: number | null } = {}): NimaScorer {
  const available = opts.available ?? true;
  const scoreValue = opts.score === undefined ? 7.5 : opts.score;
  return {
    isAvailable: async () => available,
    score: async () => (scoreValue === null ? null : { score: scoreValue }),
  };
}

/**
 * Writes `code` as a real artifact through SinterFS and returns an ArchiveEntry
 * whose artifactRef resolves to that content — so the default provider's
 * `sinterFs.readArtifact(entry.artifactRef)` returns the code exactly as it
 * would in production.
 */
function makeEntryWithCode(
  sinterFs: SinterFS,
  id: string,
  code: string,
  qualityScore: number,
): ArchiveEntry {
  const ref: SinterObjectRef = sinterFs.writeArtifact({
    content: code,
    filename: `${id}.js`,
    kind: 'generated-code',
  });
  return {
    id,
    artifactRef: ref,
    descriptor: {
      values: [
        { axis: 'order-chaos', value: 0.5 },
        { axis: 'sparse-dense', value: 0.5 },
      ],
      source: 'test',
      extractedAt: '2026-01-01T00:00:00.000Z',
    },
    lineage: {
      artifactId: id,
      parentIds: [],
      provenance: 'fresh-generation',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    qualityScore,
    signals: {
      novelty: 0.5,
      structure: 0.5,
      temporalRichness: 0.5,
      perturbationResilience: 0.5,
      fertility: 0.5,
      aesthetic: 0.5,
    },
    archivedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeScreenshotBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
}

describe('createRenderedPreviewProvider — default rendered preview', () => {
  let tmpRoot: string;
  let savedRoot: string | undefined;
  let sinterFs: SinterFS;

  beforeEach(() => {
    savedRoot = process.env.SINTER_PROJECT_ROOT;
    tmpRoot = mkdtempSync(join(tmpdir(), 'taste-preview-provider-test-'));
    process.env.SINTER_PROJECT_ROOT = tmpRoot;
    sinterFs = SinterFS.open(resolveSinterProjectRoot());

    mockDetectDomain.mockReset();
    mockRender.mockReset();
    mockGetInstance.mockReset();
    mockWarn.mockReset();
    // Default getInstance returns an object whose render() is mockRender.
    mockGetInstance.mockReturnValue({ render: mockRender });
  });

  afterEach(() => {
    sinterFs.close();
    if (savedRoot !== undefined) process.env.SINTER_PROJECT_ROOT = savedRoot;
    else delete process.env.SINTER_PROJECT_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the screenshot buffer on a successful render', async () => {
    const provider = createRenderedPreviewProvider(sinterFs);
    const entry = makeEntryWithCode(sinterFs, 'a', 'function setup() { createCanvas(10,10); }', 0.5);

    mockDetectDomain.mockReturnValue('p5');
    mockRender.mockResolvedValue({
      success: true,
      screenshot: { buffer: makeScreenshotBuffer(), width: 400, height: 400, success: true },
      logs: [],
      errors: [],
    });

    const preview = await provider(entry);

    expect(preview).toBeInstanceOf(Buffer);
    expect(preview?.equals(makeScreenshotBuffer())).toBe(true);
    expect(mockRender).toHaveBeenCalledTimes(1);
    // Visual domain → no warning logged.
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('skips non-visual domains silently (no render, no warning)', async () => {
    const provider = createRenderedPreviewProvider(sinterFs);
    // Tone code — an audio domain with no screenshot to score.
    const entry = makeEntryWithCode(sinterFs, 'a', 'const synth = new Tone.Synth()', 0.5);

    mockDetectDomain.mockReturnValue('tone');

    const preview = await provider(entry);

    expect(preview).toBeNull();
    // Provider short-circuited before touching the renderer.
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('logs a warning and returns null when the render fails (success:false)', async () => {
    const provider = createRenderedPreviewProvider(sinterFs);
    const entry = makeEntryWithCode(sinterFs, 'a', 'function setup() {}', 0.5);

    mockDetectDomain.mockReturnValue('p5');
    mockRender.mockResolvedValue({
      success: false,
      error: 'canvas never appeared',
      screenshot: undefined,
      logs: [],
      errors: ['canvas never appeared'],
    });

    const preview = await provider(entry);

    expect(preview).toBeNull();
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    // Warning names the entry id and the failure so operators can trace it.
    expect(mockWarn).toHaveBeenCalledWith(
      'TasteLearningService',
      expect.stringContaining('Preview render failed for archive entry a'),
    );
  });

  it('logs a warning and returns null when the renderer throws', async () => {
    const provider = createRenderedPreviewProvider(sinterFs);
    const entry = makeEntryWithCode(sinterFs, 'a', 'function setup() {}', 0.5);

    mockDetectDomain.mockReturnValue('p5');
    mockRender.mockRejectedValue(new Error('Failed to initialize headless browser: no chromium'));

    const preview = await provider(entry);

    expect(preview).toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'TasteLearningService',
      expect.stringContaining('Preview render threw for archive entry a'),
    );
  });

  it('logs a warning and returns null when the artifact content is missing', async () => {
    const provider = createRenderedPreviewProvider(sinterFs);
    // Entry whose artifactRef hash points at nothing stored.
    const entry: ArchiveEntry = {
      id: 'ghost',
      artifactRef: { kind: 'generated-code', uri: 'sinter://artifact/ghost', hash: 'nonexistent-hash' },
      descriptor: {
        values: [{ axis: 'order-chaos', value: 0.5 }, { axis: 'sparse-dense', value: 0.5 }],
        source: 'test',
        extractedAt: '2026-01-01T00:00:00.000Z',
      },
      lineage: { artifactId: 'ghost', parentIds: [], provenance: 'fresh-generation', createdAt: '2026-01-01T00:00:00.000Z' },
      qualityScore: 0.5,
      signals: { novelty: 0.5, structure: 0.5, temporalRichness: 0.5, perturbationResilience: 0.5, fertility: 0.5, aesthetic: 0.5 },
      archivedAt: '2026-01-01T00:00:00.000Z',
    };

    const preview = await provider(entry);

    expect(preview).toBeNull();
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'TasteLearningService',
      expect.stringContaining('No artifact content for archive entry ghost'),
    );
  });
});

describe('TasteLearningService — default preview provider wired through enrichment', () => {
  let tmpRoot: string;
  let savedRoot: string | undefined;
  let sinterFs: SinterFS;

  beforeEach(() => {
    savedRoot = process.env.SINTER_PROJECT_ROOT;
    tmpRoot = mkdtempSync(join(tmpdir(), 'taste-preview-service-test-'));
    process.env.SINTER_PROJECT_ROOT = tmpRoot;
    sinterFs = SinterFS.open(resolveSinterProjectRoot());

    mockDetectDomain.mockReset();
    mockRender.mockReset();
    mockGetInstance.mockReset();
    mockWarn.mockReset();
    mockGetInstance.mockReturnValue({ render: mockRender });
  });

  afterEach(() => {
    sinterFs.close();
    if (savedRoot !== undefined) process.env.SINTER_PROJECT_ROOT = savedRoot;
    else delete process.env.SINTER_PROJECT_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('NIMA unavailable → never renders, falls back to existing qualityScore', async () => {
    const entry = makeEntryWithCode(sinterFs, 'a', 'function setup() { createCanvas(10,10); }', 0.8);
    // No previewProvider passed → default (rendered) provider is in effect.
    const service = new TasteLearningService(sinterFs, { nima: makeNimaStub({ available: false }) });

    const enriched = await service.enrichArchiveWithNima([entry]);

    // The upfront availability gate short-circuits before any rendering.
    expect(mockRender).not.toHaveBeenCalled();
    expect(enriched[0].qualityScore).toBe(0.8);
    expect(enriched[0].nimaScore).toBeUndefined();
  });

  it('render failure → falls back to existing qualityScore (no nimaScore)', async () => {
    const entry = makeEntryWithCode(sinterFs, 'a', 'function setup() { createCanvas(10,10); }', 0.8);
    mockDetectDomain.mockReturnValue('p5');
    mockRender.mockResolvedValue({
      success: false,
      error: 'boom',
      screenshot: undefined,
      logs: [],
      errors: ['boom'],
    });

    const service = new TasteLearningService(sinterFs, { nima: makeNimaStub({ available: true, score: 9 }) });
    const enriched = await service.enrichArchiveWithNima([entry]);

    expect(mockRender).toHaveBeenCalledTimes(1);
    // Preview was null → NIMA.score never invoked → entry unchanged.
    expect(enriched[0].qualityScore).toBe(0.8);
    expect(enriched[0].nimaScore).toBeUndefined();
    // One warn for the render failure, one for the incomplete enrichment.
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(String(mockWarn.mock.calls[1][1])).toContain('NIMA enrichment incomplete');
  });

  it('successful render → qualityScore overridden by nimaScore/10', async () => {
    const entries = [
      makeEntryWithCode(sinterFs, 'a', 'function setup() { createCanvas(10,10); }', 0.8),
      makeEntryWithCode(sinterFs, 'b', 'function setup() { createCanvas(10,10); }', 0.4),
    ];
    mockDetectDomain.mockReturnValue('p5');
    mockRender.mockResolvedValue({
      success: true,
      screenshot: { buffer: makeScreenshotBuffer(), width: 400, height: 400, success: true },
      logs: [],
      errors: [],
    });

    const service = new TasteLearningService(sinterFs, { nima: makeNimaStub({ available: true, score: 7.5 }) });
    const enriched = await service.enrichArchiveWithNima(entries);

    expect(mockRender).toHaveBeenCalledTimes(2);
    for (const e of enriched) {
      expect(e.qualityScore).toBeCloseTo(0.75, 5);
      expect(e.nimaScore).toBe(7.5);
    }
    // Original entries are not mutated.
    expect(entries[0].qualityScore).toBe(0.8);
    expect(entries[0].nimaScore).toBeUndefined();
    // No warnings on the happy path.
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
