import { VideoRenderError } from './VideoRenderer.js';

/**
 * Wall-clock budget for a render. Per-call timeouts (CDP, npm, ffmpeg) do not
 * bound a render built from thousands of calls, and a scene that spins the
 * page's main thread answers none of them. This rejects when the budget runs
 * out whether or not `work` ever settles. `work` gets an AbortSignal that
 * fires on timeout so a cooperative backend can stop; `onTimeout` is the hard
 * stop (kill the process group).
 */
export async function withRenderBudget<T>(
  label: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      // Say only what is true: a hard stop exists only when the caller supplied one (Sol L3-11).
      const stop = onTimeout ? 'render process group killed' : 'cooperative abort signalled; no hard stop registered';
      reject(new VideoRenderError('RENDER_TIMEOUT', `${label} exceeded its ${timeoutMs} ms budget; ${stop}`));
    }, timeoutMs);
  });
  const running = work(controller.signal);
  running.catch(() => {}); // a late rejection after the timeout must not go unhandled
  try {
    return await Promise.race([running, expired]);
  } catch (err) {
    if (err instanceof VideoRenderError && err.code === 'RENDER_TIMEOUT') {
      try { await onTimeout?.(); } catch { /* the kill is best effort; the timeout is what we report */ }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SIGKILL a whole process group (negative pid), falling back to the single
 * pid. Puppeteer spawns Chrome detached, so its pid is its group id and the
 * zygote/GPU/renderer children go with it. Never kills by name or pattern.
 */
export function killProcessGroup(pid: number | undefined | null): boolean {
  if (!pid || pid <= 1) return false;
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { /* group gone or not a leader */ }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}
