import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A video export must never hang: every render has a wall-clock budget, a
// timeout kills the renderer's whole process group, and the failure carries
// the stable code RENDER_TIMEOUT. The page below never answers, like a scene
// that spins the main thread (`while (true) {}`) and never replies to CDP.
const BROWSER_PID = 424242;
const mockClose = vi.hoisted(() => vi.fn(() => new Promise<void>(() => {}))); // close() hangs too
const mockLaunch = vi.hoisted(() => vi.fn(async () => ({
  process: () => ({ pid: 424242 }),
  close: mockClose,
  newPage: async () => ({
    setViewport: async () => {}, setRequestInterception: async () => {},
    evaluateOnNewDocument: async () => {}, on: () => {}, goto: async () => {},
    waitForFunction: () => new Promise(() => {}), // never settles
    evaluate: () => new Promise(() => {}),
    $: async () => ({ screenshot: async () => new Uint8Array([1]) }),
  }),
})));
const mockExecuteRenderJob = vi.hoisted(() => vi.fn((..._a: unknown[]) => new Promise<void>(() => {})));

vi.mock('puppeteer', () => ({ default: { launch: mockLaunch } }));
vi.mock('@hyperframes/producer', () => ({
  createRenderJob: (c: unknown) => c,
  executeRenderJob: mockExecuteRenderJob,
}));
vi.mock('../../../src/utils/browserAssetFallbacks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/browserAssetFallbacks.js')>()),
  resolveChromiumExecutablePath: () => '/opt/chromium',
}));
vi.mock('../../../src/export/VideoExporter.js', () => ({ VideoExporter: class { framesToVideo = vi.fn(); } }));

import { RevideoRenderer } from '../../../src/render/RevideoRenderer.js';
import { HyperFramesRenderer } from '../../../src/render/HyperFramesRenderer.js';
import { VideoRenderError } from '../../../src/render/VideoRenderer.js';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

const SCENE = `import { makeScene2D, Rect } from '@revideo/2d';
import { waitFor } from '@revideo/core';
export default makeScene2D('S', function* (view) { view.add(<Rect width={10} height={10} />); while (true) {} });`;

describe('video render budget', () => {
  let kill: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockClose.mockClear(); mockLaunch.mockClear(); mockExecuteRenderJob.mockClear();
    kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });
  afterEach(() => { kill.mockRestore(); });

  it('revideo mp4 export times out with RENDER_TIMEOUT and SIGKILLs the browser process group', async () => {
    const started = Date.now();
    const err = await new RevideoRenderer().render(SCENE, '/tmp/never.mp4', { fps: 10, width: 64, height: 64, timeoutMs: 300 })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VideoRenderError);
    expect((err as VideoRenderError).code).toBe('RENDER_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(kill).toHaveBeenCalledWith(-BROWSER_PID, 'SIGKILL');
  }, 15_000);

  it('revideo stills time out the same way', async () => {
    const err = await new RevideoRenderer().renderStills(SCENE, { fps: 10, width: 64, height: 64, timeoutMs: 300 })
      .then(() => null, (e: unknown) => e);
    expect((err as VideoRenderError)?.code).toBe('RENDER_TIMEOUT');
    expect(kill).toHaveBeenCalledWith(-BROWSER_PID, 'SIGKILL');
  }, 15_000);

  it('hyperframes export aborts a hung producer and fails with RENDER_TIMEOUT', async () => {
    const err = await new HyperFramesRenderer().render('<html></html>', '/tmp/never.mp4', { timeoutMs: 200 })
      .then(() => null, (e: unknown) => e);
    expect((err as VideoRenderError)?.code).toBe('RENDER_TIMEOUT');
    const signal = mockExecuteRenderJob.mock.calls[0][4] as AbortSignal;
    expect(signal.aborted).toBe(true);
  }, 15_000);

  it('L3-11: the timeout text claims a kill only when a hard stop was registered', async () => {
    const { withRenderBudget } = await import('../../../src/render/RenderBudget.js');
    const never = () => new Promise<never>(() => {});
    const soft = await withRenderBudget('x', 20, never).then(() => '', (e: Error) => e.message);
    expect(soft).toContain('no hard stop registered');
    expect(soft).not.toContain('process group killed');
    const hard = await withRenderBudget('x', 20, never, () => {}).then(() => '', (e: Error) => e.message);
    expect(hard).toContain('render process group killed');
  });

  it('a timed-out revideo piece fails honestly: candidate failure, code in the error, no still to score', async () => {
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCENE, { domain: 'revideo', renderTimeoutMs: 300 });
    expect(evidence).toMatchObject({ candidateFailure: true, infraUnavailable: false });
    expect(evidence.errors?.[0]).toContain('RENDER_TIMEOUT');
    expect(evidence.screenshot).toBeUndefined();
    expect(evidence.lateScreenshot).toBeUndefined();
  }, 15_000);
});
