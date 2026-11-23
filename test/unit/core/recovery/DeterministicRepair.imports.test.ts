import { describe, it, expect } from 'vitest';
import { repairRejected } from '../../../../src/core/recovery/DeterministicRepair.js';
import { CodeValidator } from '../../../../src/core/CodeValidator.js';

describe('deterministic import recovery', () => {
  it('blender: adds the missing import bpy', () => {
    const r = repairRejected('bpy.ops.mesh.primitive_cube_add()\n', 'blender');
    expect(r?.repairs).toEqual(['blender:import']);
    expect(r?.code.startsWith('import bpy\n')).toBe(true);
  });
  it('blender: leaves code that already imports bpy alone', () => {
    expect(repairRejected('import bpy\nbpy.ops.mesh.primitive_cube_add()\n', 'blender')).toBeNull();
  });
  it('revideo: imports the 2d and core names the scene uses', () => {
    const code = 'export default makeScene2D(function* (view) {\n  const r = createRef<Rect>();\n  view.add(<Rect ref={r} />);\n  yield* waitFor(1);\n});\n';
    const r = repairRejected(code, 'revideo');
    expect(r?.repairs).toEqual(['revideo:imports']);
    expect(r?.code).toContain("from '@revideo/2d'");
    expect(r?.code).toContain("from '@revideo/core'");
    expect(r?.code).toMatch(/import \{ makeScene2D, Rect \}/);
    expect(r?.code).toMatch(/import \{ createRef, waitFor \}/);
  });
  it('revideo: does not re-import what is already imported or declared', () => {
    const code = "import { makeScene2D, Rect } from '@revideo/2d';\nexport default makeScene2D(function* (v) { v.add(<Rect />); });\n";
    expect(repairRejected(code, 'revideo')).toBeNull();
  });
  it('end to end: the validator accepts a blender script that forgot the import', () => {
    const v = CodeValidator.validate('bpy.ops.mesh.primitive_cube_add()\nbpy.context.scene.render.engine = "CYCLES"\n', 'blender');
    expect(v.errors.filter(e => /imports bpy/.test(e))).toEqual([]);
  });
});
