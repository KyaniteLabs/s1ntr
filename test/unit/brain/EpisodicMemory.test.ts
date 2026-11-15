import { describe, it, expect, beforeEach } from 'vitest';
import { EpisodicMemory, Episode, Conversation, GenerationSession } from '../../../src/brain/archive/EpisodicMemory.js';

describe('EpisodicMemory', () => {
  let episodicMemory: EpisodicMemory;

  beforeEach(() => {
    episodicMemory = new EpisodicMemory();
  });

  describe('recordConversation', () => {
    it('should store a conversation', () => {
      const conversation: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ],
        createdAt: new Date('2026-03-22T10:00:00Z'),
        updatedAt: new Date('2026-03-22T10:01:00Z')
      };

      episodicMemory.recordConversation(conversation);

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('conversation');
      expect(episodes[0].content).toEqual(conversation);
    });

    it('should store multiple conversations', () => {
      const conv1: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'First' }],
        createdAt: new Date('2026-03-22T10:00:00Z'),
        updatedAt: new Date('2026-03-22T10:00:00Z')
      };

      const conv2: Conversation = {
        id: 'conv-2',
        sessionId: 'session-2',
        messages: [{ role: 'user', content: 'Second' }],
        createdAt: new Date('2026-03-22T11:00:00Z'),
        updatedAt: new Date('2026-03-22T11:00:00Z')
      };

      episodicMemory.recordConversation(conv1);
      episodicMemory.recordConversation(conv2);

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toHaveLength(2);
    });
  });

  describe('recordGeneration', () => {
    it('should store a generation session', () => {
      const generation: GenerationSession = {
        id: 'gen-1',
        prompt: 'Create a sunset',
        code: 'function draw() { background(255, 100, 0); }',
        domain: 'p5js',
        score: 8.5,
        timestamp: new Date('2026-03-22T12:00:00Z')
      };

      episodicMemory.recordGeneration(generation);

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('generation');
      expect(episodes[0].content).toEqual(generation);
    });

    it('should store generation without score', () => {
      const generation: GenerationSession = {
        id: 'gen-1',
        prompt: 'Test',
        code: 'code',
        domain: 'p5js',
        timestamp: new Date()
      };

      episodicMemory.recordGeneration(generation);

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].content).toEqual(generation);
    });
  });

  describe('recordFeedback', () => {
    it('should store a feedback episode', () => {
      episodicMemory.recordFeedback('artwork-1', 9, 'Beautiful colors!');

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('feedback');
      expect(episodes[0].content).toEqual({
        artworkId: 'artwork-1',
        rating: 9,
        comment: 'Beautiful colors!'
      });
    });

    it('should store multiple feedback episodes', () => {
      episodicMemory.recordFeedback('artwork-1', 8, 'Good');
      episodicMemory.recordFeedback('artwork-2', 10, 'Excellent');

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toHaveLength(2);
    });
  });

  describe('recallRecent', () => {
    it('should return most recent episodes', () => {
      const conv: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'First' }],
        createdAt: new Date('2026-03-22T10:00:00Z'),
        updatedAt: new Date('2026-03-22T10:00:00Z')
      };

      const gen: GenerationSession = {
        id: 'gen-1',
        prompt: 'Test',
        code: 'code',
        domain: 'p5js',
        timestamp: new Date('2026-03-22T11:00:00Z')
      };

      episodicMemory.recordConversation(conv);
      episodicMemory.recordGeneration(gen);

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toHaveLength(2);
      // Most recent first
      expect(episodes[0].type).toBe('generation');
      expect(episodes[1].type).toBe('conversation');
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        episodicMemory.recordFeedback(`artwork-${i}`, i, `Comment ${i}`);
      }

      const episodes = episodicMemory.recallRecent(3);
      expect(episodes).toHaveLength(3);
    });

    it('should return empty array when no episodes', () => {
      const episodes = episodicMemory.recallRecent(10);
      expect(episodes).toEqual([]);
    });
  });

  describe('recallByTag', () => {
    it('should return episodes matching tag', () => {
      const conv: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'Create #abstract art' }],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      episodicMemory.recordConversation(conv);

      const episodes = episodicMemory.recallByTag('abstract');
      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('conversation');
    });

    it('should return empty array when no matches', () => {
      const conv: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'No tags here' }],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      episodicMemory.recordConversation(conv);

      const episodes = episodicMemory.recallByTag('abstract');
      expect(episodes).toEqual([]);
    });
  });

  describe('recallByMood', () => {
    it('should return episodes matching mood', () => {
      const gen: GenerationSession = {
        id: 'gen-1',
        prompt: 'Create something #melancholy',
        code: 'code',
        domain: 'p5js',
        timestamp: new Date()
      };

      episodicMemory.recordGeneration(gen);

      const episodes = episodicMemory.recallByMood('melancholy');
      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('generation');
    });

    it('should return empty array when no mood matches', () => {
      const gen: GenerationSession = {
        id: 'gen-1',
        prompt: 'Just a regular prompt',
        code: 'code',
        domain: 'p5js',
        timestamp: new Date()
      };

      episodicMemory.recordGeneration(gen);

      const episodes = episodicMemory.recallByMood('happy');
      expect(episodes).toEqual([]);
    });
  });

  describe('searchSimilar', () => {
    it('should return episodes with similar content', () => {
      const gen1: GenerationSession = {
        id: 'gen-1',
        prompt: 'Create a sunset with orange colors',
        code: 'code1',
        domain: 'p5js',
        timestamp: new Date()
      };

      const gen2: GenerationSession = {
        id: 'gen-2',
        prompt: 'Draw mountains',
        code: 'code2',
        domain: 'p5js',
        timestamp: new Date()
      };

      episodicMemory.recordGeneration(gen1);
      episodicMemory.recordGeneration(gen2);

      const episodes = episodicMemory.searchSimilar('sunset');
      expect(episodes.length).toBeGreaterThan(0);
      expect(episodes[0].content.prompt).toContain('sunset');
    });

    it('should return empty array when no matches', () => {
      const gen: GenerationSession = {
        id: 'gen-1',
        prompt: 'Draw mountains',
        code: 'code',
        domain: 'p5js',
        timestamp: new Date()
      };

      episodicMemory.recordGeneration(gen);

      const episodes = episodicMemory.searchSimilar('ocean');
      expect(episodes).toEqual([]);
    });
  });

  describe('getPreferences', () => {
    it('should aggregate user preferences from feedback', () => {
      // Record feedback with ratings
      episodicMemory.recordFeedback('artwork-1', 9, 'Great #abstract piece');
      episodicMemory.recordFeedback('artwork-2', 8, 'Nice #geometric style');
      episodicMemory.recordFeedback('artwork-3', 7, 'Love the #minimalist approach');
      episodicMemory.recordFeedback('artwork-4', 5, 'Not my style');

      const preferences = episodicMemory.getPreferences();

      expect(preferences.preferredMoods).toEqual([]);
      // Episodes are kept newest-first; feedback recorded within one millisecond ties,
      // so the tag order depends on the clock. The set of tags is the contract.
      expect([...preferences.preferredTechniques].sort()).toEqual(['abstract', 'geometric', 'minimalist']);
      expect(preferences.preferredDomains).toBeInstanceOf(Map);
    });

    it('should identify preferred moods from high-rated feedback', () => {
      episodicMemory.recordFeedback('artwork-1', 9, 'Amazing #surreal atmosphere');
      episodicMemory.recordFeedback('artwork-2', 8, 'Love the #dreamy mood');

      const preferences = episodicMemory.getPreferences();

      expect(preferences.preferredMoods).toContain('surreal');
      expect(preferences.preferredMoods).toContain('dreamy');
    });

    it('should identify preferred techniques from high-rated feedback', () => {
      episodicMemory.recordFeedback('artwork-1', 9, 'Great use of #watercolor technique');
      episodicMemory.recordFeedback('artwork-2', 8, 'Excellent #impasto brushwork');

      const preferences = episodicMemory.getPreferences();

      expect(preferences.preferredTechniques).toContain('watercolor');
      expect(preferences.preferredTechniques).toContain('impasto');
    });

    it('should aggregate domain scores from generations', () => {
      const gen1: GenerationSession = {
        id: 'gen-1',
        prompt: 'Test 1',
        code: 'code1',
        domain: 'p5js',
        score: 8,
        timestamp: new Date()
      };

      const gen2: GenerationSession = {
        id: 'gen-2',
        prompt: 'Test 2',
        code: 'code2',
        domain: 'p5js',
        score: 9,
        timestamp: new Date()
      };

      const gen3: GenerationSession = {
        id: 'gen-3',
        prompt: 'Test 3',
        code: 'code3',
        domain: 'processing',
        score: 7,
        timestamp: new Date()
      };

      episodicMemory.recordGeneration(gen1);
      episodicMemory.recordGeneration(gen2);
      episodicMemory.recordGeneration(gen3);

      const preferences = episodicMemory.getPreferences();

      expect(preferences.preferredDomains.get('p5js')).toBe(8.5); // average of 8 and 9
      expect(preferences.preferredDomains.get('processing')).toBe(7);
    });

    it('should return empty preferences when no data', () => {
      const preferences = episodicMemory.getPreferences();

      expect(preferences.preferredMoods).toEqual([]);
      expect(preferences.preferredTechniques).toEqual([]);
      expect(preferences.preferredDomains.size).toBe(0);
    });
  });

  describe('save and load', () => {
    it('should save episodes to file', async () => {
      const conversation: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'Hello' }],
        createdAt: new Date('2026-03-22T10:00:00Z'),
        updatedAt: new Date('2026-03-22T10:00:00Z')
      };

      episodicMemory.recordConversation(conversation);

      const testFile = '/tmp/episodic-memory-test.json';
      await episodicMemory.save(testFile);

      // Verify file exists
      const fs = await import('fs/promises');
      const exists = await fs.access(testFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Cleanup
      await fs.unlink(testFile);
    });

    it('should load episodes from file', async () => {
      const conversation: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'Hello' }],
        createdAt: new Date('2026-03-22T10:00:00Z'),
        updatedAt: new Date('2026-03-22T10:00:00Z')
      };

      episodicMemory.recordConversation(conversation);

      const testFile = '/tmp/episodic-memory-test.json';
      await episodicMemory.save(testFile);

      // Create new instance and load
      const newMemory = new EpisodicMemory();
      await newMemory.load(testFile);

      const episodes = newMemory.recallRecent(10);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].type).toBe('conversation');

      // Cleanup
      const fs = await import('fs/promises');
      await fs.unlink(testFile);
    });

    it('should preserve all episode types after save/load', async () => {
      const conversation: Conversation = {
        id: 'conv-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'Hello' }],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const generation: GenerationSession = {
        id: 'gen-1',
        prompt: 'Test',
        code: 'code',
        domain: 'p5js',
        score: 8,
        timestamp: new Date()
      };

      episodicMemory.recordConversation(conversation);
      episodicMemory.recordGeneration(generation);
      episodicMemory.recordFeedback('artwork-1', 9, 'Great');

      const testFile = '/tmp/episodic-memory-test.json';
      await episodicMemory.save(testFile);

      const newMemory = new EpisodicMemory();
      await newMemory.load(testFile);

      const episodes = newMemory.recallRecent(10);
      expect(episodes).toHaveLength(3);

      const types = episodes.map(e => e.type);
      expect(types).toContain('conversation');
      expect(types).toContain('generation');
      expect(types).toContain('feedback');

      // Cleanup
      const fs = await import('fs/promises');
      await fs.unlink(testFile);
    });
  });

  describe('re-recording the same session', () => {
    const gen = (score: number, iso: string): GenerationSession => ({
      id: 'gen-repeat', prompt: 'p', code: 'c', domain: 'p5js', score, timestamp: new Date(iso)
    });

    it('replaces the generation episode instead of inflating domain support', () => {
      episodicMemory.recordGeneration(gen(2, '2026-03-22T10:00:00Z'));
      episodicMemory.recordGeneration(gen(2, '2026-03-22T10:00:00Z'));
      episodicMemory.recordGeneration(gen(8, '2026-03-22T11:00:00Z'));

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes.map(e => e.id)).toEqual(['episode-gen-gen-repeat']);
      expect((episodes[0].content as GenerationSession).score).toBe(8);
      expect(episodicMemory.getPreferences().preferredDomains.get('p5js')).toBe(8);
    });

    it('replaces the conversation episode with the updated conversation', () => {
      const base: Conversation = {
        id: 'conv-repeat', sessionId: 's', messages: [{ role: 'user', content: 'Hi #calm' }],
        createdAt: new Date('2026-03-22T10:00:00Z'), updatedAt: new Date('2026-03-22T10:00:00Z')
      };
      episodicMemory.recordConversation(base);
      episodicMemory.recordConversation({
        ...base,
        messages: [...base.messages, { role: 'assistant', content: 'Hello' }],
        updatedAt: new Date('2026-03-22T10:05:00Z')
      });

      const episodes = episodicMemory.recallRecent(10);
      expect(episodes.length).toBe(1);
      expect((episodes[0].content as Conversation).messages.length).toBe(2);
      expect(episodicMemory.recallByTag('calm').length).toBe(1);
    });

    it('keeps distinct feedback events as separate episodes', () => {
      episodicMemory.recordFeedback('art-1', 8, 'nice');
      episodicMemory.recordFeedback('art-1', 8, 'nice');
      expect(episodicMemory.recallRecent(10).length).toBe(2);
    });

    it('collapses duplicate episodes from an older save file to the latest copy on load', async () => {
      const { mkdtemp, writeFile, rm } = await import('fs/promises');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const dir = await mkdtemp(join(tmpdir(), 'episodic-dup-'));
      const file = join(dir, 'episodic.json');
      const older = { id: 'gen-x', prompt: 'p', code: 'c', domain: 'glsl', score: 3, timestamp: '2026-03-22T10:00:00.000Z' };
      const newer = { ...older, score: 9, timestamp: '2026-03-22T12:00:00.000Z' };
      await writeFile(file, JSON.stringify({
        episodes: [
          { id: 'episode-gen-gen-x', type: 'generation', timestamp: older.timestamp, content: older },
          { id: 'episode-gen-gen-x', type: 'generation', timestamp: newer.timestamp, content: newer },
          { id: 'episode-gen-gen-x', type: 'generation', timestamp: older.timestamp, content: older },
        ],
        conversations: [],
        generations: [['gen-x', newer]],
      }));

      try {
        await episodicMemory.load(file);
        const episodes = episodicMemory.recallRecent(10);
        expect(episodes.length).toBe(1);
        expect((episodes[0].content as GenerationSession).score).toBe(9);
        expect(episodicMemory.getPreferences().preferredDomains.get('glsl')).toBe(9);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects a load from a missing file without changing memory', async () => {
      episodicMemory.recordGeneration(gen(5, '2026-03-22T10:00:00Z'));
      await expect(episodicMemory.load('/nonexistent/episodic-missing.json')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(episodicMemory.recallRecent(10).length).toBe(1);
    });
  });
});
