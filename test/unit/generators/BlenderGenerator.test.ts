import { describe, expect, it, vi } from 'vitest';

import { BlenderGenerator } from '../../../src/generators/blender/BlenderGenerator.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { blenderConfidence, metaConfidence, p5Confidence } from '../../../src/generators/registerGenerators.js';
import { GenerationError } from '../../../src/errors/GenerationError.js';

const GOOD_SCRIPT = [
  'import bpy',
  'bpy.ops.object.select_all(action="SELECT")',
  'bpy.ops.object.delete()',
  'bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 1))',
  'bpy.ops.object.light_add(type="SUN", location=(4, -4, 6))',
  'bpy.ops.object.camera_add(location=(6, -6, 4), rotation=(1.1, 0, 0.8))',
  'bpy.context.scene.camera = bpy.context.object',
].join('\n');

class TestableBlenderGenerator extends BlenderGenerator {
  validateForTest(code: string) {
    return this.validateOutput(code);
  }
}

function makeLlm(): LLMClient {
  return new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'blender-test-model' });
}

describe('BlenderGenerator', () => {
  it('returns the raw python and strips a markdown fence the model added', async () => {
    const llm = makeLlm();
    const complete = vi.spyOn(llm, 'complete').mockResolvedValue({
      text: 'Here is your scene:\n```python\n' + GOOD_SCRIPT + '\n```\nEnjoy.',
      success: true,
    });

    const code = await new BlenderGenerator(llm).generate('a glossy sphere on a plane');

    expect(code).toBe(GOOD_SCRIPT);
    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]?.[0];
    expect(request?.prompt).toContain('a glossy sphere on a plane');
    expect(request?.prompt).toContain('Do NOT call bpy.ops.render');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries once with a tighter prompt when the first answer has no bpy import', async () => {
    const llm = makeLlm();
    const complete = vi.spyOn(llm, 'complete')
      .mockResolvedValueOnce({ text: 'I would build a sphere with a camera.', success: true })
      .mockResolvedValueOnce({ text: GOOD_SCRIPT, success: true });

    const code = await new BlenderGenerator(llm).generate('a sphere');

    expect(code).toBe(GOOD_SCRIPT);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].prompt).toContain('did not return a valid Blender python script');
  });

  it('throws a GenerationError naming the reason when both attempts are invalid', async () => {
    const llm = makeLlm();
    const complete = vi.spyOn(llm, 'complete').mockResolvedValue({
      text: 'import bpy\nimport subprocess\nsubprocess.run(["id"])\n',
      success: true,
    });

    const attempt = new BlenderGenerator(llm).generate('a sphere');

    await expect(attempt).rejects.toBeInstanceOf(GenerationError);
    await expect(attempt).rejects.toThrow(/subprocess/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('throws when the provider returns empty text or an error', async () => {
    const llm = makeLlm();
    vi.spyOn(llm, 'complete').mockResolvedValue({ text: '', success: false, error: 'provider down' });

    await expect(new BlenderGenerator(llm).generate('a sphere')).rejects.toThrow(/provider down/);
  });

  it('validateOutput accepts a bpy script and rejects non-python, missing import and escapes', () => {
    const gen = new TestableBlenderGenerator();
    expect(gen.validateForTest(GOOD_SCRIPT)).toEqual({ valid: true });
    expect(gen.validateForTest('<!DOCTYPE html><html></html>').valid).toBe(false);
    expect(gen.validateForTest('x = 1\n'.repeat(20)).error).toContain('imports bpy');
    expect(gen.validateForTest('import bpy\nimport socket\n' + 'x = 1\n'.repeat(10)).error).toContain('socket');
  });
});

describe('blenderConfidence routing', () => {
  it('claims the explicit --domain blender route and bpy scene requests', () => {
    expect(blenderConfidence('Target creative domain: blender\nA marble bust')).toBe(0.99);
    expect(blenderConfidence('write a bpy script that renders a donut')).toBe(0.95);
    expect(blenderConfidence('make a blender scene of a lighthouse at dusk')).toBe(0.95);
    expect(blenderConfidence('render it in Blender with a soft key light')).toBe(0.95);
  });

  it('stays out of the way of every other domain', () => {
    expect(blenderConfidence('a p5.js flow field with particles')).toBe(0);
    expect(blenderConfidence('a smoothie recipe visual, mixes like a blender')).toBe(0);
    expect(blenderConfidence('Target creative domain: meta\nan ink simulation')).toBe(0);
    expect(p5Confidence('a blender scene of a donut')).toBeLessThan(0.95);
    expect(metaConfidence('a blender scene of a donut')).toBe(0);
  });
});
