/**
 * Behavioral tests for the revideo path through Exporter.exportVideo().
 *
 * Unlike Exporter.video.test.ts (which mocks RevideoRenderer to test domain
 * routing), this suite exercises the REAL RevideoRenderer so it asserts the
 * actual end-to-end wiring:
 *
 *   - DEFAULT options  -> Exporter.exportVideo() drives the canvas-capture path
 *                         (esbuild bundle -> headless browser -> ffmpeg stitch)
 *                         and produces an mp4, never touching the upstream
 *                         @revideo renderVideo().
 *   - allowUpstreamRenderer: true -> the call reaches the upstream renderVideo()
 *                         boundary (mocked so no real render happens).
 *
 * The heavy browser (puppeteer) and ffmpeg (VideoExporter) boundaries are mocked
 * so the test asserts path selection + wiring without a real browser/ffmpeg.
 * esbuild is left real (fast, local, deterministic). Output goes inside the repo
 * so VideoExporter's path sanitizer accepts it.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const mockRenderVideo = vi.hoisted(() => vi.fn(async () => ({ duration: 5 })));
const mockFramesToVideo = vi.hoisted(() => vi.fn(async () => {}));
const mockScreenshot = vi.hoisted(() => vi.fn(async () => {}));
const mockLaunch = vi.hoisted(() =>
  vi.fn(async () => ({
    newPage: async () => ({
      setViewport: async () => {},
      on: () => {},
      goto: async () => {},
      waitForFunction: async () => {},
      evaluate: async (fn: unknown) => {
        if (typeof fn === 'function' && fn.toString().includes('__sinter')) {
          return { ready: true, total: 2, error: null };
        }
        return undefined;
      },
      $: async () => ({ screenshot: mockScreenshot }),
    }),
    close: async () => {},
  })),
);

vi.mock('@revideo/renderer', () => ({ renderVideo: mockRenderVideo }));
vi.mock('puppeteer', () => ({ default: { launch: mockLaunch } }));
vi.mock('../../../src/export/VideoExporter.js', () => ({
  VideoExporter: class {
    framesToVideo = mockFramesToVideo;
  },
}));

// Stop the temp-project npm install (execSync) from actually running, while
// keeping the rest of child_process real so other transitive importers still load.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});

// The capability detector probes node_modules for @revideo/*; treat it as a
// satisfied boundary so the test asserts threading behavior, not whether the
// optional deps happen to be installed in this environment.
vi.mock('../../../src/render/VideoCapabilityDetector.js', () => ({
  VideoCapabilityDetector: { require: vi.fn() },
}));

import { Exporter } from '../../../src/export/Exporter.js';

const SCENE_CODE = `
import { makeScene2D, Rect } from '@revideo/2d';
import { createRef, waitFor } from '@revideo/core';

export default makeScene2D("OptInScene", function* (view) {
  const rect = createRef<Rect>();
  view.add(<Rect ref={rect} width={400} height={300} fill={'blue'} />);
  yield* waitFor(1);
});
`;

// Repo-local temp dir so VideoExporter's path sanitizer (cwd-scoped) accepts the
// output path on the capture path.
const REPO_TMP = path.resolve(process.cwd(), 'artifacts', 'test-tmp-revideo-export');

describe('Exporter.exportVideo revideo (real RevideoRenderer)', () => {
  let exporter: Exporter;
  let tempDir: string;

  beforeEach(async () => {
    mockRenderVideo.mockClear();
    mockRenderVideo.mockResolvedValue({});
    mockFramesToVideo.mockClear();
    mockScreenshot.mockClear();
    mockLaunch.mockClear();
    exporter = new Exporter();
    await fs.mkdir(REPO_TMP, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(REPO_TMP, 'exporter-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(REPO_TMP, { recursive: true, force: true }).catch(() => {});
  });

  it('drives the canvas-capture path and produces an mp4 for revideo with default options', async () => {
    const outputPath = path.join(tempDir, 'default.mp4');

    await exporter.exportVideo(SCENE_CODE, outputPath, { domain: 'revideo' });

    // Default path: headless browser capture + ffmpeg stitch, no upstream renderer.
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(mockScreenshot).toHaveBeenCalledTimes(2); // 2 frames per the mocked harness
    expect(mockFramesToVideo).toHaveBeenCalledTimes(1);
    const [, stitchedOut] = mockFramesToVideo.mock.calls[0];
    expect(stitchedOut).toBe(outputPath);
    expect(mockRenderVideo).not.toHaveBeenCalled();
  });

  it('reaches the upstream renderer when allowUpstreamRenderer: true', async () => {
    const outputPath = path.join(tempDir, 'optin.mp4');

    await exporter.exportVideo(SCENE_CODE, outputPath, {
      domain: 'revideo',
      allowUpstreamRenderer: true,
    });

    expect(mockRenderVideo).toHaveBeenCalledTimes(1);
    const callArg = mockRenderVideo.mock.calls[0][0] as {
      projectFile: string;
      settings: { outFile: string };
    };
    expect(callArg.projectFile).toBe('./src/project.ts');
    expect(callArg.settings.outFile).toBe('optin.mp4');
    // Opt-in path must NOT use the canvas-capture machinery.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockFramesToVideo).not.toHaveBeenCalled();
  });
});
