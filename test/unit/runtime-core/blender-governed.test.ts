import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createLiminalProductionEffects, isLiminalProductionDomain,
} from '../../../src/runtime-core/LiminalProductionEffects.js';

vi.mock('../../../src/generators/DomainTeaching.js', () => ({ buildDomainTeaching: () => '' }));

// #1628: sinter generate refused --domain blender although the renderer could
// run it in a bwrap sandbox. The governed path now takes blender: the raw bpy
// script is the playable, and the generator gets Blender's scene rules.

const SCRIPT = `import bpy
import math
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
bpy.ops.mesh.primitive_torus_add()
bpy.ops.object.light_add(type="SUN", location=(3, 3, 5))
bpy.ops.object.camera_add(location=(0, -6, 3), rotation=(math.radians(65), 0, 0))
bpy.context.scene.camera = bpy.context.object
`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeRenderer() {
  return {
    preflightSandbox: (code: string) => ({
      sourceDigest: createHash('sha256').update(code).digest('hex'),
      networkPolicy: 'isolated' as const, realtimeTransportsDenied: true as const, outputLimitEnforced: true as const,
    }),
    render: vi.fn(async () => ({ rendered: true, success: true, logs: [], errors: [],
      screenshot: { buffer: PNG, width: 640, height: 360, success: true },
      lateScreenshot: { buffer: PNG, width: 640, height: 360, success: true } })),
  };
}

describe('governed blender generate (#1628)', () => {
  it('is a governed production domain', () => {
    expect(isLiminalProductionDomain('blender')).toBe(true);
  });

  it('keeps the bpy script as the playable and teaches the scene rules', async () => {
    const generate = vi.fn().mockResolvedValue({ success: true, code: SCRIPT });
    const renderer = fakeRenderer();
    const effects = createLiminalProductionEffects({
      generator: { getConfig: () => ({ provider: 'fake', model: 'generator' }), generate } as never,
      evaluator: {} as never, renderer: renderer as never,
      generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
    });
    const artifact = await effects.generate({ identity: 'fake/generator', domain: 'blender',
      prompt: 'A glass torus at dusk', startTransport: vi.fn(async () => 1), failTransport: vi.fn(async () => {}) });

    expect(artifact.playable.trim()).toBe(SCRIPT.trim());
    expect(artifact.playable).not.toContain('<html');
    const systemPrompt = JSON.stringify(generate.mock.calls[0]);
    expect(systemPrompt).toContain('import bpy');
    expect(systemPrompt).toContain('Do NOT call bpy.ops.render');
  });
});

describe('governed domains (revideo removed as an art domain)', () => {
  it('nbe stays governed; revideo is no longer a production domain', () => {
    expect(isLiminalProductionDomain('revideo')).toBe(false);
    expect(isLiminalProductionDomain('nbe')).toBe(true);
  });
});
