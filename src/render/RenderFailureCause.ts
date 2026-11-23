import type { RenderResult } from './HeadlessRenderer.js';

/**
 * Why a browser render failed, typed once for every consumer (Sol L3-12). Only the
 * renderer's own reason counts: text the piece threw is removed, so a sketch's
 * "browser is not defined" is not read as a missing browser, and a captured frame
 * proves the browser ran. `host-contention` is the render-duration guard firing on a
 * loaded host (infrastructure, retryable); `infra` is a missing or broken browser;
 * `candidate` is the piece's own failure.
 */
export type RenderFailureCause = 'host-contention' | 'infra' | 'candidate';
export function classifyRenderFailure(
  result: Pick<RenderResult, 'success' | 'error' | 'pageErrors' | 'screenshot' | 'rendered' | 'setupDeadline'>,
): RenderFailureCause | undefined {
  if (result.success) return undefined;
  if (result.setupDeadline) return 'infra';
  const lowerError = (result.pageErrors ?? [])
    .reduce((message, thrown) => message.split(thrown).join(''), result.error || '')
    .toLowerCase();
  if (lowerError.includes('render_host_contention')) return 'host-contention';
  if (!result.screenshot?.success && (
    lowerError.includes('failed to initialize headless browser')
    || lowerError.includes('browser context not initialized')
    || lowerError.includes('executable')
    || lowerError.includes('sandbox unavailable')
    || lowerError.includes('playwright')
    || lowerError.includes('chromium')
    || lowerError.includes('browser')
    || lowerError.includes('spawn')
    || lowerError.includes('econnrefused'))) return 'infra';
  return 'candidate';
}
