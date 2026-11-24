import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { inlineVendorAssets } from '../utils/vendorAssets.js';
import { withRenderBudget } from './RenderBudget.js';
import { VideoRenderer, VideoRenderOptions, VideoRenderResult } from './VideoRenderer.js';

const DEFAULT_FPS = 30;
const HYPERFRAMES_RENDER_BUDGET_MS = 300_000;


interface AssetDescriptor {
  path: string;
  type: 'video' | 'image' | 'audio';
  startAt: number;
  duration: number;
}

export interface HyperFramesRenderOptions extends VideoRenderOptions {
  assets?: AssetDescriptor[];
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toFileUrl(absolutePath: string): string {
  if (absolutePath.startsWith('file://') || absolutePath.startsWith('http://') || absolutePath.startsWith('https://')) {
    return absolutePath;
  }
  return `file://${path.resolve(absolutePath)}`;
}

function buildAssetInjectionScript(assets: AssetDescriptor[]): string {
  const elements: string[] = [];

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const src = escapeHtmlAttr(toFileUrl(asset.path));
    const attrs = `data-start="${Number(asset.startAt) || 0}" data-duration="${Number(asset.duration) || 0}" data-track-index="${i}"`;

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
  const idx = html.lastIndexOf('</body>');
  if (idx !== -1) {
    return `${html.slice(0, idx)}${script}\n${html.slice(idx)}`;
  }

  return html + '\n' + script;
}

export interface ProbedMedia { width: number; height: number; duration: number }

/** What the file really is: ffprobe on the written output. Throws when it cannot be read as video. */
export function probeMediaWithFfprobe(file: string, signal?: AbortSignal): Promise<ProbedMedia> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json', file], { timeout: 30_000, signal }, (error, stdout) => {
      if (error) { reject(new Error(`HyperFrames output could not be probed: ${error.message}`)); return; }
      try {
        const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
        const stream = parsed.streams?.[0];
        const duration = Number(parsed.format?.duration);
        if (!stream?.width || !stream?.height || !Number.isFinite(duration)) throw new Error('no video stream');
        resolve({ width: stream.width, height: stream.height, duration });
      } catch (e) { reject(new Error(`HyperFrames output is not readable video: ${(e as Error).message}`)); }
    });
  });
}

export class HyperFramesRenderer implements VideoRenderer {
  private tempBaseDir: string;
  private probeMedia: (file: string, signal?: AbortSignal) => Promise<ProbedMedia>;

  constructor(options?: { tempDir?: string; probeMedia?: (file: string, signal?: AbortSignal) => Promise<ProbedMedia> }) {
    this.tempBaseDir = options?.tempDir ?? os.tmpdir();
    this.probeMedia = options?.probeMedia ?? probeMediaWithFfprobe;
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

    let html = code;
    if (opts.assets && opts.assets.length > 0) {
      html = injectAssetsIntoHtml(html, opts.assets);
    }
    html = await inlineVendorAssets(html);

    let compDir: string | undefined;
    let stagingDir: string | undefined;
    try {
      compDir = await this.writeComposition(html);

      const outputDir = path.dirname(path.resolve(outputPath));
      await fs.mkdir(outputDir, { recursive: true });
      stagingDir = await fs.mkdtemp(path.join(outputDir, '.hyperframes-'));
      const stagedOutput = path.join(stagingDir, path.basename(outputPath));

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
      // are not used to size the output; the returned metadata is probed from the written file.
      const ext = path.extname(outputPath).slice(1);
      const job = createRenderJob({
        fps,
        quality: 'standard',
        format: (ext as 'mp4' | 'webm' | 'mov' | 'gif' | 'png-sequence') || 'mp4',
      });

      // executeRenderJob(job, projectDir, outputPath, onProgress?, abortSignal?) → Promise<void>
      // The producer drives its own browser; the abort signal is the only handle on it,
      // so a hung export is aborted on timeout instead of waiting forever.
      const compositionDir = compDir;
      const media = await withRenderBudget('hyperframes render', opts.timeoutMs ?? HYPERFRAMES_RENDER_BUDGET_MS,
        async (signal) => {
          await executeRenderJob(job, compositionDir, stagedOutput, undefined, signal);
          signal.throwIfAborted();

          // A producer can resolve without writing a file. Only promote a newly written regular file.
          const written = await fs.lstat(stagedOutput).catch(() => null);
          if (!written?.isFile() || written.size === 0) {
            throw new Error(`HyperFrames render finished but wrote no output at ${outputPath}`);
          }
          signal.throwIfAborted();
          return this.probeMedia(stagedOutput, signal);
        });
      await fs.rename(stagedOutput, outputPath);

      return {
        outputPath,
        duration: media.duration,
        width: media.width,
        height: media.height,
        format: (ext as 'mp4' | 'webm' | 'mov') || 'mp4',
      };
    } finally {
      await Promise.all([
        compDir && this.cleanup(compDir),
        stagingDir && this.cleanup(stagingDir),
      ]);
    }
  }
}
