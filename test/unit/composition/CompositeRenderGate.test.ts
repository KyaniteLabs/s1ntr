import { describe, it, expect, afterEach, vi } from 'vitest';

const puppeteerMocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock('puppeteer', () => ({
  default: { launch: puppeteerMocks.launch },
}));

const mockResolve = vi.hoisted(() => vi.fn(() => '/opt/chromium' as string | null));
vi.mock('../../../src/utils/browserAssetFallbacks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/browserAssetFallbacks.js')>()),
  resolveChromiumExecutablePath: mockResolve,
}));
import {
  verdictFromMeasure,
  layersToDemote,
  gateEnabled,
  measureCompositeHtml,
  DEMOTED_OPACITY_FACTOR,
} from '../../../src/composition/CompositeRenderGate.js';

const measure = (meanLuminance: number, brightFraction = 0.3, darkFraction = 0.1) => ({
  meanLuminance,
  brightFraction,
  darkFraction,
});

describe('CompositeRenderGate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    puppeteerMocks.launch.mockReset();
    mockResolve.mockReturnValue('/opt/chromium');
  });

  describe('verdictFromMeasure', () => {
    it('flags washed-out frames at the calibrated threshold', () => {
      expect(verdictFromMeasure(measure(0.93))).toBe('washout'); // dusk-bloom class
      expect(verdictFromMeasure(measure(0.8))).toBe('washout'); // boundary inclusive
      expect(verdictFromMeasure(measure(0.79))).toBe('ok');
    });

    it('flags crushed frames only when bright focal content is absent', () => {
      expect(verdictFromMeasure(measure(0.05, 0.0))).toBe('too-dark');
      expect(verdictFromMeasure(measure(0.1, 0.019))).toBe('too-dark'); // boundary inclusive
      // Legit dark design: dark ground WITH bright focal content passes —
      // the calibration that stops kinetic typography being forced into mud.
      expect(verdictFromMeasure(measure(0.05, 0.1))).toBe('ok');
    });

    it('passes balanced frames', () => {
      expect(verdictFromMeasure(measure(0.47))).toBe('ok'); // the graded showpiece
    });

    it('routes concentrated clipped highlights through washout remediation', () => {
      expect(verdictFromMeasure({ meanLuminance: 0.47, brightFraction: 0.39,
        darkFraction: 0.14, brightnessStd: 86, clippedHighlightFraction: 0.18 }))
        .toBe('washout');
    });

    it('flags mid-grey mud when the spread collapses with no anchors (fog-audit calibration)', () => {
      // Flat slate stack: mid luminance, no darks, no highlights, std 9.
      expect(verdictFromMeasure({ meanLuminance: 0.48, brightFraction: 0.01, darkFraction: 0.0, brightnessStd: 9 })).toBe('muddy');
      // Same stats without a measured std: conservative, stays ok.
      expect(verdictFromMeasure(measure(0.48, 0.01, 0.0))).toBe('ok');
      // Healthy spread at the same luminance stays ok.
      expect(verdictFromMeasure({ meanLuminance: 0.48, brightFraction: 0.01, darkFraction: 0.0, brightnessStd: 28 })).toBe('ok');
      // Dark-anchored frames are never mud regardless of spread.
      expect(verdictFromMeasure({ meanLuminance: 0.4, brightFraction: 0.01, darkFraction: 0.3, brightnessStd: 9 })).toBe('ok');
    });
  });

  describe('layersToDemote', () => {
    it('demotes lightening blends (and overlay) on washout, never the base layer', () => {
      expect(layersToDemote('washout', ['screen', 'screen', 'lighten', 'overlay', 'normal'])).toEqual([1, 2, 3]);
    });

    it('demotes darkening blends on too-dark, never the base layer', () => {
      expect(layersToDemote('too-dark', ['multiply', 'multiply', 'darken', 'screen'])).toEqual([1, 2]);
    });

    it('squeezes every non-base layer on mud so the base value structure shows through', () => {
      expect(layersToDemote('muddy', ['normal', 'screen', 'normal', 'overlay'])).toEqual([1, 2, 3]);
    });

    it('returns nothing for ok frames or when no blend is in the failed direction', () => {
      expect(layersToDemote('ok', ['screen', 'screen'])).toEqual([]);
      expect(layersToDemote('washout', ['normal', 'multiply', 'difference'])).toEqual([]);
      expect(layersToDemote('too-dark', ['normal', 'screen', 'lighten'])).toEqual([]);
    });
  });

  it('measures screenshot pixels and always closes the browser', async () => {
    vi.stubEnv('LIMINAL_DISABLE_SANDBOX', 'false');
    class FakeImage {
      width = 2;
      height = 1;
      onload?: () => void;
      onerror?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: () => ({ data: pixels }),
        }),
      }),
    });
    const page = {
      setViewport: vi.fn(),
      setContent: vi.fn(),
      screenshot: vi.fn(async () => 'base64-shot'),
      evaluate: vi.fn(async (callback, value) => callback(value)),
    };
    const browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    puppeteerMocks.launch.mockResolvedValue(browser);

    const result = await measureCompositeHtml('<main>art</main>', {
      width: 320,
      height: 240,
      settleMs: 0,
    });

    expect(result).toEqual({
      meanLuminance: 0.5,
      brightFraction: 0.5,
      darkFraction: 0.5,
      clippedHighlightFraction: 0.5,
      brightnessStd: 127.5,
    });
    expect(page.setViewport).toHaveBeenCalledWith({ width: 320, height: 240 });
    expect(browser.close).toHaveBeenCalledOnce();
    // The gate measures what the renderer draws: software WebGL, sandbox on.
    const { args } = puppeteerMocks.launch.mock.calls[0][0] as { args: string[] };
    expect(args).toContain('--enable-unsafe-swiftshader');
    expect(args).not.toContain('--no-sandbox');
    expect(args.some((arg) => arg.startsWith('--disable-web-security'))).toBe(false);
  });

  it('launches the resolved Chromium with the gate\'s own args', async () => {
    puppeteerMocks.launch.mockRejectedValue(new Error('stop'));
    await expect(measureCompositeHtml('<main/>')).rejects.toThrow('stop');
    const opts = puppeteerMocks.launch.mock.calls[0][0] as { executablePath: string; args: string[] };
    expect(opts.executablePath).toBe('/opt/chromium');
    expect(opts.args).toContain('--enable-unsafe-swiftshader');
  });

  it('throws the missing-browser error and never launches when nothing resolves', async () => {
    mockResolve.mockReturnValue(null);
    await expect(measureCompositeHtml('<main/>')).rejects.toThrow(/Chromium executable not found/);
    expect(puppeteerMocks.launch).not.toHaveBeenCalled();
  });

  describe('gate config', () => {
    const saved = process.env.SINTER_COMPOSITE_GATE;
    afterEach(() => {
      if (saved === undefined) delete process.env.SINTER_COMPOSITE_GATE;
      else process.env.SINTER_COMPOSITE_GATE = saved;
    });

    it('is on by default and disabled by SINTER_COMPOSITE_GATE=0', () => {
      delete process.env.SINTER_COMPOSITE_GATE;
      expect(gateEnabled()).toBe(true);
      process.env.SINTER_COMPOSITE_GATE = '0';
      expect(gateEnabled()).toBe(false);
    });

    it('honors SINTER_COMPOSITE_GATE_TIMEOUT_MS and the navTimeoutMs option (wave-10 defect #7)', async () => {
      vi.stubGlobal('Image', class { width = 1; height = 1; onload?: () => void; set src(_v: string) { queueMicrotask(() => this.onload?.()); } });
      vi.stubGlobal('document', {
        createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) }) }),
      });
      const page = { setViewport: vi.fn(), setContent: vi.fn(), screenshot: vi.fn(async () => 'b64'), evaluate: vi.fn(async (cb: (v: string) => void, v: string) => cb(v)) };
      const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
      puppeteerMocks.launch.mockResolvedValue(browser);

      // Default is 30s (the prior fixed value).
      await measureCompositeHtml('<main>art</main>', { settleMs: 0 });
      expect(page.setContent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeout: 30_000, waitUntil: 'networkidle0' }));

      // Env lifts it for slow CDN-bound hosts.
      process.env.SINTER_COMPOSITE_GATE_TIMEOUT_MS = '90000';
      page.setContent.mockClear();
      await measureCompositeHtml('<main>art</main>', { settleMs: 0 });
      expect(page.setContent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeout: 90_000 }));

      // Explicit caller option wins over env.
      page.setContent.mockClear();
      await measureCompositeHtml('<main>art</main>', { settleMs: 0, navTimeoutMs: 45_000 });
      expect(page.setContent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeout: 45_000 }));

      delete process.env.SINTER_COMPOSITE_GATE_TIMEOUT_MS;
    });

    it('keeps demoted layers translucent rather than occluding the stack', () => {
      expect(DEMOTED_OPACITY_FACTOR).toBe(0.75);
    });
  });
});
