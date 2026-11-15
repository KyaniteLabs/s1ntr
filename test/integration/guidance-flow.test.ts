/**
 * Integration tests for Guidance flow in chat sessions
 *
 * Exercises conversation callback wiring with a no-spend loop fixture and
 * tests GuidanceEngine suggestion data directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationManager } from '../../src/chat/ConversationManager.js';
import { SemanticArtMemory } from '../../src/brain/archive/SemanticArtMemory.js';
import type { CreativeBrief, Suggestion } from '../../src/chat/types.js';
import { RalphLoop } from '../../src/core/RalphLoop.js';
import { GuidanceEngine } from '../../src/chat/GuidanceEngine.js';
import type { CompostMill } from '../../src/compost/CompostMill.js';

vi.mock('../../src/core/RalphLoop.js', () => ({ RalphLoop: { run: vi.fn() } }));
const loopResult = { code: '// fixture', iterations: 1, completed: true,
  reason: 'done', timestamp: '2026-01-01T00:00:00.000Z', duration: 0, finalScore: 0.7 };
const brief: CreativeBrief = { intent: 'create something abstract', context: 'test',
  mood: 'calm', constraints: [], references: [], domain: 'p5', techniques: [],
  complexity: 'simple' };

// Mock CompostMill for testing
const createMockCompostMill = (seedCount: number = 0): Partial<CompostMill> => ({
  getSeedCount: async () => seedCount,
  getTopSeeds: async (n: number) => Array(Math.min(n, seedCount)).fill(null).map((_, i) => ({
    id: `seed-${i}`,
    content: `Mock seed content ${i}`,
    score: 0.8 - i * 0.1,
    source: { fragments: [`frag-${i}`], collisionType: 'heuristic', domains: ['p5'] },
    promotedAt: new Date().toISOString(),
    usedBy: [],
    useCount: 0,
  })),
});

describe('Guidance Flow Integration', () => {
  let conversationManager: ConversationManager;
  let artBrain: SemanticArtMemory;
  let guidance: GuidanceEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(RalphLoop.run).mockResolvedValue(loopResult);
    artBrain = new SemanticArtMemory();
    guidance = new GuidanceEngine(artBrain);
    conversationManager = new ConversationManager(artBrain);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe('ConversationManager initialization', () => {
    it('creates GuidanceEngine instance on initialization', () => {
      expect(conversationManager.guidance).toBeInstanceOf(GuidanceEngine);
    });

    it('creates SemanticArtMemory instance if not provided', () => {
      const managerWithoutArtBrain = new ConversationManager();
      expect(managerWithoutArtBrain.artBrain).toBeInstanceOf(SemanticArtMemory);
    });
  });

  describe('Suggestion emission during generation', () => {
    it('records suggestions in conversation history', async () => {
      const brief: CreativeBrief = {
        intent: 'create something abstract',
        context: 'test context',
        mood: 'calm',
        constraints: [],
        references: [],
        domain: 'p5',
        techniques: [],
        complexity: 'simple',
      };

      const action = vi.fn().mockResolvedValue(undefined);
      const suggestion: Suggestion = { type: 'swarm', title: 'Compare approaches',
        description: 'Try multiple perspectives.', priority: 'high', action };
      vi.mocked(RalphLoop.run).mockImplementation((_prompt, options) => {
        options?.onSuggestion?.(suggestion);
        return Promise.resolve(loopResult);
      });
      conversationManager.startNewSession();
      await conversationManager.generateFromBrief(brief);
      expect(action).toHaveBeenCalledExactlyOnceWith();
      expect(conversationManager.getCurrentSessionMessages()).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'system',
          content: '[Suggestion] Compare approaches: Try multiple perspectives.' })]));
    });

    it('returns prioritized swarm guidance for early iterations', () => {
      const suggestions = guidance.suggestNextAction({
        prompt: 'create something abstract',
        domain: 'p5',
        techniques: [],
        constraints: [],
        references: [],
      });
      expect(suggestions).toEqual(expect.arrayContaining([expect.objectContaining({
        type: 'swarm', title: 'Try a new artistic approach', priority: 'high',
        description: 'Multiple perspectives might help break through this creative block.',
      })]));
    });
  });

  describe('GuidanceEngine iteration tracking', () => {
    it('tracks iteration and score for context-aware suggestions', () => {
      guidance.updateIteration(1, 0.5);
      guidance.updateIteration(2, 0.6);
      guidance.updateIteration(3, 0.7);

      expect((guidance as any).currentIteration).toBe(3);
      expect((guidance as any).recentScores).toEqual([0.5, 0.6, 0.7]);
    });

    it('maintains score history within max length', () => {
      for (let i = 1; i <= 15; i++) {
        guidance.updateIteration(i, 0.5 + i * 0.01);
      }

      // Should only keep last 10 scores
      expect((guidance as any).recentScores.length).toBe(10);
    });
  });

  describe('Subsystem data integration', () => {
    it('provides compost suggestions when seeds available', async () => {
      const mockMill = createMockCompostMill(10);
      const guidanceWithCompost = new GuidanceEngine(artBrain, mockMill as CompostMill);

      const suggestions = await guidanceWithCompost.getCompostSuggestions();

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].type).toBe('compost');
    });

    it('provides swarm suggestions for early iterations', async () => {
      const suggestions = await guidance.getSwarmSuggestions({
        prompt: 'something abstract',
        domain: 'p5',
        techniques: [],
        constraints: [],
        references: [],
      });

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].type).toBe('swarm');
    });

    it('provides evolution suggestions when scores plateauing', () => {
      // Set up plateauing scores
      for (let i = 1; i <= 10; i++) {
        guidance.updateIteration(i, 0.7);
      }

      const suggestions = guidance.getEvolutionSuggestions({
        prompt: 'optimize',
        domain: 'p5',
        techniques: [],
        constraints: [],
        references: [],
      });

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].type).toBe('parameter');
      expect(suggestions[0].title).toContain('diversity');
    });
  });

  describe('Suggestion priority ordering', () => {
    it('orders suggestions by priority (high first)', () => {
      (guidance as any).currentIteration = 1;

      const suggestions = guidance.suggestNextAction({
        prompt: 'something abstract',
        domain: 'p5',
        techniques: [],
        constraints: [],
        references: [],
      });

      // Check that suggestions are sorted by priority
      if (suggestions.length > 1) {
        for (let i = 0; i < suggestions.length - 1; i++) {
          const priorityOrder = { high: 0, medium: 1, low: 2 };
          const current = priorityOrder[suggestions[i].priority];
          const next = priorityOrder[suggestions[i + 1].priority];
          expect(current).toBeLessThanOrEqual(next);
        }
      }
    });
  });

  describe('Empty and edge case handling', () => {
    it('returns empty suggestions for null context', () => {
      const suggestions = guidance.suggestNextAction(null as any);
      expect(suggestions).toEqual([]);
    });

    it('returns empty suggestions for undefined context', () => {
      const suggestions = guidance.suggestNextAction(undefined as any);
      expect(suggestions).toEqual([]);
    });

    it('handles empty prompt gracefully', () => {
      const suggestions = guidance.suggestNextAction({
        prompt: '',
        domain: 'p5',
        techniques: [],
        constraints: [],
        references: [],
      });

      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  describe('ConversationManager loop callback contract', () => {
    it('passes its guidance engine and callback to RalphLoop', async () => {
      conversationManager.startNewSession();
      await conversationManager.generateFromBrief(brief);
      expect(RalphLoop.run).toHaveBeenCalledExactlyOnceWith(expect.any(String),
        expect.objectContaining({ chatMode: true,
          guidanceEngine: conversationManager.guidance, onSuggestion: expect.any(Function) }));
    });

    it('records formatted GuidanceEngine suggestions through the loop callback', async () => {
      const suggestions = conversationManager.guidance.suggestNextAction({
        prompt: 'something abstract',
        domain: 'p5',
        techniques: [],
        constraints: [],
        references: [],
      });

      vi.mocked(RalphLoop.run).mockImplementation((_prompt, options) => {
        suggestions.forEach(suggestion => options?.onSuggestion?.(suggestion));
        return Promise.resolve(loopResult);
      });
      conversationManager.startNewSession();
      await conversationManager.generateFromBrief(brief);
      expect(suggestions.length).toBeGreaterThan(0);

      const recorded = conversationManager.getCurrentSessionMessages()
        .filter(message => message.content.startsWith('[Suggestion]'));
      expect(recorded.map(message => message.content)).toEqual(suggestions.map(
        suggestion => `[Suggestion] ${suggestion.title}: ${suggestion.description}`));
      expect(recorded.every(message => message.role === 'system')).toBe(true);
    });
  });
});
