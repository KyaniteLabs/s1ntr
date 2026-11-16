/**
 * One tempo contract for Strudel pieces (#1769).
 *
 * The prompt teaches bpm(n), but Strudel 1.3.0 has setcps/setcpm and no bpm.
 * The judge's renderer and the viewer page both install this, so the judge and
 * a listener hear the same piece at the same speed. Strudel counts four beats
 * per cycle (its default 0.5 cps is 120 BPM), so bpm(n) sets n / 240 cycles
 * per second, the same as setcpm(n / 4).
 *
 * Kept as plain JavaScript text rather than a serialized TS function: bundlers
 * (esbuild keepNames) inject helpers into Function.prototype.toString output
 * that do not exist in the page.
 */
export const STRUDEL_TEMPO_JS = `(function (g) {
  function setBpm(value) {
    var v = Number(value);
    if (typeof g.setcps !== 'function' || !isFinite(v) || v <= 0) return undefined;
    return g.setcps(v / 240);
  }
  if (typeof g.bpm !== 'function') g.bpm = setBpm;
  if (typeof g.setbpm !== 'function') g.setbpm = setBpm;
})(globalThis);`;

/** The contract as a page script, for HTML that runs Strudel. */
export const STRUDEL_TEMPO_SCRIPT = `<script>${STRUDEL_TEMPO_JS}</script>`;
