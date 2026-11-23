/**
 * Sol L3-11 (HyperFrames half), real producer: the engine sizes the output from the composition's own HTML, so a caller
 * asking for 1920x1080 / 99 s must be told what the file really is (ffprobe), not what was asked.
 * Needs @hyperframes/producer, its browser, ffmpeg/ffprobe and vendored GSAP. ~6 s.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HyperFramesRenderer } from '../../src/render/HyperFramesRenderer.js';

vi.setConfig({ testTimeout: 180_000 });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><script src="/vendor/gsap/3.15.0/gsap.min.js"></script></head><body style="margin:0"><div id="root" data-composition-id="demo" data-width="640" data-height="360" data-start="0" data-duration="1" style="position:relative;width:640px;height:360px;background:#102040"><div id="orb" class="clip" data-start="0" data-duration="1" style="position:absolute;left:50px;top:100px;width:100px;height:100px;border-radius:50%;background:#f0a030"></div></div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});tl.to('#orb',{x:300,duration:1},0);window.__timelines['demo']=tl;</script></body></html>`;

describe('HyperFrames real export metadata', () => {
  it('returns the probed size and duration of the written file, not the requested ones', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hf-real-'));
    try {
      const result = await new HyperFramesRenderer({ tempDir: dir }).render(HTML, path.join(dir, 'out.mp4'),
        { fps: 15, width: 1920, height: 1080, duration: 99, timeoutMs: 150_000 });
      expect(result.width).toBe(640);
      expect(result.height).toBe(360);
      expect(result.duration).toBeGreaterThan(0.5);
      expect(result.duration).toBeLessThan(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
