import { describe, expect, it, vi, beforeEach } from 'vitest';

// #1628: an explicit revideo domain renders the real scene in the contained
// Revideo harness instead of being refused as an approximation.
const renderStills = vi.hoisted(() => vi.fn());
vi.mock('../../../src/render/RevideoRenderer.js', () => ({
  RevideoRenderer: class { renderStills = renderStills; },
}));

import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

const SCENE = `import { makeScene2D, Rect } from '@revideo/2d';
import { createRef, waitFor } from '@revideo/core';
export default makeScene2D('S', function* (view) {
  const r = createRef<Rect>();
  view.add(<Rect ref={r} width={400} height={300} fill={'#123'} />);
  yield* r().scale(2, 1);
  yield* waitFor(1);
});`;

const contained = { networkIsolated: true, permissionsDenied: true, blockedRequests: 1, cleanupSucceeded: true };

describe('HeadlessRenderer revideo (#1628)', () => {
  beforeEach(() => { renderStills.mockReset(); });

  it('renders the scene and hands the judges an early and a late still with containment', async () => {
    renderStills.mockResolvedValue({ early: Buffer.from([1]), late: Buffer.from([2]), width: 960, height: 540,
      durationSeconds: 2, containment: contained });
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCENE, { domain: 'revideo' });
    expect(evidence.rendered).toBe(true);
    expect(evidence.screenshot?.dataBase64).toBe(Buffer.from([1]).toString('base64'));
    expect(evidence.lateScreenshot?.dataBase64).toBe(Buffer.from([2]).toString('base64'));
    expect(evidence.containment).toMatchObject({ networkIsolated: true, permissionsDenied: true,
      cleanupSucceeded: true, blockedRequests: 1, timeoutEnforced: true, outputLimitEnforced: true });
  });

  it('reports an uncontained harness as not isolated, so admission rejects it', async () => {
    renderStills.mockResolvedValue({ early: Buffer.from([1]), late: Buffer.from([2]), width: 960, height: 540,
      durationSeconds: 2, containment: { ...contained, networkIsolated: false } });
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCENE, { domain: 'revideo' });
    expect(evidence.containment?.networkIsolated).toBe(false);
  });

  it('a scene that fails to bundle is a candidate failure, not infra and not a refused wrapper', async () => {
    renderStills.mockImplementation(async () => { throw new Error('Build failed with 1 error: scene.tsx:3:4: Expected ")"'); });
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCENE, { domain: 'revideo' });
    expect(evidence).toMatchObject({ candidateFailure: true, infraUnavailable: false });
    expect(evidence.rendered).not.toBe(false);
    expect(evidence.errors?.[0]).toContain('Revideo render failed: Build failed');
  });

  it('a browser that will not launch is infra', async () => {
    renderStills.mockImplementation(async () => { throw new Error('Failed to launch the browser process!'); });
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCENE, { domain: 'revideo' });
    expect(evidence).toMatchObject({ candidateFailure: false, infraUnavailable: true });
  });

  it('refuses an oversized scene before bundling it', async () => {
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCENE + '//'.repeat(2_000_000), { domain: 'revideo' });
    expect(renderStills).not.toHaveBeenCalled();
    expect(evidence.errors).toContain('RENDER_OUTPUT_BYTES_EXCEEDED');
  });
});
