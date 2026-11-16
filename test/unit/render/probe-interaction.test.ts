// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeInteraction, settleInteractionProbe } from '../../../src/render/HeadlessRenderer.js';

describe('probeInteraction (#1629)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('clicks an SVG element with role="button" without throwing', async () => {
    document.body.innerHTML = '<svg><rect id="r" role="button" width="10" height="10"></rect></svg><p id="out">0</p>';
    const rect = document.getElementById('r')!;
    expect((rect as unknown as { click?: unknown }).click).toBeUndefined();
    rect.addEventListener('click', () => { document.getElementById('out')!.textContent = '1'; });
    await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: true, target: 'control' });
  });

  it('still clicks an HTML button', async () => {
    document.body.innerHTML = '<button id="b">go</button>';
    document.getElementById('b')!.addEventListener('click', e => { (e.target as HTMLElement).textContent = 'done'; });
    await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: true, target: 'control' });
  });

  it('reports no action when nothing is interactive', async () => {
    document.body.innerHTML = '<div>static</div>';
    await expect(probeInteraction()).resolves.toEqual({ actions: 0, stateChanged: false, target: 'none' });
  });
});

describe('probeInteraction on canvas pieces (#1702)', () => {
  let timer: ReturnType<typeof setInterval> | undefined;
  // jsdom has no layout: give canvases a box unless a test marks one hidden.
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const hidden = this.hasAttribute('data-hidden');
      return { left: 0, top: 0, right: 40, bottom: 30, x: 0, y: 0,
        width: hidden ? 0 : 40, height: hidden ? 0 : 30, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => { if (timer) clearInterval(timer); timer = undefined; vi.restoreAllMocks(); });

  it('acts on a canvas piece that listens for pointerdown on the window', async () => {
    document.body.innerHTML = '<canvas id="c" width="40" height="30"></canvas><p id="out">0</p>';
    let hits = 0;
    const onDown = () => { hits++; document.getElementById('out')!.textContent = String(hits); };
    window.addEventListener('pointerdown', onDown);
    try {
      await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: true, target: 'canvas-pointer' });
    } finally { window.removeEventListener('pointerdown', onDown); }
  });

  it('acts on a canvas piece that listens for mousemove on the canvas', async () => {
    document.body.innerHTML = '<canvas id="c" width="40" height="30"></canvas>';
    const canvas = document.getElementById('c')!;
    canvas.addEventListener('mousemove', () => canvas.setAttribute('data-hover', '1'));
    await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: true, target: 'canvas-pointer' });
  });

  it('reports no change when the canvas ignores the pointer', async () => {
    document.body.innerHTML = '<canvas id="c" width="40" height="30"></canvas>';
    await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: false, target: 'canvas-pointer' });
  });

  it('does not credit a button with a change the page makes on its own', async () => {
    document.body.innerHTML = '<button id="b">noop</button><p id="tick">0</p>';
    let ticks = 0;
    timer = setInterval(() => { document.getElementById('tick')!.textContent = String(++ticks); }, 10);
    await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: null, target: 'control' });
  });

  it('tries the canvas after a no-op button and credits the canvas', async () => {
    document.body.innerHTML = '<button id="b">noop</button><canvas id="c" width="40" height="30"></canvas>';
    const canvas = document.getElementById('c')!;
    canvas.addEventListener('pointerdown', () => canvas.setAttribute('data-down', '1'));
    await expect(probeInteraction()).resolves.toEqual({ actions: 2, stateChanged: true, target: 'canvas-pointer' });
  });

  it('reports an error, not "nothing to act on", when the probe crashes', async () => {
    document.body.innerHTML = '<button>x</button>';
    vi.spyOn(document, 'querySelectorAll').mockImplementation(() => { throw new Error('boom'); });
    await expect(probeInteraction()).resolves.toEqual({ actions: 0, stateChanged: null, target: 'error' });
  });

  it('skips a zero-box canvas and acts on the visible one', async () => {
    document.body.innerHTML = '<canvas id="h" data-hidden="1" width="400" height="300"></canvas>'
      + '<canvas id="v" width="40" height="30"></canvas>';
    const hidden = document.getElementById('h')!;
    const visible = document.getElementById('v')!;
    hidden.addEventListener('pointerdown', () => hidden.setAttribute('data-hit', '1'));
    visible.addEventListener('pointerdown', () => visible.setAttribute('data-hit', '1'));
    await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: true, target: 'canvas-pointer' });
    expect(visible.getAttribute('data-hit')).toBe('1');
    expect(hidden.hasAttribute('data-hit')).toBe(false);
  });

  it('sends the pointer sequence to an overlay above the canvas', async () => {
    document.body.innerHTML = '<canvas id="c" width="40" height="30"></canvas><div id="o"></div>';
    const overlay = document.getElementById('o')!;
    overlay.addEventListener('pointerdown', () => overlay.setAttribute('data-down', '1'));
    document.elementFromPoint = () => overlay;
    try {
      await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: true, target: 'canvas-pointer' });
    } finally { delete (document as { elementFromPoint?: unknown }).elementFromPoint; }
  });
});

describe('probeInteraction under the containment census (#1702)', () => {
  type Census = { timers: number };
  const root = globalThis as { __liminalContainmentCensus?: Census };
  let original: typeof setTimeout;
  beforeEach(() => { document.body.innerHTML = ''; original = globalThis.setTimeout; });
  afterEach(() => { globalThis.setTimeout = original; delete root.__liminalContainmentCensus; });

  const installCensus = (census: Census, limit: number) => {
    root.__liminalContainmentCensus = census;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      if (++census.timers > limit) return 0;
      return original(...args);
    }) as typeof setTimeout;
  };

  it('leaves the piece\'s timer count as the piece left it', async () => {
    const census = { timers: 7 };
    installCensus(census, 2048);
    document.body.innerHTML = '<button id="b">go</button><p id="out">0</p>';
    document.getElementById('b')!.addEventListener('click', () => { document.getElementById('out')!.textContent = '1'; });
    await expect(probeInteraction()).resolves.toEqual({ actions: 1, stateChanged: true, target: 'control' });
    expect(census.timers).toBe(7);
  });

  it('gives its timers back exactly once when the renderer settles it mid-run', async () => {
    const census = { timers: 7 };
    installCensus(census, 2048);
    document.body.innerHTML = '<button>go</button>';
    const running = probeInteraction();
    expect(census.timers).toBeGreaterThan(7);
    settleInteractionProbe();
    expect(census.timers).toBe(7);
    await expect(running).resolves.toEqual({ actions: 0, stateChanged: null, target: 'error' });
    expect(census.timers).toBe(7);
  });

  it('reports an error instead of hanging when the census refuses its timers', async () => {
    const census = { timers: 2047 };
    installCensus(census, 2048);
    document.body.innerHTML = '<button>go</button>';
    await expect(probeInteraction()).resolves.toEqual({ actions: 0, stateChanged: null, target: 'error' });
    expect(census.timers).toBe(2047);
  });
});
