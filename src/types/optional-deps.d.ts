/**
 * Type declarations for optional dependencies.
 * These modules may not be installed, so we provide minimal type info.
 */

declare module 'sharp' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface _SharpOptions {
    [key: string]: unknown;
  }
  interface CacheOptions {
    [key: unknown]: unknown;
  }
  interface CacheResult {
    [key: unknown]: unknown;
  }
  interface SharpInstance {
    metadata(): Promise<{ width?: number; height?: number }>;
    resize(options: Record<string, unknown>): SharpInstance;
    jpeg(options: Record<string, unknown>): SharpInstance;
    png(options?: Record<string, unknown>): SharpInstance;
    composite(images: Array<{ input: Buffer; left: number; top: number }>): SharpInstance;
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer; info: { width: number; height: number };
    }>;
    [key: string]: unknown;
  }
  function sharp(input: string | Buffer | {
    create: { width: number; height: number; channels: 3 | 4; background: string };
  }): SharpInstance;
  namespace sharp {
    function cache(options?: boolean | CacheOptions): CacheResult;
    function concurrency(concurrency?: number): number;
  }
  export = sharp;
}

declare module 'music-metadata' {
  interface AudioMetadata {
    format: {
      duration?: number;
      sampleRate?: number;
      bitrate?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }
  export function parseFile(path: string): Promise<AudioMetadata>;
}

declare module 'meyda' {
  export interface MeydaFeatures {
    amplitudeSpectrum?: Float32Array;
    spectralCentroid?: number;
    rms?: number;
    zcr?: number;
    [key: string]: unknown;
  }
  
  export function extract(
    features: string | string[],
    signal: Float32Array,
    previousSignal?: Float32Array
  ): MeydaFeatures;
  
  export const audioContext: unknown;
  export const bufferSize: number;
}

/**
 * Extensions to the Window object for Puppeteer-injected metrics.
 * Used by RuntimeHealthMonitor.
 */
interface SinterMetrics {
  frameCount: number;
  lastFrameTime: number;
  fpsSamples: number[];
}

interface Window {
  __liminalMetrics?: SinterMetrics;
}
