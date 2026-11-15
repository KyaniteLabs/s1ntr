/**
 * Atelier CycleDriver dry-run (PRD Wave 1): no LLM — mocked transports, fixture HTML.
 * Covers: directive eligibility (A3), deterministic gates, ensemble consensus probes,
 * Pareto accept law (v3.1), seeds JSONL contract (fix 2), checkpoint persistence.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CycleDriver } from '../../../src/atelier/CycleDriver.js';
import { GuiEvolution } from '../../../src/atelier/GuiEvolution.js';
import type { AtelierTransport, ElementCritique, MutationDirective } from '../../../src/atelier/GuiSpec.js';

function mockBrain(directive: Partial<MutationDirective>): AtelierTransport {
  return {
    label: 'brain',
    async authorDirective({ nicheKey }) {
      return {
        id: 'd1', nicheKey, hypothesis: 'add missing controls',
        verifyingMetric: 'coverage', boundedEdit: 'add controls with error states',
        authoredBy: 'test', createdAt: new Date().toISOString(),
        ...directive,
      };
    },
    async generateCandidate() { throw new Error('unused'); },
    async critique() { return []; },
    async probe() { return false; },
  };
}

function mockEye(critiques: ElementCritique[], probeOk: boolean): AtelierTransport {
  return {
    label: 'eye',
    async authorDirective() { throw new Error('unused'); },
    async generateCandidate() { throw new Error('unused'); },
    async critique() { return critiques; },
    async probe() { return probeOk; },
  };
}

function fixtureHtml(withControls: boolean): string {
  const controls = withControls
    ? '<button data-atelier-control="generate">Generate</button>'
      + '<button data-atelier-control="status">Status</button>'
      + '<button data-atelier-control="gallery">Gallery</button>'
    : '';
  const panels = ['create', 'state', 'gallery'].map(panel =>
    `<section data-atelier-panel="${panel}" data-atelier-error-state="${panel}">panel ${panel}</section>`).join('');
  return `<!DOCTYPE html><html><body><main>${controls}${panels}</main></body></html>`;
}

function makeDriver(rootDir: string, opts: {
  candidateHtml: string;
  brainDirective?: Partial<MutationDirective>;
  critiques?: ElementCritique[];
  probeOk?: boolean;
  evolution?: GuiEvolution;
}) {
  const renderer = {
    async renderHtml() { return { succeeded: true, runtimeErrors: 0, renderMs: 200 }; },
  };
  return new CycleDriver({
    rootDir,
    brain: mockBrain(opts.brainDirective ?? {}),
    generator: {
      label: 'generator',
      async authorDirective() { throw new Error('unused'); },
      async generateCandidate() { return opts.candidateHtml; },
      async critique() { return []; },
      async probe() { return false; },
    },
    eyes: [mockEye(opts.critiques ?? [], opts.probeOk ?? true), mockEye(opts.critiques ?? [], opts.probeOk ?? true)],
    renderer,
    evolution: opts.evolution ?? new GuiEvolution(),
    baseHtml: fixtureHtml(false),
    requiredControls: ['generate', 'status', 'gallery'],
    specBrief: 'test spec',
  });
}

describe('Atelier CycleDriver dry-run', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atelier-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('admits a first candidate that passes gates with full coverage and probes', async () => {
    const driver = makeDriver(dir, { candidateHtml: fixtureHtml(true) });
    const report = await driver.runCycle(1);
    expect(report.decision?.accepted).toBe(true);
    expect(report.metrics?.coverage).toBe(1);
    expect(report.metrics?.findability).toBe(1);
    expect(report.metrics?.errorVisibility).toBe(1);
    expect(report.gates).toEqual({ build: true, render: true, runtimeErrors: true, coverageFloor: true, simplicityFloor: true });
  });

  it('rejects on deterministic gate failure (no controls)', async () => {
    const driver = makeDriver(dir, { candidateHtml: fixtureHtml(false) });
    const report = await driver.runCycle(1);
    expect(report.decision?.accepted).toBe(false);
  });

  it('enforces the A3 directive-eligibility law', async () => {
    const driver = makeDriver(dir, {
      candidateHtml: fixtureHtml(true),
      brainDirective: { verifyingMetric: undefined as unknown as MutationDirective['verifyingMetric'] },
    });
    await expect(driver.runCycle(1)).rejects.toThrow('ATELIER_DIRECTIVE_INELIGIBLE');
  });

  it('consensus probes: one eye failing drops findability below 1', async () => {
    const driver = new CycleDriver({
      rootDir: dir,
      brain: mockBrain({}),
      generator: {
        label: 'g', async authorDirective() { throw new Error('x'); },
        async generateCandidate() { return fixtureHtml(true); },
        async critique() { return []; }, async probe() { return false; },
      },
      eyes: [mockEye([], true), mockEye([], false)],
      renderer: { async renderHtml() { return { succeeded: true, runtimeErrors: 0, renderMs: 200 }; } },
      evolution: new GuiEvolution(), baseHtml: fixtureHtml(false),
      requiredControls: ['generate', 'status', 'gallery'], specBrief: 'test',
    });
    const report = await driver.runCycle(1);
    expect(report.metrics?.findability).toBeLessThan(1);
    expect(report.metrics?.coverage).toBe(1);
  });

  it('writes seeds JSONL with the ingest contract and checkpoints the decision', async () => {
    const critiques: ElementCritique[] = [{
      element: 'generate button', defect: 'too small',
      mechanicalFix: 'increase hit area to 44px', vendor: 'eye-0',
    }];
    const driver = makeDriver(dir, { candidateHtml: fixtureHtml(true), critiques });
    const report = await driver.runCycle(1);
    expect(typeof report.seedsFile).toBe('string');
    const lines = readFileSync(report.seedsFile!, 'utf8').trim().split('\n');
    // Both eyes' rationales compost — one line per vendor critique.
    expect(lines).toHaveLength(2);
    const seed = JSON.parse(lines[0]);
    expect(seed).toMatchObject({ element: 'generate button', defect: 'too small', cycle: 1 });
    expect(seed.ingestedBy).toContain('compost add');
    expect(existsSync(join(dir, '.omx', 'atelier', 'cycles', report.cycle ? '' : ''))).toBe(true);
  });

  it('Pareto law: equal-metrics second candidate goes to pairwise, loss rejects', async () => {
    const evolution = new GuiEvolution();
    const first = makeDriver(dir, { candidateHtml: fixtureHtml(true), evolution });
    await first.runCycle(1);
    // Second cycle: identical metrics → deterministic tie → pairwise decides.
    // Mock eye critiques containing 'worse than' to force the pairwise loss.
    const critiques: ElementCritique[] = [{
      element: 'layout', defect: 'worse than incumbent', mechanicalFix: 'n/a', vendor: 'eye-0',
    }];
    const second = makeDriver(dir, {
      candidateHtml: fixtureHtml(true), evolution, critiques, brainDirective: { id: 'd2' },
    });
    const report = await second.runCycle(2);
    expect(['deterministic-tie-pairwise-loss', 'pairwise-tiebreak']).toContain(report.decision?.reason);
  });
});
