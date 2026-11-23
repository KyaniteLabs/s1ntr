import { beforeAll, describe, expect, it } from 'vitest';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';
import { checkBlenderReadiness } from '../../src/render/BlenderReadiness.js';

const FIXED_SCRIPT = `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
bpy.ops.object.light_add(type='SUN', location=(3, -3, 5))
bpy.context.object.data.energy = 4.0
bpy.ops.object.camera_add(location=(4, -4, 3), rotation=(1.1, 0, 0.8))
bpy.context.scene.camera = bpy.context.object
bpy.context.scene.render.resolution_x = 96
bpy.context.scene.render.resolution_y = 64
`;

describe.skipIf(process.env.REQUIRE_REAL_BLENDER !== '1')('HeadlessRenderer with a real Blender', () => {
  beforeAll(() => {
    const readiness = checkBlenderReadiness();
    if (!readiness.ready) throw new Error(`BLENDER_REAL_REQUIRED_BUT_UNAVAILABLE: ${readiness.problems.join(' ')}`);
  });

  it('renders a fixed cube script to a PNG', async () => {
    const result = await new HeadlessRenderer().render(FIXED_SCRIPT, { domain: 'blender' });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.screenshot?.success).toBe(true);
    const png = result.screenshot?.buffer;
    expect(png?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(result.screenshot?.width).toBeGreaterThan(0);
    expect(result.screenshot?.height).toBeGreaterThan(0);
  }, 120_000);

  it('reports a raising bpy script with its Python error', async () => {
    const result = await new HeadlessRenderer().render('import bpy\nraise RuntimeError("s1ntr-real-blender-probe")\n', { domain: 'blender' });
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('script');
    expect(result.errors.join('\n')).toContain('s1ntr-real-blender-probe');
  }, 120_000);
});
