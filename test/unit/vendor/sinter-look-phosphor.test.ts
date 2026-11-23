import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Fixture copied byte for byte from the launch reel's canonical phosphor table:
//   /srv/models-nvme/scratch/s1ntr-reel/d10/fx18v/v4_tiles.py  (PH, lines 18-19; identical in d10/fx10e/v4_tiles.py)
// YOU is the hand-picked P7 (d10/look/P7-PICK.md: body #b29cff, core #e6dcff), per the 10e.13 note in that file.
// IT is S1NTR's own tube (also P7); the kit keys it as `s1ntr`. Wheel order: d10/ab9/glow9.py:5.
const REEL_PH: Record<string, [string, string]> = {
  you: ['#b29cff', '#e6dcff'], kai: ['#d42e9f', '#ffe1f2'], cursor: ['#44d6cf', '#cef4f1'], claude: ['#f3572b', '#ffe3d9'],
  codex: ['#69dd3d', '#def2d9'], hermes: ['#37abf4', '#d5efff'], s1ntr: ['#b29cff', '#e6dcff'],
};

describe('sinter-look PHOSPHOR matches the reel table', () => {
  it('asserts all seven body+core pairs', () => {
    const src = readFileSync('vendor/sinter-kits/1.0.0/sinter-look.js', 'utf8');
    const block = src.slice(src.indexOf('var PHOSPHOR'), src.indexOf('};', src.indexOf('var PHOSPHOR')));
    const got: Record<string, [string, string]> = {};
    for (const m of block.matchAll(/(\w+): \{ body: '(#[0-9a-f]{6})', core: '(#[0-9a-f]{6})' \}/g)) got[m[1]] = [m[2], m[3]];
    expect(got).toEqual(REEL_PH);
  });
});
