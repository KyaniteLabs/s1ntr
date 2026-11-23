import { afterAll, describe, expect, it, vi } from 'vitest';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';
import { classifyRenderFailure } from '../../../src/render/RenderFailureCause.js';
import { RenderAndScorePipeline } from '../../../src/render/RenderAndScorePipeline.js';

// Sol L3-05 / L3-06: a hung browser call must not outlive the deadline, and two overlapping renders
// on the shared renderer must each judge their own page, not the shared page census.
describe('render hard deadline (L3-05)', () => {
  it('HeadlessRenderer.render returns a typed failure and closes the page when the work hangs', async () => {
    const renderer = HeadlessRenderer.getInstance();
    let closed = false;
    const spy = renderer as unknown as { renderGuarded: (c: string, o: unknown, h: { page?: unknown }) => Promise<unknown> };
    const original = spy.renderGuarded;
    spy.renderGuarded = (_c, _o, hold) => {
      hold.page = { close: async () => { closed = true; } };
      return new Promise(() => undefined);
    };
    try {
      const started = Date.now();
      const result = await renderer.render('<html></html>', { hardDeadlineMs: 150 });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/RENDER_HARD_DEADLINE/);
      expect(closed).toBe(true);
    } finally { spy.renderGuarded = original; }
  });

  it('closes a page created after a setup deadline before loading code', async () => {
    const renderer = HeadlessRenderer.getInstance();
    const state = renderer as unknown as { context: unknown };
    const originalContext = state.context;
    let resolvePage!: (page: unknown) => void;
    const pendingPage = new Promise(resolve => { resolvePage = resolve; });
    const page = { close: vi.fn(async () => undefined), isClosed: () => true, setContent: vi.fn() };
    const newPage = vi.fn(() => pendingPage);
    const initialize = vi.spyOn(renderer, 'initialize').mockResolvedValue(undefined);
    state.context = { newPage, pages: () => [] };
    try {
      const result = await renderer.render('<html></html>', { hardDeadlineMs: 30, keepPageOpen: true });
      expect(classifyRenderFailure(result)).toBe('infra');
      expect(newPage).toHaveBeenCalledOnce();
      resolvePage(page);
      await vi.waitFor(() => expect(page.close).toHaveBeenCalledOnce());
      expect(page.setContent).not.toHaveBeenCalled();
    } finally {
      initialize.mockRestore();
      state.context = originalContext;
    }
  });

  it('reports a pipeline timeout when scoring stalls after a successful capture', async () => {
    const pipeline = new RenderAndScorePipeline({ timeout: 30 });
    const internals = pipeline as unknown as { renderer: unknown; visualScorer: unknown };
    internals.renderer = { render: async () => ({ success: true, errors: [],
      screenshot: { success: true, buffer: Buffer.alloc(1) } }) };
    internals.visualScorer = { score: () => new Promise(() => undefined) };
    const result = await pipeline.process('<html></html>', 'html');
    expect(result).toMatchObject({ success: false, score: 0, error: expect.stringContaining('PIPELINE_TIMEOUT') });
  });

  it('RenderAndScorePipeline stops waiting on a renderer that never answers', async () => {
    const pipeline = new RenderAndScorePipeline({ timeout: 150 });
    (pipeline as unknown as { renderer: unknown }).renderer = { render: () => new Promise(() => undefined) };
    const started = Date.now();
    const result = await pipeline.process('<html></html>', 'html');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PIPELINE_TIMEOUT/);
  });
});

describe('per-request containment (L3-06)', () => {
  afterAll(async () => { await HeadlessRenderer.getInstance().cleanup?.(); });
  it('two concurrent renders both report their own page closed', async () => {
    const renderer = HeadlessRenderer.getInstance();
    const html = (c: string) => `<!doctype html><html><body style="margin:0;background:${c}"><canvas id=c width=64 height=64></canvas><script>const x=document.getElementById('c').getContext('2d');x.fillStyle='#ff8800';x.fillRect(8,8,40,40);</script></body></html>`;
    const [a, b] = await Promise.all([
      renderer.render(html('#223'), { domain: 'html', stabilizationTime: 100, lateCaptureDelay: 100 }),
      renderer.render(html('#322'), { domain: 'html', stabilizationTime: 100, lateCaptureDelay: 100 }),
    ]);
    expect(a.containment?.cleanupSucceeded).toBe(true);
    expect(b.containment?.cleanupSucceeded).toBe(true);
  }, 120_000);
});
