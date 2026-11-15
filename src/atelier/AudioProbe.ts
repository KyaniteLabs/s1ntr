/**
 * AudioProbe — audible-validation gate for audio-domain artifacts.
 *
 * A piece that cannot produce sound is not music, however good its code
 * looks. This probe loads the playable headlessly, patches the WebAudio
 * node prototypes BEFORE page scripts run, clicks the play control, and
 * counts real audio source starts. Judges never see a silent artifact.
 */
export interface AudioProbeResult {
  readonly events: number;
  readonly clicked: boolean;
  readonly error?: string;
}

const INIT_SCRIPT = `
window.__sinterAudioEvents = 0;
(function () {
  try {
    var patch = function (proto) {
      var orig = proto.start;
      proto.start = function () { window.__sinterAudioEvents++; return orig.apply(this, arguments); };
    };
    if (window.AudioBufferSourceNode) patch(AudioBufferSourceNode.prototype);
    if (window.OscillatorNode) patch(OscillatorNode.prototype);
  } catch (e) { /* probe must never break the page */ }
})();
`;

export async function probeAudio(htmlPath: string): Promise<AudioProbeResult> {
  let browser: import('playwright').Browser | null = null;
  try {
    const { chromium } = await import('playwright');
    const { resolveChromiumExecutablePath } = await import('../utils/browserAssetFallbacks.js');
    const { sandboxOptOutArgs } = await import('../security/SandboxConfig.js');
    browser = await chromium.launch({ headless: true,
      executablePath: resolveChromiumExecutablePath(),
      args: [...sandboxOptOutArgs(), '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // #924 regression: stored playables reference root-absolute /vendor/ URLs
    // that never resolve under file:// — every vendored piece looked silent.
    // Inline the vendored assets and load via setContent, with the probe init
    // PREPENDED (addInitScript does not run for setContent documents).
    const { readFileSync } = await import('node:fs');
    const { inlineVendorAssets } = await import('../utils/vendorAssets.js');
    // The probe must reproduce the PRODUCTION page environment: the renderer's
    // html-prepended init carries the strudel tempo/pattern shims and the
    // Dirt-Samples bank preload that stored playables need to actually sound
    // (PRs #1119/#1122/#1123). Without it the probe hears silence for pieces
    // the real render plays.
    const { audioCapturePageInit } = await import('../render/HeadlessRenderer.js');
    const raw = readFileSync(htmlPath, 'utf8');
    const inlined = await inlineVendorAssets(raw);
    const init = '<script>' + INIT_SCRIPT + '</script>'
      + '<script>(' + audioCapturePageInit.toString() + ')();</script>';
    await page.setContent(init + inlined, { waitUntil: 'load', timeout: 20000 });
    // #926: poll for the play control instead of a flat 1500ms sleep — it
    // appears as soon as the page script runs (typically <300ms headless).
    let control = await page.waitForSelector('#sinter-tone-start, #sinter-strudel-play, button#play', { timeout: 2000 }).catch(() => null);
    if (!control) control = await page.$('button:has-text("Start preview"), button:has-text("Play")');
    if (!control) return { events: 0, clicked: false, error: 'NO_PLAY_CONTROL' };
    // The strudel shell ignores clicks until its sample-bank boot finishes
    // ("Still booting"): click, and re-click while the shell reports booting.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await control.click();
      const stillBooting = await page.evaluate(() =>
        (document.getElementById('sinter-strudel-status')?.textContent ?? '').includes('booting')
        || (document.getElementById('status')?.textContent ?? '').includes('booting'))
        .catch(() => false);
      if (!stillBooting) break;
      await page.waitForTimeout(1200);
    }
    // #926: poll for audio events instead of a flat 5000ms sleep — the
    // piece is live as soon as the first source start lands (<1s typical).
    await page.waitForFunction(
      () => ((window as { __sinterAudioEvents?: number }).__sinterAudioEvents ?? 0) > 0,
      undefined, { timeout: 7000, polling: 200 },
    ).catch(() => undefined);
    const events = await page.evaluate(() => (window as { __sinterAudioEvents?: number }).__sinterAudioEvents ?? 0);
    return { events, clicked: true };
  } catch (error) {
    return { events: 0, clicked: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await browser?.close().catch(() => {});
  }
}
