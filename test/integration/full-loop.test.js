import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, test, vi } from 'vitest';
/**
 * Full-Loop Integration Tests for RalphLoop
 *
 * End-to-end tests that verify the complete Ralph-Wiggum Loop:
 * - Real p5.js code generation
 * - Iteration accumulation and context passing
 * - Promise detection and termination
 * - Gallery persistence
 * - Quality evaluation
 * - Complete workflow from start to finish
 */

const { onGenerationCompleteMock } = vi.hoisted(() => ({
  onGenerationCompleteMock: vi.fn(async () => {})
}));

// Provider boundary 2: the headless browser. Serve a recorded healthy render
// (see test/fixtures/ralph-loop) instead of launching Chrome.
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

vi.mock('../../src/harness/MetaHarnessIntegration.js', () => ({
  metaHarness: { onGenerationComplete: onGenerationCompleteMock }
}));

import { RalphLoop } from '../../src/core/RalphLoop.js';
import { run } from '../../src/index.js';
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

describe('Full-Loop Integration Tests', () => {
  let testGalleryDir;
  let gallery;
  let proofLLMCleanup;
  let savedScoreTimeout;

  beforeEach(() => {
    // test/setup.ts wipes every LLM env var in its own beforeEach; re-apply the
    // fake provider so LLMClient.isConfigured() is true when the loop runs.
    proofLLMCleanup?.reapply();
  });

  beforeAll(async () => {
    // NODE_ENV=test caps the rendered-evidence judge at 1s, which would degrade scores.
    savedScoreTimeout = process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS;
    process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS = '30000';
    proofLLMCleanup = await installIntegrationProofLLMEnv();
    testGalleryDir = path.join(process.cwd(), 'test-full-loop-gallery');
    gallery = new Gallery(testGalleryDir);
  });

  afterAll(async () => {
    await proofLLMCleanup?.();
    if (savedScoreTimeout === undefined) delete process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS;
    else process.env.LIMINAL_RENDERED_SCORE_TIMEOUT_MS = savedScoreTimeout;
  });

  afterEach(async () => {
    try {
      await fs.rm(testGalleryDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }
    ContextAccumulation.clear();
    RalphLoop.reset();
  });

  describe('Complete Loop Workflow', () => {
    test('should run complete loop with real p5.js generation', async () => {
      const prompt = 'Create a simple p5.js sketch with a circle that changes color';
      const projectName = 'complete-loop-test';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir,
        project: projectName
      });

      // Verify basic result structure

      expect(result.code).toContain('function setup');
      expect(result?.iterations).toBe(3);
      expect(result.completed).toBe(false); // Max iterations, no promise
      expect(result.reason).toContain('max iterations');
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.duration).toBeGreaterThan(0);
      expect(result.finalScore).toBeGreaterThanOrEqual(0);
      expect(result.finalScore).toBeLessThanOrEqual(1);

      // Verify generated code is valid p5.js
      expect(result.code).toContain('function setup');
      expect(result.code).toContain('function draw');
      expect(result.code).toContain('createCanvas');
    });
    test('should report an incomplete loop truthfully to the meta-harness', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const loopReason = 'Stopped after reaching the configured iteration limit';
      process.env.NODE_ENV = 'not-test';
      onGenerationCompleteMock.mockClear();

      vi.spyOn(RalphLoop, 'run').mockResolvedValue({
        code: 'function setup() { createCanvas(100, 100); background(0); }\nfunction draw() { fill(255); circle(width / 2, height / 2, 40); }',
        iterations: 1,
        completed: false,
        reason: loopReason,
        timestamp: new Date().toISOString(),
        duration: 1,
        finalScore: 0.5,
        project: 'completion-honesty-test',
        model: 'test-model'
      });

      try {
        await run('Exercise incomplete completion wiring', {
          maxIterations: 1,
          output: path.join(testGalleryDir, 'output'),
          galleryDir: path.join(testGalleryDir, 'gallery'),
          project: 'completion-honesty-test'
        });

        expect(onGenerationCompleteMock).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: loopReason
        }));
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        vi.restoreAllMocks();
        onGenerationCompleteMock.mockClear();
      }
    });

    test('should run complete loop and terminate on COMPLETE promise', async () => {
      const prompt = 'Create a p5.js sketch and include <promise>COMPLETE</promise> when finished';
      const projectName = 'promise-termination-test';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 10,
        galleryDir: testGalleryDir,
        project: projectName
      });

      // Verify promise-based termination

      expect(result?.completed).toBe(true);
      expect(result.reason).toContain('promise');
      expect(result.iterations).toBe(1);
      expect(result.code).toContain('<promise>COMPLETE</promise>');

      // Verify generated code is valid
      expect(result.code).toContain('function setup');
      expect(result.code).toContain('function draw');
    });

    test('should verify iterations accumulate in context', async () => {
      const prompt = 'Create and improve a p5.js particle system';
      const projectName = 'context-accumulation-test';

      const initialHistory = ContextAccumulation.getHistory();
      expect(initialHistory.length).toBe(0);

      await RalphLoop.run(prompt, {
        maxIterations: 5,
        galleryDir: testGalleryDir,
        project: projectName
      });

      const finalHistory = ContextAccumulation.getHistory();

      // Verify iterations accumulated
      expect(finalHistory.length).toBe(5);

      // Verify each iteration has proper structure
      finalHistory.forEach((context, index) => {
        expect(context.iteration).toBe(index + 1);
        expect(context.prompt).toBe(prompt);
        expect(context.usedPrompt).toContain(prompt);

        expect(context.code?.length).toBeGreaterThan(0);
        expect(typeof context.evaluation.score).toBe('number');
        expect(context.evaluation.score).toBeGreaterThanOrEqual(0);
        expect(context.evaluation.score).toBeLessThanOrEqual(1);
        expect(context.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(context.maxIterations).toBe(5);
      });

      // Code evolution: when LLM is used we expect variation; when template is used (no LLM), same code each time
      const codes = finalHistory.map(h => h.code);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBeGreaterThan(1);
      // when not configured, template returns same code so we only assert structure above
    });

    test('should save all iterations to gallery', async () => {
      const prompt = 'Create a p5.js animated sketch';
      const projectName = 'gallery-persistence-test';

      await RalphLoop.run(prompt, {
        maxIterations: 4,
        galleryDir: testGalleryDir,
        project: projectName
      });

      // Verify gallery saved iterations
      const history = await gallery.loadHistory(projectName);

      expect(history?.length).toBe(4);

      // Verify each saved iteration
      history.forEach((iteration, index) => {
        expect(iteration.version).toBe(index + 1);

        expect(iteration.code?.length).toBeGreaterThan(0);
        expect(iteration.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      // Verify gallery directory structure
      const projectPath = gallery.getProjectPath(projectName);
      const stats = await fs.stat(projectPath);
      expect(stats.isDirectory()).toBe(true);

      // Verify individual iteration files exist
      for (let i = 1; i <= 4; i++) {
        const iterationPath = path.join(projectPath, `v${i}.js`);
        const fileExists = await fs.access(iterationPath).then(() => true).catch(() => false);
        expect(fileExists).toBe(true);
      }
    });

    test('should evaluate quality of each iteration', async () => {
      const prompt = 'Create a high-quality p5.js sketch';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // Verify each iteration was evaluated
      expect(history.length).toBe(3);
      history.forEach(context => {
        expect(typeof context.evaluation.score).toBe('number');
        expect(context.evaluation.score).toBeGreaterThanOrEqual(0);
        expect(context.evaluation.score).toBeLessThanOrEqual(1);

        // Check for issues array
                expect(Array.isArray(context.evaluation.issues)).toBe(true);
      });

      // RalphLoop returns the best valid candidate (code and score), not the last one
      const bestScore = Math.max(...history.map(h => h.evaluation.score));
      expect(result.finalScore).toBe(bestScore);
    });
  });

  describe('Real p5.js Code Generation', () => {
    test('should generate valid p5.js setup function', async () => {
      const prompt = 'Create a p5.js sketch with setup()';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result.code).toContain('function setup');
      expect(result.code).toContain('createCanvas');
      expect(result.code).toContain('background');
    });

    test('should generate valid p5.js draw function', async () => {
      const prompt = 'Create a p5.js sketch with draw()';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result.code).toContain('function draw');
      expect(result.code).toMatch(/draw\s*\(\s*\)/);
    });

    test('should generate p5.js sketches with proper syntax', async () => {
      const prompt = 'Create a syntactically correct p5.js sketch';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      // Test that generated code is valid JavaScript
      expect(() => {
        // Should not throw syntax errors
        Function(result.code);
      }).not.toThrow();

      // Test for balanced brackets and parentheses
      const openBraces = (result.code.match(/\{/g) || []).length;
      const closeBraces = (result.code.match(/\}/g) || []).length;
      expect(openBraces).toBe(closeBraces);

      const openParens = (result.code.match(/\(/g) || []).length;
      const closeParens = (result.code.match(/\)/g) || []).length;
      expect(openParens).toBe(closeParens);
    });

    test('should generate different code on each iteration', async () => {
      const prompt = 'Create a p5.js sketch';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();
      const codes = history.map(h => h.code);

      // All codes should be defined
      codes.forEach(code => {

        expect(code?.length).toBeGreaterThan(0);
      });

      // When LLM is configured we expect variation; when template fallback is used, same code each time
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBeGreaterThan(1);
    });

    test('should include p5.js specific functions and methods', async () => {
      const prompt = 'Create a p5.js sketch with various p5.js methods';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      // Look for common p5.js functions/methods
      const p5Functions = [
        'createCanvas', 'background', 'fill', 'stroke', 'rect',
        'ellipse', 'line', 'point', 'triangle', 'quad'
      ];

      const foundFunctions = p5Functions.filter(func => result.code.includes(func));
      expect(foundFunctions.length).toBeGreaterThan(0);
    });
  });

  describe('Context Injection and Evolution', () => {
    test('should inject context into prompt when placeholder exists', async () => {
      const prompt = 'Create {{context}}'; // Contains context placeholder

      await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // First iteration should have context injected
      expect(history[0].usedPrompt).not.toContain('{{context}}');
      expect(history[0].usedPrompt.toLowerCase()).toContain('iteration');

      // Original prompt should be preserved
      expect(history[0].prompt).toBe(prompt);

      // Second iteration should have more context
      expect(history[1].usedPrompt.toLowerCase()).toContain('iteration');
      expect(history[1].usedPrompt).toContain('Previous iterations');
    });

    test('should build proper context for injection', async () => {
      const prompt = 'Improve based on context {{context}}';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // Second iteration should reference first
      expect(history[1].usedPrompt).toContain('Previous iterations: 1');
      expect(history[1].usedPrompt).toContain('Last iteration (1)');

      // Third iteration should reference previous
      expect(history[2].usedPrompt).toContain('Previous iterations: 2');
      expect(history[2].usedPrompt).toContain('Last iteration (2)');

      // Context should include quality trends
      expect(history[2].usedPrompt).toContain('Quality trend');
    });

    test('should maintain prompt consistency across iterations', async () => {
      const prompt = 'Use this exact same prompt every iteration';

      await RalphLoop.run(prompt, {
        maxIterations: 4,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // All iterations should have the same original prompt
      history.forEach(context => {
        expect(context.prompt).toBe(prompt);
      });
    });
  });

  describe('Safety Mechanisms', () => {
    test('should enforce max iterations hard limit', async () => {
      const prompt = 'Keep generating forever';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 5,
        galleryDir: testGalleryDir
      });

      expect(result.iterations).toBe(5); // Should hit max
      expect(result.completed).toBe(false);
      expect(result.reason).toContain('max iterations');
    });

    test('should handle generator failures gracefully', async () => {
      const prompt = ''; // Empty prompt that might cause issues

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir,
        tolerateErrors: true
      });

      expect(result.iterations).toBe(2);
    });

    test('should maintain state immutability', async () => {
      const prompt = 'Test immutability';

      await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

      const history1 = ContextAccumulation.getHistory();
      const history2 = ContextAccumulation.getHistory();

      // Should return copies, not same references
      expect(history1).not.toBe(history2);
      expect(history1[0]).not.toBe(history2[0]);

      // But content should be the same
      expect(history1[0].code).toBe(history2[0].code);
    });
  });

  describe('Promise Detection Integration', () => {
    test('should terminate immediately on COMPLETE promise', async () => {
      const prompt = 'Generate and finish with <promise>COMPLETE</promise>';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 20, // High limit
        galleryDir: testGalleryDir
      });

      expect(result.completed).toBe(true);
      expect(result.reason).toContain('promise');
      expect(result.code).toContain('<promise>COMPLETE</promise>');
      expect(result.iterations).toBe(1);
    });

    test('should not terminate on partial promise matches', async () => {
      const prompt = 'Generate code but do not include the exact promise format';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      expect(result.completed).toBe(false);
      expect(result.iterations).toBe(3);
      expect(result.reason).toContain('max iterations');
    });

    test('should preserve promise in final output', async () => {
      const prompt = 'Create sketch and complete with <promise>COMPLETE</promise>';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 10,
        galleryDir: testGalleryDir
      });

      expect(result.code).toContain('<promise>COMPLETE</promise>');

      // Promise should be in the generated code, not just metadata
      expect(result.code.length).toBeGreaterThan('<promise>COMPLETE</promise>'.length);
    });
  });

  describe('Gallery Integration', () => {
    test('should save complete iteration history to gallery', async () => {
      const prompt = 'Create a complex p5.js animation';
      const projectName = 'complete-history-test';

      await RalphLoop.run(prompt, {
        maxIterations: 6,
        galleryDir: testGalleryDir,
        project: projectName
      });

      // Verify gallery has complete history
      const history = await gallery.loadHistory(projectName);

      expect(history?.length).toBe(6);

      // Verify version sequence
      history.forEach((iteration, index) => {
        expect(iteration.version).toBe(index + 1);
      });

      // Verify timestamps are sequential
      const timestamps = history.map(h => new Date(h.timestamp).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });

    test('should create proper directory structure', async () => {
      const prompt = 'Test directory structure';
      const projectName = 'directory-structure-test';

      await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir,
        project: projectName
      });

      // Check that gallery directory was created
      const galleryExists = await fs.access(testGalleryDir).then(() => true).catch(() => false);
      expect(galleryExists).toBe(true);

      // Check that project directory was created using Gallery's getProjectPath
      const projectPath = gallery.getProjectPath(projectName);
      const projectExists = await fs.access(projectPath).then(() => true).catch(() => false);
      expect(projectExists).toBe(true);

      // Check that individual iteration files exist
      const v1Path = path.join(projectPath, 'v1.js');
      const v2Path = path.join(projectPath, 'v2.js');

      expect(await fs.access(v1Path).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(v2Path).then(() => true).catch(() => false)).toBe(true);
    });

    test('should save valid JavaScript to gallery files', async () => {
      const prompt = 'Create valid p5.js code';
      const projectName = 'valid-code-test';

      await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir,
        project: projectName
      });

      const history = await gallery.loadHistory(projectName);

      // Verify each saved file contains valid JavaScript
      history.forEach(iteration => {
        expect(() => {
          Function(iteration.code);
        }).not.toThrow();
      });
    });
  });

  describe('Result Object Completeness', () => {
    test('should return comprehensive result object', async () => {
      const prompt = 'Create a comprehensive test result';
      const projectName = 'result-completeness-test';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir,
        project: projectName
      });

      // Verify all expected fields exist
      expect(result).toMatchObject({
        code: expect.any(String),
        iterations: 3,
        completed: expect.any(Boolean),
        reason: expect.any(String),
        timestamp: expect.any(String),
        duration: expect.any(Number),
        finalScore: expect.any(Number),
        project: projectName
      });

      // Verify data types and constraints
      expect(typeof result.code).toBe('string');
      expect(typeof result.iterations).toBe('number');
      expect(result.completed === true || result.completed === false).toBe(true);
      expect(typeof result.reason).toBe('string');
      expect(typeof result.timestamp).toBe('string');
      expect(typeof result.duration).toBe('number');
      expect(typeof result.finalScore).toBe('number');

      // Verify constraints
      expect(result.code.length).toBeGreaterThan(0);
      expect(result.iterations).toBe(3);
      expect(result.duration).toBeGreaterThanOrEqual(0); // Changed from > to >= since duration could be 0
      expect(result.finalScore).toBeGreaterThanOrEqual(0);
      expect(result.finalScore).toBeLessThanOrEqual(1);
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    test('should track execution duration accurately', async () => {
      const prompt = 'Test duration tracking';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 2,
        galleryDir: testGalleryDir
      });

            expect(result.duration).toBeGreaterThanOrEqual(0);

      // Duration should be reasonable - just check it's not excessively long
      expect(result.duration).toBeLessThan(60000); // Less than 1 minute
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle very long prompts', async () => {
      const longPrompt = 'Create a p5.js sketch '.repeat(1000);

      const result = await RalphLoop.run(longPrompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result?.iterations).toBe(1);
      expect(result.code).toContain('function setup');
    });

    test('should handle unicode in prompts', async () => {
      const unicodePrompt = 'Create p5.js art with emoji 🎨 and café and 中文';

      const result = await RalphLoop.run(unicodePrompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir
      });

      expect(result.iterations).toBe(1);
      expect(result.code).toContain('function setup');
    });

    test('should handle special characters in project names', async () => {
      const prompt = 'Test special characters';
      const projectName = 'test-project-123_abc';

      const result = await RalphLoop.run(prompt, {
        maxIterations: 1,
        galleryDir: testGalleryDir,
        project: projectName
      });

      expect(result?.project).toBe(projectName);
    });

    test('should handle concurrent loop executions', async () => {
      const prompt = 'Concurrent execution test';

      // Run multiple loops concurrently with different projects
      const results = await Promise.all([
        RalphLoop.run(prompt, { maxIterations: 1, galleryDir: testGalleryDir, project: 'concurrent-1' }),
        RalphLoop.run(prompt, { maxIterations: 1, galleryDir: testGalleryDir, project: 'concurrent-2' }),
        RalphLoop.run(prompt, { maxIterations: 1, galleryDir: testGalleryDir, project: 'concurrent-3' })
      ]);

      expect(results).toHaveLength(3);
      results.forEach(result => {

        expect(result?.iterations).toBe(1);
      });

      // Verify each project saved correctly
      const history1 = await gallery.loadHistory('concurrent-1');
      const history2 = await gallery.loadHistory('concurrent-2');
      const history3 = await gallery.loadHistory('concurrent-3');

      expect(history1.length).toBe(1);
      expect(history2.length).toBe(1);
      expect(history3.length).toBe(1);
    });
  });

  describe('Quality Evolution Tracking', () => {
    test('should track quality scores across iterations', async () => {
      const prompt = 'Improve quality over iterations';

      await RalphLoop.run(prompt, {
        maxIterations: 4,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();
      const scores = history.map(h => h.evaluation.score);

      // Verify we have scores for all iterations
      expect(scores).toHaveLength(4);
      scores.forEach(score => {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      });
    });

    test('should calculate quality trends in context', async () => {
      const prompt = 'Show quality trends {{context}}';

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      const history = ContextAccumulation.getHistory();

      // Later iterations should include quality trend information
      expect(history[2].usedPrompt).toContain('Quality trend');
      expect(history[2].usedPrompt).toContain('Average score');
      expect(history[2].usedPrompt).toContain('Trend:');
    });
  });

  describe('RalphLoop State Management', () => {
    test('should maintain accurate state information', async () => {
      const prompt = 'Test state management';

      // Before running
      expect(RalphLoop.getState().iteration).toBe(0);
      expect(RalphLoop.isRunning()).toBe(false);

      await RalphLoop.run(prompt, {
        maxIterations: 3,
        galleryDir: testGalleryDir
      });

      // After running
      expect(RalphLoop.getState().iteration).toBe(3);
      expect(RalphLoop.isRunning()).toBe(true);
      expect(RalphLoop.getState().history.length).toBe(3);

      // After reset
      RalphLoop.reset();
      expect(RalphLoop.getState().iteration).toBe(0);
      expect(RalphLoop.isRunning()).toBe(false);
    });

    test('should provide accurate progress information', async () => {
      const prompt = 'Test progress tracking';

      await RalphLoop.run(prompt, {
        maxIterations: 5,
        galleryDir: testGalleryDir
      });

      const progress = RalphLoop.getProgress();
            expect(progress.iteration).toBe(5);
      expect(progress.maxIterations).toBe(5);
      expect(progress.progress).toBe(1); // 5/5 = 1.0
    });
  });
});
