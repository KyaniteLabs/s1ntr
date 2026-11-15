import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { VideoRenderer, VideoRenderOptions, VideoRenderResult } from './VideoRenderer.js';
import { VideoExporter } from '../export/VideoExporter.js';
import { Logger } from '../utils/Logger.js';
import { getChromeArgs, sandboxOptOutArgs } from '../security/SandboxConfig.js';

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

// Safety cap so a runaway/very long scene cannot capture an unbounded number of
// frames (e.g. a scene with no terminating waitFor). 60s @ 60fps = 3600 frames.
const MAX_CAPTURE_FRAMES = 3600;
// Time budget for the headless render+capture so a hung browser cannot block CI.
const CAPTURE_TIMEOUT_MS = 180_000;

export interface CompositionConfig {
  id: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
}

// Minimal structural type for the slice of esbuild we load dynamically. esbuild
// is a transitive dependency (via @revideo/renderer), so we avoid a top-level
// `import('esbuild')` type reference that would not resolve at build time.
interface EsbuildPluginBuild {
  onResolve(options: { filter: RegExp }, callback: () => { path: string; namespace: string }): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: () => { contents: string }): void;
}
interface EsbuildPlugin {
  name: string;
  setup(build: EsbuildPluginBuild): void;
}
interface EsbuildModule {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
}

export class RevideoRenderer implements VideoRenderer {
  private tempDir: string;

  constructor(options?: { tempDir?: string }) {
    this.tempDir = options?.tempDir ?? os.tmpdir();
  }

  async writeProject(code: string, opts: VideoRenderOptions = {}): Promise<string> {
    const fps = opts.fps ?? DEFAULT_FPS;
    const width = opts.width ?? DEFAULT_WIDTH;
    const height = opts.height ?? DEFAULT_HEIGHT;
    const projectDir = path.resolve(
      this.tempDir,
      `revideo-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );

    await fs.mkdir(path.join(projectDir, 'src', 'scenes'), { recursive: true });

    await fs.writeFile(path.join(projectDir, 'src', 'scenes', 'scene.tsx'), this.normalizeSceneCode(code));

    await fs.writeFile(
      path.join(projectDir, 'src', 'project.ts'),
      [
        "import { makeProject } from '@revideo/core';",
        "import scene from './scenes/scene?scene';",
        'export default makeProject({',
        "  name: 'sinter-render',",
        '  scenes: [scene],',
        '  settings: {',
        `    shared: { size: { x: ${width}, y: ${height} } },`,
        `    rendering: { fps: ${fps} },`,
        `    preview: { fps: ${fps} },`,
        '  },',
        '});',
      ].join('\n')
    );

    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify(
        {
          name: 'sinter-render-project',
          type: 'module',
          dependencies: {
            '@revideo/core': '^0.10.4',
            '@revideo/2d': '^0.10.4',
            '@revideo/renderer': '^0.10.4',
            '@revideo/vite-plugin': '^0.10.4',
            '@revideo/ui': '^0.10.4',
            '@revideo/ffmpeg': '^0.10.4',
            vite: '^5.4.0',
          },
        },
        null,
        2
      )
    );

    const editorStubPath = path.join(projectDir, 'node_modules', '@revideo', '2d', 'editor', 'index.js');
    await fs.mkdir(path.dirname(editorStubPath), { recursive: true });
    await fs.writeFile(
      editorStubPath,
      [
        "// Stub for the Revideo editor module. The editor is only needed for the",
        "// dev-server UI; the headless renderer never uses it. @revideo/core still",
        "// dynamically imports it, so we provide a minimal no-op default export.",
        'export default function createEditor() { return null; }',
      ].join('\n')
    );

    const viteConfigLines = [
      "import { defineConfig } from 'vite';",
      "import path from 'path';",
      "import revideoPluginModule from '@revideo/vite-plugin';",
      '',
      `const EDITOR_STUB = ${JSON.stringify(editorStubPath)};`,
      "const revideoPlugin = (revideoPluginModule as any).default ?? revideoPluginModule;",
      '',
      "const revideoEditorResolver = () => ({",
      "  name: 'revideo-editor-resolver',",
      "  enforce: 'pre',",
      '  resolveId(id) {',
      "    if (id === '/@id/@revideo/2d/editor' || id === '@revideo/2d/editor') {",
      '      return { id: EDITOR_STUB, external: false };',
      '    }',
      '  },',
      '});',
      '',
      "export default defineConfig({",
      "  logLevel: 'info',",
      '  resolve: {',
      '    alias: [',
      "      { find: '/@id/@revideo/2d/editor', replacement: EDITOR_STUB },",
      "      { find: '@revideo/2d/editor', replacement: EDITOR_STUB },",
      '    ],',
      '  },',
      "  plugins: [revideoEditorResolver(), revideoPlugin({ project: './src/project.ts' })]",
      '});',
    ];

    await fs.writeFile(path.join(projectDir, 'vite.config.ts'), viteConfigLines.join('\n'));

    await fs.writeFile(
      path.join(projectDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
            jsxImportSource: '@revideo/2d/lib',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
          },
        },
        null,
        2
      )
    );

    try {
      execSync('npm install --loglevel=error', {
        cwd: projectDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err) {
      await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Failed to install Revideo project dependencies: ${err instanceof Error ? err.message : String(err)}`);
    }

    return projectDir;
  }

  async render(code: string, outputPath: string, opts: VideoRenderOptions = {}): Promise<VideoRenderResult> {
    const fps = opts.fps ?? DEFAULT_FPS;
    const width = opts.width ?? DEFAULT_WIDTH;
    const height = opts.height ?? DEFAULT_HEIGHT;
    const allowUpstreamRenderer = opts.allowUpstreamRenderer ?? false;

    // Default path: drive the real Revideo scene in a headless browser via the
    // @revideo/core Player + Stage, capture the canvas frame-by-frame, and stitch
    // the PNGs into an mp4 with ffmpeg (the same capture+stitch pipeline every
    // other domain uses through CanvasRecorder). This bypasses the upstream
    // @revideo/renderer toolchain, which hangs silently in headless Chrome.
    if (!allowUpstreamRenderer) {
      return this.renderViaCanvasCapture(code, outputPath, { fps, width, height });
    }

    return this.renderViaUpstream(code, outputPath, { ...opts, fps, width, height });
  }

  /**
   * Real default export: bundle a tiny browser harness (scene + Player + Stage),
   * step the animation frame-by-frame, screenshot the Stage canvas, and ffmpeg
   * the frames into an mp4. No vite dev server, no per-render npm install.
   */
  private async renderViaCanvasCapture(
    code: string,
    outputPath: string,
    opts: { fps: number; width: number; height: number },
  ): Promise<VideoRenderResult> {
    const { fps, width, height } = opts;
    const ext = (path.extname(outputPath).slice(1) || 'mp4') as 'mp4' | 'webm' | 'mov';

    const workDir = await fs.mkdtemp(path.join(this.tempDir, 'revideo-capture-'));
    const framesDir = path.join(workDir, 'frames');
    await fs.mkdir(framesDir, { recursive: true });

    try {
      const harnessJs = await this.bundleHarness(this.normalizeSceneCode(code), workDir, { fps, width, height });
      const html = this.buildHarnessHtml();
      await fs.writeFile(path.join(workDir, 'harness.js'), harnessJs);
      await fs.writeFile(path.join(workDir, 'index.html'), html);

      const capturedFrames = await this.captureFrames(workDir, framesDir, { fps, width, height });
      if (capturedFrames === 0) {
        throw new Error('Revideo canvas capture produced no frames; the scene did not render.');
      }

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await new VideoExporter().framesToVideo(framesDir, outputPath, fps);

      return {
        outputPath,
        duration: capturedFrames / fps,
        width,
        height,
        format: ext,
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Bundle the browser harness (scene + Player/Stage driver) into a single ESM file. */
  private async bundleHarness(
    sceneCode: string,
    workDir: string,
    opts: { fps: number; width: number; height: number },
  ): Promise<string> {
    const repoRequire = createRequire(import.meta.url);
    // @revideo/renderer is gated by VideoCapabilityDetector before we get here,
    // and it depends on esbuild, so we resolve esbuild relative to it rather than
    // requiring a top-level esbuild dependency.
    const revideoRendererPath = repoRequire.resolve('@revideo/renderer');
    const esbuildPath = createRequire(revideoRendererPath).resolve('esbuild');
    const esbuild = (await import(pathToFileURL(esbuildPath).href)) as unknown as EsbuildModule;

    // Bundle with the repo root as the working dir so esbuild resolves @revideo/*
    // and the @revideo/2d JSX runtime from the repo's top-level node_modules.
    const repoRoot = this.findRepoRoot();

    const sceneEntry = path.join(workDir, 'scene.tsx');
    const harnessEntry = path.join(workDir, 'harness-entry.tsx');
    await fs.writeFile(sceneEntry, sceneCode);
    await fs.writeFile(harnessEntry, this.buildHarnessSource(opts));

    // Stub the editor plugin that makeScene2D references but the headless render
    // path never needs.
    const editorStubPlugin: EsbuildPlugin = {
      name: 'revideo-editor-stub',
      setup(build) {
        build.onResolve({ filter: /@revideo\/2d\/editor$/ }, () => ({
          path: 'revideo-editor-stub',
          namespace: 'revideo-editor-stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'revideo-editor-stub' }, () => ({
          contents: 'export default function createEditor() { return null; }',
        }));
      },
    };

    const result = await esbuild.build({
      entryPoints: [harnessEntry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: '@revideo/2d/lib',
      absWorkingDir: repoRoot,
      // The harness/scene files live in an OS temp dir, so esbuild's default
      // node_modules walk (relative to the importer) never reaches the repo.
      // nodePaths makes it resolve @revideo/* + the JSX runtime from the repo.
      nodePaths: [path.join(repoRoot, 'node_modules')],
      plugins: [editorStubPlugin],
      logLevel: 'silent',
    });

    return result.outputFiles[0].text;
  }

  /** Walk up from this module to the repo root that owns node_modules/@revideo. */
  private findRepoRoot(): string {
    let dir = path.dirname(new URL(import.meta.url).pathname);
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, 'node_modules', '@revideo', 'core'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    // Fallback: cwd (callers run from the repo root in practice).
    return process.cwd();
  }

  /** TSX source for the in-browser harness that drives Player + Stage. */
  private buildHarnessSource(opts: { fps: number; width: number; height: number }): string {
    const { fps, width, height } = opts;
    return [
      "import { makeProject, Player, Stage, Vector2 } from '@revideo/core';",
      "import scene from './scene.tsx';",
      '',
      `const WIDTH = ${width};`,
      `const HEIGHT = ${height};`,
      `const FPS = ${fps};`,
      '',
      'async function main() {',
      '  const project = makeProject({',
      "    name: 'sinter-render',",
      '    scenes: [scene],',
      '    settings: {',
      '      shared: { size: { x: WIDTH, y: HEIGHT } },',
      '      rendering: { fps: FPS },',
      '      preview: { fps: FPS },',
      '    },',
      '  });',
      '',
      '  const stage = new Stage();',
      '  stage.configure({',
      '    size: new Vector2(WIDTH, HEIGHT),',
      '    resolutionScale: 1,',
      '    background: project.settings.shared.background,',
      '  });',
      '',
      '  const canvas = stage.finalBuffer;',
      "  canvas.id = 'sinter-canvas';",
      "  canvas.style.width = WIDTH + 'px';",
      "  canvas.style.height = HEIGHT + 'px';",
      '  document.body.appendChild(canvas);',
      '',
      '  const player = new Player(project, { fps: FPS, size: new Vector2(WIDTH, HEIGHT) });',
      '  player.togglePlayback(false);',
      '',
      '  // Wait for the playback manager to recalculate so the duration is known.',
      '  await new Promise((resolve) => {',
      '    player.onRecalculated.subscribe(() => resolve());',
      '    player.activate();',
      '    setTimeout(resolve, 8000);',
      '  });',
      '  player.deactivate();',
      '',
      '  async function renderCurrent() {',
      '    await stage.render(player.playback.currentScene, player.playback.previousScene);',
      '  }',
      '',
      '  window.__sinter = {',
      '    ready: true,',
      '    totalFrames: player.playback.duration,',
      '    error: null,',
      '    seekAndRender: async (frame) => {',
      '      await player.playback.seek(frame);',
      '      await renderCurrent();',
      '    },',
      '  };',
      '}',
      '',
      'main().catch((e) => {',
      '  window.__sinter = window.__sinter || {};',
      '  window.__sinter.ready = false;',
      '  window.__sinter.error = String((e && (e.stack || e.message)) || e);',
      "  console.error('SINTER_HARNESS_ERROR', e);",
      '});',
    ].join('\n');
  }

  /** Minimal HTML page that loads the bundled harness as an ES module. */
  private buildHarnessHtml(): string {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>Sinter Revideo Harness</title>',
      '<style>html,body{margin:0;background:#000;}</style></head>',
      '<body><script type="module" src="./harness.js"></script></body>',
      '</html>',
    ].join('\n');
  }

  /** Drive the harness in headless Chrome, screenshotting the canvas per frame. */
  private async captureFrames(
    workDir: string,
    framesDir: string,
    opts: { fps: number; width: number; height: number },
  ): Promise<number> {
    const puppeteer = await import('puppeteer');
    const disableSandbox = process.env.LIMINAL_DISABLE_SANDBOX === 'true';
    const browser = await puppeteer.default.launch({
      headless: true,
      args: getChromeArgs({ forceDisableSandbox: disableSandbox }),
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: opts.width, height: opts.height });
      page.on('pageerror', (err: unknown) =>
        Logger.warn('RevideoRenderer', `Harness page error: ${err instanceof Error ? err.message : String(err)}`),
      );

      const indexUrl = pathToFileURL(path.join(workDir, 'index.html')).href;
      await page.goto(indexUrl, { waitUntil: 'load', timeout: 30_000 });

      await page.waitForFunction(
        'window.__sinter && (window.__sinter.ready || window.__sinter.error)',
        { timeout: CAPTURE_TIMEOUT_MS },
      );

      const state = (await page.evaluate(() => {
        const s = (window as unknown as {
          __sinter?: { ready?: boolean; totalFrames?: number; error?: string | null };
        }).__sinter;
        return {
          ready: s?.ready ?? false,
          total: s?.totalFrames ?? 0,
          error: s?.error ?? null,
        };
      })) as { ready: boolean; total: number; error: string | null };

      if (!state.ready) {
        throw new Error(`Revideo harness failed to initialize: ${state.error ?? 'unknown error'}`);
      }

      const totalFrames = Math.min(Math.max(state.total, 1), MAX_CAPTURE_FRAMES);
      const canvas = await page.$('#sinter-canvas');
      if (!canvas) {
        throw new Error('Revideo harness did not create the render canvas.');
      }

      let captured = 0;
      for (let frame = 0; frame < totalFrames; frame++) {
        await page.evaluate(
          (f) =>
            (window as unknown as {
              __sinter: { seekAndRender: (n: number) => Promise<void> };
            }).__sinter.seekAndRender(f),
          frame,
        );
        const framePath = path.join(framesDir, `frame_${String(frame).padStart(5, '0')}.png`);
        await canvas.screenshot({ path: framePath as `${string}.png`, type: 'png' });
        captured++;
      }

      return captured;
    } finally {
      await browser.close();
    }
  }

  /**
   * Opt-in legacy path through the upstream @revideo/renderer toolchain. Known to
   * hang silently in headless Chrome (a timeout only converts the hang into a
   * failure); kept for parity and not recommended for CI.
   */
  private async renderViaUpstream(
    code: string,
    outputPath: string,
    opts: VideoRenderOptions & { fps: number; width: number; height: number },
  ): Promise<VideoRenderResult> {
    const { fps, width, height } = opts;
    const logProgress = opts.logProgress ?? false;
    const progressCallback = opts.progressCallback;

    let projectDir: string | undefined;
    try {
      projectDir = await this.writeProject(code, { fps, width, height });

      const renderVideoFn: (config: Record<string, unknown>) => Promise<unknown> = await (async () => {
        try {
          const projectRequire = createRequire(path.join(projectDir, 'package.json'));
          const rendererPath = projectRequire.resolve('@revideo/renderer');
          const mod = await import(pathToFileURL(rendererPath).href);
          return mod.renderVideo ?? mod.default?.renderVideo;
        } catch (projectErr) {
          try {
            const mod = await import('@revideo/renderer');
            return mod.renderVideo ?? mod.default?.renderVideo;
          } catch (rootErr) {
            const projectDetail = projectErr instanceof Error ? projectErr.message : String(projectErr);
            const rootDetail = rootErr instanceof Error ? rootErr.message : String(rootErr);
            throw new Error(
              `Revideo rendering requires @revideo/renderer, @revideo/vite-plugin, and @revideo/ui. Install optional dependencies with: pnpm install. Project import: ${projectDetail}. Root import: ${rootDetail}`
            );
          }
        }
      })();

      if (typeof renderVideoFn !== 'function') {
        throw new Error('Revideo renderer did not expose renderVideo()');
      }

      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const previousCwd = process.cwd();
      process.chdir(projectDir);
      const previousPuppeteerPath = process.env.PUPPETEER_EXECUTABLE_PATH;
      try {
        const systemChrome = process.env.PUPPETEER_EXECUTABLE_PATH
          || process.env.CHROME_PATH
          || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
        if (systemChrome) {
          process.env.PUPPETEER_EXECUTABLE_PATH = systemChrome;
        }
        const RENDER_TIMEOUT_MS = 300_000;
        let renderTimeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            renderVideoFn({
              projectFile: './src/project.ts',
              settings: {
                outDir: path.dirname(outputPath),
                outFile: path.basename(outputPath),
                workers: 1,
                logProgress,
                progressCallback,
                puppeteer: {
                  args: sandboxOptOutArgs(),
                  executablePath: systemChrome,
                },
                projectSettings: {
                  size: { x: width, y: height },
                },
              },
            }),
            new Promise<void>((_, reject) => {
              renderTimeoutId = setTimeout(
                () => reject(new Error(`Revideo upstream render timed out after ${RENDER_TIMEOUT_MS}ms`)),
                RENDER_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(renderTimeoutId);
        }
      } finally {
        process.chdir(previousCwd);
        if (previousPuppeteerPath === undefined) {
          delete process.env.PUPPETEER_EXECUTABLE_PATH;
        } else {
          process.env.PUPPETEER_EXECUTABLE_PATH = previousPuppeteerPath;
        }
      }

      const config = this.getCompositionConfig(code, fps);
      const ext = (path.extname(outputPath).slice(1) || 'mp4') as 'mp4' | 'webm' | 'mov';
      await this.cleanupIntermediateOutputs(outputPath, ext);

      return {
        outputPath,
        duration: config.durationInFrames / fps,
        width,
        height,
        format: ext,
      };
    } finally {
      if (projectDir) {
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    }
  }


  private normalizeSceneCode(code: string): string {
    return code.replace(
      /export\s+default\s+makeScene2D\s*\(\s*function\*/,
      "export default makeScene2D('GeneratedScene', function*"
    );
  }


  private async cleanupIntermediateOutputs(outputPath: string, ext: 'mp4' | 'webm' | 'mov'): Promise<void> {
    const outputDir = path.dirname(outputPath);
    const base = path.basename(outputPath, path.extname(outputPath));
    await Promise.all([
      path.join(outputDir, `${base}-0.${ext}`),
      path.join(outputDir, `${base}-audio.wav`),
      path.join(outputDir, `${base}-visuals.${ext}`),
    ].map((file) => fs.unlink(file).catch(() => {})));
  }

  getCompositionConfig(code: string, fps: number = DEFAULT_FPS): CompositionConfig {
    const waitForValues = [...code.matchAll(/yield\*\s*waitFor\((\d+(?:\.\d+)?)\)/g)]
      .map((m) => parseFloat(m[1]));
    const durationValues = [...code.matchAll(/\.duration\((\d+(?:\.\d+)?)\)/g)]
      .map((m) => parseFloat(m[1]));
    const totalSeconds = waitForValues.reduce((a, b) => a + b, 0)
      + durationValues.reduce((a, b) => a + b, 0);
    const durationInFrames = totalSeconds > 0
      ? Math.ceil(totalSeconds * fps)
      : fps * 10;

    const rectMatch = code.match(/Rect[^>]*width=\{(\d+)\}[^>]*height=\{(\d+)\}/);
    const viewMatch = code.match(/view\.fill\([^)]*\)/);
    let width = DEFAULT_WIDTH;
    let height = DEFAULT_HEIGHT;
    if (rectMatch) {
      width = parseInt(rectMatch[1], 10);
      height = parseInt(rectMatch[2], 10);
    } else if (!viewMatch) {
      const sizeMatch = code.match(/size\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
      if (sizeMatch) {
        width = parseInt(sizeMatch[1], 10);
        height = parseInt(sizeMatch[2], 10);
      }
    }

    return {
      id: 'GeneratedScene',
      fps,
      durationInFrames,
      width,
      height,
    };
  }
}
