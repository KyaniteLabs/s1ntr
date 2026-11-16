import { describe, it, expect } from 'vitest';
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
});
