// Sol L3 row 8: real governed Blender Create. Blender is not installed on every host (and needs bwrap to count as
// contained), so this skips LOUDLY with the exact reason; where Blender exists it drives the real renderer through the
// spawned CLI on the fake provider (no real provider call).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider } from '../helpers/fakeProviderServer';

function have(bin: string): string | null {
  try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
const blender = process.env.SINTER_BLENDER_BIN || have('blender');
const bwrap = have('bwrap');
const reason = !blender ? 'blender is not installed (run scripts/art-batch/install_blender.sh, or set SINTER_BLENDER_BIN)'
  : !bwrap ? 'bwrap is not installed, so Blender would not be contained and cannot be admitted' : '';
if (reason) console.warn(`[blender-real-create] SKIPPED: ${reason}`);

const SCRIPT = `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
bpy.ops.object.light_add(type='SUN', location=(3, 3, 5))
bpy.ops.object.camera_add(location=(6, -6, 4), rotation=(1.1, 0, 0.8))
bpy.context.scene.camera = bpy.context.object`;

describe.skipIf(!!reason)('governed Create, real Blender', () => {
  it('renders a PNG into the evidence and ends saved (0 accepted or 3 not accepted), never an error', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'sinter-blender-'));
    const fake = await startFakeProvider({ generate: () => SCRIPT, judge: () => goodJudgeReply(0.8) });
    try {
      const env = { ...fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') }),
        ...(process.env.SINTER_BLENDER_BIN ? { SINTER_BLENDER_BIN: process.env.SINTER_BLENDER_BIN } : {}) };
      const run = await runSinterAsync(['generate', '-o', path.join(work, 'out'), '--domain', 'blender', 'a lit cube'], env, undefined, 590_000);
      expect([0, 3]).toContain(run.status);
      const all = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true })
        .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); })(path.join(work, 'out'));
      expect(all.some(f => f.endsWith('.png'))).toBe(true);
    } finally { await fake.close(); rmSync(work, { recursive: true, force: true }); }
  }, 600_000);
});
