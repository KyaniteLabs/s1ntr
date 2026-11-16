import { describe, it, expect, vi, afterEach } from 'vitest';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

type Observe = (page: { evaluate: (script: string) => Promise<unknown> }, deadlineMs?: number) => Promise<unknown>;

describe('HeadlessRenderer interaction probe deadline (#1702)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reports an error when the page never answers, not even the settle call', async () => {
    vi.useFakeTimers();
    const renderer = new HeadlessRenderer() as unknown as { observeInteraction: Observe };
    const pending = renderer.observeInteraction.call(renderer, { evaluate: () => new Promise(() => {}) }, 5_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toEqual({ actions: 0, stateChanged: null, target: 'error' });
  });

  it('asks the page to settle the probe\'s timers once the deadline passes', async () => {
    vi.useFakeTimers();
    const renderer = new HeadlessRenderer() as unknown as { observeInteraction: Observe };
    const scripts: string[] = [];
    const page = { evaluate: (script: string) => {
      scripts.push(script);
      return scripts.length === 1 ? new Promise(() => {}) : Promise.resolve(undefined);
    } };
    const pending = renderer.observeInteraction.call(renderer, page as never, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ actions: 0, stateChanged: null, target: 'error' });
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain('__liminalProbe');
  });

  it('returns what the page reported when it answers in time', async () => {
    const renderer = new HeadlessRenderer() as unknown as { observeInteraction: Observe };
    const seen = { actions: 1, stateChanged: true, target: 'control' };
    await expect(renderer.observeInteraction.call(renderer, { evaluate: async () => seen }, 5_000)).resolves.toEqual(seen);
  });
});
