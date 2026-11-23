import { describe, expect, it } from 'vitest';
import { assertBlenderReady, checkBlenderReadiness } from '../../../src/render/BlenderReadiness.js';
import type { SandboxDeps } from '../../../src/render/BlenderSandbox.js';

const deps = (present: string[], env: Record<string, string> = {}): SandboxDeps => ({
  which: (c) => (present.includes(c) ? (c.startsWith('/') ? c : `/usr/bin/${c}`) : null),
  realpath: (p) => p,
  hostEnv: { HOME: '/home/u', ...env },
});

describe('checkBlenderReadiness', () => {
  it('is not ready without a blender binary (the v16 batch hosts)', () => {
    const r = checkBlenderReadiness('linux', deps(['bwrap']));
    expect(r.ready).toBe(false);
    expect(r.problems.join(' ')).toContain('Blender executable not found');
  });
  it('is not ready on macOS or without bwrap, even with blender (Kaggle, Mac seats)', () => {
    expect(checkBlenderReadiness('darwin', deps(['blender'])).problems.join(' ')).toContain('macOS is not sandboxed');
    expect(checkBlenderReadiness('linux', deps(['blender'])).problems.join(' ')).toContain('bwrap');
  });
  it('is ready on linux with blender and bwrap, honouring SINTER_BLENDER_BIN', () => {
    expect(checkBlenderReadiness('linux', deps(['blender', 'bwrap'])).ready).toBe(true);
    expect(checkBlenderReadiness('linux', deps(['/opt/b/blender', 'bwrap'], { SINTER_BLENDER_BIN: '/opt/b/blender' })).ready).toBe(true);
  });
  it('assertBlenderReady throws BLENDER_LANE_NOT_READY naming the missing piece', () => {
    expect(() => assertBlenderReady('linux', deps([]))).toThrow(/BLENDER_LANE_NOT_READY.*no model call was made/);
  });
});
