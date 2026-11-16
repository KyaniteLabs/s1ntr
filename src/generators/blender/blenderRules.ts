/**
 * Blender scene-script rules, shared by the legacy BlenderGenerator and the
 * governed production path. A leaf module on purpose: the governed path must
 * not load TierBasedGenerator (production authority registry, #1628).
 */
export const BLENDER_RULES = [
  'You are writing a Blender Python (bpy) script that builds a 3D scene. Sinter will run it headless with `blender -b --factory-startup` and render one still image.',
  '',
  'Rules:',
  '  - Start with `import bpy` (and `import math` / `import random` / `import mathutils` / `import bmesh` if needed). Nothing else may be imported.',
  '  - Clear the default scene first (`bpy.ops.object.select_all(action="SELECT")` then `bpy.ops.object.delete()`).',
  '  - Build real geometry with materials (Principled BSDF: base color, roughness, metallic, emission where useful), at least one light, and a camera that frames the subject. Set `bpy.context.scene.camera` to your camera.',
  '  - Set a world background color or a sky so the frame is not flat grey.',
  '  - Do NOT call bpy.ops.render or set the output path, resolution or sample count: the host renders the frame and caps resolution and samples.',
  '  - No network, no subprocess, no shell, no os/sys file access, no exec/eval, no reading or writing files. Pure scene construction only.',
  '  - Keep it deterministic: seed `random` if you use it.',
  '',
  'Output ONLY the raw Python script. No markdown fences, no prose.',
].join('\n');
