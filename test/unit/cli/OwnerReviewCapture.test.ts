import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RenderEvidence } from '../../../src/core/types/GenerationEvaluation.js';
import {
  captureOwnerEvidence, ownerCaptureFromRender, type OwnerCaptureRenderer,
} from '../../../src/cli/OwnerReviewCapture.js';

const early = Buffer.from('early-frame-bytes').toString('base64');
const late = Buffer.from('late-frame-bytes').toString('base64');
const sha = (base64: string) => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
const measured = { pass: true, issue: null, measurement: { frames: 12, spanMs: 900, maxFlashesPerSecond: 0 } };

const rendered = (extra: Partial<RenderEvidence> = {}): RenderEvidence => ({
  rendered: true, rendererEnvironmentDigest: 'env-1', timingMs: 3400, infraUnavailable: false, candidateFailure: false,
  screenshot: { mimeType: 'image/png', dataBase64: early, width: 800, height: 600 },
  lateScreenshot: { mimeType: 'image/png', dataBase64: late, width: 800, height: 600 },
  errors: [], interaction: { actions: 2, stateChanged: true }, playback: { controlsAccessible: true, started: true },
  containment: { networkIsolated: true, permissionsDenied: true, cleanupSucceeded: true, blockedRequests: 0,
    routeInstalled: true, timeoutEnforced: true, outputLimitEnforced: true, outputBytes: 10,
    postRunCensus: { durationMs: 3400, usedHeapBytes: 1000, eventListeners: 3, eventsDispatched: 2, timers: 1,
      audioContexts: 0, pagesBefore: 1, pagesAfter: 1 } },
  ...extra,
});

const payload = (asset: { payload: string | Uint8Array } | undefined) => JSON.parse(String(asset?.payload));

describe('ownerCaptureFromRender', () => {
  it('maps a full observation to every runtime class, bound to the candidate by ref', () => {
    const { inputs, limitations } = ownerCaptureFromRender('cand-1', rendered(), measured);
    expect(limitations).toEqual([]);
    expect(inputs.timeSamples?.map((sample) => sample.ref)).toEqual(['cand-1.capture.time.early', 'cand-1.capture.time.late']);
    expect(inputs.timeSamples?.map((sample) => payload(sample).frameDigest)).toEqual([sha(early), sha(late)]);
    expect(JSON.stringify(inputs)).not.toContain(early);
    expect(inputs.runtimeState?.ref).toBe('cand-1.capture.runtime');
    expect(payload(inputs.runtimeState)).toMatchObject({ rendererEnvironmentDigest: 'env-1', timingMs: 3400,
      errors: [], postRunCensus: { eventListeners: 3 } });
    expect(payload(inputs.interactionTrace)).toEqual({ interaction: { actions: 2, stateChanged: true },
      playback: { controlsAccessible: true, started: true } });
    expect(payload(inputs.clockEvents)).toEqual({ timingMs: 3400, framesCaptured: 2 });
    expect(payload(inputs.accessibility)).toMatchObject({ check: 'photosensitivity-wcag-2.3.1', pass: true });
    for (const asset of [inputs.interactionTrace, inputs.clockEvents, inputs.accessibility]) {
      expect(asset?.ref).toMatch(/^cand-1\.capture\./);
    }
  });

  it('gives different candidates different payloads and never refers to the brief plan', () => {
    const a = ownerCaptureFromRender('a', rendered(), measured).inputs;
    const b = ownerCaptureFromRender('b', rendered({ timingMs: 900, errors: ['boom'] }), measured).inputs;
    expect(a.runtimeState?.payload).not.toBe(b.runtimeState?.payload);
    expect(JSON.stringify([a, b])).not.toContain('brief-plan');
  });

  it('names interaction as not observed instead of inventing a trace', () => {
    const { inputs, limitations } = ownerCaptureFromRender('c', rendered({ interaction: undefined }), measured);
    expect(inputs.interactionTrace).toBeUndefined();
    expect(limitations).toEqual(['interaction-not-observed']);
  });

  it('names interaction as not observed when the probe found nothing to act on', () => {
    const { inputs, limitations } = ownerCaptureFromRender('c',
      rendered({ interaction: { actions: 0, stateChanged: false } }), measured);
    expect(inputs.interactionTrace).toBeUndefined();
    expect(limitations).toEqual(['interaction-not-observed']);
  });

  it('drops the accessibility card when no flash was measured and never falls back to a text scan', () => {
    for (const flash of [null, { pass: false, issue: 'Photosensitivity not measured: no frame reached the screen', measurement: null }]) {
      const { inputs, limitations } = ownerCaptureFromRender('c', rendered(), flash);
      expect(inputs.accessibility).toBeUndefined();
      expect(limitations).toEqual(['accessibility-not-measured']);
    }
  });

  it('records a measured flash failure as a known failure on the sealed card', () => {
    const flash = { pass: false, issue: 'Photosensitivity risk: 6 flashes in one second (max safe: 3)',
      measurement: { frames: 60, spanMs: 1000, maxFlashesPerSecond: 6 } };
    const { inputs } = ownerCaptureFromRender('c', rendered(), flash);
    expect(payload(inputs.accessibility)).toMatchObject({ pass: false });
    expect(inputs.knownFailures).toEqual([flash.issue]);
  });

  it('keeps only the early sample when the late frame is missing', () => {
    const { inputs, limitations } = ownerCaptureFromRender('c', rendered({ lateScreenshot: undefined }), measured);
    expect(inputs.timeSamples).toHaveLength(1);
    expect(payload(inputs.clockEvents).framesCaptured).toBe(1);
    expect(limitations).toContain('late-frame-not-captured');
  });

  it('leaves every runtime class absent when infrastructure was unavailable or nothing was drawn', () => {
    for (const [evidence, reason] of [
      [{ infraUnavailable: true, candidateFailure: false, timingMs: 5 }, 'render-infrastructure-unavailable'],
      [{ infraUnavailable: false, candidateFailure: false, timingMs: 5 }, 'render-not-observed'],
      [rendered({ rendered: false }), 'render-not-observed'],
    ] as const) {
      const { inputs, limitations } = ownerCaptureFromRender('c', evidence, null);
      for (const key of ['timeSamples', 'interactionTrace', 'runtimeState', 'clockEvents', 'accessibility'] as const) {
        expect(inputs[key]).toBeUndefined();
      }
      expect(limitations).toContain(reason);
      expect(limitations).toContain('accessibility-not-measured');
    }
  });

  it('reports a candidate that threw as a known failure', () => {
    const { inputs } = ownerCaptureFromRender('c', rendered({ candidateFailure: true, failure: 'x is not defined' }), measured);
    expect(inputs.knownFailures).toEqual(['candidate-render-failed: x is not defined']);
    expect(payload(inputs.runtimeState)).toMatchObject({ candidateFailure: true, failure: 'x is not defined' });
  });
});

describe('captureOwnerEvidence', () => {
  const candidates = [{ id: 'one', artifact: { html: '<p>one</p>' } }, { id: 'two', artifact: { html: '<p>two</p>' } }];

  it('renders each candidate own html once and keys the result by candidate', async () => {
    const renders: string[] = [];
    const flashes: string[] = [];
    const renderer: OwnerCaptureRenderer = {
      render: async (html) => { renders.push(html); return rendered({ timingMs: html.charCodeAt(3) }); },
      measureFlash: async (html) => { flashes.push(html); return measured; },
    };
    const captured = await captureOwnerEvidence(candidates, renderer);
    expect(renders).toEqual(['<p>one</p>', '<p>two</p>']);
    expect(flashes).toEqual(renders);
    expect([...captured.keys()]).toEqual(['one', 'two']);
    expect(captured.get('one')?.inputs.runtimeState?.ref).toBe('one.capture.runtime');
    expect(captured.get('one')?.inputs.runtimeState?.payload).not.toBe(captured.get('two')?.inputs.runtimeState?.payload);
  });

  it('leaves a candidate unobserved when its renderer throws, and still captures the next one', async () => {
    const renderer: OwnerCaptureRenderer = {
      render: (html) => { if (html.includes('one')) throw new Error('browser gone'); return Promise.resolve(rendered()); },
      measureFlash: async () => { throw new Error('screencast gone'); },
    };
    const captured = await captureOwnerEvidence(candidates, renderer);
    expect(captured.get('one')?.inputs.runtimeState).toBeUndefined();
    expect(captured.get('one')?.limitations).toEqual(
      expect.arrayContaining(['render-infrastructure-unavailable', 'accessibility-not-measured']));
    expect(captured.get('two')?.inputs.runtimeState?.ref).toBe('two.capture.runtime');
    expect(captured.get('two')?.limitations).toEqual(['accessibility-not-measured']);
  });

  it('refuses two candidates with one id rather than sealing one render under both', async () => {
    const renderer: OwnerCaptureRenderer = { render: async () => rendered(), measureFlash: async () => measured };
    await expect(captureOwnerEvidence([candidates[0]!, { id: 'one', artifact: { html: '<p>other</p>' } }], renderer))
      .rejects.toThrow('OWNER_CAPTURE_DUPLICATE_CANDIDATE_ID');
  });
});
