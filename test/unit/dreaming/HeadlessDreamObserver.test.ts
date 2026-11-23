import { describe, expect, it, vi } from 'vitest';
import { HeadlessDreamObserver } from '../../../src/dreaming/research/HeadlessDreamObserver.js';
import { createDreamRenderedEvidenceAuthority } from
  '../../../src/dreaming/research/DreamResearchEvidence.js';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';
import { frozenExperiment } from './dreamResearchFixtures.js';

describe('HeadlessDreamObserver', () => {
  it('forces isolated bounded rendering and receipt-binds early and late frames', async () => {
    const renderWithEvidence = vi.fn(async () => ({ timingMs: 5,
      infraUnavailable: false, candidateFailure: false, errors: [],
      rendererEnvironmentDigest: '6'.repeat(64),
      containment: { networkIsolated: true, permissionsDenied: true,
        cleanupSucceeded: true, blockedRequests: 0, routeInstalled: true,
        timeoutEnforced: true, outputLimitEnforced: true, outputBytes: 16 },
      screenshot: { mimeType: 'image/png', dataBase64: Buffer.from('early').toString('base64') },
      lateScreenshot: { mimeType: 'image/png', dataBase64: Buffer.from('late').toString('base64') } }));
    const renderedEvidence = createDreamRenderedEvidenceAuthority();
    const observer = new HeadlessDreamObserver({ renderWithEvidence } as unknown as HeadlessRenderer,
      { timeoutMs: 1_000, maximumOutputBytes: 1_000 }, renderedEvidence.issuer);
    const result = await observer.observe({ id: 'candidate', source: '<html>new</html>',
      graphDigest: 'b'.repeat(64), layerIds: ['one'], domains: ['html'] }, frozenExperiment());
    expect(renderWithEvidence).toHaveBeenCalledWith('<html>new</html>',
      expect.objectContaining({ networkPolicy: 'isolated', timeout: 1_000,
        keepPageOpen: false, maximumOutputBytes: 1_000 }));
    expect(result.frames).toHaveLength(2);
    expect(result.containment).toMatchObject({ networkIsolated: true,
      cleanupSucceeded: true });
    expect(() => renderedEvidence.resolver.assertAttested(result)).not.toThrow();
    expect(() => renderedEvidence.resolver.assertAttested({ ...result }))
      .toThrow('DREAM_RENDERED_EVIDENCE_CAPABILITY_INVALID');
  });

  it('delegates output enforcement to the receipt-producing renderer', async () => {
    const renderWithEvidence = vi.fn(async () => { throw new Error('RENDER_OUTPUT_BYTES_EXCEEDED'); });
    const renderedEvidence = createDreamRenderedEvidenceAuthority();
    const observer = new HeadlessDreamObserver({ renderWithEvidence } as unknown as HeadlessRenderer,
      { timeoutMs: 1, maximumOutputBytes: 1 }, renderedEvidence.issuer);
    await expect(observer.observe({ id: 'large', source: 'too large',
      graphDigest: 'b'.repeat(64), layerIds: ['one'], domains: ['html'] }, frozenExperiment()))
      .rejects.toThrow('RENDER_OUTPUT_BYTES_EXCEEDED');
    expect(renderWithEvidence).toHaveBeenCalledOnce();
  });

  it('renders a self-contained candidate as html, never a sniffed library domain', async () => {
    // RCA 2026-11-18: domain 'unknown' made HeadlessRenderer sniff the source. A vanilla canvas
    // piece that defines draw() or names a synth was read as p5/tone, which demands a vendored
    // runtime the self-contained contract forbids: RENDER_PINNED_RUNTIME_ASSET_REQUIRED.
    const source = '<html><canvas id="c"></canvas><script>function draw(){} const synth = 1;</script></html>';
    expect(HeadlessRenderer.detectDomain(source)).toBe('p5');
    const renderWithEvidence = vi.fn(async () => { throw new Error('stop'); });
    const observer = new HeadlessDreamObserver({ renderWithEvidence } as unknown as HeadlessRenderer,
      { timeoutMs: 1, maximumOutputBytes: 1 }, createDreamRenderedEvidenceAuthority().issuer);
    await expect(observer.observe({ id: 'c', source, graphDigest: 'b'.repeat(64),
      layerIds: ['one'], domains: ['html'] }, frozenExperiment())).rejects.toThrow('stop');
    expect(renderWithEvidence).toHaveBeenCalledWith(source, expect.objectContaining({ domain: 'html' }));
  });
});
