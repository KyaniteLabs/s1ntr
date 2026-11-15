/**
 * Fix 8: Consolidate Triple Redundancy - Verification Tests
 *
 * Contract checks for the consolidated collaboration, scoring, and memory
 * entry points and the absence of deprecated direct import paths.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { CollaborationEngine } from '../../src/collab/CollaborationEngine.js';
import { ScoringEngine } from '../../src/core/ScoringEngine.js';
import { harnessMemory, HarnessMemory } from '../../src/harness/HarnessMemory.js';

const legacyEntryExists = (module: string): boolean => ['ts', 'js'].some(extension =>
  existsSync(new URL(`../../src/${module}.${extension}`, import.meta.url)));

describe('Consolidated collaboration, scoring, and memory contracts', () => {
  describe('Collaboration entry point', () => {
    it('exposes the CollaborationEngine run interface', () => {
      const engine = new CollaborationEngine({
        callLLM: async (prompt: string) => `Response: ${prompt}`,
      });
      expect(typeof engine.run).toBe('function');
    });

    it('should not have deprecated DeepCollaboration module', () => {
      expect(legacyEntryExists('collab/DeepCollaboration')).toBe(false);
    });

    it('should not have deprecated CollaborativeClient module', () => {
      expect(legacyEntryExists('collab/CollaborativeClient')).toBe(false);
    });

    it('runs hybrid collaboration through the swarm interface', async () => {
      const output = 'function setup(){createCanvas(200,200);} function draw(){background(20);circle(frameCount,100,20);}';
      const engine = new CollaborationEngine({
        callLLM: () => Promise.resolve(output),
        swarmConfig: { mode: 'hybrid', maxRounds: 1, skipRouting: true, musicalChairs: false },
      });
      const result = await engine.run('Draw a moving circle');
      expect(result).toMatchObject({ mode: 'swarm', output });
      expect(result.raw).toMatchObject({ mode: 'hybrid', finalOutput: output });
      expect(result.raw.rounds).toHaveLength(1);
    });
  });

  describe('Scoring plugin contracts', () => {
    let scoringEngine: ScoringEngine;

    beforeEach(() => {
      scoringEngine = new ScoringEngine('comprehensive');
    });

    it('exposes the ScoringEngine plugin API', () => {
      expect(typeof scoringEngine.score).toBe('function');
      expect(typeof scoringEngine.register).toBe('function');
    });

    it('should accept plugin strategies', () => {
      const customStrategy = {
        name: 'custom-test-strategy',
        score: () => ({
          score: 0.5,
          dimensions: { technical: 0.5, creative: 0.5 },
          strategy: 'custom-test-strategy',
        }),
      };

      scoringEngine.register(customStrategy);
      expect(scoringEngine.hasStrategy('custom-test-strategy')).toBe(true);
    });

    it('should have built-in strategies including creative and aesthetic', () => {
      const strategies = scoringEngine.listStrategies();
      
      // Core strategies
      expect(strategies).toContain('comprehensive');
      expect(strategies).toContain('fast');
      expect(strategies).toContain('keyword');
      expect(strategies).toContain('fitness');
      
      // Consolidated strategies
      expect(strategies).toContain('creative');
      expect(strategies).toContain('aesthetic');
    });

    it('should support creative scoring strategy', async () => {
      const code = `
        function setup() {
          createCanvas(400, 400);
        }
        function draw() {
          background(220);
          ellipse(200, 200, 100);
        }
      `;
      
      const result = await scoringEngine.score({ output: code }, 'creative');
      expect(result.strategy).toBe('creative');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.dimensions.creative).toBeGreaterThanOrEqual(0);
      expect(result.dimensions.creative).toBeLessThanOrEqual(1);
    });

    it('should support aesthetic scoring strategy', async () => {
      const code = `
        function setup() {
          createCanvas(400, 400);
        }
        function draw() {
          background(255);
          fill(100, 150, 200);
          noStroke();
          ellipse(200, 200, 100);
        }
      `;
      
      const result = await scoringEngine.score({ output: code }, 'aesthetic');
      expect(result.strategy).toBe('aesthetic');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.dimensions.aesthetic).toBeGreaterThanOrEqual(0);
      expect(result.dimensions.aesthetic).toBeLessThanOrEqual(1);
    });

    it('should allow unregistering strategies', () => {
      const customStrategy = {
        name: 'temporary-strategy',
        score: () => ({ score: 0.5, dimensions: {}, strategy: 'temporary-strategy' }),
      };

      scoringEngine.register(customStrategy);
      expect(scoringEngine.hasStrategy('temporary-strategy')).toBe(true);
      
      scoringEngine.unregister('temporary-strategy');
      expect(scoringEngine.hasStrategy('temporary-strategy')).toBe(false);
    });
  });

  describe('HarnessMemory API', () => {
    it('exports the consolidated HarnessMemory instance', () => {
      expect(harnessMemory).toBeInstanceOf(HarnessMemory);
    });

    it('should record and retrieve episodes', () => {
      const episodeId = harnessMemory.recordEpisode({
        type: 'generation',
        prompt: 'Test prompt',
        code: 'Test code',
        domain: 'p5',
        score: 0.8,
        tags: ['test', 'particle'],
      });

      expect(typeof episodeId).toBe('string');

      const episodes = harnessMemory.getRecentEpisodes(10);
      expect(episodes).toEqual(expect.arrayContaining([expect.objectContaining({
        id: episodeId, prompt: 'Test prompt', domain: 'p5', score: 0.8,
      })]));
    });

    it('should filter episodes by domain', () => {
      // Record episodes in different domains
      harnessMemory.recordEpisode({
        type: 'generation',
        prompt: 'p5 test',
        domain: 'p5',
        tags: ['test'],
      });
      
      harnessMemory.recordEpisode({
        type: 'generation',
        prompt: 'shader test',
        domain: 'shader',
        tags: ['test'],
      });

      const p5Episodes = harnessMemory.getEpisodesByDomain('p5');
      expect(p5Episodes.some(ep => ep.domain === 'p5')).toBe(true);
    });

    it('should track tasks', () => {
      const taskId = harnessMemory.startTask({
        type: 'M8',
        description: 'Test task',
      });

      expect(typeof taskId).toBe('string');

      const tasks = harnessMemory.getTasks();
      expect(tasks.some(t => t.id === taskId)).toBe(true);
    });

    it('should record adaptations', () => {
      const adaptationId = harnessMemory.recordAdaptation({
        patternName: 'test-pattern',
        patternSeverity: 'low',
        fixType: 'code',
        description: 'Test adaptation',
        success: true,
      });

      expect(typeof adaptationId).toBe('string');

      const adaptations = harnessMemory.getAdaptations();
      expect(adaptations.some(a => a.id === adaptationId)).toBe(true);
    });

    it('should provide memory status', () => {
      const status = harnessMemory.getStatus();
      
      expect(status.initialized).toBe(true);
      expect(typeof status.tasksTotal).toBe('number');
      expect(typeof status.episodesTotal).toBe('number');
      expect(typeof status.adaptationsTotal).toBe('number');
      expect(typeof status.patternsTracked).toBe('number');
    });
  });

  describe('Deprecated direct import paths', () => {
    it('keeps the archived EpisodicMemory out of the direct brain import path', () => {
      expect(legacyEntryExists('brain/EpisodicMemory')).toBe(false);
    });

    it('keeps the archived SemanticArtMemory out of the direct brain import path', () => {
      expect(legacyEntryExists('brain/SemanticArtMemory')).toBe(false);
    });

    it('exposes HarnessMemory initialization, persistence, and episode lookup', () => {
      expect(typeof harnessMemory.initialize).toBe('function');
      expect(typeof harnessMemory.save).toBe('function');
      expect(typeof harnessMemory.getRelevantEpisodes).toBe('function');
    });
  });
});
