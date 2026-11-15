/**
 * RenderArtifactTool - give the harness agent eyes.
 *
 * Renders an artifact (inline code or a repo file) through the existing
 * HeadlessRenderer evidence path and returns the screenshot plus console
 * logs/errors. The screenshot is consumed by the agent loop and attached as
 * an image input to the next planning call when the harness model is
 * vision-capable (see LLMModeAgent); the tool itself is read-only with
 * respect to the repository.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tool, type ToolResult, type RenderArtifactParams, type RenderArtifactResult } from './types.js';
import { HeadlessRenderer, type RenderDomain, type RenderOptions } from '../../render/HeadlessRenderer.js';

const MAX_CODE_CHARS = 200_000;
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 4096;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

const RENDER_DOMAINS: ReadonlySet<string> = new Set([
  'p5', 'three', 'glsl', 'hydra', 'strudel', 'tone', 'svg', 'html',
  'dataviz', 'meta', 'ascii', 'kinetic', 'textgen', 'unknown',
]);

/** Injectable subset of HeadlessRenderer so tests can fake the render path. */
type RendererLike = Pick<HeadlessRenderer, 'renderWithEvidence'>;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export class RenderArtifactTool extends Tool {
  readonly name = 'renderArtifact';
  readonly description = 'Render an artifact headlessly and capture a screenshot for visual inspection';

  constructor(private readonly renderer?: RendererLike) {
    super();
  }

  async execute(params: unknown): Promise<ToolResult<RenderArtifactResult>> {
    const startTime = Date.now();
    const raw = (params || {}) as RenderArtifactParams;

    try {
      if (raw.domain !== undefined && !RENDER_DOMAINS.has(raw.domain)) {
        return {
          success: false,
          error: `Unknown render domain: ${raw.domain}. Allowed: ${[...RENDER_DOMAINS].join(', ')}`,
          duration: Date.now() - startTime,
        };
      }

      const codeResult = await this.resolveCode(raw);
      if (codeResult.error !== undefined) {
        return { success: false, error: codeResult.error, duration: Date.now() - startTime };
      }
      const code = codeResult.code;

      const options: RenderOptions = {
        domain: (raw.domain as RenderDomain | undefined) ?? 'unknown',
        width: clampInt(raw.width, MIN_DIMENSION, MAX_DIMENSION, 800),
        height: clampInt(raw.height, MIN_DIMENSION, MAX_DIMENSION, 600),
        timeout: clampInt(raw.timeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 30000),
      };

      const renderer = this.renderer ?? HeadlessRenderer.getInstance();
      const evidence = await renderer.renderWithEvidence(code, options);

      const domain = options.domain && options.domain !== 'unknown'
        ? options.domain
        : HeadlessRenderer.detectDomain(code);

      const data: RenderArtifactResult = {
        domain,
        timingMs: evidence.timingMs,
        infraUnavailable: evidence.infraUnavailable,
        candidateFailure: evidence.candidateFailure,
        screenshot: evidence.screenshot,
        lateScreenshot: evidence.lateScreenshot,
        logs: evidence.logs ?? [],
        errors: evidence.errors ?? [],
      };

      // Infra failure is a capability failure, not a candidate verdict: the
      // caller must not treat it as "the artifact rendered blank".
      if (evidence.infraUnavailable) {
        return {
          success: false,
          error: 'Render infrastructure unavailable (headless browser failed to start or crashed)',
          data,
          duration: Date.now() - startTime,
        };
      }

      // Candidate failures (blank render, JS errors, timeout) are still a
      // successful tool execution: the agent needs the error text to fix the
      // artifact.
      return { success: true, data, duration: Date.now() - startTime };
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
        duration: Date.now() - startTime,
      };
    }
  }

  private async resolveCode(raw: RenderArtifactParams): Promise<{ code: string; error?: undefined } | { code?: undefined; error: string }> {
    const hasCode = typeof raw.code === 'string' && raw.code.trim().length > 0;
    const hasPath = typeof raw.path === 'string' && raw.path.trim().length > 0;

    if (hasCode === hasPath) {
      return { error: 'renderArtifact requires exactly one of params.code or params.path' };
    }

    if (hasCode) {
      if (raw.code!.length > MAX_CODE_CHARS) {
        return { error: `params.code exceeds ${MAX_CODE_CHARS} characters` };
      }
      return { code: raw.code! };
    }

    const resolved = path.resolve(raw.path!);
    if (!this.validatePath(resolved)) {
      return { error: `Path not allowed: ${raw.path}` };
    }
    const code = await readFile(resolved, 'utf8');
    if (code.trim().length === 0) {
      return { error: `Artifact file is empty: ${raw.path}` };
    }
    if (code.length > MAX_CODE_CHARS) {
      return { error: `Artifact file exceeds ${MAX_CODE_CHARS} characters: ${raw.path}` };
    }
    return { code };
  }
}

export const renderArtifactTool = new RenderArtifactTool();
