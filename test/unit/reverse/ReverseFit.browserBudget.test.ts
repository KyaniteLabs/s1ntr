import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAudioWithBrowser } from '../../../src/cli/ReverseFit.js';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

afterEach(() => vi.restoreAllMocks());

describe('renderAudioWithBrowser duration budget', () => {
  it.each([
    { domain: 'tone', durationSec: 6, stabilizationTime: 7500, timeout: 37500, maximumDurationMs: 60000 },
    { domain: 'tone', durationSec: 120, stabilizationTime: 121500, timeout: 151500, maximumDurationMs: 486000 },
    { domain: 'strudel', durationSec: 124.3, stabilizationTime: 125800, timeout: 155800, maximumDurationMs: 503200 },
  ])('budgets capture and readback for $durationSec seconds of $domain', async (
    { domain, durationSec, stabilizationTime, timeout, maximumDurationMs },
  ) => {
    // Replace the browser boundary; never start Chromium or wait in real time.
    vi.spyOn(HeadlessRenderer.prototype, 'initialize').mockResolvedValue(undefined);
    const close = vi.spyOn(HeadlessRenderer.prototype, 'close').mockResolvedValue(undefined);
    const samples = new Float32Array([0, 0.5, -0.5]);
    const render = vi.spyOn(HeadlessRenderer.prototype, 'render').mockResolvedValue({
      success: true, logs: [], errors: [],
      audio: { success: true, samples, sampleRate: 8000, duration: durationSec, warnings: [] },
    });

    await expect(renderAudioWithBrowser('audio source', domain, durationSec)).resolves.toEqual({
      samples, sampleRate: 8000,
    });
    expect(render).toHaveBeenCalledWith('audio source', {
      domain, stabilizationTime, timeout, maximumDurationMs,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the renderer when the capture fails', async () => {
    vi.spyOn(HeadlessRenderer.prototype, 'initialize').mockResolvedValue(undefined);
    const close = vi.spyOn(HeadlessRenderer.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(HeadlessRenderer.prototype, 'render').mockResolvedValue({
      success: false, error: 'capture failed', logs: [], errors: ['capture failed'],
    });

    await expect(renderAudioWithBrowser('audio source', 'tone', 120))
      .rejects.toThrow('REVERSE_RENDER_FAILED: tone: capture failed');
    expect(close).toHaveBeenCalledOnce();
  });
});
