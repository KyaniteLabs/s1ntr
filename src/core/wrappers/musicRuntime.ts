/**
 * The one music runtime (#1732).
 *
 * The playable page a viewer opens and the judge's renderer both run this
 * code, so the judge scores exactly what a viewer hears. Before it existed,
 * each side had its own compatibility shims: the renderer defined bpm() and
 * Pattern methods that the page lacked (#1729), so a piece could score well
 * and play silence.
 *
 * `installMusicRuntime` is serialized with toString() into a <script>, so it
 * must not reference anything outside its own body and must not declare
 * named inner functions (tsx/esbuild keepNames would wrap them in a
 * __name() helper that does not exist in the page).
 *
 * It is idempotent: a playable page embeds it, and the renderer injects it
 * again so stored playables made before this module heal on rescore. A
 * second call only runs the pending boot step; nothing is installed twice.
 */

import { STRUDEL_TEMPO_SCRIPT } from '../../render/strudelTempo.js';

/** Sample banks every Strudel piece gets: the REPL's defaults plus the
 * classic Dirt short names (bd, hh, cp...) that corpus pieces use. */
export const STRUDEL_SAMPLE_BANKS: readonly string[] = [
  'https://strudel.b-cdn.net/piano.json',
  'https://strudel.b-cdn.net/vcsl.json',
  'https://strudel.b-cdn.net/tidal-drum-machines.json',
  'https://strudel.b-cdn.net/tidal-drum-machines-alias.json',
  'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json',
];

/** Pattern methods models invent (TidalCycles habits). Vendored Strudel
 * 1.3.0 has none of them; a call throws and the piece is silent. A no-op that
 * returns the pattern keeps it playing at the scheduler's tempo. A browser
 * probe (2026-11-16, E37) showed the no-op does not disturb the scheduler:
 * plain peak 0.31, shimmed .bpm(120) peak 0.29, unshimmed .bpm(120) silent. */
export const STRUDEL_PATTERN_NOOPS: readonly string[] = ['bpm', 'cpm', 'tempo', 'setcpm', 'setbpm'];

export function installMusicRuntime(banks: string[], patternNoops: string[]): void {
  const w = window as unknown as Record<string, unknown>;
  // Second call (the renderer injected it first): run the boot step now, so
  // the page's own script finds __sinterStrudelBoot set right after Strudel
  // loads instead of waiting for the next poll.
  if (typeof w.__sinterMusicRuntime === 'function') { (w.__sinterMusicRuntime as () => boolean)(); return; }

  // bpm()/setbpm() come from the one tempo contract (strudelTempo.ts, #1769),
  // which musicRuntimeScript() installs ahead of this function.

  type StrudelGlobal = {
    Pattern?: { prototype: Record<string, unknown> };
    initStrudel?: () => Promise<unknown>;
    samples?: (u: string) => Promise<unknown>;
  };
  let patched = false;
  let booting = false;
  const step = (): boolean => {
    const sd = w.strudel as StrudelGlobal | undefined;
    if (!sd) return false;
    if (!patched && sd.Pattern?.prototype) {
      const proto = sd.Pattern.prototype;
      for (const m of patternNoops) {
        if (typeof proto[m] !== 'function') proto[m] = function (this: unknown) { return this; };
      }
      patched = true;
    }
    if (!booting && typeof sd.initStrudel === 'function' && typeof sd.samples === 'function') {
      booting = true;
      const sdRef = sd;
      // The page's Play button waits on this one boot, so the judge and the
      // viewer start from the same loaded banks.
      w.__sinterStrudelBoot = sd.initStrudel().then(() => Promise.all(
        banks.map((u) => (sdRef.samples as (x: string) => Promise<unknown>)(u).catch(() => undefined)),
      ));
    }
    return patched && booting;
  };
  w.__sinterMusicRuntime = step;
  if (step()) return;
  const timer = setInterval(() => { if (step()) clearInterval(timer); }, 50);
  setTimeout(() => clearInterval(timer), 30_000);
}

/** The runtime as inline <script> tags: the #1769 tempo contract, then the runtime. */
export function musicRuntimeScript(): string {
  return STRUDEL_TEMPO_SCRIPT + '<script>(' + installMusicRuntime.toString() + ')('
    + JSON.stringify(STRUDEL_SAMPLE_BANKS) + ',' + JSON.stringify(STRUDEL_PATTERN_NOOPS)
    + ');</script>';
}
