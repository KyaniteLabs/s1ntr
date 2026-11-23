import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { 
  sanitizeFilename, 
  validateFilePath, 
  PathSanitizationError 
} from '../security/PathSanitizer.js';
import { ExportError } from '../errors/ExportError.js';

const execFileAsync = promisify(execFile);

export interface VideoExporterOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Absolute epoch-ms deadline shared with the caller's setup/drive stages (Sol L3-11): encode gets only what is left. */
  deadlineAt?: number;
}

export interface ProbedMedia { width: number; height: number; durationSec: number }

export class VideoExporter {
  private ffmpegPath: string;
  private ffprobePath: string;
  private deadlineAt: number | undefined;

  constructor(options: VideoExporterOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.deadlineAt = options.deadlineAt;
  }

  /** Measure what a file really is, so callers never report requested dimensions/duration as if they were produced. */
  async probe(file: string): Promise<ProbedMedia> {
    const target = validateFilePath(file, process.cwd());
    const left = this.deadlineAt === undefined ? Infinity : this.deadlineAt - Date.now();
    if (left <= 0) {
      throw new ExportError('ffprobe not started: the render deadline was already spent before verification', { format: 'video' });
    }
    try {
      const { stdout } = await execFileAsync(this.ffprobePath, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration', '-of', 'json', target], { timeout: Math.min(30000, left), killSignal: 'SIGKILL' });
      const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
      const width = parsed.streams?.[0]?.width; const height = parsed.streams?.[0]?.height;
      const durationSec = Number(parsed.format?.duration);
      if (typeof width !== 'number' || !Number.isInteger(width) || width <= 0
        || typeof height !== 'number' || !Number.isInteger(height) || height <= 0
        || !Number.isFinite(durationSec) || durationSec <= 0) {
        throw new ExportError(`ffprobe found no video stream in '${path.basename(target)}'`, { format: 'video' });
      }
      return { width, height, durationSec };
    } catch (error: unknown) {
      if (error instanceof ExportError) throw error;
      throw new ExportError(`ffprobe failed on '${path.basename(target)}': ${(error as Error).message}`,
        { cause: error instanceof Error ? error : undefined, format: 'video' });
    }
  }

  async convert(input: string, output: string, format: 'mp4' | 'webm' | 'gif'): Promise<void> {
    const sanitizedInput = validateFilePath(input, process.cwd());
    const sanitizedOutput = validateFilePath(output, process.cwd());
    const args = this.buildConvertArgs(sanitizedInput, sanitizedOutput, format);
    await this.execFFmpeg(args);
  }

  async resize(input: string, output: string, width: number, height: number): Promise<void> {
    const sanitizedInput = validateFilePath(input, process.cwd());
    const sanitizedOutput = validateFilePath(output, process.cwd());
    const args = this.buildResizeArgs(sanitizedInput, sanitizedOutput, width, height);
    await this.execFFmpeg(args);
  }

  async addAudio(video: string, audio: string, output: string): Promise<void> {
    const sanitizedVideo = validateFilePath(video, process.cwd());
    const sanitizedAudio = validateFilePath(audio, process.cwd());
    const sanitizedOutput = validateFilePath(output, process.cwd());
    const args = this.buildAddAudioArgs(sanitizedVideo, sanitizedAudio, sanitizedOutput);
    await this.execFFmpeg(args);
  }

  async extractFrames(input: string, outputDir: string, fps: number = 24): Promise<void> {
    const sanitizedInput = validateFilePath(input, process.cwd());
    // For outputDir, validate that the directory name itself is safe
    sanitizeFilename(path.basename(outputDir));
    await fs.mkdir(outputDir, { recursive: true });
    const args = this.buildExtractFramesArgs(sanitizedInput, outputDir, fps);
    await this.execFFmpeg(args);
  }

  async framesToVideo(framesDir: string, output: string, fps: number): Promise<void> {
    // For framesDir, validate that the directory name itself is safe
    sanitizeFilename(path.basename(framesDir));
    const sanitizedOutput = validateFilePath(output, process.cwd());
    const args = this.buildFramesToVideoArgs(framesDir, sanitizedOutput, fps);
    await this.execFFmpeg(args);
  }

  // --- Build args methods (exposed for testing without subprocess) ---

  buildConvertArgs(input: string, output: string, format: string): string[] {
    const args = ['-i', input, '-y'];

    if (format === 'gif') {
      args.push(
        '-vf', 'fps=15,scale=640:-1:flags=lanczos,split[s0][s1]',
        '-palettegen', '[s0][palette]',
        '-filter_complex', '[s1][palette]paletteuse',
      );
    } else if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0');
    } else {
      args.push('-c:v', 'libx264', '-crf', '23', '-preset', 'medium');
    }

    args.push(output);
    return args;
  }

  buildResizeArgs(input: string, output: string, width: number, height: number): string[] {
    return [
      '-i', input, '-y',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:a', 'copy',
      output,
    ];
  }

  buildAddAudioArgs(video: string, audio: string, output: string): string[] {
    return [
      '-i', video, '-i', audio, '-y',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-map', '0:v:0', '-map', '1:a:0',
      '-shortest',
      output,
    ];
  }

  buildExtractFramesArgs(input: string, outputDir: string, fps: number): string[] {
    const pattern = path.join(outputDir, 'frame_%05d.png');
    return [
      '-i', input,
      '-vf', `fps=${fps}`,
      pattern,
    ];
  }

  buildFramesToVideoArgs(framesDir: string, output: string, fps: number): string[] {
    const pattern = path.join(framesDir, 'frame_%05d.png');
    return [
      '-framerate', String(fps),
      '-i', pattern,
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
      output,
    ];
  }

  // --- Private ---

  private async execFFmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const left = this.deadlineAt === undefined ? Infinity : this.deadlineAt - Date.now();
    if (left <= 0) {
      throw new ExportError('FFmpeg not started: the render deadline was already spent before encoding', { format: 'video' });
    }
    const timeout = Math.min(300000, left);
    try {
      // SIGKILL: ffmpeg may ignore the default SIGTERM mid-encode, and a hung encoder must not outlive the budget.
      return await execFileAsync(this.ffmpegPath, args, { timeout, killSignal: 'SIGKILL' });
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string; killed?: boolean };
      if (err.killed) {
        throw new ExportError(`FFmpeg killed (SIGKILL) after exceeding its ${Math.round(timeout)} ms budget`,
          { cause: error instanceof Error ? error : undefined, format: 'video' });
      }
      if (err.code === 'ENOENT') {
        throw new ExportError(
          `FFmpeg not found at '${this.ffmpegPath}'. Install FFmpeg and ensure it is on PATH.`,
          { cause: error instanceof Error ? error : undefined, format: 'video' }
        );
      }
      throw new ExportError(
        `FFmpeg failed: ${err.message}`,
        { cause: error instanceof Error ? error : undefined, format: 'video' }
      );
    }
  }
}

export { PathSanitizationError };
