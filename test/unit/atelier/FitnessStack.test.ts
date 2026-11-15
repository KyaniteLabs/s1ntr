import { describe, expect, it } from 'vitest';
import { deterministicTie, evaluateFitness, paretoImproves } from '../../../src/atelier/FitnessStack.js';
import type { AtelierMetrics } from '../../../src/atelier/GuiSpec.js';

const FULL_HTML = '<html><body>'
  + '<div data-atelier-panel="create" data-atelier-error-state="create"></div>'
  + '<div data-atelier-panel="state" data-atelier-error-state="state"></div>'
  + '<div data-atelier-panel="gallery" data-atelier-error-state="gallery"></div>'
  + '<button data-atelier-control="make"></button><button data-atelier-control="keep"></button>'
  + '</body></html>';

const base = { html: FULL_HTML, renderSucceeded: true, runtimeErrors: 0, renderMs: 200, requiredControls: ['make', 'keep'] };

const metrics = (o: Partial<AtelierMetrics> = {}): AtelierMetrics => ({
  coverage: 0.5, latencyToFirstSignal: 0.5, errorVisibility: 0.5, findability: 0, renderMs: 0, runtimeErrors: 0, ...o,
});

describe('evaluateFitness', () => {
  it('passes every gate with full coverage and fast render', () => {
    const r = evaluateFitness(base);
    expect(r.gates).toEqual({ build: true, render: true, runtimeErrors: true, coverageFloor: true, simplicityFloor: true });
    expect(r.metrics).toEqual({
      coverage: 1, latencyToFirstSignal: 1, errorVisibility: 1, findability: 0, renderMs: 200, runtimeErrors: 0,
    });
  });

  it('scores coverage as the fraction of required controls present and gates at 0.5', () => {
    const half = evaluateFitness({ ...base, requiredControls: ['make', 'keep', 'share', 'undo'] });
    expect(half.metrics.coverage).toBe(0.5);
    expect(half.gates.coverageFloor).toBe(true);
    const low = evaluateFitness({ ...base, requiredControls: ['make', 'a', 'b', 'c'] });
    expect(low.metrics.coverage).toBe(0.25);
    expect(low.gates.coverageFloor).toBe(false);
  });

  it('treats an empty required-controls list as full coverage', () => {
    expect(evaluateFitness({ ...base, requiredControls: [] }).metrics.coverage).toBe(1);
  });

  it('falls off latency linearly from 300ms to 5s', () => {
    expect(evaluateFitness({ ...base, renderMs: 300 }).metrics.latencyToFirstSignal).toBe(1);
    expect(evaluateFitness({ ...base, renderMs: 5000 }).metrics.latencyToFirstSignal).toBe(0);
    expect(evaluateFitness({ ...base, renderMs: 9000 }).metrics.latencyToFirstSignal).toBe(0);
    expect(evaluateFitness({ ...base, renderMs: 2650 }).metrics.latencyToFirstSignal).toBeCloseTo(0.5, 10);
  });

  it('counts only panels that expose both the panel and its error state', () => {
    const html = '<html><div data-atelier-panel="create" data-atelier-error-state="create"></div>'
      + '<div data-atelier-panel="state"></div></html>';
    expect(evaluateFitness({ ...base, html }).metrics.errorVisibility).toBeCloseTo(1 / 3, 10);
  });

  it('fails the build gate on empty html or a missing closing tag', () => {
    expect(evaluateFitness({ ...base, html: '   ' }).gates.build).toBe(false);
    expect(evaluateFitness({ ...base, html: '<html><body>' }).gates.build).toBe(false);
  });

  it('fails render and runtime gates from the inputs', () => {
    const r = evaluateFitness({ ...base, renderSucceeded: false, runtimeErrors: 2 });
    expect(r.gates.render).toBe(false);
    expect(r.gates.runtimeErrors).toBe(false);
    expect(r.metrics.runtimeErrors).toBe(2);
  });

  it('allows up to 7 interactive elements and fails the simplicity gate at 12 (score 0.6 is the boundary)', () => {
    const els = (n: number) => '<html>' + '<button></button>'.repeat(n) + '</html>';
    expect(evaluateFitness({ ...base, html: els(7) }).gates.simplicityFloor).toBe(true);
    expect(evaluateFitness({ ...base, html: els(11) }).gates.simplicityFloor).toBe(true);
    expect(evaluateFitness({ ...base, html: els(12) }).gates.simplicityFloor).toBe(false);
  });

  it('counts inputs, selects and textareas as interactive too', () => {
    const html = '<html>' + '<input><select></select><textarea></textarea>'.repeat(4) + '</html>';
    expect(evaluateFitness({ ...base, html }).gates.simplicityFloor).toBe(false);
  });
});

describe('paretoImproves', () => {
  it('admits a candidate that improves one axis and regresses none', () => {
    expect(paretoImproves(metrics({ coverage: 0.8 }), metrics())).toBe(true);
  });

  it('rejects an improvement that regresses another axis beyond tolerance', () => {
    expect(paretoImproves(metrics({ coverage: 0.9, errorVisibility: 0.4 }), metrics())).toBe(false);
  });

  it('tolerates a 0.001 wobble but not a bigger drop', () => {
    expect(paretoImproves(metrics({ coverage: 0.9, errorVisibility: 0.4995 }), metrics())).toBe(true);
    expect(paretoImproves(metrics({ coverage: 0.9, errorVisibility: 0.498 }), metrics())).toBe(false);
  });

  it('rejects an identical candidate (no improvement)', () => {
    expect(paretoImproves(metrics(), metrics())).toBe(false);
  });

  it('ignores axes that are not part of the pareto set', () => {
    expect(paretoImproves(metrics({ findability: 1, renderMs: 10 }), metrics())).toBe(false);
  });
});

describe('deterministicTie', () => {
  it('is a tie when every axis is within 0.001', () => {
    expect(deterministicTie(metrics({ coverage: 0.5005 }), metrics())).toBe(true);
  });

  it('is not a tie once any axis moves further', () => {
    expect(deterministicTie(metrics({ latencyToFirstSignal: 0.6 }), metrics())).toBe(false);
  });
});
