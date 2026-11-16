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

const SCENE = `import { makeScene2D, Circle } from '@revideo/2d';
import { createRef, all, waitFor } from '@revideo/core';
export default makeScene2D('Orbit', function* (view) {
  const c = createRef<Circle>();
  const ring = createRef<Circle>();
  view.fill('#05040a');
  view.add(<Circle ref={ring} size={520} stroke={'#4ee6c8'} lineWidth={6} opacity={0.4} />);
  view.add(<Circle ref={c} size={240} fill={'#9a7cff'} />);
  yield* all(c().scale(1.6, 2), c().position.x(300, 2), ring().rotation(180, 2));
  yield* all(c().position.x(-300, 2), c().fill('#ff7ab6', 2), ring().opacity(1, 2));
  yield* all(c().position.x(0, 1.5), c().scale(1, 1.5), ring().size(640, 1.5));
  yield* waitFor(1);
});`;

describe('governed revideo generate (#1628)', () => {
  it('is a governed production domain; nbe is not (no model step)', () => {
    expect(isLiminalProductionDomain('revideo')).toBe(true);
    expect(isLiminalProductionDomain('nbe')).toBe(false);
  });

  it('keeps the scene source as the playable and teaches the scene rules', async () => {
    const generate = vi.fn().mockResolvedValue({ success: true, code: SCENE });
    const effects = createLiminalProductionEffects({
      generator: { getConfig: () => ({ provider: 'fake', model: 'generator' }), generate } as never,
      evaluator: {} as never, renderer: fakeRenderer() as never,
      generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
    });
    const artifact = await effects.generate({ identity: 'fake/generator', domain: 'revideo',
      prompt: 'An orbit that breathes', startTransport: vi.fn(async () => 1), failTransport: vi.fn(async () => {}) });

    expect(artifact.playable.trim()).toBe(SCENE.trim());
    expect(artifact.playable).not.toContain('data-revideo-timeline-preview');
    const prompts = JSON.stringify(generate.mock.calls[0]);
    expect(prompts).toContain('makeScene2D');
    expect(prompts).toContain('the render is offline');
  });
});
