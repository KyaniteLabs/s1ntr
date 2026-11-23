// Test-only preload (node --import): replaces ONLY the reverse-fit's real-time browser capture (the one render call
// asked for stabilizationTime = duration*1000+1500 with maximumDurationMs set) with a synthetic 3 s signal that fits
// the brief. Everything else (Create's own render, the judge, admission, exit codes) stays real.
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.FIT_PRELOAD_DIST + '/render/HeadlessRenderer.js').href);
const SR = 8000;
function tone(out, from, to, hz, gain, decay = 0) {
  for (let i = Math.round(from * SR); i < Math.min(out.length, Math.round(to * SR)); i++) {
    const t = i / SR - from; out[i] += gain * Math.sin(2 * Math.PI * hz * t) * Math.exp(-decay * t);
  }
}
const o = new Float32Array(3 * SR);
tone(o, 0, 1.5, 200, 0.1); tone(o, 0, 1.5, 600, 0.05);
tone(o, 1.5, 2.9, 200, 0.4); tone(o, 1.5, 2.9, 600, 0.25); tone(o, 1.5, 2.9, 1500, 0.1);
for (const [hz, g] of [[110, 1], [220, 0.7], [440, 0.6], [880, 0.5], [1760, 0.4], [3300, 0.3]]) tone(o, 2.9, 3, hz, g * 0.8, 20);
const real = mod.HeadlessRenderer.prototype.render;
mod.HeadlessRenderer.prototype.render = async function (code, opts) {
  if (process.env.FIT_PRELOAD_LOG) (await import('node:fs')).appendFileSync(process.env.FIT_PRELOAD_LOG, JSON.stringify({ s: opts && opts.stabilizationTime, t: opts && opts.timeout, m: opts && opts.maximumDurationMs, d: opts && opts.domain }) + '\n');
  if (opts && opts.stabilizationTime === 4500 && opts.maximumDurationMs) {
    return { audio: { success: true, samples: o, sampleRate: SR } };
  }
  return real.call(this, code, opts);
};
