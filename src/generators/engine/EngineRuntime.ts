/**
 * EngineRuntime: the page-side half of the engine contract, written once and embedded in every
 * engine page (nbe now; reaction-diffusion, physarum, particle-life and lenia next).
 *
 * It owns the four things every engine must do the same way:
 *   1. READY SIGNAL. `window.sinterEngine.state` goes running -> ready | failed, and the page
 *      posts `<id>:<readyMessage>` plus `{type:'sinter:engine'}` to its parent. The capture path
 *      (HeadlessRenderer.waitForEngineReady) waits on `state`, not on a timer.
 *   2. LOUD FAILURE. `fail(message)` puts a visible message on the page (never a blank canvas),
 *      sets state `failed` and records the reason; capture turns it into ENGINE_FAILED:<id>.
 *   3. CLOCK. By default the engine runs on requestAnimationFrame. When the hosting composition
 *      sends `sinter:state` ({time}) the engine switches to that external clock and steps to
 *      `time * stepRate`; `advanceTo(seconds)` does the same synchronously for offline renders.
 *   4. LAYER HOOKS. `layer` is background | overlay | mask (from `window.SINTER_ENGINE_LAYER` or
 *      `#layer=`); the engine's draw reads it to paint opaque, transparent-where-empty, or a
 *      grey luminance matte. `input` (0..1) follows `sinter:signal`/`sinter:causal` messages or
 *      `setInput()`, so an audio level or a beat can drive the piece.
 */

export interface EngineRuntimeOptions {
  readonly id: string;
  /** Message posted to window when ready; null posts none (nbe posts its own legacy literal). */
  readonly readyMessage: string | null;
}

export function engineLayerCss(): string {
  return 'html[data-sinter-layer="overlay"],html[data-sinter-layer="overlay"] body{background:transparent!important}';
}

/** JS source (ES5, no dependencies) that defines `window.sinterEngine`. Embed before the engine code. */
export function engineRuntimeScript(options: EngineRuntimeOptions): string {
  const id = JSON.stringify(options.id);
  const message = JSON.stringify(options.readyMessage);
  return `(function () {
  'use strict';
  var ID = ${id}, READY_MESSAGE = ${message};
  var layerMatch = /layer=(background|overlay|mask)/.exec((location.hash || '') + (location.search || ''));
  var layer = window.SINTER_ENGINE_LAYER || (layerMatch ? layerMatch[1] : 'background');
  if (layer !== 'background' && layer !== 'overlay' && layer !== 'mask') layer = 'background';
  document.documentElement.setAttribute('data-sinter-layer', layer);
  var E = window.sinterEngine = {
    id: ID, state: 'running', error: null, layer: layer,
    steps: 0, frame: 0, time: 0, input: 0, externalClock: false, stepRate: 60,
    setInput: function (v) { v = Number(v); E.input = isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; },
    ready: function () {
      if (E.state !== 'running') return;
      E.state = 'ready';
      if (READY_MESSAGE) window.postMessage(READY_MESSAGE, '*');
      try { if (window.parent !== window) window.parent.postMessage({ type: 'sinter:engine', id: ID, state: 'ready' }, '*'); } catch (e) {}
    },
    fail: function (message) {
      if (E.state === 'failed') return;
      E.state = 'failed'; E.error = String(message || 'unknown engine failure');
      var box = document.createElement('div');
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;padding:12px 16px;font:14px monospace;color:#fff;background:#7a1020;z-index:99999';
      box.textContent = 'ENGINE_FAILED:' + ID + ': ' + E.error;
      document.body.appendChild(box);
      try { window.postMessage(ID + ':failed', '*'); } catch (e) {}
      try { if (window.parent !== window) window.parent.postMessage({ type: 'sinter:engine', id: ID, state: 'failed', error: E.error }, '*'); } catch (e) {}
    },
    /** run({step, draw, stepsPerFrame, readyAfter, stepRate}): the engine's loop. step() advances one sim step. */
    run: function (cfg) {
      var perFrame = Math.max(1, cfg.stepsPerFrame | 0 || 1);
      E.stepRate = cfg.stepRate || 60 * perFrame;
      var failed = function (err) { E.fail(err && err.message ? err.message : err); };
      function advance(n) {
        for (var i = 0; i < n && E.state !== 'failed'; i++) { cfg.step(); E.steps++; }
        E.time = E.steps / E.stepRate;
        if (E.state === 'running' && E.steps >= cfg.readyAfter) { cfg.draw(); E.ready(); }
      }
      E.advanceTo = function (seconds) {
        try { var target = Math.floor(Math.max(0, seconds) * E.stepRate); if (target > E.steps) advance(target - E.steps); cfg.draw(); } catch (err) { failed(err); }
      };
      E.stepBy = function (n) { try { advance(n | 0); cfg.draw(); } catch (err) { failed(err); } };
      var externalTarget = 0;
      addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'sinter:state' && d.state && isFinite(d.state.time) && d.state.time >= 0) {
          E.externalClock = true; externalTarget = Math.floor(d.state.time * E.stepRate);
        } else if ((d.type === 'sinter:signal' || d.type === 'sinter:causal') && isFinite(d.value)) {
          E.setInput(d.value);
        }
      });
      function loop() {
        if (E.state === 'failed') return;
        try {
          if (E.externalClock) { var gap = Math.min(240, externalTarget - E.steps); if (gap > 0) advance(gap); }
          else advance(perFrame);
          E.frame++;
          cfg.draw();
        } catch (err) { failed(err); return; }
        requestAnimationFrame(loop);
      }
      try { advance(Math.min(cfg.warmSteps || 0, cfg.readyAfter)); cfg.draw(); } catch (err) { failed(err); return; }
      requestAnimationFrame(loop);
    }
  };
  addEventListener('error', function (e) { E.fail(e && e.message ? e.message : 'uncaught error'); });
})();`;
}
