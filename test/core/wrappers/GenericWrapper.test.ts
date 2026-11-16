import { describe, it, expect } from 'vitest';
import { Script, runInNewContext } from 'node:vm';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper.js';

describe('GenericWrapper', () => {
  describe('detectDomain', () => {
    describe('Strudel detection', () => {
      it('detects Strudel code with stack()', () => {
        const code = 'stack(s("bd"), s("sd"))';
        expect(GenericWrapper.detectDomain(code)).toBe('strudel');
      });

      it('detects Strudel code with s("bd")', () => {
        const code = 's("bd*2")';
        expect(GenericWrapper.detectDomain(code)).toBe('strudel');
      });

      it('detects Strudel code with cpm()', () => {
        const code = 'note("c3 e3 g3").cpm(120)';
        expect(GenericWrapper.detectDomain(code)).toBe('strudel');
      });

      it('does not misclassify p5 as Strudel', () => {
        const code = 'function setup() { s("bd"); }';
        expect(GenericWrapper.detectDomain(code)).toBeNull();
      });
    });

    describe('Hydra detection', () => {
      it('detects Hydra code with multiple patterns', () => {
        const code = 'osc(20).rotate(0.5).out(o0)';
        expect(GenericWrapper.detectDomain(code)).toBe('hydra');
      });

      it('detects Hydra code with noise and kaleid', () => {
        const code = 'noise(10).kaleid(4).out(o1)';
        expect(GenericWrapper.detectDomain(code)).toBe('hydra');
      });

      it('requires at least 2 Hydra patterns', () => {
        const code = 'osc(20)'; // Only one pattern
        expect(GenericWrapper.detectDomain(code)).toBeNull();
      });
    });

    describe('Tone.js detection', () => {
      it('detects Tone.js code with Tone. prefix', () => {
        const code = 'const synth = new Tone.Synth();';
        expect(GenericWrapper.detectDomain(code)).toBe('tone');
      });

      it('detects Tone.js with Synth', () => {
        const code = 'const synth = new Synth().toDestination();';
        expect(GenericWrapper.detectDomain(code)).toBe('tone');
      });

      it('detects Tone.js with Transport', () => {
        const code = 'Tone.Transport.start();';
        expect(GenericWrapper.detectDomain(code)).toBe('tone');
      });
    });

    describe('Shader detection', () => {
      it('detects GLSL shader code', () => {
        const code = 'void main() { gl_FragColor = vec4(1.0); }';
        expect(GenericWrapper.detectDomain(code)).toBe('shader');
      });

      it('detects shader with uniforms', () => {
        const code = 'uniform vec2 u_resolution; void main() { }';
        expect(GenericWrapper.detectDomain(code)).toBe('shader');
      });

      it('requires multiple GLSL indicators', () => {
        const code = 'void main() { }'; // Only one indicator
        expect(GenericWrapper.detectDomain(code)).toBeNull();
      });

      it('does not detect p5 as shader', () => {
        const code = 'function setup() { void main(); }';
        expect(GenericWrapper.detectDomain(code)).toBeNull();
      });
    });

    describe('Revideo detection', () => {
      it('detects Revideo imports before falling back to p5', () => {
        const code = 'import { makeScene, createRef } from "@revideo/core"; export default makeScene("x", function* () {});';
        expect(GenericWrapper.detectDomain(code)).toBe('revideo');
      });
    });

    describe('ASCII detection', () => {
      it('detects ASCII art', () => {
        const code = '█▓▒░\n████\n▓▓▓▓\n▒▒▒▒\n░░░░\n████';
        expect(GenericWrapper.detectDomain(code)).toBe('ascii');
      });

      it('detects line-art ASCII without block characters', () => {
        const code = ['   /\\', '  /  \\', ' /____\\'].join('\n');
        expect(GenericWrapper.detectDomain(code)).toBe('ascii');
      });

      it('does not detect JS code as ASCII', () => {
        const code = 'const x = "█▓▒░";\nconsole.log(x);';
        expect(GenericWrapper.detectDomain(code)).toBeNull();
      });
    });
  });



    describe('HyperFrames detection', () => {
      it('detects GSAP timeline HTML with composition clips', () => {
        const code = '<div data-composition-id="demo"><h1 class="clip" data-start="0" data-duration="3" data-track-index="0">Title</h1></div><script>const tl = gsap.timeline({ paused: true }); window.__timelines = { demo: tl };</script>';
        expect(GenericWrapper.detectDomain(code)).toBe('hyperframes');
      });
    });

  describe('wrap - Strudel', () => {
    // f1d87c77 dropped one ')' in the artwork strip chain: every wrapped piece threw a SyntaxError in
    // the page and played silence (Kaggle smoke 2026-11-16: 10 of 12 strudel gates). The string-level
    // test above could not see it, so parse the real page scripts and run the real strip chain.
    const inlineScripts = (html: string) =>
      [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

    it('emits inline scripts that all parse', () => {
      const html = GenericWrapper.wrap('stack(s("bd ~ hh").gain(+6), note("c4 e4")).slow(2)', { domain: 'strudel' });
      const scripts = inlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) expect(() => new Script(s)).not.toThrow();
    });

    it('runs the artwork strip chain the page runs', () => {
      const artworkOf = (code: string) => {
        const html = GenericWrapper.wrap(code, { domain: 'strudel' });
        const m = html.match(/var artwork = ([\s\S]*?);\n/);
        if (!m) throw new Error('wrapped strudel page has no artwork statement');
        return runInNewContext(m[1]) as string;
      };
      expect(artworkOf('stack(s("bd sd")).out();')).toBe('stack(s("bd sd"))');
      expect(artworkOf('s("bd sd").tempo(120)')).toBe('s("bd sd")');
      expect(artworkOf('s("bd sd").start()')).toBe('s("bd sd")');
      expect(artworkOf('s("bd").out().gain(1)')).toBe('s("bd").out().gain(1)');
    });

    it('strips a trailing .out() from strudel code (Kabelsalat method; silences a pattern)', () => {
      const result = GenericWrapper.wrap('stack(s("bd sd"), note("c3 e3")).out()', { domain: 'strudel' });
      expect(result).toContain('.replace(/\\s*\\.\\s*out\\s*\\(\\s*\\)\\s*;?\\s*$/, \'\')');
      const strip = (c: string) => c.replace(/\s*\.\s*out\s*\(\s*\)\s*;?\s*$/, '');
      expect(strip('stack(s("bd sd")).out();\n')).toBe('stack(s("bd sd"))');
      expect(strip('s("bd").out().gain(1)')).toBe('s("bd").out().gain(1)');
    });

    it('allows the Strudel editor to fetch its sample manifest without broadening every wrapper', () => {
      const result = GenericWrapper.wrap('s("bd sd")', { domain: 'strudel' });

      expect(result).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval'");
      expect(result).toContain("connect-src 'self' https://strudel.b-cdn.net https://raw.githubusercontent.com");
      expect(result).toContain('strudel.b-cdn.net/tidal-drum-machines.json');
      expect(result).not.toContain("connect-src 'none'");
    });

    it('wraps Strudel code', () => {
      const code = 's("bd sd")';
      const result = GenericWrapper.wrap(code, { domain: 'strudel' });
      
      expect(result).toContain('<!DOCTYPE html>');
      // Vendored pinned @strudel/web bundle (#924, zero CDN)
      expect(result).toContain('src="/vendor/strudel-web/1.3.0/strudel-web.js"');
      expect(result).toContain('Strudel Live Coding Pattern');
    });

    it('wires the one-tap play button to the strudel web runtime', () => {
      const code = 's("bd")';
      const result = GenericWrapper.wrap(code, { domain: 'strudel' });

      expect(result).toContain('id="sinter-strudel-play"');
      expect(result).toContain('strudel.initStrudel');
      expect(result).toContain('strudel.evaluate');
      expect(result).toContain('strudel.hush');
      expect(result).not.toContain('<strudel-editor>');
      expect(result).not.toContain('@strudel/repl');
    });

    it('keeps Strudel source code visibly readable even if the embedded editor renders blank', () => {
      const code = 'stack(s("bd"), s("sd"))';
      const result = GenericWrapper.wrap(code, { domain: 'strudel' });

      expect(result).toContain('data-strudel-source-code');
      expect(result).toContain('stack(s(&quot;bd&quot;), s(&quot;sd&quot;))');
    });
  });

  describe('wrap - Hydra', () => {
    it('permits Hydra synth eval while keeping network connections blocked', () => {
      const result = GenericWrapper.wrap('osc(20).out()', { domain: 'hydra' });

      expect(result).toContain("script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval'");
      expect(result).toContain("connect-src 'none'");
    });

    it('wraps Hydra code', () => {
      const code = 'osc(20).out()';
      const result = GenericWrapper.wrap(code, { domain: 'hydra' });
      
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('hydra-synth');
      expect(result).toContain('Hydra Visual Synthesizer');
      expect(result).not.toContain('Logger.error');
    });

    it('pins bare render() to the primary output so the patch fills the frame (F15)', () => {
      // Bare render() = hydra's 2x2 debug grid: top-left quadrant patch,
      // three black quadrants — observed live in composites.
      const result = GenericWrapper.wrap('osc(8,0.1,1.2).kaleid(3).out(o0)\nrender()', { domain: 'hydra' });
      expect(result).toContain('render(o0)');
      expect(result).not.toMatch(/\brender\s*\(\s*\)/);

      // Explicit output args are preserved untouched.
      const explicit = GenericWrapper.wrap('osc(4).out(o1)\nrender(o1)', { domain: 'hydra' });
      expect(explicit).toContain('render(o1)');
    });

    it('uses viewport dimensions with default resolution fallback', () => {
      const code = 'osc(20).out()';
      const result = GenericWrapper.wrap(code, { domain: 'hydra' });
      
      expect(result).toContain('const hydraWidth = window.innerWidth || 1280');
      expect(result).toContain('const hydraHeight = window.innerHeight || 720');
      expect(result).toContain('width: hydraWidth');
      expect(result).toContain('height: hydraHeight');
      expect(result).toContain('setResolution(hydraWidth, hydraHeight)');
      expect(result).toContain('const go = () => {}');
      expect(result).toContain('const o = typeof o0');
    });

    it('uses custom resolution as viewport fallback when provided', () => {
      const code = 'osc(20).out()';
      const result = GenericWrapper.wrap(code, { domain: 'hydra', hydraResolution: { width: 1920, height: 1080 } });
      
      expect(result).toContain('const hydraWidth = window.innerWidth || 1920');
      expect(result).toContain('const hydraHeight = window.innerHeight || 1080');
      expect(result).toContain('setResolution(nextWidth, nextHeight)');
    });
  });

  describe('wrap - Tone.js', () => {
    it('allows Tone.js browser audio workers without opening network connections', () => {
      const result = GenericWrapper.wrap('const synth = new Tone.Synth();', { domain: 'tone' });

      expect(result).toContain('worker-src blob:');
      expect(result).toContain("connect-src 'none'");
    });

    it('wraps Tone.js code', () => {
      const code = 'const synth = new Tone.Synth();';
      const result = GenericWrapper.wrap(code, { domain: 'tone' });
      
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('Tone.js');
      expect(result).toContain('/vendor/tone/14.8.49/Tone.js');
    });

    it('strips stray tool-call markup before embedding raw Tone snippets', () => {
      const code = 'const synth = new Tone.Synth();</arg_value>\\n</tool_call>';
      const result = GenericWrapper.wrap(code, { domain: 'tone' });

      expect(result).toContain('const synth = new Tone.Synth();');
      expect(result).not.toContain('</arg_value>');
      expect(result).not.toContain('</tool_call>');
    });

    it('includes play/stop controls', () => {
      const code = 'const synth = new Tone.Synth();';
      const result = GenericWrapper.wrap(code, { domain: 'tone' });
      
      expect(result).toContain('▶ Play');
      expect(result).toContain('⏹ Stop');
      expect(result).toContain('id="start"');
      expect(result).toContain('id="stop"');
    });



    it('wraps Tone HTML fragments that start with script tags without injecting script tags into the preview runtime', () => {
      const code = `<script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script>
<script>
const synth = new Tone.Synth().toDestination();
document.body.innerHTML = ` + '`' + `<button id="startButton">Start Ambient Sequence</button>` + '`' + `;
</script>
</body>
</html>`;
      const result = GenericWrapper.wrap(code, { domain: 'tone' });

      expect(result).toContain('data-tone-preview-shell');
      expect(result).toContain('id="sinter-tone-visualizer"');
      const runtimeStart = result.indexOf('try {', result.indexOf('liminalToneStatus'));
      const runtimeBlock = result.slice(runtimeStart, result.indexOf('} catch (error)', runtimeStart));
      expect(runtimeBlock).not.toContain('<script');
      expect(runtimeBlock).not.toContain('document.body.innerHTML');
      expect(runtimeBlock).toContain('tone-artifact-surface');
      expect(runtimeBlock).toContain('new Tone.Synth().toDestination()');
    });

    it('syncs the Tone visualizer speed to the generated Tone.Transport BPM', () => {
      const code = 'Tone.Transport.bpm.value = 84; const seq = new Tone.Sequence((time, note) => {}, ["C4"], "4n");';
      const result = GenericWrapper.wrap(code, { domain: 'tone' });

      expect(result).toContain('data-tone-tempo-sync="true"');
      expect(result).toContain('data-tone-bpm="84"');
      expect(result).toContain('let liminalToneBpm = 84;');
      expect(result).toContain('liminalToneBeatSeconds = 60 / liminalToneBpm;');
    });

    it('does not overwrite authored Tone BPM expressions with the numeric fallback', () => {
      const code = 'const bpm = 90; Tone.Transport.bpm.value = bpm; const seq = new Tone.Sequence((time, note) => {}, ["C4"], "4n").start(0);';
      const result = GenericWrapper.wrap(code, { domain: 'tone' });
      const startBlock = result.slice(result.indexOf("playBtn.addEventListener('click'"));

      expect(result).toContain('syncSinterToneTempo();');
      expect(result).toContain('Tone.Transport.bpm.value = bpm;');
      expect(startBlock).not.toContain('Tone.Transport.bpm.value = liminalToneBpm');
    });

    it('uses the last literal Tone.Transport BPM as the initial visual fallback', () => {
      const code = 'Tone.Transport.bpm.value = 90; Tone.Transport.bpm.value = 180;';
      const result = GenericWrapper.wrap(code, { domain: 'tone' });

      expect(result).toContain('data-tone-bpm="180"');
      expect(result).toContain('let liminalToneBpm = 180;');
    });

    it('wraps raw Tone HTML in a polished preview shell instead of showing a bare button page', () => {
      const code = `<!DOCTYPE html>
<html>
<body>
  <button id="startButton">Start Ambient Sequence</button>
  <script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script>
  <script>
    const synth = new Tone.Synth().toDestination();
    document.getElementById('startButton').addEventListener('click', () => synth.triggerAttackRelease('C4', '8n'));
  </script>
</body>
</html>`;
      const result = GenericWrapper.wrap(code, { domain: 'tone' });

      expect(result).toContain('data-tone-preview-shell');
      expect(result).toContain('id="sinter-tone-start"');
      expect(result).toContain('id="sinter-tone-visualizer"');
      expect(result).toContain('id="startButton"');
      expect(result).toContain('Embedded Tone artifact');
    });
  });

  describe('audio scope shows the real sound', () => {
    /** Run the page's scope script against a fake Web Audio graph. */
    function runScope(html: string) {
      const body = html.slice(html.indexOf('(function () {\n  var scopes'), html.indexOf('</script>', html.indexOf('var scopes')));
      class AudioNode { targets: unknown[] = []; connect(t: unknown) { this.targets.push(t); return t; } }
      class AudioDestinationNode extends AudioNode { constructor(public context: unknown) { super(); } }
      let wave = 0;
      class Analyser extends AudioNode {
        fftSize = 0; smoothingTimeConstant = 0;
        constructor(public context: { state: string }) { super(); }
        getFloatTimeDomainData(a: Float32Array) { for (let i = 0; i < a.length; i++) a[i] = wave * Math.sin(i / 7); }
        getByteFrequencyData(a: Uint8Array) { a.fill(wave ? 200 : 0); }
      }
      const ctx: { state: string; createAnalyser: () => Analyser } = { state: 'running', createAnalyser: () => new Analyser(ctx) };
      const win: Record<string, unknown> = { AudioNode, AudioDestinationNode };
      new Function('window', 'requestAnimationFrame', body)(win, () => 0);
      const g = new Proxy({}, { get: () => () => undefined, set: () => true });
      const canvas = { width: 400, height: 100, dataset: {} as Record<string, string>, getContext: () => g };
      const draw = () => { (win.__sinterDrawScope as (c: unknown) => void)(canvas); return canvas.dataset.audioRms; };
      return { win, dest: new AudioDestinationNode(ctx), source: new AudioNode(), setWave: (v: number) => { wave = v; }, draw };
    }

    for (const domain of ['strudel', 'tone'] as const) {
      it(`${domain}: measures the audio reaching the speakers, not a clock`, () => {
        const html = GenericWrapper.wrap('note("c3")', { domain });
        expect(html.indexOf('__sinterScopes')).toBeLessThan(html.indexOf('<script src="/vendor/'));
        expect(html).not.toContain('Math.sin(beat');
        const s = runScope(html);
        s.source.connect(s.dest);
        s.source.connect(s.dest);
        expect((s.win.__sinterScopes as unknown[]).length).toBe(1);
        expect(s.source.targets).toEqual([s.dest, (s.win.__sinterScopes as unknown[])[0], s.dest, (s.win.__sinterScopes as unknown[])[0]]);
        s.setWave(0.5);
        expect(Number(s.draw())).toBeCloseTo(0.3536, 2);
      });
    }

    it('reports silence when nothing sounds or nothing is connected', () => {
      const s = runScope(GenericWrapper.wrap('note("c3")', { domain: 'strudel' }));
      expect(s.draw()).toBe('0.0000');
      s.source.connect(s.dest);
      s.setWave(0);
      expect(s.draw()).toBe('0.0000');
    });

    it('does not tap connections to ordinary nodes', () => {
      const s = runScope(GenericWrapper.wrap('note("c3")', { domain: 'tone' }));
      const other = new (s.win.AudioNode as new () => { targets: unknown[] })();
      s.source.connect(other);
      expect(s.source.targets).toEqual([other]);
      expect((s.win.__sinterScopes as unknown[]).length).toBe(0);
    });
  });

  describe('wrap - Shader', () => {
    it('wraps GLSL shader code', () => {
      const code = 'void main() { gl_FragColor = vec4(1.0); }';
      const result = GenericWrapper.wrap(code, { domain: 'shader' });
      
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('GLSL Shader');
      expect(result).toContain('webgl');
      expect(result).not.toContain('Logger.error');
    });

    it('includes WebGL canvas', () => {
      const code = 'void main() { gl_FragColor = vec4(1.0); }';
      const result = GenericWrapper.wrap(code, { domain: 'shader' });
      
      expect(result).toContain('glCanvas');
    });

    it('normalizes GLSL 300 and Shadertoy aliases for the browser wrapper', () => {
      const code = `#version 300 es
precision highp float;
uniform float iTime;
uniform vec2 iResolution;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / iResolution.xy;
  fragColor = vec4(vec3(sin(iTime + uv.x)), 1.0);
}`;
      const result = GenericWrapper.wrap(code, { domain: 'shader' });

      expect(result).not.toContain('#version 300 es');
      expect(result).not.toContain('out vec4 fragColor');
      expect(result).not.toContain('iTime');
      expect(result).not.toContain('iResolution');
      expect(result).toContain('uniform float u_time');
      expect(result).toContain('uniform vec2 u_resolution');
      expect(result).toContain('gl_FragColor = vec4');
    });

    it('maps bare time/resolution uniforms onto the host-bound u_* names', () => {
      const code = `precision highp float;
uniform float time;
uniform vec2 resolution;
void main() { vec2 uv = gl_FragCoord.xy / resolution; gl_FragColor = vec4(uv, sin(time), 1.0); }`;
      const result = GenericWrapper.wrap(code, { domain: 'shader' });

      expect(result).toContain('uniform float u_time;');
      expect(result).toContain('uniform vec2 u_resolution;');
      expect(result).toContain('gl_FragCoord.xy / u_resolution;');
      expect(result).toContain('sin(u_time)');
      expect(result).not.toMatch(/uniform float time;/);
    });

    it('leaves a bare uniform alone when the u_* form is already declared', () => {
      const code = `precision highp float;
uniform float u_time;
uniform float time;
void main() { gl_FragColor = vec4(vec3(time), 1.0); }`;
      const result = GenericWrapper.wrap(code, { domain: 'shader' });

      expect(result).toContain('uniform float time;');
      expect(result.match(/uniform float u_time;/g)).toHaveLength(1);
    });

    it('normalizes GLSL out variables even when the model omits #version 300', () => {
      const code = `precision highp float;
uniform vec2 u_resolution;
out vec4 fragColor;
void main() { fragColor = vec4(1.0); }`;
      const result = GenericWrapper.wrap(code, { domain: 'shader' });

      expect(result).not.toContain('out vec4 fragColor');
      expect(result).toContain('gl_FragColor = vec4(1.0)');
    });

    it('auto-injects precision mediump float when the model omits it (WebGL1 GLSL ES 1.00 requirement)', () => {
      const code = `uniform float u_time;
uniform vec2 u_resolution;
void main() { gl_FragColor = vec4(uv.x, uv.y, 0.0, 1.0); }`;
      const result = GenericWrapper.wrap(code, { domain: 'shader' });

      expect(result).toContain('precision mediump float;');
    });

    it('does not double-inject precision in the user shader when the model already declares it', () => {
      const code = `precision highp float;
uniform float u_time;
void main() { gl_FragColor = vec4(1.0); }`;
      const result = GenericWrapper.wrap(code, { domain: 'shader' });

      // The auto-inject step must not duplicate a precision declaration that
      // the model already emitted. Scan the harness for all precision
      // declarations and confirm only the model's one survived injection.
      const userPrecision = result.match(/precision\s+(?:lowp|mediump|highp)\s+float\s*;/g) ?? [];
      expect(userPrecision).toHaveLength(1);
      expect(userPrecision[0]).toBe('precision highp float;');
    });

    it('does not embed a runtime fallback shader; compile failures stay honest', () => {
      const code = `precision mediump float;
uniform float u_time;
void main() { gl_FragColor = vec4(1.0); }`;
      const result = GenericWrapper.wrap(code, { domain: 'shader' });

      // The harness must NOT contain a recovery shader source string. If the
      // model-emitted fragment shader fails to compile, the harness surfaces
      // a visible error div so the gauntlet can detect and report the failure
      // — it must not substitute a known-good image that would mask the bug.
      expect(result).not.toContain('fsFallback');
      // The honest error path is preserved.
      expect(result).toContain('Shader compile error');
    });
  });

  describe('wrap - Revideo', () => {
    it('wraps Revideo code', () => {
      const code = 'import { makeScene } from "@revideo/core";';
      const result = GenericWrapper.wrap(code, { domain: 'revideo' });

      expect(result).toContain('<!DOCTYPE html>');
    });
  });

  describe('wrap - Revideo', () => {
    it('wraps Revideo source as inert readable code, not executable script', () => {
      const code = 'import { makeScene } from "@revideo/core"; export default makeScene("x", function* () {});';
      const result = GenericWrapper.wrap(code, { domain: 'revideo' });

      expect(result).toContain('Revideo Composition');
      expect(result).toContain('from &quot;@revideo/core&quot;');
      expect(result).not.toContain('<script>\nimport { makeScene }');
    });

    it('renders a browser-visible timeline preview before the source details', () => {
      const code = `import { makeScene2D, Txt } from "@revideo/2d";
export default makeScene2D("PreviewScene", function* (view) {
  yield view.add(<Txt text="Sinter title" />);
});`;
      const result = GenericWrapper.wrap(code, { domain: 'revideo' });

      expect(result).toContain('data-revideo-timeline-preview');
      expect(result).toContain('class="revideo-stage"');
      expect(result).toContain('class="timeline-playhead"');
      expect(result).toContain('Sinter title');
      expect(result.indexOf('data-revideo-timeline-preview')).toBeLessThan(result.indexOf('<details'));
    });

    it('says the stand-in is not rendered and opens the source by default', () => {
      const result = GenericWrapper.wrap('export default makeScene2D("S", function* () {});', { domain: 'revideo' });

      expect(result).toContain('<span class="badge">Not rendered</span>');
      expect(result).toContain('aria-label="Unrendered Revideo stand-in"');
      expect(result).toContain('<details open>');
      expect(result).not.toMatch(/Frame-accurate|Rendered Revideo/);
    });
  });



  describe('wrap - HyperFrames', () => {
    it('wraps HyperFrames code as a polished composition preview shell with source details collapsed', () => {
      const code = '<div data-composition-id="demo"><h1 class="clip" data-start="0" data-duration="3" data-track-index="0">Title</h1></div><script>const tl = gsap.timeline({ paused: true }); window.__timelines = { demo: tl };</script>';
      const result = GenericWrapper.wrap(code, { domain: 'hyperframes', title: 'HyperFrames Preview' });

      expect(result).toContain('data-hyperframes-preview-shell');
      expect(result).toContain('class="hyperframes-stage"');
      expect(result).toContain('HyperFrames Preview');
      expect(result.indexOf('data-hyperframes-preview-shell')).toBeLessThan(result.indexOf('<details'));
    });

    it('injects a preview runner so paused GSAP timelines render visible frames', () => {
      const code = '<div data-composition-id="demo"><h1 class="clip" data-start="0" data-duration="3" data-track-index="0">Title</h1></div><script>const tl = gsap.timeline({ paused: true }); window.__timelines = { demo: tl };</script>';
      const result = GenericWrapper.wrap(code, { domain: 'hyperframes', title: 'HyperFrames Preview' });

      expect(result).toContain('data-hyperframes-preview-runner');
      expect(result).toContain('fitHyperframesStage');
      expect(result).toContain('timeline.progress(0.35)');
      expect(result).toContain('timeline.play(0)');
    });
  });

  describe('wrap - ASCII', () => {
    it('wraps ASCII art', () => {
      const code = '████\n▓▓▓▓\n▒▒▒▒';
      const result = GenericWrapper.wrap(code, { domain: 'ascii' });
      
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('ASCII Art');
      expect(result).toContain('Courier New');
    });

    it('escapes HTML entities', () => {
      const code = '<test>';
      const result = GenericWrapper.wrap(code, { domain: 'ascii' });
      
      expect(result).toContain('&lt;test&gt;');
    });

    it('uses monospace styling', () => {
      const code = '████\n▓▓▓▓';
      const result = GenericWrapper.wrap(code, { domain: 'ascii' });
      
      expect(result).toContain('font-family: \'Courier New\'');
    });

    it('renders ASCII as a large artist-facing preview surface', () => {
      const code = ' /\\\n/__\\';
      const result = GenericWrapper.wrap(code, { domain: 'ascii' });

      expect(result).toContain('data-ascii-preview-shell');
      expect(result).toMatch(/font-size:.*100vw.*100vh/);
      expect(result).toContain('max-width: 100%');
    });

    it('keeps small-frame chrome proportional and fits text at runtime', () => {
      const result = GenericWrapper.wrap('roses\nare red', { domain: 'ascii', title: 'Poem' });

      // Padding scales with the smaller viewport side, so a 360px gallery
      // frame is not mostly padding.
      expect(result).toContain('padding: clamp(4px, 3vmin, 56px)');
      expect(result).toContain('padding: clamp(6px, 4vmin, 72px)');
      expect(result).not.toContain('clamp(24px, 5vw, 72px)');
      // No label on a named page, so no height is reserved for one.
      expect(result).not.toMatch(/- 50px\)/);
      expect(result).toContain('data-ascii-fit');
    });

    it('reads prose at a readable size instead of shrinking it like a picture', () => {
      const poem = GenericWrapper.wrap('I kept them all.\nI stacked the failed circles like coins,', { domain: 'ascii', title: 'S1NTR' });
      const art = GenericWrapper.wrap('  /\\  \n /==\\ \n/____\\', { domain: 'ascii', title: 'S1NTR' });
      expect(poem).toContain('data-ascii-preview-shell data-text-mode="read"');
      expect(art).not.toContain('data-ascii-preview-shell data-text-mode="read"');
    });

    it('keeps the composition foreground free of the preview fitter', () => {
      const result = GenericWrapper.wrap(' /\\\n/__\\', { domain: 'ascii', compositionForeground: true });
      expect(result).not.toContain('data-ascii-fit');
      expect(result).toContain('padding: clamp(20px, 4vw, 56px)');
      // Same font fit as before the small-frame fix: 2 columns, 2 lines.
      expect(result).toContain('font-size: max(1px, min(34px, calc((min(980px, 96vw, calc(100vw - clamp(40px, 8vw, 112px))) - clamp(48px, 10vw, 144px) - 2px) / 2.44), calc((100vh - clamp(40px, 8vw, 112px) - clamp(48px, 10vw, 144px) - 50px) / 2.4))');
    });

    it('can render ASCII as transparent foreground for layered compositions', () => {
      const code = ' /\\\n/__\\';
      const result = GenericWrapper.wrap(code, { domain: 'ascii', compositionForeground: true });

      expect(result).toContain('data-composition-foreground-ascii');
      expect(result).toContain('background: transparent');
      expect(result).not.toContain('#0a0a0f');
      expect(result).not.toContain('rgba(0,0,0,.95)');
      // Foreground composite layers must be content-only: no preview chrome
      // (the "ASCII Art" label or the card border) leaking into the composite.
      expect(result).not.toContain('<div class="label">ASCII Art</div>');
      expect(result).not.toContain('border: 1px solid rgba(134, 239, 172, 0.26)');
    });

    it('keeps the label and card border in standalone (non-foreground) preview', () => {
      const code = ' /\\\n/__\\';
      const result = GenericWrapper.wrap(code, { domain: 'ascii' });

      // Standalone preview keeps the shell — only composition foreground strips it.
      expect(result).toContain('<div class="label">ASCII Art</div>');
      expect(result).toContain('border: 1px solid rgba(134, 239, 172, 0.26)');
    });

    it('uses a caller title and drops the generic "ASCII Art" label for named pages', () => {
      const result = GenericWrapper.wrap('roses\nare red', { domain: 'ascii', title: 'Liminal <Artwork>' });

      expect(result).toContain('<title>Liminal &lt;Artwork&gt;</title>');
      expect(result).not.toContain('<div class="label">ASCII Art</div>');
      expect(result).not.toContain('<title>ASCII Art</title>');
    });
  });
});
