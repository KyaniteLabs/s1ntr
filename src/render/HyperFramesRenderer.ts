import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { VideoRenderer, VideoRenderOptions, VideoRenderResult } from './VideoRenderer.js';

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;


interface AssetDescriptor {
  path: string;
  type: 'video' | 'image' | 'audio';
  startAt: number;
  duration: number;
}

export interface HyperFramesRenderOptions extends VideoRenderOptions {
  assets?: AssetDescriptor[];
}

function toFileUrl(absolutePath: string): string {
  if (absolutePath.startsWith('file://') || absolutePath.startsWith('http://') || absolutePath.startsWith('https://')) {
    return absolutePath;
  }
  return `file://${absolutePath}`;
}

function buildAssetInjectionScript(assets: AssetDescriptor[]): string {
  const elements: string[] = [];

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const src = toFileUrl(asset.path);
    const attrs = `data-start="${asset.startAt}" data-duration="${asset.duration}" data-track-index="${i}"`;

    if (asset.type === 'video') {
      elements.push(`<video src="${src}" ${attrs} style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;"></video>`);
    } else if (asset.type === 'image') {
      elements.push(`<img src="${src}" ${attrs} style="position:absolute;top:0;left:0;max-width:100%;max-height:100%;pointer-events:none;">`);
    } else if (asset.type === 'audio') {
      elements.push(`<audio src="${src}" ${attrs}></audio>`);
    }
  }

  return [
    '<div id="sinter-injected-assets" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;">',
    ...elements,
    '</div>',
  ].join('\n');
}

function injectAssetsIntoHtml(html: string, assets: AssetDescriptor[]): string {
  const script = buildAssetInjectionScript(assets);

  if (html.includes('</body>')) {
    return html.replace('</body>', `${script}\n</body>`);
  }

  return html + '\n' + script;
}

export class HyperFramesRenderer implements VideoRenderer {
  private tempBaseDir: string;

  constructor(options?: { tempDir?: string }) {
    this.tempBaseDir = options?.tempDir ?? os.tmpdir();
  }

  async writeComposition(code: string): Promise<string> {
    const compDir = path.join(
      this.tempBaseDir,
      `hyperframes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );

    await fs.mkdir(compDir, { recursive: true });
    await fs.writeFile(path.join(compDir, 'index.html'), code);

    return compDir;
  }

  async cleanup(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
  }

  async render(
    code: string,
    outputPath: string,
    opts: HyperFramesRenderOptions = {}
  ): Promise<VideoRenderResult> {
    const fps = opts.fps ?? DEFAULT_FPS;
    const width = opts.width ?? DEFAULT_WIDTH;
    const height = opts.height ?? DEFAULT_HEIGHT;

    let html = code;
    if (opts.assets && opts.assets.length > 0) {
      html = injectAssetsIntoHtml(html, opts.assets);
    }

    let compDir: string | undefined;
    try {
      compDir = await this.writeComposition(html);

      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      let createRenderJob: (config: { fps: number; quality: string; format: string }) => unknown;
      let executeRenderJob: (job: unknown, projectDir: string, outputPath: string, onProgress?: unknown, abortSignal?: AbortSignal) => Promise<void>;
      try {
        // Dynamic import via variable prevents TS from following into broken @hyperframes/engine types
        const producerModule = '@hyperframes/producer';
        const mod = await import(producerModule);
        createRenderJob = mod.createRenderJob;
        executeRenderJob = mod.executeRenderJob;
        if (!createRenderJob || !executeRenderJob) {
          throw new Error('createRenderJob/executeRenderJob not exported');
        }
      } catch {
        throw new Error(
          'HyperFrames rendering requires @hyperframes/producer. Install with: pnpm add @hyperframes/producer'
        );
      }

      // createRenderJob accepts RenderConfigInput: { fps, quality, format?, outputResolution?, ... }
      // projectDir (compDir) is passed separately to executeRenderJob; entryFile defaults to "index.html".
      // outputResolution is intentionally omitted: the engine reads the composition's own dimensions
      // from the HTML (via the compile stage), so forcing a preset here would mismatch compositions
      // that don't happen to use a canonical CanvasResolution size. The width/height opts we received
      // are only used to populate the returned VideoRenderResult metadata.
      const ext = path.extname(outputPath).slice(1);
      const job = createRenderJob({
        fps,
        quality: 'standard',
        format: (ext as 'mp4' | 'webm' | 'mov' | 'gif' | 'png-sequence') || 'mp4',
      });

      // executeRenderJob(job, projectDir, outputPath, onProgress?, abortSignal?) → Promise<void>
      await executeRenderJob(job, compDir, outputPath);

      const duration = opts.duration ?? 0;

      return {
        outputPath,
        duration,
        width,
        height,
        format: (ext as 'mp4' | 'webm' | 'mov') || 'mp4',
      };
    } finally {
      if (compDir) {
        await this.cleanup(compDir);
      }
    }
  }
}
