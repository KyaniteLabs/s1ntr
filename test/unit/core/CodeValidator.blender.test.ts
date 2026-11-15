import { describe, it, expect } from 'vitest';
import { CodeValidator } from '../../../src/core/CodeValidator.js';
import { isCodeComplete } from '../../../src/core/isCodeComplete.js';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

const SCENE = [
  'import bpy',
  'bpy.ops.mesh.primitive_cube_add(size=2)',
  'bpy.ops.object.light_add(type="SUN")',
  'bpy.ops.object.camera_add(location=(5, -5, 4))',
].join('\n');

describe('CodeValidator blender domain', () => {
  it('detects a bpy script before any web-domain heuristic (even with draw())', () => {
    expect(CodeValidator.detectDomain(SCENE)).toBe('blender');
    expect(CodeValidator.detectDomain('from bpy import ops\ndef draw():\n    pass\n' + 'x = 1\n'.repeat(10))).toBe('blender');
    expect(HeadlessRenderer.detectDomain('import bpy\ndef draw():\n  pass\n')).toBe('blender');
  });

  it('accepts a clean scene script', () => {
    const result = CodeValidator.validate(SCENE, 'blender');
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects python that never imports bpy', () => {
    const result = CodeValidator.validate('print("hello world")\n'.repeat(5), 'blender');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('imports bpy');
  });

  it('rejects sandbox escapes with the offending construct named', () => {
    const result = CodeValidator.validate(SCENE + '\nimport subprocess\nsubprocess.run(["id"])\n', 'blender');
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('subprocess');
  });

  it('isCodeComplete: balanced bpy script is complete, truncated or import-less is not', () => {
    expect(isCodeComplete(SCENE, 'blender')).toBe(true);
    expect(isCodeComplete(SCENE + '\nbpy.ops.mesh.primitive_uv_sphere_add(', 'blender')).toBe(false);
    expect(isCodeComplete('x = 1\ny = 2\n', 'blender')).toBe(false);
  });
});
