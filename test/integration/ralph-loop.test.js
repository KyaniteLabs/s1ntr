import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, test, vi } from 'vitest';
/**
 * Integration tests for RalphLoop iteration engine
 *
 * Tests the complete Ralph-Wiggum Loop:
 * - Loop terminates on promise detection
 * - Loop terminates on max-iterations
 * - Context correctly passes between iterations
 * - Safety mechanisms work
 * - Integration with all core components
 */

import { RalphLoop } from '../../src/core/RalphLoop.js';
import { PromiseDetector } from '../../src/core/PromiseDetector.js';
import { PromptStore } from '../../src/core/PromptStore.js';
import { ContextAccumulation } from '../../src/core/ContextAccumulation.js';
import { CreativeEvaluator } from '../../src/core/CreativeEvaluator.js';
import { P5Generator } from '../../src/generators/p5/P5Generator.js';
import { Gallery } from '../../src/gallery/Gallery.js';
import fs from 'fs/promises';
import path from 'path';
import { installIntegrationProofLLMEnv } from './helpers/proof-llm-server.js';

vi.setConfig({ testTimeout: 60_000 });

// Provider boundary 1: the LLM is the loopback fake server installed by
// installIntegrationProofLLMEnv() (real HTTP, deterministic bodies).
// Provider boundary 2: the headless browser. The loop only trusts a score when
// it has rendered evidence, so serve a recorded healthy render from a fixture
// instead of launching Chrome. Everything between the two boundaries is real.
const recordedRender = vi.hoisted(() => ({ evidence: null, calls: 0 }));
vi.mock('../../src/render/HeadlessRenderer.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { readFileSync } = await import('node:fs');
  recordedRender.evidence = JSON.parse(
    readFileSync(new URL('../fixtures/ralph-loop/render-evidence.json', import.meta.url), 'utf8'),
  );
  const fake = {
    renderWithEvidence: async () => {
      recordedRender.calls += 1;
      return structuredClone(recordedRender.evidence);
    },
  };
  return { ...actual, HeadlessRenderer: { ...actual.HeadlessRenderer, getInstance: () => fake } };
});

describe('RalphLoop Integration Tests', () => {
  let testGalleryDir;
  let gallery;
  let proofLLMCleanup;

  beforeEach(() => {
    // test/setup.ts deletes every LLM env var in its own beforeEach, which
    // runs before this one. Without re-applying the fake provider here,
    // LLMClient.isConfigured() is false and the loop never reaches it.
    proofLLMCleanup?.reapply();
  });

  let savedScoreTimeout;

  beforeAll(async () => {
    // NODE_ENV=test caps the rendered-evidence judge at 1s, which a cold loopback
    // server can miss; that would degrade the score and stop the loop early.
    savedScoreTimeout = process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS;
    process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS = '30000';
    proofLLMCleanup = await installIntegrationProofLLMEnv();
    // Create a test gallery directory
    testGalleryDir = path.join(process.cwd(), 'test-gallery');
    gallery = new Gallery(testGalleryDir);
  });

  afterAll(async () => {
    await proofLLMCleanup?.();
    if (savedScoreTimeout === undefined) delete process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS;
    else process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS = savedScoreTimeout;
  });

  afterEach(async () => {
    // Clean up test gallery directory after each test
    try {
      await fs.rm(testGalleryDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }
    // Clear context accumulation between tests
    ContextAccumulation.clear();
  });

  describe('Basic Loop Functionality', () => {
    test('should run single iteration', async () => {
      const prompt = 'Generate a simple p5.js sketch';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result?.iterations).toBe(1);

      expect(typeof result.code).toBe('string');
      expect(result.code).toContain('function setup()');
      expect(result.code).toContain('function draw()');
      expect(recordedRender.calls).toBeGreaterThanOrEqual(1);
    });

    test('should run multiple iterations', async () => {
      const prompt = 'Generate a particle system';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      expect(result?.iterations).toBe(3);
      expect(result.code).toContain('function draw()');
      expect(result.reason).toMatch(/^max iterations reached \(3\)/);
    });

    test('should terminate on promise detection', async () => {
      const prompt = 'Generate a sketch and output <promise>COMPLETE</promise> when done';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 20,
        galleryDir: testGalleryDir
      });

      expect(result?.completed).toBe(true);
      expect(result.reason).toBe('promise detected in generated code');
    });

    test('should terminate on max iterations', async () => {
      const prompt = 'Generate a sketch but never complete it';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 5,
        galleryDir: testGalleryDir
      });

      expect(result?.iterations).toBe(5);
      expect(result.completed).toBe(false);
      expect(result.reason).toMatch(/^max iterations reached \(5\)/);
    });
  });

  describe('Context Accumulation', () => {
    test('should pass context between iterations', async () => {
      const prompt = 'Generate and improve a sketch';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      expect(history?.length).toBe(3);

      // Each context entry should have expected structure
      history.forEach((context, index) => {

        expect(context?.iteration).toBe(index + 1);
        expect(context.code).toContain('function setup()');
        expect(new Date(context.timestamp).toISOString()).toBe(context.timestamp);
      });
    });

    test('should include previous code in context', async () => {
      const prompt = 'Iterate on this sketch';

      await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // Second iteration should have access to first iteration's code
      expect(history.length).toBe(2);
      expect(history[0].code).toContain('function setup()');
      expect(history[1].code).toContain('function setup()');

      // The fake provider stamps each response with its request number, so
      // the second iteration's code must differ from the first.
      expect(history[0].code).not.toBe(history[1].code);
    });

    test('should maintain context immutability', async () => {
      const prompt = 'Test context';

      await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      const history1 = ContextAccumulation.getHistory();
      const history2 = ContextAccumulation.getHistory();

      // getHistory should return copies, not references
      expect(history1).not.toBe(history2);
      expect(history1[0]).not.toBe(history2[0]);
    });
  });

  describe('Safety Mechanisms', () => {
    test('should enforce max iterations limit', async () => {
      const prompt = 'Run forever';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 5,
        galleryDir: testGalleryDir
      });

      expect(result.iterations).toBe(5);
      expect(result.reason).toMatch(/^max iterations reached \(5\)/);
    });

    test('should handle empty prompt gracefully', async () => {
      const prompt = '';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result?.iterations).toBe(1);
    });

    test('should handle null/undefined options', async () => {
      const prompt = 'Test';

      // Should not throw with null options
      const result = await RalphLoop.run(prompt, null);

      expect(result.code).toContain('function draw()');
      expect(result.iterations).toBe(20);
      expect(result.reason).toMatch(/^max iterations reached \(20\)/);
    });

    test('should handle generator errors gracefully', async () => {
      const prompt = 'Test error handling';

      // The fake provider answers every request with HTTP 400, a non-retryable
      // provider error.
      proofLLMCleanup.failWith(400);
      let result;
      try {
        result = await RalphLoop.run(prompt, {
          maxIterations: 1,
          galleryDir: testGalleryDir,
          tolerateErrors: true
        });
      } finally {
        proofLLMCleanup.failWith(0);
      }

      expect(result.completed).toBe(false);
      expect(result.iterations).toBe(1);
    });
  });

  describe('Gallery Integration', () => {
    test('should save iterations to gallery', async () => {
      const prompt = 'Save my iterations';
      const projectName = 'test-project';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir,
        project: projectName
      });

      const history = await gallery.loadHistory(projectName);

      expect(history?.length).toBe(3);

      history.forEach((iteration, index) => {
        expect(iteration.version).toBe(index + 1);

        expect(iteration.code).toContain('function setup()');
      });
    });

    test('should create gallery directory structure', async () => {
      const prompt = 'Create directory structure';
      const projectName = 'directory-test';

      await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir,
        project: projectName
      });

      const projectPath = gallery.getProjectPath(projectName);

      // Check directory exists
      const stats = await fs.stat(projectPath);
      expect(stats.isDirectory()).toBe(true);
    });

    test('should handle gallery save failures gracefully', async () => {
      const prompt = 'Handle save failures';

      // Use invalid gallery directory to trigger save error
      const result = await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: '/invalid/path/that/cannot/be/created',
        tolerateErrors: true
      });

      // Should complete iteration even if save fails

      expect(result?.iterations).toBe(1);
    });

    test('should throw error when gallery save fails and tolerateErrors is false', async () => {
      const prompt = 'Throw on save failure';
      const blockingGalleryPath = path.join(testGalleryDir, 'not-a-directory');
      await fs.mkdir(testGalleryDir, { recursive: true });
      await fs.writeFile(blockingGalleryPath, 'blocking file');

      // Use a file where a gallery directory is expected to trigger a deterministic save error.
      await expect(RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: blockingGalleryPath,
        tolerateErrors: false,
        project: 'test-project'
      })).rejects.toThrow();
    });
  });

  describe('Quality Evaluation', () => {
    test('should evaluate each iteration', async () => {
      const prompt = 'Generate quality code';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      expect(result.iterations).toBe(3);

      // Each iteration was scored by the fake judge (0.72-0.895) with full confidence
      const history = ContextAccumulation.getHistory();
      expect(history).toHaveLength(3);
      history.forEach(context => {
        expect(context.evaluation.failureClass).toBe('none');
        expect(context.evaluation.confidence).toBeGreaterThan(0.5);
        expect(context.evaluation.score).toBeGreaterThanOrEqual(0.7);
        expect(context.evaluation.score).toBeLessThanOrEqual(0.9);
      });
    });

    test('should track quality improvement', async () => {
      const prompt = 'Improve quality over iterations';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 5,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // Quality scores should be tracked
      const scores = history.map(h => h.evaluation.score);

      expect(scores?.length).toBe(5);

      // All scores should be valid
      scores.forEach(score => {
        expect(score).toBeGreaterThanOrEqual(0.7);
        expect(score).toBeLessThanOrEqual(0.9);
      });
    });
  });

  describe('Quality gate', () => {
    test('should break loop when score below minQualityScore', async () => {
      RalphLoop.reset();
      // Mock evaluator to return low score so loop exits on quality gate
      const origAssess = CreativeEvaluator.assess;
      CreativeEvaluator.assess = () => ({
        score: 0.5,
        passed: false,
        issues: ['low quality'],
        technicalScore: 0.5,
        creativeScore: 0.5,
        metrics: {}
      });
      try {
        const result = await RalphLoop.run('generate bad code', {
          maxIterations: 5,
          galleryDir: testGalleryDir,
          minQualityScore: 1.0
        });
        expect(result.reason).toContain('quality threshold');
        expect(result.iterations).toBe(2);
      } finally {
        CreativeEvaluator.assess = origAssess;
      }
    });
  });

  describe('Promise Detection', () => {
    test('should detect exact promise string', async () => {
      const prompt = 'Complete this task <promise>COMPLETE</promise>';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 10,
        galleryDir: testGalleryDir
      });

      expect(result.completed).toBe(true);
      expect(result.reason).toContain('promise');
    });

    test('should not detect partial promise matches', async () => {
      const prompt = 'Almost complete but not quite promise COMPLETE almost';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      // Should hit max iterations, not promise detection
      expect(result.iterations).toBe(2);
      expect(result.completed).toBe(false);
    });

    test('should require exact formatting', async () => {
      const prompt = 'complete with wrong format PROMISE COMPLETE';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      // Should not detect incorrectly formatted promise
      expect(result.iterations).toBe(2);
      expect(result.completed).toBe(false);
    });
  });

  describe('Prompt Consistency', () => {
    test('should use same prompt every iteration', async () => {
      const prompt = 'Use this exact prompt every time';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // All iterations should have the same original prompt
      history.forEach(context => {
        expect(context.prompt).toBe(prompt);
      });
    });

    test('should inject context into prompt', async () => {
      const prompt = 'Generate {{context}}';

      await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // Context should be injected
      expect(history.length).toBe(2);

      // usedPrompt should contain the injected context, not the placeholder
      expect(history[0].usedPrompt).not.toContain('{{context}}');
      expect(history[0].usedPrompt).toContain('Iteration: 1');

      // Original prompt should be preserved
      expect(history[0].prompt).toBe(prompt);
    });
  });

  describe('Result Object', () => {
    test('should return comprehensive result object', async () => {
      const prompt = 'Generate comprehensive result';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir,
        project: 'result-test'
      });

      expect(result).toMatchObject({
        code: expect.any(String),
        iterations: 3,
        completed: expect.any(Boolean),
        reason: expect.any(String),
        timestamp: expect.any(String),
        finalScore: expect.any(Number)
      });
    });

    test('should include final code in result', async () => {
      const prompt = 'Return final code';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      expect(result.code).toContain('function draw()');

      // Final code should be valid JavaScript
      expect(() => {
        // Should not throw syntax error
        Function(result.code);
      }).not.toThrow();
    });

    test('should track completion time', async () => {
      const prompt = 'Track time';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThan(0);
      expect(result.duration).toBeLessThan(60_000);
    });
  });

  describe('Edge Cases', () => {
    test('should handle very long prompts', async () => {
      const longPrompt = 'A'.repeat(10000);

      const result = await RalphLoop.run(longPrompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result?.iterations).toBe(1);
    });

    test('should handle unicode in prompts', async () => {
      const unicodePrompt = 'Generate art with emoji 🎨 and unicode café';

      const result = await RalphLoop.run(unicodePrompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result?.iterations).toBe(1);
    });

    test('should handle special characters in project name', async () => {
      const prompt = 'Test special chars';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir,
        project: 'test-project-123'
      });

      expect(result.iterations).toBe(1);
      expect(await gallery.loadHistory('test-project-123')).toHaveLength(1);
    });

    test('should handle concurrent loop executions', async () => {
      const prompt = 'Concurrent test';

      // Run multiple loops concurrently
      const results = await Promise.all([
        RalphLoop.run(prompt, { maxIterations: 1, galleryDir: testGalleryDir, project: 'concurrent-1' }),
        RalphLoop.run(prompt, { maxIterations: 1, galleryDir: testGalleryDir, project: 'concurrent-2' }),
        RalphLoop.run(prompt, { maxIterations: 1, galleryDir: testGalleryDir, project: 'concurrent-3' })
      ]);

      expect(results).toHaveLength(3);
      results.forEach(result => {

        expect(result?.iterations).toBe(1);
      });
    });
  });

  describe('Utility Methods', () => {
    afterEach(() => {
      ContextAccumulation.clear();
    });

    test('getState should return current loop state', async () => {
      const prompt = 'Test getState';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      const state = RalphLoop.getState();

      expect(state?.iteration).toBe(3);

      expect(state.history?.length).toBe(3);
    });

    test('getState should return empty state when no loop run', () => {
      const state = RalphLoop.getState();

      expect(state?.iteration).toBe(0);
      expect(state.history).toEqual([]);
    });

    test('reset should clear loop state', async () => {
      const prompt = 'Test reset';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      expect(RalphLoop.getState().iteration).toBe(3);

      RalphLoop.reset();

      expect(RalphLoop.getState().iteration).toBe(0);
      expect(RalphLoop.getState().history).toEqual([]);
    });

    test('isRunning should return true when loop has run', async () => {
      const prompt = 'Test isRunning';

      expect(RalphLoop.isRunning()).toBe(false);

      await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(RalphLoop.isRunning()).toBe(true);
    });

    test('isRunning should return false when no loop has run', () => {
      expect(RalphLoop.isRunning()).toBe(false);
    });

    test('getProgress should return null when no loop running', () => {
      const progress = RalphLoop.getProgress();
      expect(progress).toBeNull();
    });

    test('getProgress should return progress when loop is running', async () => {
      const prompt = 'Test getProgress';

      await RalphLoop.run(prompt, {
        maxIterations: 5,
        galleryDir: testGalleryDir
      });

      const progress = RalphLoop.getProgress();

      expect(progress?.iteration).toBe(5);
      expect(progress.maxIterations).toBe(5);
      expect(progress.progress).toBe(1); // 5/5 = 1 (complete)
    });

    test('getProgress should calculate progress correctly', async () => {
      const prompt = 'Test progress calculation';
      const maxIter = 10;

      await RalphLoop.run(prompt, {
        maxIterations: maxIter,
        galleryDir: testGalleryDir,
        _disableIterationExtension: true
      });

      const progress = RalphLoop.getProgress();

      expect(progress?.iteration).toBe(maxIter);
      expect(progress.maxIterations).toBe(maxIter);
      expect(progress.progress).toBe(1);
    });
  });
});
