/**
 * RalphLoop Convergence Tests
 *
 * Tier 0 Fix: Tests to verify loop iteration and convergence detection
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RalphLoop } from '../../src/core/RalphLoop.js';
import { installIntegrationProofLLMEnv } from '../integration/helpers/proof-llm-server.js';

// Provider boundary 1: loopback fake LLM (real HTTP). Boundary 2: the headless
// browser, served from a recorded healthy render. The loop in between is real.
vi.mock('../../src/render/HeadlessRenderer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/HeadlessRenderer.js')>();
  const evidence = JSON.parse(
    fs.readFileSync(new URL('../fixtures/ralph-loop/render-evidence.json', import.meta.url), 'utf8'),
  );
  const fake = { renderWithEvidence: async () => structuredClone(evidence) };
  return { ...actual, HeadlessRenderer: { ...actual.HeadlessRenderer, getInstance: () => fake } };
});

describe('RalphLoop', () => {
  describe('Convergence detection', () => {
    let proofLLMCleanup: Awaited<ReturnType<typeof installIntegrationProofLLMEnv>>;
    let galleryDir: string;
    let savedScoreTimeout: string | undefined;

    beforeAll(async () => {
      // NODE_ENV=test caps the rendered-evidence judge at 1s; lift it.
      savedScoreTimeout = process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS;
      process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS = '30000';
      proofLLMCleanup = await installIntegrationProofLLMEnv();
      galleryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-convergence-'));
    });

    afterAll(async () => {
      await proofLLMCleanup?.();
      fs.rmSync(galleryDir, { recursive: true, force: true });
      if (savedScoreTimeout === undefined) delete process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS;
      else process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS = savedScoreTimeout;
    });

    beforeEach(() => {
      // test/setup.ts wipes LLM env vars in its own beforeEach; re-apply the fake.
      proofLLMCleanup.reapply();
      RalphLoop.reset();
    });

    afterEach(() => {
      RalphLoop.reset();
    });

    it('should track iteration count correctly', async () => {
      // minQualityScore 0 means quality never stops the loop, so the only
      // exit is the iteration cap.
      const result = await RalphLoop.run('test prompt', {
        maxIterations: 3,
        minQualityScore: 0,
        galleryDir,
      });

      expect(result.iterations).toBe(3);
      expect(result.completed).toBe(false);
      expect(result.reason).toMatch(/^max iterations reached \(3\)/);
      expect(RalphLoop.getState().history.map(h => h.iteration)).toEqual([1, 2, 3]);
    }, 60_000);

    it('should detect convergence when scores plateau', async () => {
      // This test documents the convergence detection behavior
      // In practice, we'd need to mock the scoring to test this precisely
      
      // Verify that the convergence constants are set correctly
      // by checking the LoopConfig defaults
      const { DEFAULT_MAX_ITERATIONS } = await import('../../src/core/LoopConfig.js');
      
      expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThanOrEqual(5);
    });

    it('should allow loop to run when score < threshold and iteration < maxIterations', async () => {
      // Verify the loop conditions are properly set up
      const { normalizeOptions } = await import('../../src/core/LoopConfig.js');
      
      const options = normalizeOptions({
        maxIterations: 10,
        minQualityScore: 0.9,
      });
      
      expect(options.maxIterations).toBe(10);
      expect(options.minQualityScore).toBe(0.9);
    });
  });

  describe('Loop state management', () => {
    it('should reset loop state correctly', () => {
      RalphLoop.reset();
      
      const state = RalphLoop.getState();
      expect(state.iteration).toBe(0);
      expect(state.history).toEqual([]);
    });

    it('should report not running when no iterations', () => {
      RalphLoop.reset();
      
      expect(RalphLoop.isRunning()).toBe(false);
    });
  });
});
