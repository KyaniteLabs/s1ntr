import { describe, expect, it, vi } from 'vitest';

import { createLiminalProductionEffects } from '../../../src/runtime-core/LiminalProductionEffects.js';

vi.mock('../../../src/generators/DomainTeaching.js', () => ({ buildDomainTeaching: () => '' }));

// Premium seats ran 13-15 minutes per call and were cut off at a hard timeout
// they never knew about, losing the whole reply. Every generator call now
// tells the model how long it has, so it can size its reasoning to fit.

const source = `<!doctype html><html><head></head><body>
<div data-composition-id="layers"><div class="clip">Foreground</div></div>
<script>const tl = gsap.timeline({paused:true});
tl.to('.clip', {x:100,duration:2}); window.__timelines = {layers:tl};</script>
</body></html>`;
const repaired = source.replace('</head>', '<script src="/vendor/gsap/3.15.0/gsap.min.js"></script></head>');

function effectsWith(generate: ReturnType<typeof vi.fn>, timeout?: number, generationWallMs?: number) {
  return createLiminalProductionEffects({
    generator: { getConfig: () => ({ provider: 'fake', model: 'generator', timeout }), generate } as never,
    evaluator: {} as never, renderer: {} as never,
    generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
    ...(generationWallMs !== undefined ? { generationWallMs } : {}),
  });
}
const request = () => ({ identity: 'fake/generator', domain: 'hyperframes', prompt: 'Layered parallax',
  startTransport: vi.fn(async () => 1), failTransport: vi.fn(async () => {}) });

describe('generation time budget', () => {
  it('tells the first call and the repair call how many minutes they have', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockResolvedValueOnce({ success: true, code: repaired });
    await effectsWith(generate, 40 * 60_000).generate(request());

    const primary = String(generate.mock.calls[0][1]);
    expect(primary.startsWith('Layered parallax')).toBe(true);
    expect(primary).toMatch(/TIME BUDGET: about 40 minutes/);
    expect(primary).toMatch(/aim to finish within 28 minutes/);
    expect(String(generate.mock.calls[1][1])).toMatch(/TIME BUDGET: about 40 minutes/);
  });

  it('uses the remaining wall time when it is shorter than the seat timeout', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockResolvedValueOnce({ success: true, code: repaired });
    await effectsWith(generate, 40 * 60_000, 10 * 60_000).generate(request());
    expect(String(generate.mock.calls[0][1])).toMatch(/TIME BUDGET: about 10 minutes/);
    // With a wall budget the repair runs under its own 3-minute deadline.
    expect(String(generate.mock.calls[1][1])).toMatch(/TIME BUDGET: about 3 minutes/);
  });

  it('adds nothing when no limit is known', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({ success: true, code: source })
      .mockResolvedValueOnce({ success: true, code: repaired });
    await effectsWith(generate).generate(request());
    expect(String(generate.mock.calls[0][1])).not.toContain('TIME BUDGET');
  });
});
