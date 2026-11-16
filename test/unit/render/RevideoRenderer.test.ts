import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

// ── Hoisted mocks ──────────────────────────────────────────────────
// Upstream renderer boundary (opt-in path only).
const mockRenderVideo = vi.hoisted(() => vi.fn(async () => ({ duration: 5 })));

// Heavy capture-path boundaries: puppeteer (browser) and VideoExporter (ffmpeg)
// are mocked so we assert the capture path is selected and wired without running
// a real browser or ffmpeg. esbuild is NOT mocked: it is fast, fully local, and
// deterministic, so the real bundler runs and proves the harness compiles.
const mockFramesToVideo = vi.hoisted(() => vi.fn(async () => {}));
const mockScreenshot = vi.hoisted(() => vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
// The page fence: what the renderer installed, in order, and its request handler.
const pageCalls = vi.hoisted(() => ({ order: [] as string[], seeks: [] as number[],
  onRequest: undefined as undefined | ((r: unknown) => void) }));
const mockBrowserClose = vi.hoisted(() => vi.fn(async () => {}));
// Default harness state: ready with 3 frames so the capture loop captures 3.
const harnessState = vi.hoisted(() => ({ ready: true, totalFrames: 3, error: null as string | null }));
const mockLaunch = vi.hoisted(() =>
  vi.fn(async () => ({
    newPage: async () => ({
      setViewport: async () => {},
      setRequestInterception: async () => { pageCalls.order.push('intercept'); },
      evaluateOnNewDocument: async () => { pageCalls.order.push('guards'); },
      on: (event: string, handler: (r: unknown) => void) => { if (event === 'request') pageCalls.onRequest = handler; },
      goto: async () => { pageCalls.order.push('goto'); },
      waitForFunction: async () => {},
      evaluate: async (fn: unknown, arg?: unknown) => {
        // First evaluate() reads harness state; later ones drive seekAndRender.
        if (typeof fn === 'function' && fn.toString().includes('__sinter') && arg === undefined) {
          return { ready: harnessState.ready, total: harnessState.totalFrames, error: harnessState.error };
        }
        if (typeof arg === 'number') pageCalls.seeks.push(arg);
        return undefined;
      },
      $: async () => ({ screenshot: mockScreenshot }),
    }),
    close: mockBrowserClose,
  })),
);

vi.mock('@revideo/renderer', () => ({ renderVideo: mockRenderVideo }));

vi.mock('puppeteer', () => ({ default: { launch: mockLaunch } }));
const mockResolve = vi.hoisted(() => vi.fn(() => '/opt/chromium' as string | null));
vi.mock('../../../src/utils/browserAssetFallbacks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/browserAssetFallbacks.js')>()),
  resolveChromiumExecutablePath: mockResolve,
}));

vi.mock('../../../src/export/VideoExporter.js', () => ({
  VideoExporter: class {
    framesToVideo = mockFramesToVideo;
  },
}));

// Stop the temp-project npm install (execSync) from really running while keeping
// the rest of child_process real.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});

// ── System under test ──────────────────────────────────────────────
import { HARNESS_ORIGIN, harnessFilePath, RevideoRenderer } from '../../../src/render/RevideoRenderer.js';

const SCENE_CODE = `
import { makeScene2D, Rect } from '@revideo/2d';
import { createRef, waitFor } from '@revideo/core';

export default makeScene2D("SmokeScene", function* (view) {
  const rect = createRef<Rect>();
  view.add(<Rect ref={rect} width={400} height={300} fill={'blue'} />);
  yield* rect().scale(2, 1);
  yield* waitFor(3);
});
`;

describe('RevideoRenderer', () => {
  let renderer: RevideoRenderer;
  let tempDir: string;

  beforeEach(async () => {
    mockRenderVideo.mockClear();
    mockFramesToVideo.mockClear();
    mockScreenshot.mockClear();
    mockLaunch.mockClear();
    mockResolve.mockReturnValue('/opt/chromium');
    mockBrowserClose.mockClear();
    harnessState.ready = true;
    harnessState.totalFrames = 3;
    harnessState.error = null;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rev-test-'));
    renderer = new RevideoRenderer({ tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('renders via the canvas-capture path by default (no upstream renderer)', async () => {
    const outputPath = path.join(tempDir, 'out.mp4');

    const result = await renderer.render(SCENE_CODE, outputPath, { fps: 30, width: 640, height: 360 });

    // Default path bundles a harness (real esbuild), launches a browser,
    // captures frames, and stitches via ffmpeg — never touching renderVideo().
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(mockScreenshot).toHaveBeenCalledTimes(3); // one per captured frame
    expect(mockFramesToVideo).toHaveBeenCalledTimes(1);
    expect(mockRenderVideo).not.toHaveBeenCalled();

    // Result reflects the captured frame count (3 frames @ 30fps = 0.1s).
    expect(result.outputPath).toBe(outputPath);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
    expect(result.format).toBe('mp4');
    expect(result.duration).toBeCloseTo(0.1, 5);
  });

  it('stitches the captured frames to the requested mp4 path via VideoExporter', async () => {
    const outputPath = path.join(tempDir, 'nested', 'clip.mp4');

    await renderer.render(SCENE_CODE, outputPath, { fps: 24, width: 320, height: 240 });

    expect(mockFramesToVideo).toHaveBeenCalledTimes(1);
    const [framesDir, out, fps] = mockFramesToVideo.mock.calls[0];
    expect(out).toBe(outputPath);
    expect(fps).toBe(24);
    expect(String(framesDir)).toContain('revideo-capture-');
  });

  it('throws a clear error when the harness fails to initialize', async () => {
    harnessState.ready = false;
    harnessState.error = 'boom: scene threw';
    const outputPath = path.join(tempDir, 'out.mp4');

    await expect(renderer.render(SCENE_CODE, outputPath)).rejects.toThrow(
      'Revideo harness failed to initialize: boom: scene threw',
    );
    expect(mockFramesToVideo).not.toHaveBeenCalled();
    expect(mockBrowserClose).toHaveBeenCalledTimes(1); // browser still closed
  });

  it('returns VideoRenderResult from the upstream path when allowUpstreamRenderer is true', async () => {
    const outputPath = path.join(tempDir, 'out.mp4');
    mockRenderVideo.mockResolvedValue({});

    const result = await renderer.render(SCENE_CODE, outputPath, {
      fps: 30,
      width: 1920,
      height: 1080,
      allowUpstreamRenderer: true,
    });

    expect(mockRenderVideo).toHaveBeenCalledTimes(1);
    // Opt-in path must NOT use the canvas-capture machinery.
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(mockFramesToVideo).not.toHaveBeenCalled();
    expect(result.outputPath).toBe(outputPath);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.format).toBe('mp4');
    expect(result.duration).toBeGreaterThan(0);
  });

  it('throws with install instructions when @revideo/renderer is missing (opt-in path)', async () => {
    vi.resetModules();
    vi.doMock('@revideo/renderer', () => {
      throw new Error('Cannot find module @revideo/renderer');
    });
    vi.doMock('child_process', () => ({ execSync: vi.fn() }));

    const { RevideoRenderer: FreshRenderer } = await import(
      '../../../src/render/RevideoRenderer.js'
    );
    const freshRenderer = new FreshRenderer({ tempDir });
    const outputPath = path.join(tempDir, 'out.mp4');

    await expect(
      freshRenderer.render(SCENE_CODE, outputPath, { allowUpstreamRenderer: true })
    ).rejects.toThrow('@revideo/vite-plugin');

    // Restore
    vi.resetModules();
    vi.doMock('@revideo/renderer', () => ({ renderVideo: mockRenderVideo }));
    vi.doMock('child_process', () => ({ execSync: vi.fn() }));
    await import('../../../src/render/RevideoRenderer.js');
  });

  it('writeProject creates proper Revideo project structure', async () => {
    const projectDir = await renderer.writeProject(SCENE_CODE);

    const sceneFile = path.join(projectDir, 'src', 'scenes', 'scene.tsx');
    const projectFile = path.join(projectDir, 'src', 'project.ts');
    const packageFile = path.join(projectDir, 'package.json');
    const tsconfigFile = path.join(projectDir, 'tsconfig.json');
    const viteConfigFile = path.join(projectDir, 'vite.config.ts');

    const sceneContent = await fs.readFile(sceneFile, 'utf-8');
    expect(sceneContent).toBe(SCENE_CODE);

    const projectContent = await fs.readFile(projectFile, 'utf-8');
    expect(projectContent).toContain('makeProject');
    expect(projectContent).toContain("import scene from './scenes/scene?scene'");
    expect(projectContent).toContain('shared: { size: { x: 1920, y: 1080 } }');
    expect(projectContent).toContain('rendering: { fps: 30 }');

    const viteConfigContent = await fs.readFile(viteConfigFile, 'utf-8');
    expect(viteConfigContent).toContain('@revideo/vite-plugin');
    expect(viteConfigContent).toContain('./src/project.ts');
    expect(viteConfigContent).toContain('revideo-editor-resolver');
    expect(viteConfigContent).toContain('EDITOR_STUB');

    const pkg = JSON.parse(await fs.readFile(packageFile, 'utf-8'));
    expect(pkg.dependencies['@revideo/core']).toBe('^0.10.4');
    expect(pkg.dependencies['@revideo/renderer']).toBe('^0.10.4');
    expect(pkg.dependencies['@revideo/vite-plugin']).toBe('^0.10.4');
    expect(pkg.dependencies['@revideo/ui']).toBe('^0.10.4');
    expect(pkg.type).toBe('module');

    const tsconfig = JSON.parse(await fs.readFile(tsconfigFile, 'utf-8'));
    expect(tsconfig.compilerOptions.jsx).toBe('react-jsx');
    expect(tsconfig.compilerOptions.strict).toBe(true);

    await fs.rm(projectDir, { recursive: true, force: true });
  });


  it('names single-argument makeScene2D scenes before writing project files', async () => {
    const code = SCENE_CODE.replace('makeScene2D("SmokeScene", function*', 'makeScene2D(function*');
    const projectDir = await renderer.writeProject(code);
    const sceneFile = path.join(projectDir, 'src', 'scenes', 'scene.tsx');
    const sceneContent = await fs.readFile(sceneFile, 'utf-8');

    expect(sceneContent).toContain("export default makeScene2D('GeneratedScene', function*");

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('getCompositionConfig parses waitFor durations', () => {
    const config = renderer.getCompositionConfig(SCENE_CODE);
    // waitFor(3) => 3 seconds * 30fps = 90 frames
    expect(config.durationInFrames).toBe(90);
    expect(config.fps).toBe(30);
  });

  it('getCompositionConfig parses width/height from Rect', () => {
    const config = renderer.getCompositionConfig(SCENE_CODE);
    expect(config.width).toBe(400);
    expect(config.height).toBe(300);
  });

  it('getCompositionConfig falls back to defaults when no size found', () => {
    const code = `
      export default makeScene2D('minimal', function* (view) {
        yield* waitFor(2);
      });
    `;
    const config = renderer.getCompositionConfig(code);
    expect(config.width).toBe(1920);
    expect(config.height).toBe(1080);
  });

  it('getCompositionConfig falls back to 300 frames with no waitFor', () => {
    const code = `
      export default makeScene2D('empty', function* (view) {});
    `;
    const config = renderer.getCompositionConfig(code);
    expect(config.durationInFrames).toBe(300);
  });

  it('calls renderVideo from the generated project with relative project and split output settings (opt-in)', async () => {
    const outputPath = path.join(tempDir, 'nested', 'out.mp4');
    mockRenderVideo.mockResolvedValue(outputPath);

    await renderer.render(SCENE_CODE, outputPath, { allowUpstreamRenderer: true });

    expect(mockRenderVideo).toHaveBeenCalledTimes(1);
    const callArg = mockRenderVideo.mock.calls[0][0];
    expect(callArg.projectFile).toBe('./src/project.ts');
    expect(callArg.settings.outDir).toBe(path.dirname(outputPath));
    expect(callArg.settings.outFile).toBe(path.basename(outputPath));
    expect(callArg.settings.projectSettings.size).toEqual({ x: 1920, y: 1080 });
  });

  describe('harnessFilePath', () => {
    const work = path.resolve('/srv/work');
    it.each([
      ['/harness.js', path.join(work, 'harness.js')],
      ['/a/b.js?x=1#y', path.join(work, 'a', 'b.js')],
      ['//etc/passwd', path.join(work, 'etc', 'passwd')],
      // The URL parser folds %2e%2e as a dot segment, so it never leaves the root.
      ['/%2e%2e/%2e%2e/etc/passwd', path.join(work, 'etc', 'passwd')],
    ])('maps %s inside the work dir', (p, want) => {
      expect(harnessFilePath(work, `${HARNESS_ORIGIN}${p}`)).toBe(want);
    });
    it.each(['/', '/..%2F..%2Fetc%2Fpasswd', '/..%5C..%5Cetc', '/%E0%A4%A'])(
      'refuses %s', (p) => {
        expect(harnessFilePath(work, `${HARNESS_ORIGIN}${p}`)).toBeNull();
      },
    );
  });

  describe('browser resolution', () => {
    it('launches the resolved Chromium', async () => {
      await renderer.renderStills(SCENE_CODE, { fps: 30 });
      expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/opt/chromium' }));
    });

    it('throws the missing-browser error and never launches when nothing resolves', async () => {
      mockResolve.mockReturnValue(null);
      await expect(renderer.renderStills(SCENE_CODE, { fps: 30 })).rejects.toThrow(/Chromium executable not found/);
      expect(mockLaunch).not.toHaveBeenCalled();
    });
  });

  describe('contained stills (#1628)', () => {
    beforeEach(() => {
      pageCalls.order.length = 0; pageCalls.seeks.length = 0; pageCalls.onRequest = undefined;
      harnessState.ready = true; harnessState.error = null;
    });

    it('seeks only the early and 80 % frames of the real scene', async () => {
      harnessState.totalFrames = 300;
      const stills = await new RevideoRenderer().renderStills(SCENE_CODE, { fps: 30, width: 960, height: 540 });
      expect(pageCalls.seeks).toEqual([15, 240]);
      expect(stills.early.length).toBeGreaterThan(0);
      expect(stills.late.length).toBeGreaterThan(0);
      expect(stills.durationSeconds).toBe(10);
      expect(stills.containment).toMatchObject({ networkIsolated: true, permissionsDenied: true, cleanupSucceeded: true });
      expect(mockFramesToVideo).not.toHaveBeenCalled();
    });

    it('a short scene takes its early still at a quarter, not past the end', async () => {
      harnessState.totalFrames = 8;
      await new RevideoRenderer().renderStills(SCENE_CODE, { fps: 30 });
      expect(pageCalls.seeks).toEqual([2, 6]);
    });

    it('fences the page before it loads anything', async () => {
      harnessState.totalFrames = 3;
      await new RevideoRenderer().renderStills(SCENE_CODE, { fps: 30 });
      expect(pageCalls.order.slice(0, 3)).toEqual(['intercept', 'guards', 'goto']);
    });

    it('serves only the harness files, admits data: and blob:, and counts every block', async () => {
      harnessState.totalFrames = 3;
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'revideo-fence-'));
      mockScreenshot.mockImplementationOnce(async () => {
        // Each request must get exactly one verdict: respond, continue or abort.
        const fire = async (url: string) => {
          const r = {
            url: () => url,
            abort: vi.fn(async () => {}),
            continue: vi.fn(async () => {}),
            respond: vi.fn(async (_: { status: number; body?: unknown }) => {}),
          };
          pageCalls.onRequest!(r);
          await vi.waitFor(() => expect(r.abort.mock.calls.length + r.continue.mock.calls.length + r.respond.mock.calls.length).toBe(1));
          if (r.respond.mock.calls.length) return `respond:${r.respond.mock.calls[0][0].status}`;
          return r.continue.mock.calls.length ? 'continue' : 'abort';
        };
        expect(await fire(`${HARNESS_ORIGIN}/harness.js`)).toBe('respond:200');
        expect(await fire(`${HARNESS_ORIGIN}/index.html`)).toBe('respond:200');
        expect(await fire(`${HARNESS_ORIGIN}/missing.js`)).toBe('respond:404');
        expect(await fire('data:image/png;base64,AAAA')).toBe('continue');
        expect(await fire(`blob:${HARNESS_ORIGIN}/1234`)).toBe('continue');
        expect(await fire('https://cdn.example.com/x.js')).toBe('abort');
        // An encoded ../ resolves outside the work dir: blocked, not served.
        expect(await fire(`${HARNESS_ORIGIN}/..%2F..%2Fetc%2Fpasswd`)).toBe('abort');
        // file:// is no longer how the harness loads, so it is outside the fence.
        expect(await fire(pathToFileURL('/etc/passwd').href)).toBe('abort');
        // A symlink inside the work dir that points out of it is blocked too.
        const [workName] = (await fs.readdir(root)).filter((n) => n.startsWith('revideo-stills-'));
        await fs.symlink(path.resolve('package.json'), path.join(root, workName, 'escape.js'));
        expect(await fire(`${HARNESS_ORIGIN}/escape.js`)).toBe('abort');
        return new Uint8Array([1]);
      });
      const stills = await new RevideoRenderer({ tempDir: root }).renderStills(SCENE_CODE, { fps: 30 });
      expect(stills.containment.blockedRequests).toBe(4);
      expect(await fs.readdir(root)).toEqual([]);
      await fs.rm(root, { recursive: true, force: true });
    });
  });
});
