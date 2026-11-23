/**
 * VideoRenderer - shared interface for all video rendering backends.
 *
 * Both RevideoRenderer and HyperFramesRenderer implement this interface.
 * The Exporter dispatches to the correct implementation based on domain.
 */

export interface VideoRenderOptions {
  fps?: number;
  duration?: number;
  width?: number;
  height?: number;
  logProgress?: boolean;
  progressCallback?: (worker: number, progress: number) => void;
  /**
   * Opt-in to the upstream @revideo/renderer video-export path. This path is
   * currently fragile and can hang silently, so it is disabled by default.
   * When false (default), render() fails fast with a clear message.
   */
  allowUpstreamRenderer?: boolean;
  /**
   * Wall-clock budget for the whole render. When it runs out the render fails
   * with VideoRenderError code RENDER_TIMEOUT and the renderer's process group
   * is killed. Each backend has its own default.
   */
  timeoutMs?: number;
}

/** Stable failure codes for a video render. A failed render never carries a stand-in result. */
export type VideoRenderErrorCode = 'RENDER_TIMEOUT';

export class VideoRenderError extends Error {
  constructor(readonly code: VideoRenderErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'VideoRenderError';
  }
}

export interface VideoRenderResult {
  outputPath: string;
  duration: number;
  width: number;
  height: number;
  format: 'mp4' | 'webm' | 'mov';
}

export interface VideoRenderer {
  render(code: string, outputPath: string, opts: VideoRenderOptions): Promise<VideoRenderResult>;
}
