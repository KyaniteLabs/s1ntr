/**
 * Generic HTML wrapper for non-P5/Three domains
 * Handles: Strudel, Hydra, Tone.js, Shader, Revideo, ASCII
 */

import { expandShaderChunks } from '../../generators/glsl/ShaderChunks.js';
import { SECURITY_HEADERS } from './SecurityHeaders.js';
import { transliterateTypography } from '../../core/recovery/SourceRecovery.js';
import { VENDOR_ASSETS } from '../../utils/vendorAssets.js';
import type { EngineDomainString } from '../../types/domains.js';
import { answerCode } from '../../llm/ModelOutput.js';
import { scriptSafe, scriptString } from '../../utils/scriptEmbed.js';
import { musicRuntimeScript } from './musicRuntime.js';
import { parse } from '@babel/parser';

const STRUDEL_CDN = VENDOR_ASSETS.strudel;
const HYDRA_CDN = VENDOR_ASSETS.hydra;
/**
 * Declared in the same block the hydra piece runs in, so a piece that
 * declares go or o is a redeclaration SyntaxError. HydraValidator parses the
 * piece behind this exact line. One line so piece line numbers don't shift.
 */
export const HYDRA_PIECE_PRELUDE = "const go = () => {}; const o = typeof o0 !== 'undefined' ? o0 : undefined;";
const TONE_CDN = VENDOR_ASSETS.tone;
const STRUDEL_SECURITY_HEADERS = SECURITY_HEADERS
  // 'unsafe-eval' is REQUIRED: the strudel runtime transpiles pattern code via
  // new Function — without it the pattern evaluates hollow and plays silence
  // (proven by CSP bisection: every directive variant failed until this).
  // worker-src 'self': the vendored bundle spawns its clockworker from its own
  // /vendor/... URL. connect-src: sample banks stay REMOTE (see #924) — the
  // b-cdn manifests reference audio on raw.githubusercontent.com.
  .replace("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval'")
  .replace("connect-src 'none'", "worker-src blob: 'self'; connect-src 'self' https://strudel.b-cdn.net https://raw.githubusercontent.com");
// The real REPL loads these banks from its CDN (verified by watching strudel.cc's
// own network traffic). Without them, sample-based patterns run in silence.
const HYDRA_SECURITY_HEADERS = SECURITY_HEADERS
  .replace("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval'");
// Tone imports worklet code from locally generated blob URLs.
const TONE_SECURITY_HEADERS = SECURITY_HEADERS
  .replace("'unsafe-inline'; style-src", "'unsafe-inline' blob:; style-src")
  .replace("connect-src 'none';", 'connect-src blob:;')
  .replace("media-src 'self';", "media-src 'self'; worker-src blob:;");

/**
 * Audio pages show their work: a scope drawn from the sound actually reaching
 * the speakers, not a clock-driven animation. Must run before the audio
 * library loads — it taps every connect() into an AudioDestinationNode with a
 * per-context AnalyserNode. Silence draws a flat line labelled "silent".
 */
const AUDIO_SCOPE_SCRIPT = `<script>
(function () {
  var scopes = window.__sinterScopes = [];
  var proto = window.AudioNode && window.AudioNode.prototype;
  if (proto && window.AudioDestinationNode) {
    var connect = proto.connect, taps = new WeakMap();
    proto.connect = function (target) {
      var out = connect.apply(this, arguments);
      try {
        if (target instanceof window.AudioDestinationNode) {
          var a = taps.get(target.context);
          if (!a) { a = target.context.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0.7; taps.set(target.context, a); scopes.push(a); }
          if (this !== a) connect.call(this, a);
        }
      } catch (e) { /* a scope must never break playback */ }
      return out;
    };
  }
  window.__sinterDrawScope = function (canvas) {
    var g = canvas.getContext('2d'), wave = new Float32Array(2048), spec = new Uint8Array(1024);
    function frame() {
      var w = canvas.width, h = canvas.height, rms = 0, live = scopes.filter(function (a) { return a.context.state === 'running'; });
      g.fillStyle = '#020617'; g.fillRect(0, 0, w, h);
      if (live.length) {
        live[0].getFloatTimeDomainData(wave); live[0].getByteFrequencyData(spec);
        for (var i = 0; i < wave.length; i++) rms += wave[i] * wave[i];
        rms = Math.sqrt(rms / wave.length);
      }
      var bars = 64, bw = w / bars;
      for (var b = 0; b < bars; b++) {
        var lo = Math.floor(Math.pow(512, b / bars)), hi = Math.max(lo + 1, Math.floor(Math.pow(512, (b + 1) / bars)));
        var m = 0; for (var k = lo; k < hi; k++) m = Math.max(m, spec[k]);
        var bh = (m / 255) * h * 0.9;
        g.fillStyle = 'hsl(' + (200 - b * 2.6) + ',85%,' + (40 + m / 8) + '%)';
        g.fillRect(b * bw + 1, h - bh, bw - 2, bh);
      }
      g.strokeStyle = 'rgba(248,250,252,.9)'; g.lineWidth = 2; g.beginPath();
      for (var x = 0; x < w; x++) { var y = h / 2 - wave[Math.floor(x / w * wave.length)] * h * 0.45; x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
      var silent = rms < 1e-4;
      g.fillStyle = silent ? '#94a3b8' : '#facc15'; g.font = '600 ' + Math.max(11, h / 12) + 'px ui-monospace, monospace';
      g.fillText(silent ? 'silent' : 'live audio · rms ' + rms.toFixed(3), 10, Math.max(16, h / 8));
      canvas.dataset.audioRms = rms.toFixed(4);
      if (silent) wave.fill(0), spec.fill(0);
      requestAnimationFrame(frame);
    }
    frame();
  };
})();
</script>`;

export type GenericDomain = Extract<EngineDomainString, 'strudel' | 'hydra' | 'tone' | 'shader' | 'revideo' | 'ascii' | 'hyperframes'>;

export interface GenericWrapOptions {
  domain: GenericDomain;
  title?: string;
  autoPlay?: boolean;
  showPreview?: boolean;
  asciiWidth?: number;
  hydraResolution?: { width: number; height: number };
  /** True when this output is stacked above another composition layer. */
  compositionForeground?: boolean;
}

export class GenericWrapper {
  private static escapeHTML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private static isHTMLDocument(code: string): boolean {
    const trimmed = code.trim();
    return /^<!doctype\s+html/i.test(trimmed) || /^<html\b/i.test(trimmed) || /<body\b/i.test(trimmed);
  }

  private static isHTMLFragment(code: string): boolean {
    if (!/<\/?(?:script|style|button|div|main|section|canvas|audio|body|html)\b/i.test(code)) return false;
    // JS that names a tag in a string or comment is still JS; the HTML path
    // would find no <script> in it and drop the artwork.
    return !this.parsesAsScript(code);
  }

  private static parsesAsScript(code: string): boolean {
    for (const sourceType of ['script', 'module'] as const) {
      try {
        parse(code, { sourceType, allowAwaitOutsideFunction: true });
        return true;
      } catch {
        // try the next source type
      }
    }
    return false;
  }

  private static extractBodyFragment(html: string): string {
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
    if (body) return body;
    return html
      .replace(/<!doctype\s+html[^>]*>/gi, '')
      .replace(/<html\b[^>]*>|<\/html>/gi, '')
      .replace(/<head\b[\s\S]*?<\/head>/gi, '')
      .replace(/<body\b[^>]*>|<\/body>/gi, '');
  }

  private static extractInlineScripts(html: string): string[] {
    return [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map(match => match[1])
      .map(script => this.retargetToneDomWrites(script))
      .filter(script => script.trim().length > 0)
      .filter(script => !/\bdocument\.write\s*\(/.test(script));
  }

  private static retargetToneDomWrites(script: string): string {
    // Retarget only page-level document replacement writes. Local element
    // updates such as querySelector(...).innerHTML stay authored so generated
    // controls do not lose their own internal rendering behavior.
    return script.replace(
      /\bdocument\.(?:body|documentElement)\.innerHTML\b/g,
      "document.getElementById('tone-artifact-surface').innerHTML",
    );
  }

  private static extractToneBpm(code: string): number | null {
    const bpmMatches = [...code.matchAll(/\b(?:Tone\.)?Transport\.bpm\.value\s*=\s*([0-9]+(?:\.[0-9]+)?)/g)];
    const lastBpmMatch = bpmMatches.at(-1);
    if (!lastBpmMatch) return null;
    const bpm = Number(lastBpmMatch[1]);
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) return null;
    return Math.round(bpm);
  }

  private static stripExecutableHTML(fragment: string): string {
    return fragment
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<\/?script\b[^>]*>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<\/?(?:html|body)\b[^>]*>/gi, '')
      .trim();
  }

  private static stripLLMToolMarkup(code: string): string {
    return answerCode(code)
      .replace(/<tool_call\b[\s\S]*?<arg_value\b[^>]*>/gi, '')
      .replace(/<\/arg_value>(?:\\n|\s)*<\/tool_call>\s*$/gi, '')
      .replace(/<\/arg_value>[\s\S]*?<\/tool_call>\s*$/gi, '')
      .trim();
  }

  private static extractRevideoLabels(code: string): string[] {
    const labels = [
      ...[...code.matchAll(/<Txt\b[^>]*\btext\s*=\s*(?:\{\s*)?["'`]([^"'`]{2,90})["'`]/g)].map(match => match[1]),
      ...[...code.matchAll(/<Txt\b[^>]*>([^<]{2,90})<\/Txt>/g)].map(match => match[1]),
      ...[...code.matchAll(/["'`]([^"'`]{4,70})["'`]/g)].map(match => match[1]),
    ];
    const blocked = /^(?:@revideo\/|react|typescript|tsx|durationInFrames|width|height|fps|fill|font|fontFamily|layout|center|middle|white|black|transparent)$/i;
    return [...new Set(labels
      .map(label => label.replace(/\s+/g, ' ').trim())
      .filter(label => label.length >= 3 && !blocked.test(label) && !label.includes('@revideo/')))]
      .slice(0, 3);
  }

  /**
   * Detect domain from code content for generic wrappers
   */
  static detectDomain(code: string): GenericDomain | null {
    if (this.isHyperframesCode(code)) return 'hyperframes';
    if (this.isStrudelCode(code)) return 'strudel';
    if (this.isHydraCode(code)) return 'hydra';
    if (this.isToneJSCode(code)) return 'tone';
    if (this.isShaderCode(code)) return 'shader';
    if (this.isRevideoCode(code)) return 'revideo';
    if (this.isASCIICode(code)) return 'ascii';
    return null;
  }

  private static isHyperframesCode(code: string): boolean {
    const hasComposition = /data-composition-id/i.test(code);
    const hasClipTiming = /class\s*=\s*["'][^"']*\bclip\b[^"']*["']/i.test(code) && /data-(?:start|duration|track-index)/i.test(code);
    const hasTimeline = /gsap\.(?:timeline|from|to)\s*\(/.test(code) || /window\.__timelines/.test(code);
    return hasComposition && hasClipTiming && hasTimeline;
  }

  private static isStrudelCode(code: string): boolean {
    const strudelPatterns = [
      /\bstack\s*\(/,
      /\bs\s*\(\s*["']/,  // s("bd")
      /\bnote\s*\(/,
      /\bsound\s*\(/,      // Strudel v2
      /\|>/,               // Strudel v2 pipe operator
      /\bstruct\s*\(/,     // Strudel v2
      /\.cpm\s*\(/,
      /\.fast\s*\(/,
      /\.slow\s*\(/,
    ];
    return strudelPatterns.some(p => p.test(code)) &&
           !code.includes('function setup()') &&
           !code.includes('void main()');
  }

  private static isHydraCode(code: string): boolean {
    const hydraPatterns = [
      /\bosc\s*\(/,
      /\bshape\s*\(/,
      /\bnoise\s*\(/,
      /\bvoronoi\s*\(/,
      /\.kaleid\s*\(/,
      /\.colorama\s*\(/,
      /\.modulate\s*\(/,
      /\.out\s*\(\s*o\d/,
      /\brender\s*\(/,
    ];
    return hydraPatterns.filter(p => p.test(code)).length >= 2;
  }

  private static isToneJSCode(code: string): boolean {
    const tonePatterns = [
      /\bTone\./,
      /\bSynth\b/,
      /\bPolySynth\b/,
      /\bMembraneSynth\b/,
      /\bReverb\b/,
      /\bDelay\b/,
      /\bTransport\b/,
      /\bSequence\b/,
      /\bPattern\b/,
      /\btriggerAttackRelease\b/,
    ];
    return tonePatterns.some(p => p.test(code));
  }

  private static isShaderCode(code: string): boolean {
    const hasVoidMain = /void\s+main\s*\(/.test(code);
    const hasFragColor = /gl_FragColor|out\s+vec4\s+fragColor/.test(code);
    const hasUniforms = /uniform\s+(vec2|vec3|vec4|float|int|mat)/.test(code);
    const hasPrecision = /precision\s+(highp|mediump|lowp)\s+float/.test(code);

    const glslIndicators = [hasVoidMain, hasFragColor, hasUniforms, hasPrecision]
      .filter(Boolean).length;

    return glslIndicators >= 2 && !code.includes('function setup()') && !code.includes('function draw()');
  }

  private static isRevideoCode(code: string): boolean {
    return /@revideo\/(core|2d)|\bmakeScene\s*\(|\bcreateRef\s*(?:<|\()|from\s+['"]@revideo\//.test(code);
  }

  private static isASCIICode(code: string): boolean {
    const lines = code.split('\n');
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    const hasMultipleLines = nonEmptyLines.length >= 3;
    const artChars = code.match(/[█▓▒░@#%*+=~^_/\\|(){}[\].,:;'"-]/g)?.length ?? 0;
    const visibleChars = code.replace(/\s/g, '').length || 1;
    const hasAsciiArtDensity = artChars >= 8 && artChars / visibleChars > 0.35;
    const noJSFunctions = !/\b(function|const|let|var|import|export)\b/.test(code);
    const noHTMLTags = !/<[a-z][\s\S]*>/i.test(code);

    return hasMultipleLines && hasAsciiArtDensity && noJSFunctions && noHTMLTags;
  }

  /**
   * Wrap code based on the specified domain
   */
  static wrap(code: string, options: GenericWrapOptions): string {
    const { domain } = options;

    switch (domain) {
      case 'strudel':
        return this.wrapStrudel(code, options.autoPlay ?? false);
      case 'hydra':
        return this.wrapHydra(code, options.hydraResolution ?? { width: 1280, height: 720 });
      case 'tone':
        return this.wrapToneJS(code);
      case 'shader':
        return this.wrapShader(code);
      case 'revideo':
        return this.wrapRevideo(code, options.showPreview ?? false);
      case 'hyperframes':
        return this.wrapHyperframes(code, options.title ?? 'HyperFrames Preview');
      case 'ascii':
        return this.wrapASCII(code, options.asciiWidth ?? 60, options.compositionForeground ?? false, options.title);
      default:
        throw new Error(`Unknown domain: ${domain}`);
    }
  }

  private static wrapStrudel(code: string, _autoPlay = false): string {
    // Transliterate typographic chars (em-dash, arrows, curly quotes) — the
    // transpiler's parser rejects them even in comments, and older artifacts
    // predate the spine's intake normalization.
    code = transliterateTypography(code);
    const visibleCode = this.escapeHTML(code);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${STRUDEL_SECURITY_HEADERS.trim()}
    <title>Strudel Pattern</title>
    ${AUDIO_SCOPE_SCRIPT}
    <script src="${STRUDEL_CDN}"></script>
    ${musicRuntimeScript()}
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background: radial-gradient(circle at 18% 12%, rgba(236,72,153,.2), transparent 28%), #111122;
            color: #fff;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            padding: 20px;
            min-height: 100vh;
        }
        [data-strudel-source-code] { min-height: 320px; margin: 0 0 14px; white-space: pre-wrap; word-break: break-word; color: #fdf2f8; background: rgba(2,6,23,.72); border: 1px solid rgba(148,163,184,.22); border-radius: 14px; padding: 16px; line-height: 1.5; }
        #sinter-strudel-play { display: block; width: 100%; margin: 0 0 12px; padding: 18px 20px; font: 800 18px system-ui, sans-serif; letter-spacing: .04em; color: #1b1024; background: linear-gradient(90deg, #f9a8d4, #ec4899); border: 0; border-radius: 14px; cursor: pointer; }
        #sinter-strudel-play:hover { filter: brightness(1.08); }
        #sinter-strudel-status { color: #f9a8d4; font-size: 13px; margin: 0 0 12px; }
        .hint { margin: 0 0 12px; color: #f9a8d4; }
        .eyebrow { color: #f9a8d4; font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 10px; }
        @media (max-width: 860px) { [data-strudel-editor-shell] { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <h3 style="color: #ec4899; margin-bottom: 8px;">🎵 Strudel Live Coding Pattern</h3>
    <p class="hint">Tap the play button — browser audio needs exactly one tap, then it runs on its own.</p>
    <button id="sinter-strudel-play" type="button" aria-label="Play pattern">&#9654; Play</button>
    <canvas id="sinter-audio-scope" width="1200" height="220" style="display:block;width:100%;height:160px;margin:0 0 12px;border-radius:14px;"></canvas>
    <pre data-strudel-source-code><code>${visibleCode}</code></pre>
    <div id="sinter-strudel-status" role="status">Ready.</div>
    <script>
      (function () {
        window.__sinterDrawScope(document.getElementById('sinter-audio-scope'));
        var btn = document.getElementById('sinter-strudel-play');
        var status = document.getElementById('sinter-strudel-status');
        var ready = false;
        var bootFailed = false;
        // (shims removed — see artwork tail-strip above)
        // One boot shared with the judge's renderer: the music runtime
        // (musicRuntime.ts) starts Strudel and loads the sample banks.
        var booted = window.__sinterStrudelBoot || Promise.reject(new Error('music runtime did not start Strudel'));
        // Generated pieces often END with invented .start()/.out() calls. A
        // trailing .out() routes a pattern away from superdough (silence), so
        // strip it; invented tempo methods are no-ops in the music runtime. The JSON embed escapes < as \u003c so an
        // artwork containing a script-close tag (comment/prose) cannot
        // terminate the page's script early (H5).
        var artwork = ${JSON.stringify(code).replace(/</g, '\\u003c')}
          .replace(/\\s*\\.\\s*start\\s*\\(\\s*\\)\\s*;?\\s*$/, '')
          .replace(/\\s*\\.\\s*tempo\\s*\\([^)]*\\)\\s*;?\\s*$/, '')
          // A trailing .out() is Kabelsalat's signal-output method; on a Strudel
          // pattern it routes away from superdough and the piece is silent.
          .replace(/\\s*\\.\\s*out\\s*\\(\\s*\\)\\s*;?\\s*$/, '');
        booted.then(function () { ready = true; status.textContent = 'Ready.'; })
          .catch(function (err) { bootFailed = true; console.warn('Strudel boot error:', err); status.textContent = 'Boot error: ' + (err && err.message ? err.message : err); });
        btn.addEventListener('click', function () {
          // A failed boot stays failed; only a boot still running asks for patience.
          if (!ready) { if (!bootFailed) status.textContent = 'Still booting — try again in a second.'; return; }
          try {
            // Chrome autoplay policy: the context must resume inside the
            // gesture handler, before any async work.
            var ctx = strudel.getAudioContext();
            if (ctx && ctx.state === 'suspended') { ctx.resume(); }
            strudel.evaluate(artwork).then(function (pattern) {
              // Strudel's REPL catches a pattern error itself, logs it, and
              // resolves with no pattern: that is not playing.
              if (!pattern) throw new Error('the pattern did not evaluate');
              btn.innerHTML = '&#9632; Stop';
              status.textContent = 'Playing.';
              btn.onclick = function () { try { strudel.hush(); } catch (e) {} btn.innerHTML = '&#9654; Play'; status.textContent = 'Stopped.'; btn.onclick = null; };
            }).catch(function (err) {
              console.error('Strudel playback error:', err);
              status.textContent = 'Playback error: ' + (err && err.message ? err.message : err);
            });
          } catch (err) {
            console.error('Strudel playback error:', err);
            status.textContent = 'Playback error: ' + (err && err.message ? err.message : err);
          }
        });
      })();
    </script>
</body>
</html>`;
  }

  private static wrapHydra(code: string, resolution: { width: number; height: number }): string {
    // A bare render() switches hydra-synth into its 2x2 output-buffer debug
    // grid: the patch shrinks to the top-left quadrant and the other three
    // render black. Generated code emits it often enough that it reached live
    // composites (investor-audit F15, pixel-identical reproduction). Pin bare
    // render() to the primary output; explicit render(oN) calls are preserved.
    // Backtick escaping corrupted legit template literals in the artwork (H5);
    // scriptSafe changes only what the HTML parser would misread.
    const safeCode = scriptSafe(code.replace(/\brender\s*\(\s*\)/g, 'render(o0)'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${HYDRA_SECURITY_HEADERS.trim()}
    <title>Hydra Visual Synthesizer</title>
    <script src="${HYDRA_CDN}"></script>
    <style>
        body {
            margin: 0;
            background: #000;
            overflow: hidden;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        canvas {
            width: 100vw;
            height: 100vh;
            display: block;
            object-fit: cover;
        }
        #error {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: #ff4444;
            font-family: monospace;
            background: rgba(0,0,0,0.9);
            padding: 20px;
            border-radius: 8px;
            display: none;
            max-width: 80%;
        }
    </style>
</head>
<body>
    <canvas id="hydra-canvas"></canvas>
    <div id="error"></div>
    <script>
        const canvas = document.getElementById('hydra-canvas');
        const errorDiv = document.getElementById('error');

        try {
            const hydraWidth = window.innerWidth || ${resolution.width};
            const hydraHeight = window.innerHeight || ${resolution.height};
            canvas.width = hydraWidth;
            canvas.height = hydraHeight;

            // Signal that hydra is initialized and ready to render.
            window.__hydraReady = true;
            window.__hydraWidth = hydraWidth;
            window.__hydraHeight = hydraHeight;

            const hydra = new Hydra({
                canvas: canvas,
                detectAudio: false,
                enableStreamCapture: false,
                width: hydraWidth,
                height: hydraHeight
            });

            // Expose hydra globally so waitForFirstFrame can read pixel data.
            window.hydra = hydra;

            // Call setResolution synchronously after construction so all
            // internal buffers are allocated at the correct size.
            if (typeof setResolution === 'function') {
                setResolution(hydraWidth, hydraHeight);
            }

            window.addEventListener('resize', () => {
                const nextWidth = window.innerWidth || ${resolution.width};
                const nextHeight = window.innerHeight || ${resolution.height};
                canvas.width = nextWidth;
                canvas.height = nextHeight;
                window.__hydraWidth = nextWidth;
                window.__hydraHeight = nextHeight;
                if (typeof setResolution === 'function') setResolution(nextWidth, nextHeight);
            });
            ${HYDRA_PIECE_PRELUDE}

            ${safeCode}

        } catch (err) {
            console.error('Hydra error:', err);
            errorDiv.style.display = 'block';
            errorDiv.innerHTML = '<strong>Hydra Error:</strong><br>' + err.message;
        }
    </script>
</body>
</html>`;
  }

  private static wrapShader(code: string): string {
    const normalizedCode = this.normalizeShaderForWebGL1(code);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${SECURITY_HEADERS.trim()}
    <title>GLSL Shader</title>
    <style>
        body { margin: 0; overflow: hidden; background: #000; }
        canvas { display: block; width: 100vw; height: 100vh; }
    </style>
</head>
<body>
    <canvas id="glCanvas"></canvas>
    <script>
        const canvas = document.getElementById('glCanvas');
        const gl = canvas.getContext('webgl');

        if (!gl) {
            alert('WebGL not supported');
            throw new Error('WebGL not supported');
        }

        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
        }
        window.addEventListener('resize', resize);
        resize();

        const vsSource = \`attribute vec4 aVertexPosition; void main() { gl_Position = aVertexPosition; }\`;
        const fsSource = ${scriptString(normalizedCode)};

        function loadShader(gl, type, source) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error('Shader compile error:', gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        }

        const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
        const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

        if (!vertexShader || !fragmentShader) {
            console.error('Shader compilation failed');
            document.body.innerHTML = '<div style="color:#f66;padding:2rem;font-family:monospace;">Shader compile error — see console</div>';
        } else {
            const shaderProgram = gl.createProgram();
            gl.attachShader(shaderProgram, vertexShader);
            gl.attachShader(shaderProgram, fragmentShader);
            gl.linkProgram(shaderProgram);

            if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
                console.error('Program link error:', gl.getProgramInfoLog(shaderProgram));
            } else {
                const positions = new Float32Array([-1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0]);
                const positionBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

                const vertexPosition = gl.getAttribLocation(shaderProgram, 'aVertexPosition');
                gl.enableVertexAttribArray(vertexPosition);
                gl.vertexAttribPointer(vertexPosition, 2, gl.FLOAT, false, 0, 0);

                const uResolution = gl.getUniformLocation(shaderProgram, 'u_resolution');
                const uTime = gl.getUniformLocation(shaderProgram, 'u_time');
                const uMouse = gl.getUniformLocation(shaderProgram, 'u_mouse');
                const uBeat = gl.getUniformLocation(shaderProgram, 'u_beat');

                let mouseX = 0, mouseY = 0;
                canvas.addEventListener('mousemove', (e) => {
                    mouseX = e.clientX;
                    mouseY = canvas.height - e.clientY;
                });

                let startTime = Date.now();
                function render() {
                    const time = (Date.now() - startTime) / 1000;
                    gl.useProgram(shaderProgram);
                    gl.uniform2f(uResolution, canvas.width, canvas.height);
                    gl.uniform1f(uTime, time);
                    gl.uniform2f(uMouse, mouseX, mouseY);
                    gl.uniform1f(uBeat, (window.sinterSignal && window.sinterSignal.beat) || 0);
                    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                    requestAnimationFrame(render);
                }
                render();
            }
        }
    </script>
</body>
</html>`;
  }

  private static normalizeShaderForWebGL1(code: string): string {
    let normalized = expandShaderChunks(code)
      .replace(/\biTime\b/g, 'u_time')
      .replace(/\biResolution\b/g, 'u_resolution');

    // Bare `uniform float time;` / `uniform vec2 resolution;` / `uniform vec2 mouse;`
    // are never set by the host (it binds only u_*), so resolution stays 0 and the
    // frame renders blank. Rename them unless the u_* form is already declared.
    for (const [bare, host] of [['time', 'u_time'], ['resolution', 'u_resolution'], ['mouse', 'u_mouse']]) {
      const declaresBare = new RegExp(`\\buniform\\s+\\w+\\s+${bare}\\s*;`).test(normalized);
      const declaresHost = new RegExp(`\\buniform\\s+\\w+\\s+${host}\\s*;`).test(normalized);
      if (declaresBare && !declaresHost) {
        normalized = normalized.replace(new RegExp(`\\b${bare}\\b`, 'g'), host);
      }
    }

    const outVar = normalized.match(/\bout\s+vec4\s+([A-Za-z_$][\w$]*)\s*;/)?.[1];
    normalized = normalized
      .replace(/^\s*#version\s+300\s+es\s*/m, '')
      .replace(/\bout\s+vec4\s+[A-Za-z_$][\w$]*\s*;\s*/g, '');

    if (outVar) {
      normalized = normalized.replace(new RegExp(`\\b${outVar}\\b`, 'g'), 'gl_FragColor');
    }

    // WebGL1 / GLSL ES 1.00 fragment shaders MUST declare a precision for the
    // default float or compile fails with "No precision specified for default
    // float". The GLSL 300 strip above has already downgraded the shader, so
    // inject here. Matches ShaderGenerator.wrapForGallery's behavior so the
    // gauntlet screenshot never shows a shader-error screen for this case.
    if (!/^\s*precision\s+(?:lowp|mediump|highp)\s+float\s*;/m.test(normalized)) {
      normalized = `precision mediump float;\n${normalized}`;
    }

    return normalized;
  }

  private static wrapRevideo(code: string, _showPreview = false): string {
    const escaped = this.escapeHTML(code);

    const durationMatch = code.match(/durationInFrames[=:]\s*(\d+)/);
    const fpsMatch = code.match(/fps[=:]\s*(\d+)/);
    const widthMatch = code.match(/width[=:]\s*(\d+)/);
    const heightMatch = code.match(/height[=:]\s*(\d+)/);

    const duration = durationMatch ? parseInt(durationMatch[1]) : 150;
    const fps = fpsMatch ? parseInt(fpsMatch[1]) : 30;
    const width = widthMatch ? parseInt(widthMatch[1]) : 1920;
    const height = heightMatch ? parseInt(heightMatch[1]) : 1080;
    const durationSec = (duration / fps).toFixed(1);
    const labels = this.extractRevideoLabels(code);
    const title = this.escapeHTML(labels[0] ?? 'Revideo scene');
    const subtitle = this.escapeHTML(labels[1] ?? 'Generated motion timeline');
    const caption = this.escapeHTML(labels[2] ?? 'Not rendered: a stand-in drawn from the scene code');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${SECURITY_HEADERS.trim()}
    <title>Revideo Composition</title>
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 20%, rgba(96,165,250,.18), transparent 32%), #05070d; color: #e0e7ff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 36px; }
        .header { display: flex; justify-content: space-between; gap: 1rem; align-items: center; margin-bottom: 18px; }
        .badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 6px;
            background: rgba(59, 130, 246, 0.3);
            color: #60a5fa;
            font-size: 0.8rem;
            margin-right: 0.5rem;
        }
        .meta { display: flex; gap: 1rem; flex-wrap: wrap; color: #94a3b8; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .meta-value { color: #e2e8f0; font-weight: 700; }
        [data-revideo-timeline-preview] { display: grid; gap: 16px; }
        .revideo-stage { position: relative; aspect-ratio: ${width} / ${height}; min-height: 360px; overflow: hidden; border-radius: 24px; border: 1px solid rgba(148,163,184,.28); background: linear-gradient(135deg, #090b17, #14162f 50%, #250b28); box-shadow: 0 24px 80px rgba(0,0,0,.42); }
        .revideo-frame-grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px); background-size: 80px 80px; opacity: .28; }
        .orb { position: absolute; width: 30%; aspect-ratio: 1; border-radius: 999px; filter: blur(1px); background: radial-gradient(circle at 35% 35%, #ecfeff, #22d3ee 24%, #7c3aed 58%, transparent 70%); left: 9%; top: 18%; animation: revideo-orbit ${durationSec}s ease-in-out infinite alternate; }
        .title-card { position: absolute; left: 8%; right: 8%; bottom: 14%; padding: clamp(18px, 4vw, 54px); border: 1px solid rgba(255,255,255,.18); border-radius: 22px; background: rgba(7,10,22,.58); backdrop-filter: blur(12px); animation: revideo-title ${durationSec}s ease-in-out infinite; }
        .eyebrow { color: #67e8f9; letter-spacing: .22em; text-transform: uppercase; font-size: clamp(11px, 1.1vw, 14px); font-weight: 800; }
        h1 { margin: 8px 0 0; font-size: clamp(40px, 8vw, 116px); line-height: .9; letter-spacing: -.06em; }
        .subtitle { margin-top: 14px; color: #c4b5fd; font-size: clamp(18px, 2.6vw, 42px); font-weight: 700; }
        .caption { margin-top: 8px; color: #94a3b8; font-size: clamp(13px, 1.4vw, 18px); }
        .timeline { position: relative; height: 68px; border: 1px solid rgba(148,163,184,.24); border-radius: 16px; background: rgba(15,23,42,.74); overflow: hidden; }
        .track { position: absolute; left: 18px; right: 18px; top: 22px; height: 12px; border-radius: 999px; background: linear-gradient(90deg, #38bdf8, #a78bfa, #f472b6); }
        .ticks { position: absolute; left: 18px; right: 18px; bottom: 12px; display: grid; grid-template-columns: repeat(8, 1fr); color: #64748b; font: 10px ui-monospace, monospace; }
        .timeline-playhead { position: absolute; top: 9px; bottom: 9px; width: 3px; border-radius: 999px; background: #fff; box-shadow: 0 0 18px #67e8f9; animation: revideo-playhead ${durationSec}s linear infinite; }
        .frame-readout { position: absolute; right: 18px; top: 43px; color: #cbd5e1; font: 11px ui-monospace, monospace; }
        details { margin-top: 18px; border: 1px solid rgba(148,163,184,.22); border-radius: 16px; background: rgba(2,6,23,.66); }
        summary { cursor: pointer; padding: 14px 16px; color: #bfdbfe; font-weight: 700; }
        pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; padding: 0 16px 16px; overflow-x: auto; color: #dbeafe; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .note { color: #94a3b8; font-size: 12px; margin-top: 10px; }
        @keyframes revideo-playhead { from { left: 18px; } to { left: calc(100% - 18px); } }
        @keyframes revideo-orbit { from { transform: translate3d(0, 0, 0) scale(.92); } to { transform: translate3d(145%, 38%, 0) scale(1.24); } }
        @keyframes revideo-title { 0% { transform: translateY(18px); opacity: .72; } 35%, 80% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(-10px); opacity: .86; } }
    </style>
</head>
<body>
    <main data-revideo-timeline-preview>
        <div class="header">
            <div>
                <span class="badge">Revideo</span>
                <span class="badge">Not rendered</span>
            </div>
            <div class="meta">
                <div>Duration: <span class="meta-value">${durationSec}s</span> (${duration} frames @ ${fps}fps)</div>
                <div>Resolution: <span class="meta-value">${width}×${height}</span></div>
            </div>
        </div>
        <section class="revideo-stage" aria-label="Unrendered Revideo stand-in">
            <div class="revideo-frame-grid"></div>
            <div class="orb"></div>
            <article class="title-card">
                <div class="eyebrow">Revideo scene, not rendered</div>
                <h1>${title}</h1>
                <div class="subtitle">${subtitle}</div>
                <div class="caption">${caption}</div>
            </article>
        </section>
        <section class="timeline" aria-label="Timeline scrub preview">
            <div class="track"></div>
            <div class="timeline-playhead"></div>
            <div class="ticks"><span>0f</span><span>${Math.round(duration * .14)}f</span><span>${Math.round(duration * .28)}f</span><span>${Math.round(duration * .42)}f</span><span>${Math.round(duration * .56)}f</span><span>${Math.round(duration * .70)}f</span><span>${Math.round(duration * .84)}f</span><span>${duration}f</span></div>
            <div class="frame-readout">looping ${duration} frames</div>
        </section>
        <p class="note">Not rendered. This stand-in shows the scene's title, length and size, not its frames. The source below is what a Revideo render would play.</p>
        <details open>
            <summary>Source code and export details</summary>
            <pre><code>${escaped}</code></pre>
        </details>
    </main>
</body>
</html>`;
  }

  private static wrapHyperframes(code: string, title = 'HyperFrames Preview'): string {
    const escapedSource = this.escapeHTML(code);
    const previewCode = this.injectHyperframesPreviewRunner(code);
    const escapedSrcdoc = previewCode
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const compositionId = code.match(/data-composition-id\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'composition';
    const width = code.match(/data-width\s*=\s*["']?(\d+)/i)?.[1] ?? '1920';
    const height = code.match(/data-height\s*=\s*["']?(\d+)/i)?.[1] ?? '1080';
    const clipCount = (code.match(/class\s*=\s*["'][^"']*\bclip\b[^"']*["']/gi) ?? []).length;
    const timelineCount = (code.match(/gsap\.(?:timeline|from|to)\s*\(/g) ?? []).length;
    const safeTitle = this.escapeHTML(title);
    const safeCompositionId = this.escapeHTML(compositionId);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 18% 12%, rgba(45,212,191,.22), transparent 30%), radial-gradient(circle at 82% 0%, rgba(129,140,248,.2), transparent 32%), #05070d; color: #eaf2ff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    [data-hyperframes-preview-shell] { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 36px; display: grid; gap: 16px; }
    .hyperframes-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .eyebrow { display: inline-flex; align-items: center; gap: 8px; border: 1px solid rgba(125,211,252,.32); background: rgba(8,47,73,.42); color: #7dd3fc; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 10px 0 0; font-size: clamp(34px, 6vw, 76px); line-height: .92; letter-spacing: -.055em; }
    .summary { color: #cbd5e1; max-width: 56ch; line-height: 1.55; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; color: #bfdbfe; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pill { border: 1px solid rgba(148,163,184,.22); border-radius: 999px; background: rgba(15,23,42,.74); padding: 6px 10px; }
    .hyperframes-stage-wrap { border: 1px solid rgba(148,163,184,.28); border-radius: 28px; overflow: hidden; background: linear-gradient(135deg, rgba(15,23,42,.96), rgba(30,41,59,.76)); box-shadow: 0 28px 90px rgba(0,0,0,.42); }
    .hyperframes-stage { display: block; width: 100%; aspect-ratio: ${width} / ${height}; min-height: 420px; border: 0; background: #050816; }
    .timeline { position: relative; height: 72px; border: 1px solid rgba(148,163,184,.22); border-radius: 18px; background: rgba(2,6,23,.72); overflow: hidden; }
    .timeline-label { position: absolute; left: 18px; top: 12px; color: #a5b4fc; font: 11px ui-monospace, monospace; }
    .track { position: absolute; left: 18px; right: 18px; top: 34px; height: 14px; border-radius: 999px; background: linear-gradient(90deg, #2dd4bf, #38bdf8, #a78bfa, #f472b6); box-shadow: 0 0 22px rgba(56,189,248,.24); }
    .playhead { position: absolute; top: 14px; bottom: 12px; width: 3px; border-radius: 999px; background: #fff; box-shadow: 0 0 22px #67e8f9; animation: hf-playhead 5s linear infinite; }
    .note { color: #94a3b8; font-size: 12px; margin: 0; }
    details { border: 1px solid rgba(148,163,184,.22); border-radius: 16px; background: rgba(2,6,23,.62); }
    summary { cursor: pointer; padding: 14px 16px; color: #93c5fd; font-weight: 800; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 0 16px 16px; max-height: 320px; overflow: auto; color: #dbeafe; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    @keyframes hf-playhead { from { left: 18px; } to { left: calc(100% - 18px); } }
    @media (max-width: 820px) { .hyperframes-header { display: grid; } .meta { justify-content: flex-start; } .hyperframes-stage { min-height: 280px; } }
  </style>
</head>
<body>
  <main data-hyperframes-preview-shell>
    <section class="hyperframes-stage-wrap" aria-label="Rendered HyperFrames stage preview">
      <iframe class="hyperframes-stage" title="HyperFrames rendered stage" srcdoc="${escapedSrcdoc}" sandbox="allow-scripts allow-same-origin"></iframe>
    </section>
    <section class="hyperframes-header">
      <div>
        <div class="eyebrow">HyperFrames composition</div>
        <h1>${safeTitle}</h1>
        <p class="summary">A browser-visible composition preview for HTML + GSAP assets. The generated stage stays live above; export/render details stay available without dominating the artist-facing view.</p>
      </div>
      <div class="meta" aria-label="HyperFrames metadata">
        <span class="pill">id: ${safeCompositionId}</span>
        <span class="pill">${clipCount} clips</span>
        <span class="pill">${timelineCount} timeline calls</span>
        <span class="pill">${width}×${height}</span>
      </div>
    </section>
    <section class="timeline" aria-label="HyperFrames timeline preview">
      <div class="timeline-label">GSAP timeline / export preview</div>
      <div class="track"></div>
      <div class="playhead"></div>
    </section>
    <p class="note">Use @hyperframes/producer / Exporter.exportVideo() for final MP4 output. This shell is for quick visual inspection inside Studio.</p>
    <details>
      <summary>Source code and export details</summary>
      <pre><code>${escapedSource}</code></pre>
    </details>
  </main>
</body>
</html>`;
}

  private static injectHyperframesPreviewRunner(code: string): string {
    const runner = `<script data-hyperframes-preview-runner>
(function () {
  function fitHyperframesStage() {
    const stage = document.querySelector('[data-composition-id]');
    if (!stage) return;
    const width = Number(stage.getAttribute('data-width')) || stage.offsetWidth || 1920;
    const height = Number(stage.getAttribute('data-height')) || stage.offsetHeight || 1080;
    const scale = Math.min(window.innerWidth / width, window.innerHeight / height, 1);
    document.documentElement.style.width = '100%';
    document.documentElement.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.width = '100%';
    document.body.style.height = '100%';
    document.body.style.overflow = 'hidden';
    stage.style.position = 'absolute';
    stage.style.transformOrigin = 'top left';
    stage.style.transform = 'scale(' + scale + ')';
    stage.style.left = Math.max(0, (window.innerWidth - width * scale) / 2) + 'px';
    stage.style.top = Math.max(0, (window.innerHeight - height * scale) / 2) + 'px';
  }
  function runHyperframesTimelines() {
    fitHyperframesStage();
    const timelines = Object.values(window.__timelines || {});
    for (const timeline of timelines) {
      if (!timeline || typeof timeline.progress !== 'function') continue;
      try {
        timeline.progress(0.35);
        if (typeof timeline.play === 'function') timeline.play(0);
      } catch (error) {
        console.error('HyperFrames preview timeline issue:', error);
      }
    }
  }
  window.addEventListener('resize', fitHyperframesStage);
  window.addEventListener('load', () => setTimeout(runHyperframesTimelines, 250));
  setTimeout(runHyperframesTimelines, 800);
})();
</script>`;
    if (/<\/body>/i.test(code)) return code.replace(/<\/body>/i, `${runner}\n</body>`);
    return `${code}\n${runner}`;
  }

  private static wrapASCII(code: string, _width: number, compositionForeground = false, title?: string): string {
    const lines = code.split('\n');
    const columns = lines.reduce((width, line) =>
      Math.max(width, Array.from(line.replace(/\t/g, '    ')).length), 1);
    // Previews are shown everywhere from a full browser tab down to a 360px
    // gallery thumbnail. Fixed-px padding floors ate most of a small frame and
    // the font shrank to unreadable, so chrome now scales with the smaller
    // viewport side and a runtime fitter (below) sizes the text exactly.
    const bodyPadding = compositionForeground ? 'clamp(20px, 4vw, 56px)' : 'clamp(4px, 3vmin, 56px)';
    const bodyPad2 = compositionForeground ? 'clamp(40px, 8vw, 112px)' : 'clamp(8px, 6vmin, 112px)';
    const prePad2 = compositionForeground ? 'clamp(48px, 10vw, 144px)' : 'clamp(12px, 8vmin, 144px)';
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const bodyBackground = compositionForeground
      ? 'transparent'
      : 'radial-gradient(circle at 18% 16%, rgba(34, 197, 94, 0.18), transparent 30%), #0a0a0f';
    const preBackground = compositionForeground
      ? 'transparent'
      : 'linear-gradient(135deg, rgba(0,0,0,.95), rgba(15,23,42,.86))';
    const preBoxShadow = compositionForeground ? 'none' : '0 28px 90px rgba(0,0,0,.42)';
    // As a composition foreground layer the ascii must be content-only: a card
    // border, padding, min-size box and the "ASCII Art" label are preview chrome
    // that otherwise leak into the blended composite (a labelled bordered box
    // over the other layers). Strip them when compositionForeground.
    const preBorder = compositionForeground ? 'none' : '1px solid rgba(134, 239, 172, 0.26)';
    const preBorderRadius = compositionForeground ? '0' : '24px';
    const prePadding = compositionForeground ? '0' : 'clamp(6px, 4vmin, 72px)';
    const preMinWidth = compositionForeground ? 'auto' : 'min(760px, 100%)';
    const preMinHeight = compositionForeground ? 'auto' : '0';
    // A named page (title given) is a judged/shared artwork, not the ascii preview:
    // no generic label over it (a textgen poem was framed as "ASCII Art").
    const labelHtml = compositionForeground || title ? '' : '<div class="label">ASCII Art</div>';
    const labelReserve = labelHtml || compositionForeground ? '50px' : '0px';
    // Prose (a textgen poem) must be read, not shrunk to fit like a picture:
    // it gets a readable size, wraps, and scrolls. ASCII art still fits whole.
    const nonSpace = code.replace(/\s/g, '');
    const prose = !compositionForeground && nonSpace.length > 0
      && (nonSpace.match(/\p{L}/gu)?.length ?? 0) / nonSpace.length >= 0.7;
    const modeAttr = prose ? ' data-text-mode="read"' : '';
    const fitFont = `min(34px, calc((min(980px, 96vw, calc(100vw - ${bodyPad2})) - ${prePad2} - 2px) / ${columns * 0.61}), calc((100vh - ${bodyPad2} - ${prePad2} - ${labelReserve}) / ${Math.max(1, lines.length) * 1.2}))`;
    // CSS can only estimate glyph width (0.61em) per font; the fitter measures
    // the real text box at two sizes and solves for the largest font that fits.
    const fitScript = compositionForeground ? '' : `
    <script data-ascii-fit>
    (function () {
      var shell = document.querySelector('[data-ascii-preview-shell]');
      var pre = shell && shell.querySelector('pre');
      if (!pre) return;
      function box(px) { pre.style.fontSize = px + 'px'; return [pre.offsetWidth, pre.offsetHeight]; }
      var read = shell.getAttribute('data-text-mode') === 'read';
      function fit() {
        var cs = getComputedStyle(document.body);
        var label = shell.querySelector('.label');
        var availW = Math.min(980, window.innerWidth * 0.96, window.innerWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
        var availH = window.innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
          - (label ? label.offsetHeight + parseFloat(getComputedStyle(label).marginBottom) : 0);
        var saved = [pre.style.minWidth, pre.style.width, pre.style.maxWidth];
        pre.style.minWidth = '0';
        pre.style.width = 'max-content';
        pre.style.maxWidth = 'none';
        var a = box(100), b = box(50);
        var kw = (a[0] - b[0]) / 50, kh = (a[1] - b[1]) / 50;
        var byW = (availW - (a[0] - 100 * kw)) / kw, byH = (availH - (a[1] - 100 * kh)) / kh;
        var size = Math.min(34, byW, byH);
        pre.style.minWidth = saved[0];
        pre.style.width = saved[1];
        pre.style.maxWidth = saved[2];
        var wrap = read && byW < 8;
        if (read) size = wrap ? 8 : Math.min(24, byW);
        if (wrap) shell.setAttribute('data-text-wrap', ''); else shell.removeAttribute('data-text-wrap');
        var tall = !read && size < 2.5 && byW > byH;
        if (tall) size = Math.min(34, byW);
        if (tall) shell.setAttribute('data-text-tall', ''); else shell.removeAttribute('data-text-tall');
        if (!(size > 0)) { pre.style.fontSize = ''; return; }
        pre.style.fontSize = Math.max(1, Math.floor(size * 10) / 10) + 'px';
      }
      fit();
      window.addEventListener('resize', fit);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    })();
    </script>`;
    const pageTitle = GenericWrapper.escapeHTML(title ?? 'ASCII Art');
    const shellAttr = compositionForeground
      ? ' data-composition-foreground-ascii'
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${SECURITY_HEADERS.trim()}
    <title>${pageTitle}</title>
    <style>
        body {
            margin: 0;
            background: ${bodyBackground};
            color: #86efac;
            font-family: 'Courier New', 'Courier', monospace;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            box-sizing: border-box;
            padding: ${bodyPadding};
        }
        .container {
            text-align: center;
            width: min(980px, 96vw);
        }
        pre {
            font-size: max(1px, ${fitFont});
            box-sizing: border-box;
            max-width: 100%;
            margin: 0;
            line-height: 1.2;
            tab-size: 4;
            background: ${preBackground};
            padding: ${prePadding};
            border-radius: ${preBorderRadius};
            border: ${preBorder};
            display: inline-block;
            min-width: ${preMinWidth};
            min-height: ${preMinHeight};
            text-shadow: 0 0 12px rgba(134, 239, 172, 0.6);
            box-shadow: ${preBoxShadow};
        }
        body:has([data-text-mode="read"]), body:has([data-text-tall]) { align-items: flex-start; overflow-y: auto; scrollbar-width: none; }
        [data-text-mode="read"] pre { text-align: left; }
        [data-text-wrap] pre { white-space: pre-wrap; overflow-wrap: anywhere; }
        .label {
            color: #bbf7d0;
            font-size: 12px;
            margin-bottom: 14px;
            text-transform: uppercase;
            letter-spacing: 2px;
            font-weight: 800;
        }
    </style>
</head>
<body>
    <div class="container" data-ascii-preview-shell${shellAttr}${modeAttr}>
        ${labelHtml}
        <pre><span>${escaped}</span></pre>
    </div>${fitScript}
</body>
</html>`;
  }

  private static wrapToneJS(code: string): string {
    const cleanedCode = this.stripLLMToolMarkup(code);
    if (this.isHTMLDocument(cleanedCode) || this.isHTMLFragment(cleanedCode)) return this.wrapToneHTML(cleanedCode);

    // Backtick escaping corrupted legit template literals in the artwork (H5).
    const safeCode = scriptSafe(cleanedCode);
    const bpm = this.extractToneBpm(cleanedCode) ?? 120;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${TONE_SECURITY_HEADERS.trim()}
    <title>Tone.js Audio Synthesizer</title>
    ${AUDIO_SCOPE_SCRIPT}
    <script src="${TONE_CDN}"></script>
    <style>
        body {
            margin: 0;
            background: #0a0a0f;
            color: #e2e8f0;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
        }
        h3 {
            color: #f59e0b;
            margin-bottom: 20px;
        }
        /* Artworks add full-page canvases and fixed panels and reuse #controls;
           the shell's Play must stay pressable above them (#1757). */
        [data-sinter-controls] { position: relative; z-index: 2147483647; }
        #controls {
            display: flex;
            gap: 16px;
            margin-bottom: 20px;
        }
        button {
            padding: 12px 24px;
            font-size: 16px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s;
            font-family: inherit;
        }
        #start {
            background: linear-gradient(135deg, #f59e0b, #ef4444);
            color: #08111f;
        }
        #start:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(245, 158, 11, 0.4);
        }
        #stop {
            background: #334155;
            color: #e2e8f0;
        }
        #stop:hover {
            background: #475569;
        }
        #status {
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 14px;
        }
        #status.ready { color: #94a3b8; }
        #status.playing { color: #f59e0b; }
        #paper {
            width: min(640px, 90vw);
            height: 160px;
            background: linear-gradient(180deg, #020617, #1e293b);
            border-radius: 8px;
            border: 1px solid rgba(148, 163, 184, 0.24);
            margin-top: 20px;
        }
    </style>
</head>
<body data-tone-preview-shell data-tone-tempo-sync="true" data-tone-bpm="${bpm}">
    <h3>🎹 Tone.js Audio Synthesizer</h3>
    <div id="controls" data-sinter-controls>
        <button id="start">▶ Play</button>
        <button id="stop">⏹ Stop</button>
    </div>
    <div id="status" class="ready" role="status">Ready to play (click Start Audio)</div>
    <canvas id="paper" width="1280" height="320"></canvas>
    <script>
        let isPlaying = false;
        const playBtn = document.getElementById('start');
        const stopBtn = document.getElementById('stop');
        const statusEl = document.getElementById('status');
        const visualizer = document.getElementById('paper');
        const liminalToneFallbackBpm = ${bpm};
        let liminalToneBpm = ${bpm};
        let liminalToneBeatSeconds = 60 / liminalToneBpm;
        let toneArtifactError = null;
        function syncSinterToneTempo() {
            const authoredBpm = Number(window.Tone?.Transport?.bpm?.value);
            liminalToneBpm = Number.isFinite(authoredBpm) && authoredBpm >= 30 && authoredBpm <= 300
                ? authoredBpm
                : liminalToneFallbackBpm;
            liminalToneBeatSeconds = 60 / liminalToneBpm;
            document.querySelector('[data-tone-preview-shell]')?.setAttribute('data-tone-bpm', String(Math.round(liminalToneBpm)));
        }
        window.__sinterDrawScope(visualizer);

        try {
            ${safeCode}
        } catch (err) {
            toneArtifactError = err;
            console.error('Tone artifact runtime issue:', err);
            statusEl.className = 'ready';
            statusEl.textContent = 'Tone runtime issue: ' + err.message;
        } finally {
            syncSinterToneTempo();
        }

        playBtn.addEventListener('click', async () => {
            // Autoplay policy can refuse the context; that is the page, not the artwork.
            try { await Tone.start(); } catch (err) { console.warn('Tone audio context did not start:', err); }
            syncSinterToneTempo();
            if (window.Tone?.Transport?.start) Tone.Transport.start();
            isPlaying = true;
            statusEl.className = 'playing';
            statusEl.textContent = toneArtifactError
                ? 'Preview shell running; generated Tone code has issue: ' + toneArtifactError.message
                : '🔊 Playing';
            try {
                if (typeof play === 'function') await play();
                else {
                    // Many pieces build their engine inside their own Play
                    // button; press it, never a Stop (#1757).
                    const own = [...document.querySelectorAll('button, [role="button"]')].find((el) =>
                        !el.closest('[data-sinter-controls]') && !el.disabled &&
                        /\\b(play|start|begin|listen)\\b|\u25B6/i.test([el.textContent, el.getAttribute('aria-label'), el.title, el.id, el.className].join(' ')) &&
                        !/\\b(stop|pause|mute)\\b/i.test([el.textContent, el.getAttribute('aria-label'), el.title].join(' ')));
                    if (own) own.click();
                }
            } catch (err) {
                console.error('Tone artifact play error:', err);
                statusEl.textContent = 'Generated Tone code has issue: ' + (err && err.message ? err.message : err);
            }
        });

        stopBtn.addEventListener('click', () => {
            isPlaying = false;
            statusEl.className = 'ready';
            statusEl.textContent = 'Stopped';
            if (window.Tone?.Transport) Tone.Transport.stop();
            if (typeof stop === 'function') stop();
            // A piece can start sound outside the transport; Stop silences that too.
            window.Tone?.getContext?.().rawContext?.suspend?.();
        });
    </script>
</body>
</html>`;
  }

  private static wrapToneHTML(code: string): string {
    const bodyFragment = this.stripExecutableHTML(this.extractBodyFragment(code)) ||
      '<p class="tone-empty">The generated Tone artifact did not include visible body controls.</p>';
    const inlineScripts = scriptSafe(this.extractInlineScripts(code).join('\n\n'));
    const escapedSource = this.escapeHTML(code);
    const bpm = this.extractToneBpm(code) ?? 120;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${TONE_SECURITY_HEADERS.trim()}
    <title>Tone.js Preview</title>
    ${AUDIO_SCOPE_SCRIPT}
    <script src="${TONE_CDN}"></script>
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 18%, rgba(245,158,11,.24), transparent 28%), radial-gradient(circle at 80% 8%, rgba(236,72,153,.18), transparent 30%), #07080f; color: #f8fafc; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: grid; place-items: center; padding: 28px; }
        [data-tone-preview-shell] { width: min(1120px, 100%); display: grid; grid-template-columns: minmax(280px, .9fr) minmax(320px, 1.1fr); gap: 20px; align-items: stretch; }
        .tone-panel, .tone-artifact { border: 1px solid rgba(248,250,252,.14); border-radius: 24px; background: rgba(15,23,42,.72); box-shadow: 0 24px 80px rgba(0,0,0,.36); overflow: hidden; }
        .tone-panel { padding: 24px; display: grid; gap: 18px; align-content: center; }
        .eyebrow { color: #fbbf24; letter-spacing: .18em; text-transform: uppercase; font-size: 12px; font-weight: 800; }
        h1 { margin: 0; font-size: clamp(36px, 6vw, 72px); line-height: .9; letter-spacing: -.06em; }
        .hint { color: #cbd5e1; line-height: 1.55; max-width: 46ch; }
        .controls { display: flex; gap: 12px; flex-wrap: wrap; }
        [data-sinter-controls] { position: relative; z-index: 2147483647; }
        #sinter-tone-start, #sinter-tone-stop { border: 0; border-radius: 999px; padding: 12px 18px; color: #08111f; font-weight: 800; cursor: pointer; }
        #sinter-tone-start { background: linear-gradient(135deg, #facc15, #fb7185); }
        #sinter-tone-stop { background: #cbd5e1; }
        #sinter-tone-status { color: #fef3c7; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
        #sinter-tone-visualizer { width: 100%; height: 160px; border-radius: 18px; background: linear-gradient(180deg, rgba(2,6,23,.98), rgba(30,41,59,.86)); border: 1px solid rgba(148,163,184,.22); }
        .tone-artifact { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
        .tone-artifact h2 { margin: 0; color: #fed7aa; font-size: 13px; letter-spacing: .16em; text-transform: uppercase; }
        #tone-artifact-surface { min-height: 220px; display: grid; place-items: center; border-radius: 18px; background: rgba(2,6,23,.62); border: 1px solid rgba(148,163,184,.18); padding: 20px; }
        #tone-artifact-surface button, #tone-artifact-surface [role="button"] { border: 0; border-radius: 999px; padding: 10px 15px; background: linear-gradient(135deg, #38bdf8, #a78bfa); color: white; font-weight: 800; cursor: pointer; }
        details { border-top: 1px solid rgba(148,163,184,.18); padding-top: 8px; }
        summary { cursor: pointer; color: #93c5fd; font-weight: 700; }
        pre { white-space: pre-wrap; word-break: break-word; color: #dbeafe; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 240px; overflow: auto; }
        @media (max-width: 820px) { [data-tone-preview-shell] { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <main data-tone-preview-shell data-tone-tempo-sync="true" data-tone-bpm="${bpm}">
        <section class="tone-panel" aria-label="Tone playback controls">
            <div class="eyebrow">Tone.js artifact</div>
            <h1>Audio preview</h1>
            <p class="hint">A polished wrapper around the generated Tone HTML. Start the preview here, or use the embedded controls preserved on the right.</p>
            <canvas id="sinter-tone-visualizer" width="640" height="240"></canvas>
            <div class="controls" data-sinter-controls>
                <button id="sinter-tone-start" type="button">▶ Start preview</button>
                <button id="sinter-tone-stop" type="button">⏹ Stop</button>
            </div>
            <div id="sinter-tone-status" role="status">Ready — browser audio starts after a click.</div>
        </section>
        <section class="tone-artifact" aria-label="Embedded Tone artifact">
            <h2>Embedded Tone artifact</h2>
            <div id="tone-artifact-surface">${bodyFragment}</div>
            <details>
                <summary>Original Tone HTML source</summary>
                <pre><code>${escapedSource}</code></pre>
            </details>
        </section>
    </main>
    <script>
        const liminalToneStatus = document.getElementById('sinter-tone-status');
        const liminalToneCanvas = document.getElementById('sinter-tone-visualizer');
        const liminalToneFallbackBpm = ${bpm};
        let liminalToneBpm = ${bpm};
        let liminalToneBeatSeconds = 60 / liminalToneBpm;
        let liminalTonePlaying = false;
        function syncSinterToneTempo() {
            const authoredBpm = Number(window.Tone?.Transport?.bpm?.value);
            liminalToneBpm = Number.isFinite(authoredBpm) && authoredBpm >= 30 && authoredBpm <= 300
                ? authoredBpm
                : liminalToneFallbackBpm;
            liminalToneBeatSeconds = 60 / liminalToneBpm;
            document.querySelector('[data-tone-preview-shell]')?.setAttribute('data-tone-bpm', String(Math.round(liminalToneBpm)));
        }
        window.__sinterDrawScope(liminalToneCanvas);
        try {
            ${inlineScripts}
        } catch (error) {
            console.error('Tone artifact script error:', error);
            liminalToneStatus.textContent = 'Tone artifact script error: ' + error.message;
        } finally {
            syncSinterToneTempo();
        }
        document.getElementById('sinter-tone-start').addEventListener('click', async () => {
            try {
                if (window.Tone?.start) await Tone.start();
            } catch (error) {
                console.warn('Tone audio context did not start:', error);
            }
            try {
                syncSinterToneTempo();
                liminalTonePlaying = true;
                liminalToneStatus.textContent = 'Playing — embedded artifact controls are preserved.';
                const artifactButton = document.querySelector('#tone-artifact-surface button:not([disabled]), #tone-artifact-surface [role="button"]:not([aria-disabled="true"])');
                if (artifactButton) artifactButton.click();
                else if (typeof play === 'function') play();
                syncSinterToneTempo();
                setTimeout(syncSinterToneTempo, 120);
                if (window.Tone?.Transport?.start && Tone.Transport.state !== 'started') Tone.Transport.start();
            } catch (error) {
                console.error('Tone preview start error:', error);
                liminalToneStatus.textContent = 'Start error: ' + error.message;
            }
        });
        document.getElementById('sinter-tone-stop').addEventListener('click', () => {
            liminalTonePlaying = false;
            if (window.Tone?.Transport) {
                Tone.Transport.stop();
                Tone.Transport.cancel();
            }
            if (typeof stop === 'function') stop();
            // A piece can start sound outside the transport; Stop silences that too.
            window.Tone?.getContext?.().rawContext?.suspend?.();
            liminalToneStatus.textContent = 'Stopped.';
        });
    </script>
</body>
</html>`;
  }
}

export default GenericWrapper;
