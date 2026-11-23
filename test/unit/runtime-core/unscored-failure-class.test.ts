import { describe, it, expect } from 'vitest';
import { classifyRenderFailure } from '../../../src/render/RenderFailureCause.js';
import { unscoredFailureClass } from '../../../src/runtime-core/LiminalCommandService.js';

// #1603: a run that never reached the evaluator printed failureClass=unknown.
describe('unscoredFailureClass', () => {
  it('calls a missing render infra', () => {
    expect(unscoredFailureClass({ status: 'missing', runtimeErrors: [] })).toBe('infra');
  });
  it('calls a browser launch failure infra', () => {
    expect(unscoredFailureClass({ status: 'failed',
      runtimeErrors: ['Failed to initialize headless browser: chromium not found'] })).toBe('infra');
  });
  it('calls a script failure during render render, not unknown', () => {
    expect(unscoredFailureClass({ status: 'failed',
      runtimeErrors: ['page.evaluate: TypeError: target.click is not a function'] })).toBe('render');
  });
  // Sol L3-12: the renderer's typed verdict beats text matching.
  it('trusts a typed candidate cause over browser-sounding text the piece threw', () => {
    expect(unscoredFailureClass({ status: 'failed', failureCause: 'candidate',
      runtimeErrors: ['ReferenceError: browser is not defined'] })).toBe('render');
  });
  it('calls host contention infra even though the text names no browser', () => {
    expect(unscoredFailureClass({ status: 'failed', failureCause: 'host-contention',
      runtimeErrors: ['RENDER_HOST_CONTENTION: render took 61000ms'] })).toBe('infra');
  });
});

describe('classifyRenderFailure', () => {
  it('returns nothing for a successful render', () => {
    expect(classifyRenderFailure({ success: true })).toBeUndefined();
  });
  it('separates host contention, a missing browser and a candidate failure', () => {
    expect(classifyRenderFailure({ success: false, error: 'RENDER_HOST_CONTENTION: slow' })).toBe('host-contention');
    expect(classifyRenderFailure({ success: false, error: 'Failed to initialize headless browser' })).toBe('infra');
    expect(classifyRenderFailure({ success: false, error: 'TypeError: x is not a function' })).toBe('candidate');
  });
  it('ignores browser words the piece itself threw, and a captured frame proves the browser ran', () => {
    expect(classifyRenderFailure({ success: false, error: 'browser is not defined',
      pageErrors: ['browser is not defined'] })).toBe('candidate');
    expect(classifyRenderFailure({ success: false, error: 'chromium crashed mid-run',
      screenshot: { success: true } as never })).toBe('candidate');
  });
});
