import { beforeEach, describe, expect, it, vi } from 'vitest';

const hr = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock('../../../src/render/HeadlessRenderer.js', () => ({
  HeadlessRenderer: class {
    constructor() { hr.ctor(); }
    initialize() { return hr.initialize(); }
    render(html: string, opts: unknown) { return hr.render(html, opts); }
  },
}));

import { HeadlessRendererAdaptor } from '../../../src/atelier/HeadlessRendererAdaptor.js';

describe('HeadlessRendererAdaptor', () => {
  beforeEach(() => {
    hr.initialize.mockReset().mockResolvedValue(undefined);
    hr.render.mockReset();
    hr.ctor.mockReset();
  });

  it('renders html in the html domain with a 20s timeout and maps the result', async () => {
    hr.render.mockResolvedValue({ success: true, errors: [], screenshot: { buffer: Buffer.from('png-bytes') } });
    const out = await new HeadlessRendererAdaptor().renderHtml('<p>hi</p>');
    expect(hr.render).toHaveBeenCalledWith('<p>hi</p>', { domain: 'html', timeout: 20000 });
    expect(out.succeeded).toBe(true);
    expect(out.runtimeErrors).toBe(0);
    expect(out.screenshotBase64).toBe(Buffer.from('png-bytes').toString('base64'));
    expect(out.renderMs).toBeGreaterThanOrEqual(0);
  });

  it('counts runtime errors and omits the screenshot when none was captured', async () => {
    hr.render.mockResolvedValue({ success: false, errors: ['a', 'b', 'c'] });
    const out = await new HeadlessRendererAdaptor().renderHtml('<p>x</p>');
    expect(out.succeeded).toBe(false);
    expect(out.runtimeErrors).toBe(3);
    expect(out.screenshotBase64).toBeUndefined();
  });

  it('reports one runtime error when the renderer throws', async () => {
    hr.render.mockRejectedValue(new Error('chrome crashed'));
    const out = await new HeadlessRendererAdaptor().renderHtml('<p>x</p>');
    expect(out.succeeded).toBe(false);
    expect(out.runtimeErrors).toBe(1);
    expect(out.screenshotBase64).toBeUndefined();
  });

  it('initializes the renderer lazily, once, across many renders', async () => {
    hr.render.mockResolvedValue({ success: true, errors: [] });
    const adaptor = new HeadlessRendererAdaptor();
    expect(hr.ctor).not.toHaveBeenCalled();
    await adaptor.renderHtml('a');
    await adaptor.renderHtml('b');
    expect(hr.ctor).toHaveBeenCalledTimes(1);
    expect(hr.initialize).toHaveBeenCalledTimes(1);
    expect(hr.render).toHaveBeenCalledTimes(2);
  });
});
