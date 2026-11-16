import type { LuminanceMeasure, LuminanceVerdict } from '../../render/LuminanceVerdict.js';

export type RenderMeasure = LuminanceMeasure & {
  verdict: LuminanceVerdict;
  /** True when the late frame measured non-ok while the first frame was ok —
   *  the animation decayed after capture (H13). */
  temporalDecay?: boolean;
};

export interface RenderEvidence {
  /** False when a preview is not a render of the source artifact. */
  rendered?: boolean;
  /** Digest of the actual launched browser engine/version/executable. */
  rendererEnvironmentDigest?: string;
  screenshotRef?: string;
  screenshot?: {
    mimeType: string;
    dataBase64: string;
    width?: number;
    height?: number;
  };
  /** Second capture late in the render window (H13): one frame is a single
   *  sample of a time-varying signal — the late frame is the steady state a
   *  viewer actually sees. */
  lateScreenshot?: {
    mimeType: string;
    dataBase64: string;
    width?: number;
    height?: number;
  };
  logRef?: string;
  audio?: {
    success: boolean;
    sampleRate?: number;
    durationSeconds?: number;
    peakAmplitude?: number;
    rmsAmplitude?: number;
    error?: string;
    warningCount?: number;
    /** Deterministic measurements and floor verdict (#1631). */
    silentShare?: number;
    loudnessDb?: number;
    noisiness?: number | null;
    floorFailure?: string;
  };
  playback?: { controlsAccessible: boolean; started: boolean };
  interaction?: { actions: number; stateChanged: boolean | null; target?: 'control' | 'canvas-pointer' | 'none' | 'error' };
  video?: {
    fps?: number;
    durationSeconds?: number;
  };
  timingMs: number;
  infraUnavailable: boolean;
  candidateFailure: boolean;
  /** Why the candidate failed, e.g. the message it threw. Set with candidateFailure. */
  failure?: string;
  /** Console logs captured during the render pass (diagnostic evidence). */
  logs?: string[];
  /** Page/console errors captured during the render pass (diagnostic evidence). */
  errors?: string[];
  renderMeasure?: RenderMeasure;
  containment?: {
    networkIsolated: boolean;
    permissionsDenied: boolean;
    cleanupSucceeded: boolean;
    blockedRequests: number;
    routeInstalled: boolean;
    timeoutEnforced: boolean;
    outputLimitEnforced: boolean;
    outputBytes: number;
    assetDigests?: readonly string[];
    runtimeDigest?: string;
    postRunCensus?: {
      durationMs: number;
      usedHeapBytes: number | null;
      eventListeners: number;
      eventsDispatched: number;
      timers: number;
      audioContexts: number;
      pagesBefore: number;
      pagesAfter: number;
    };
  };
}

export interface ConcreteRepairAdvice {
  issue: string;
  fix: string;
  constraint: string;
}

export interface GenerationEvaluation {
  score: number;
  confidence: number;
  failureClass: 'none' | 'render' | 'validator' | 'parse' | 'scorer' | 'infra' | 'legacy';
  repairAdvice?: ConcreteRepairAdvice;
  reasoning?: string;
  /**
   * 'unscored' when the evaluator never produced a verdict (for example it timed
   * out); `score` is then a neutral placeholder and must not be read as a result.
   * Absent on a real evaluation.
   */
  scoreState?: 'unscored';
  /** Why the evaluation is unscored, naming the evaluator and the limit that fired. */
  unscoredReason?: string;
  renderMeasure?: RenderMeasure;
  /** Primordial craft dimensions observed from rendered evidence. */
  dimensionScores?: Record<string, number>;
  /** Exact learned judgment profile applied to the overall score. */
  calibrationDigest?: string;
}
