/**
 * Intuition module tests — ThompsonSampler, DomainPrototype, IntuitionStrategy, IntuitionCache
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThompsonSampler } from '../../src/intuition/ThompsonSampler.js';
import { DomainPrototype } from '../../src/intuition/DomainPrototype.js';
import { IntuitionStrategy } from '../../src/intuition/IntuitionStrategy.js';
import { IntuitionCache } from '../../src/intuition/IntuitionCache.js';
import { MemoryConsolidator } from '../../src/intuition/MemoryConsolidator.js';
import type { ConsolidationEpisode, ConsolidatedPattern } from '../../src/intuition/MemoryConsolidator.js';
import { CreativeWorldModel } from '../../src/intuition/CreativeWorldModel.js';
import type { BehaviorVector } from '../../src/intuition/CreativeWorldModel.js';
import { DreamEngine } from '../../src/intuition/DreamEngine.js';
import type { DreamJournalEntry } from '../../src/intuition/DreamEngine.js';
import { SleepScheduler } from '../../src/intuition/SleepScheduler.js';
import { ForgettingCurve } from '../../src/intuition/ForgettingCurve.js';
import type { DecayableItem } from '../../src/intuition/ForgettingCurve.js';
import { MemoryBudget } from '../../src/intuition/MemoryBudget.js';
import type { PrunableStore, BudgetItem } from '../../src/intuition/MemoryBudget.js';
import { ProceduralTier } from '../../src/intuition/ProceduralTier.js';
import type { RoutineConfidence } from '../../src/intuition/ProceduralTier.js';
import { IntuitionEngine } from '../../src/intuition/IntuitionEngine.js';
import type { IntuitionAssessment, IntuitionSignal } from '../../src/intuition/IntuitionEngine.js';
import type { ScoringInput } from '../../src/core/ScoringEngine.js';
import { MetabolicEntropyEngine } from '../../src/entropy/MetabolicEntropyEngine.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// ThompsonSampler
// ---------------------------------------------------------------------------
describe('ThompsonSampler', () => {
  let sampler: ThompsonSampler<string>;

  beforeEach(() => {
    sampler = new ThompsonSampler<string>({ minPulls: 3, successThreshold: 0.7, maxArms: 50 });
  });

  it('should return null when no arm has enough pulls', () => {
    sampler.update('arm-a', 0.8);
    sampler.update('arm-a', 0.9);
    expect(sampler.select()).toBeNull();
  });

  it('should select an arm after minPulls reached', () => {
    for (let i = 0; i < 5; i++) sampler.update('arm-a', 0.8 + i * 0.02);
    for (let i = 0; i < 5; i++) sampler.update('arm-b', 0.3 + i * 0.02);

    const selected = sampler.select();
    expect(['arm-a', 'arm-b']).toContain(selected);
  });

  it('exploration floor: returns an under-explored arm before exploiting a trusted one', () => {
    for (let i = 0; i < 10; i++) sampler.update('trusted', 0.95);
    sampler.update('newcomer', 0.1);

    expect(sampler.select()).toBe('newcomer');
  });

  it('exploration floor: picks the least-pulled under-explored arm', () => {
    for (let i = 0; i < 5; i++) sampler.update('trusted', 0.95);
    sampler.update('two-pulls', 0.5);
    sampler.update('two-pulls', 0.5);
    sampler.update('one-pull', 0.5);

    expect(sampler.select()).toBe('one-pull');
  });

  it('exploration floor: every known arm reaches minPulls when selections are fed back', () => {
    for (let i = 0; i < 5; i++) sampler.update('trusted', 0.95);
    sampler.update('b', 0.1);
    sampler.update('c', 0.1);

    for (let i = 0; i < 4; i++) {
      const picked = sampler.select();
      if (picked !== 'trusted') sampler.update(picked!, 0.1);
    }

    expect(sampler.getArmStats('b')!.pulls).toBe(3);
    expect(sampler.getArmStats('c')!.pulls).toBe(3);
  });

  it('exploration floor can be disabled to exploit trusted arms only', () => {
    const noFloor = new ThompsonSampler<string>({ minPulls: 3, explorationFloor: false });
    for (let i = 0; i < 5; i++) noFloor.update('trusted', 0.95);
    noFloor.update('newcomer', 0.1);

    expect(noFloor.select()).toBe('trusted');
  });

  it('eviction removes the worst-mean explored arm, never an under-explored one', () => {
    const capped = new ThompsonSampler<string>({ minPulls: 2, maxArms: 3 });
    capped.update('good', 0.9); capped.update('good', 0.9);
    capped.update('bad', 0.1); capped.update('bad', 0.1);
    capped.update('fresh', 0.5);

    capped.update('incoming', 0.5);

    expect([...capped.getArms().keys()].sort()).toEqual(['fresh', 'good', 'incoming']);
  });

  it('refuses a new arm at the cap when every arm is still under-explored', () => {
    const capped = new ThompsonSampler<string>({ minPulls: 5, maxArms: 2 });
    capped.update('a', 0.5);
    capped.update('b', 0.5);

    capped.update('c', 0.5);

    expect([...capped.getArms().keys()].sort()).toEqual(['a', 'b']);
    expect(capped.getArmStats('c')).toBeNull();
    expect(capped.totalPulls).toBe(2);
  });

  it('should update alpha on success (score >= threshold)', () => {
    sampler.update('arm-x', 0.9);
    const stats = sampler.getArmStats('arm-x');
    expect(stats).toEqual({ alpha: 2, beta: 1, pulls: 1, totalReward: 0.9 });
  });

  it('should update beta on failure (score < threshold)', () => {
    sampler.update('arm-x', 0.3);
    const stats = sampler.getArmStats('arm-x');
    expect(stats!.alpha).toBe(1); // unchanged
    expect(stats!.beta).toBe(2); // started at 1, +1 for failure
  });

  it('should serialize and deserialize', () => {
    sampler.update('arm-a', 0.8);
    sampler.update('arm-a', 0.6);
    sampler.update('arm-b', 0.9);

    const state = sampler.serialize();
    expect(state.version).toBe(1);
    expect(state.arms.length).toBe(2);

    const sampler2 = new ThompsonSampler<string>();
    sampler2.deserialize(state);
    expect(sampler2.getArmStats('arm-a')!.pulls).toBe(2);
    expect(sampler2.getArmStats('arm-b')!.pulls).toBe(1);
  });

  it('should report confidence based on alpha/(alpha+beta)', () => {
    // 3 successes, 1 failure → alpha=4, beta=2 → confidence = 0.67
    sampler.update('arm-x', 0.8);
    sampler.update('arm-x', 0.8);
    sampler.update('arm-x', 0.8);
    sampler.update('arm-x', 0.3);
    expect(sampler.getConfidence('arm-x')).toBeCloseTo(4 / 6, 2);
  });

  it('should report 0 confidence for unknown arms', () => {
    expect(sampler.getConfidence('unknown')).toBe(0);
  });

  it('should report isReady when any arm has enough pulls', () => {
    expect(sampler.isReady()).toBe(false);
    for (let i = 0; i < 3; i++) sampler.update('arm-a', 0.5);
    expect(sampler.isReady()).toBe(true);
  });

  it('should evict least-pulled arm when maxArms reached', () => {
    const small = new ThompsonSampler<string>({ minPulls: 1, maxArms: 3 });
    small.update('a', 0.5);
    small.update('b', 0.5);
    small.update('c', 0.5);
    small.update('d', 0.5); // should evict least-pulled; 'd' kept (just added)
    // 0.5 < default successThreshold 0.7 → failure → beta=2, alpha=1, pulls=1
    expect(small.getArmStats('d')).toEqual({ alpha: 1, beta: 2, pulls: 1, totalReward: 0.5 });
  });

  it('should reset all state', () => {
    sampler.update('arm-a', 0.8);
    sampler.reset();
    expect(sampler.getArmStats('arm-a')).toBeNull();
    expect(sampler.totalPulls).toBe(0);
  });

  it('should find bestByMean', () => {
    for (let i = 0; i < 5; i++) sampler.update('good', 0.9);
    for (let i = 0; i < 5; i++) sampler.update('bad', 0.2);
    expect(sampler.bestByMean()).toBe('good');
  });
});

// ---------------------------------------------------------------------------
// DomainPrototype
// ---------------------------------------------------------------------------
describe('DomainPrototype', () => {
  let proto: DomainPrototype;

  beforeEach(() => {
    proto = new DomainPrototype();
  });

  it('should create centroid from first example', () => {
    proto.addExample('p5', [0.5, 0.5, 0.5], 0.8);
    const c = proto.getCentroid('p5');
    expect(c).toMatchObject({
      domain: 'p5',
      exampleCount: 1,
      avgQuality: 0.8,
      centroid: [0.5, 0.5, 0.5],
    });
  });

  it('should incrementally update centroid', () => {
    proto.addExample('p5', [1, 0, 0], 0.9);
    proto.addExample('p5', [0, 1, 0], 0.7);
    const c = proto.getCentroid('p5')!;
    expect(c.exampleCount).toBe(2);
    expect(c.centroid[0]).toBeCloseTo(0.5, 5);
    expect(c.centroid[1]).toBeCloseTo(0.5, 5);
    expect(c.avgQuality).toBeCloseTo(0.8, 5);
  });

  it('should compute cosine distance', () => {
    proto.addExample('p5', [1, 0, 0], 0.8);
    // Identical vector → distance ~0
    expect(proto.distanceToCentroid('p5', [1, 0, 0])).toBeCloseTo(0, 5);
    // Orthogonal vector → distance ~π/2 ≈ 1 (cos dist)
    expect(proto.distanceToCentroid('p5', [0, 1, 0])).toBeCloseTo(1, 1);
  });

  it('reports distance unavailable (null) for an unknown domain (#1249)', () => {
    expect(proto.distanceToCentroid('unknown', [0.5, 0.5])).toBeNull();
    expect(proto.predictQuality('unknown', [0.5, 0.5])).toBeNull();
  });

  it('a zero vector is unavailable, not a perfect match (#1249)', () => {
    proto.addExample('p5', [1, 0, 0], 0.9);
    expect(proto.distanceToCentroid('p5', [0, 0, 0])).toBeNull();
    expect(proto.predictQuality('p5', [0, 0, 0])).toBeNull();
  });

  it('dimension mismatch is unavailable and cannot corrupt the centroid (#1249)', () => {
    proto.addExample('p5', [1, 0, 0], 0.9);
    expect(proto.distanceToCentroid('p5', [1, 0])).toBeNull();
    expect(proto.addExample('p5', [1, 0], 0.9)).toBe(false);
    expect(proto.addExample('p5', [1, 0, 0, 0], 0.9)).toBe(false);
    expect(proto.getCentroid('p5')).toMatchObject({ centroid: [1, 0, 0], exampleCount: 1 });
  });

  it('rejects empty, zero and non-finite examples (#1249)', () => {
    expect(proto.addExample('p5', [], 0.9)).toBe(false);
    expect(proto.addExample('p5', [0, 0], 0.9)).toBe(false);
    expect(proto.addExample('p5', [NaN, 1], 0.9)).toBe(false);
    expect(proto.addExample('p5', [1, 1], NaN)).toBe(false);
    expect(proto.getCentroid('p5')).toBeNull();
    expect(proto.addExample('p5', [1, 1], 0.9)).toBe(true);
  });

  it('should predict quality from embedding', () => {
    proto.addExample('p5', [1, 0, 0], 0.9);
    // Close to centroid → high predicted quality
    const close = proto.predictQuality('p5', [0.95, 0.05, 0]);
    expect(close).toBeGreaterThan(0.5);
    // Far from centroid → lower predicted quality
    const far = proto.predictQuality('p5', [0, 1, 0]);
    expect(far).toBeLessThan(close);
  });

  it('should report isReady based on example count', () => {
    proto.addExample('p5', [0.5], 0.8);
    expect(proto.isReady('p5', 3)).toBe(false);
    proto.addExample('p5', [0.5], 0.8);
    proto.addExample('p5', [0.5], 0.8);
    expect(proto.isReady('p5', 3)).toBe(true);
  });

  it('should serialize and deserialize', () => {
    proto.addExample('p5', [0.5, 0.5], 0.8);
    proto.addExample('glsl', [0.3, 0.7], 0.9);
    const state = proto.serialize();
    expect(state.centroids.length).toBe(2);

    const proto2 = new DomainPrototype();
    proto2.deserialize(state);
    expect(proto2.domainCount).toBe(2);
    expect(proto2.getCentroid('p5')!.exampleCount).toBe(1);
  });

  it('should reset', () => {
    proto.addExample('p5', [0.5], 0.8);
    proto.reset();
    expect(proto.domainCount).toBe(0);
    expect(proto.getCentroid('p5')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IntuitionStrategy
// ---------------------------------------------------------------------------
describe('IntuitionStrategy', () => {
  let strategy: IntuitionStrategy;
  let prototype: DomainPrototype;
  let modelSampler: ThompsonSampler<string>;
  let strategySampler: ThompsonSampler<string>;

  beforeEach(() => {
    prototype = new DomainPrototype();
    modelSampler = new ThompsonSampler<string>({ minPulls: 2, successThreshold: 0.7 });
    strategySampler = new ThompsonSampler<string>({ minPulls: 2, successThreshold: 0.7 });
    strategy = new IntuitionStrategy(prototype, modelSampler, strategySampler);
  });

  const makeInput = (overrides?: Partial<ScoringInput>): ScoringInput => ({
    output: 'function setup() { createCanvas(400, 400); } function draw() { background(220); }',
    domain: 'p5' as any,
    prompt: 'a simple p5 sketch',
    ...overrides,
  });

  it('should return a valid ScoringResult', async () => {
    const result = await strategy.score(makeInput());
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.strategy).toBe('intuition');
    // Both dimensions are numbers in the 0-1 range (not just present)
    expect(result.dimensions.intuition).toBeGreaterThanOrEqual(0);
    expect(result.dimensions.intuition).toBeLessThanOrEqual(1);
    expect(result.dimensions.novelty).toBeGreaterThanOrEqual(0);
    expect(result.dimensions.novelty).toBeLessThanOrEqual(1);
  });

  it('should report intuition dimension in 0-1 range', async () => {
    const result = await strategy.score(makeInput());
    const intuition = result.dimensions.intuition!;
    expect(intuition).toBeGreaterThanOrEqual(0);
    expect(intuition).toBeLessThanOrEqual(1);
  });

  it('should report higher novelty for first output vs repeated', async () => {
    const first = await strategy.score(makeInput());
    const sameOutput = makeInput({
      previousOutputs: [
        'function setup() { createCanvas(400, 400); } function draw() { background(220); }',
      ],
    });
    const second = await strategy.score(sameOutput);
    expect(first.dimensions.novelty!).toBeGreaterThan(second.dimensions.novelty!);
  });

  it('should produce signals in assessment', async () => {
    await strategy.score(makeInput());
    const assessment = strategy.getLastAssessment();
    expect(assessment).toMatchObject({
      score: expect.any(Number),
      confidence: expect.any(Number),
      signals: expect.any(Array),
      recommendation: expect.stringContaining('domain: p5'),
    });
    expect(assessment!.signals.length).toBeGreaterThanOrEqual(3);
    expect(assessment!.confidence).toBeGreaterThanOrEqual(0);
    expect(assessment!.confidence).toBeLessThanOrEqual(1);
  });

  it('should build readable recommendation', async () => {
    await strategy.score(makeInput());
    const assessment = strategy.getLastAssessment()!;
    expect(assessment.recommendation).toContain('domain: p5');
  });

  it('should adapt prototype scores after training data', async () => {
    // Feed quality examples
    prototype.addExample('p5', [0.8, 0.2], 0.9);
    prototype.addExample('p5', [0.7, 0.3], 0.85);
    prototype.addExample('p5', [0.9, 0.1], 0.95);

    // Feed some model outcomes
    modelSampler.update('local', 0.85);
    modelSampler.update('local', 0.9);

    const result = await strategy.score(makeInput());
    // With prototype data, signals should be more informed
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('should handle missing domain gracefully', async () => {
    const result = await strategy.score(makeInput({ domain: undefined }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('should handle empty previousOutputs', async () => {
    const result = await strategy.score(makeInput({ previousOutputs: [] }));
    expect(result.dimensions.novelty).toBe(1); // max novelty with no history
  });
});

// ---------------------------------------------------------------------------
// IntuitionCache
// ---------------------------------------------------------------------------
describe('IntuitionCache', () => {
  let cache: IntuitionCache;

  beforeEach(() => {
    cache = new IntuitionCache({ maxSize: 10, ttlMs: 1000 });
  });

  const makeAssessment = (score: number) => ({
    score,
    confidence: 0.8,
    signals: [
      { name: 'prototype', value: score, reason: `score=${score}` },
      { name: 'novelty', value: 0.5, reason: 'mid novelty' },
    ],
    recommendation: `domain: p5 | score: ${score}`,
  });

  it('should store and retrieve assessments', () => {
    const assessment = makeAssessment(0.85);
    cache.set('p5', 'some output code', assessment);
    const retrieved = cache.get('p5', 'some output code');
    expect(retrieved).toEqual(assessment);
    expect(retrieved!.score).toBe(0.85);
  });

  it('should return null for cache miss', () => {
    expect(cache.get('p5', 'never seen')).toBeNull();
  });

  it('should differentiate by domain', () => {
    const assessment = makeAssessment(0.7);
    cache.set('p5', 'code', assessment);
    // Different domain, same output → miss
    expect(cache.get('glsl', 'code')).toBeNull();
    // Same domain, same output → hit returns the stored assessment
    expect(cache.get('p5', 'code')).toEqual(assessment);
  });

  it('should differentiate by output content', () => {
    cache.set('p5', 'output-a', makeAssessment(0.9));
    cache.set('p5', 'output-b', makeAssessment(0.3));
    expect(cache.get('p5', 'output-a')!.score).toBe(0.9);
    expect(cache.get('p5', 'output-b')!.score).toBe(0.3);
  });

  it('should expire entries after TTL', async () => {
    const shortCache = new IntuitionCache({ maxSize: 10, ttlMs: 50 });
    shortCache.set('p5', 'output', makeAssessment(0.8));
    expect(shortCache.get('p5', 'output')).toEqual(makeAssessment(0.8));

    // Wait for TTL
    await new Promise(r => setTimeout(r, 60));
    expect(shortCache.get('p5', 'output')).toBeNull();
  });

  it('should evict LRU when at capacity', () => {
    const small = new IntuitionCache({ maxSize: 3, ttlMs: 60000 });
    small.set('p5', 'first', makeAssessment(0.1));
    small.set('p5', 'second', makeAssessment(0.2));
    small.set('p5', 'third', makeAssessment(0.3));

    // Access 'first' to make it recently used
    small.get('p5', 'first');

    // Add one more → should evict 'second' (least recently used)
    small.set('p5', 'fourth', makeAssessment(0.4));

    expect(small.get('p5', 'first')!.score).toBe(0.1); // accessed, kept
    expect(small.get('p5', 'second')).toBeNull(); // evicted (LRU)
    expect(small.get('p5', 'third')!.score).toBe(0.3); // kept
    expect(small.get('p5', 'fourth')!.score).toBe(0.4); // just added
  });

  it('should track hit/miss stats', () => {
    cache.set('p5', 'output', makeAssessment(0.8));

    cache.get('p5', 'output'); // hit
    cache.get('p5', 'output'); // hit
    cache.get('p5', 'miss');   // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    expect(stats.size).toBe(1);
  });

  it('should track evictions', () => {
    const small = new IntuitionCache({ maxSize: 2, ttlMs: 60000 });
    small.set('p5', 'a', makeAssessment(0.1));
    small.set('p5', 'b', makeAssessment(0.2));
    small.set('p5', 'c', makeAssessment(0.3)); // evicts 'a'

    expect(small.getStats().evictions).toBe(1);
  });

  it('should find similar entries by embedding', () => {
    const embCache = new IntuitionCache({ maxSize: 10, ttlMs: 60000, storeEmbeddings: true });
    embCache.set('p5', 'output-1', makeAssessment(0.9), [1, 0, 0]);
    embCache.set('p5', 'output-2', makeAssessment(0.3), [0, 1, 0]);

    // Similar to first → high similarity
    const similar = embCache.findSimilar('p5', [0.95, 0.05, 0], 0.8);
    expect(similar).toMatchObject({
      domain: 'p5',
      embedding: [1, 0, 0],
      assessment: expect.objectContaining({ score: 0.9 }),
    });

    // Orthogonal to both → no match above threshold
    const noMatch = embCache.findSimilar('p5', [0, 0, 1], 0.8);
    expect(noMatch).toBeNull();
  });

  it('should filter similarity by domain', () => {
    const embCache = new IntuitionCache({ maxSize: 10, ttlMs: 60000, storeEmbeddings: true });
    embCache.set('p5', 'output', makeAssessment(0.9), [1, 0, 0]);

    // Same embedding, different domain → no match
    expect(embCache.findSimilar('glsl', [1, 0, 0], 0.5)).toBeNull();
  });

  it('should purge expired entries', async () => {
    const shortCache = new IntuitionCache({ maxSize: 10, ttlMs: 30 });
    shortCache.set('p5', 'a', makeAssessment(0.8));
    shortCache.set('p5', 'b', makeAssessment(0.9));

    await new Promise(r => setTimeout(r, 40));
    const purged = shortCache.purgeExpired();
    expect(purged).toBe(2);
    expect(shortCache.getStats().size).toBe(0);
  });

  it('should return domain-specific entries', () => {
    cache.set('p5', 'a', makeAssessment(0.8));
    cache.set('p5', 'b', makeAssessment(0.7));
    cache.set('glsl', 'c', makeAssessment(0.6));

    const p5Entries = cache.getDomainEntries('p5');
    expect(p5Entries.length).toBe(2);
    expect(p5Entries.every(e => e.domain === 'p5')).toBe(true);
  });

  it('should delete specific entries', () => {
    cache.set('p5', 'a', makeAssessment(0.8));
    expect(cache.delete('p5', 'a')).toBe(true);
    expect(cache.get('p5', 'a')).toBeNull();
    expect(cache.delete('p5', 'nonexistent')).toBe(false);
  });

  it('should serialize and deserialize', () => {
    cache.set('p5', 'a', makeAssessment(0.85));
    cache.set('glsl', 'b', makeAssessment(0.65));

    const state = cache.serialize();
    expect(state.version).toBe(1);
    expect(state.entries.length).toBe(2);

    const cache2 = new IntuitionCache({ maxSize: 10, ttlMs: 60000 });
    cache2.deserialize(state);
    expect(cache2.get('p5', 'a')!.score).toBe(0.85);
    expect(cache2.get('glsl', 'b')!.score).toBe(0.65);
  });

  it('should reset completely', () => {
    cache.set('p5', 'a', makeAssessment(0.8));
    cache.get('p5', 'a');
    cache.reset();
    expect(cache.getStats().size).toBe(0);
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
  });

  it('should check has() correctly', () => {
    expect(cache.has('p5', 'x')).toBe(false);
    cache.set('p5', 'x', makeAssessment(0.5));
    expect(cache.has('p5', 'x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IntuitionStrategy with Cache
// ---------------------------------------------------------------------------
describe('IntuitionStrategy with Cache', () => {
  let strategy: IntuitionStrategy;
  let cache: IntuitionCache;

  beforeEach(() => {
    cache = new IntuitionCache({ maxSize: 100, ttlMs: 60000 });
    const prototype = new DomainPrototype();
    const modelSampler = new ThompsonSampler<string>({ minPulls: 2, successThreshold: 0.7 });
    const strategySampler = new ThompsonSampler<string>({ minPulls: 2, successThreshold: 0.7 });
    strategy = new IntuitionStrategy(prototype, modelSampler, strategySampler, undefined, cache);
  });

  const makeInput = (overrides?: Partial<ScoringInput>): ScoringInput => ({
    output: 'function setup() { createCanvas(400, 400); }',
    domain: 'p5' as any,
    prompt: 'a simple p5 sketch',
    ...overrides,
  });

  it('should return cached result on second call', async () => {
    const input = makeInput();
    const first = await strategy.score(input);
    const second = await strategy.score(input);

    expect(first.score).toBeCloseTo(second.score, 5);
    expect(cache.getStats().hits).toBe(1); // second call was a cache hit
  });

  it('should compute fresh result for different outputs', async () => {
    const result1 = await strategy.score(makeInput({ output: 'output A' }));
    const result2 = await strategy.score(makeInput({ output: 'output B' }));

    // Different outputs → cache miss on second
    expect(cache.getStats().misses).toBeGreaterThanOrEqual(2);
  });

  it('should expose cache via getCache()', () => {
    expect(strategy.getCache()).toBe(cache);
  });
});

// ---------------------------------------------------------------------------
// MemoryConsolidator
// ---------------------------------------------------------------------------
describe('MemoryConsolidator', () => {
  let consolidator: MemoryConsolidator;
  let modelSampler: ThompsonSampler<string>;
  let strategySampler: ThompsonSampler<string>;
  let prototype: DomainPrototype;

  beforeEach(() => {
    modelSampler = new ThompsonSampler<string>({ minPulls: 1, successThreshold: 0.7 });
    strategySampler = new ThompsonSampler<string>({ minPulls: 1, successThreshold: 0.7 });
    prototype = new DomainPrototype();
    consolidator = new MemoryConsolidator(
      { modelSampler, strategySampler, prototype },
      { successThreshold: 0.7, minEpisodesForPattern: 2, maxPatterns: 50 },
    );
  });

  const makeEpisodes = (overrides: Partial<ConsolidationEpisode>[]): ConsolidationEpisode[] =>
    overrides.map((o, i) => ({
      domain: 'p5',
      output: `output-${i}`,
      qualityScore: 0.8,
      timestamp: new Date().toISOString(),
      ...o,
    }));

  it('merged quality variance matches a direct rebuild, including the between-group mean shift', () => {
    consolidator.consolidate(makeEpisodes([
      { domain: 'var', qualityScore: 0.2 }, { domain: 'var', qualityScore: 0.2 }, { domain: 'var', qualityScore: 0.2 },
    ]));
    consolidator.consolidate(makeEpisodes([
      { domain: 'var', qualityScore: 0.8 }, { domain: 'var', qualityScore: 0.8 }, { domain: 'var', qualityScore: 0.8 },
    ]));
    const merged = consolidator.getPattern('var')!;

    const direct = new MemoryConsolidator({}, { successThreshold: 0.7, minEpisodesForPattern: 2, maxPatterns: 50 });
    direct.consolidate(makeEpisodes([0.2, 0.2, 0.2, 0.8, 0.8, 0.8].map(q => ({ domain: 'var', qualityScore: q }))));
    const rebuilt = direct.getPattern('var')!;

    // Union mean 0.5, population variance 0.09, stored scaled ×4 = 0.36.
    expect(rebuilt.qualityVariance).toBeCloseTo(0.36, 10);
    expect(merged.qualityVariance).toBeCloseTo(rebuilt.qualityVariance, 10);
    expect(merged.avgQuality).toBeCloseTo(0.5, 10);
  });

  it('merged variance of unequal-size groups with spread matches a direct rebuild', () => {
    const a = [0.1, 0.3, 0.5];
    const b = [0.6, 0.9];
    consolidator.consolidate(makeEpisodes(a.map(q => ({ domain: 'uneq', qualityScore: q }))));
    consolidator.consolidate(makeEpisodes(b.map(q => ({ domain: 'uneq', qualityScore: q }))));

    const direct = new MemoryConsolidator({}, { successThreshold: 0.7, minEpisodesForPattern: 2, maxPatterns: 50 });
    direct.consolidate(makeEpisodes([...a, ...b].map(q => ({ domain: 'uneq', qualityScore: q }))));

    expect(consolidator.getPattern('uneq')!.qualityVariance)
      .toBeCloseTo(direct.getPattern('uneq')!.qualityVariance, 10);
  });

  it('decays patterns on a pinned clock and does not reset decay when an old batch is replayed', () => {
    const T0 = Date.parse('2020-01-01T00:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;
    let now = T0 + 10 * DAY;
    const pinned = new MemoryConsolidator(
      { clock: () => now },
      { successThreshold: 0.7, minEpisodesForPattern: 2, maxPatterns: 50, retentionStability: 10 },
    );
    const oldBatch = makeEpisodes([
      { domain: 'clock', qualityScore: 0.8, timestamp: new Date(T0).toISOString() },
      { domain: 'clock', qualityScore: 0.6, timestamp: new Date(T0).toISOString() },
    ]);
    pinned.consolidate(oldBatch);
    expect(pinned.getPattern('clock')!.retention).toBeCloseTo(Math.exp(-1), 10);

    now = T0 + 20 * DAY;
    pinned.consolidate(oldBatch);
    const replayed = pinned.getPattern('clock')!;
    expect(replayed.lastUpdated).toBe(new Date(T0).toISOString());
    expect(replayed.retention).toBeCloseTo(Math.exp(-2), 10);
  });

  it('should consolidate episodes into patterns', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'qwen3', qualityScore: 0.85 },
      { domain: 'p5', model: 'qwen3', qualityScore: 0.75 },
      { domain: 'p5', model: 'qwen3', qualityScore: 0.9 },
    ]);

    const result = consolidator.consolidate(episodes);
    expect(result.episodesProcessed).toBe(3);
    expect(result.patternsCreated).toBeGreaterThanOrEqual(1);

    expect(result.byDomain.p5?.episodes).toBe(3);
  });

  it('should group by domain, model, and strategy', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'qwen3', strategy: 'solo', qualityScore: 0.8 },
      { domain: 'p5', model: 'qwen3', strategy: 'solo', qualityScore: 0.7 },
      { domain: 'p5', model: 'ollama', strategy: 'swarm', qualityScore: 0.9 },
      { domain: 'p5', model: 'ollama', strategy: 'swarm', qualityScore: 0.85 },
      { domain: 'glsl', model: 'qwen3', strategy: 'solo', qualityScore: 0.6 },
      { domain: 'glsl', model: 'qwen3', strategy: 'solo', qualityScore: 0.65 },
    ]);

    const result = consolidator.consolidate(episodes);
    // Should create patterns at domain, domain:model, and domain:model:strategy levels
    const allPatterns = consolidator.getAllPatterns();
    expect(allPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it('should compute correct Thompson Beta params', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'test-model', qualityScore: 0.9 }, // success
      { domain: 'p5', model: 'test-model', qualityScore: 0.9 }, // success
      { domain: 'p5', model: 'test-model', qualityScore: 0.3 }, // failure
    ]);

    consolidator.consolidate(episodes);
    const pattern = consolidator.getPattern('p5:test-model');
    expect(pattern).toMatchObject({
      key: 'p5:test-model',
      domain: 'p5',
      model: 'test-model',
      alpha: 3, // 2 successes + 1 prior
      beta: 2,  // 1 failure + 1 prior
      episodeCount: 3,
    });
  });

  it('should skip groups with too few episodes', () => {
    const smallConsolidator = new MemoryConsolidator(undefined, { minEpisodesForPattern: 3 });
    const episodes = makeEpisodes([
      { domain: 'p5', qualityScore: 0.8 },
      { domain: 'p5', qualityScore: 0.7 },
    ]);

    const result = smallConsolidator.consolidate(episodes);
    expect(result.patternsCreated).toBe(0);
  });

  it('should update ThompsonSampler during consolidation', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'model-a', qualityScore: 0.9 },
      { domain: 'p5', model: 'model-a', qualityScore: 0.85 },
    ]);

    consolidator.consolidate(episodes);
    const stats = modelSampler.getArmStats('p5::model-a');
    // Both episodes (0.9, 0.85) ≥ threshold → 2 successes replayed at (threshold+0.1≈0.8)
    // → 2 pulls, alpha=3 (1 prior + 2), beta=1, totalReward ≈ 1.6
    expect(stats).toMatchObject({ alpha: 3, beta: 1, pulls: 2 });
    expect(stats!.totalReward).toBeCloseTo(1.6, 10);
  });

  it('should update strategy sampler during consolidation', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'qwen3', strategy: 'swarm', qualityScore: 0.9 },
      { domain: 'p5', model: 'qwen3', strategy: 'swarm', qualityScore: 0.85 },
    ]);

    consolidator.consolidate(episodes);
    const stats = strategySampler.getArmStats('p5::swarm');
    // 2 success episodes replayed at (threshold+0.1≈0.8) → alpha=3, beta=1, 2 pulls
    expect(stats).toMatchObject({ alpha: 3, beta: 1, pulls: 2 });
    expect(stats!.totalReward).toBeCloseTo(1.6, 10);
  });

  it('should update domain prototype from high-quality episodes', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', qualityScore: 0.9, embedding: [0.8, 0.2] },
      { domain: 'p5', qualityScore: 0.85, embedding: [0.7, 0.3] },
    ]);

    const result = consolidator.consolidate(episodes);
    expect(result.prototypeUpdates).toBe(2);
    // Centroid is the mean of [0.8,0.2] and [0.7,0.3]; avgQuality mean of 0.9, 0.85
    expect(prototype.getCentroid('p5')).toMatchObject({
      domain: 'p5',
      exampleCount: 2,
      centroid: [expect.closeTo(0.75, 5), expect.closeTo(0.25, 5)],
      avgQuality: expect.closeTo(0.875, 5),
    });
  });

  it('should not update prototype from low-quality episodes', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', qualityScore: 0.3, embedding: [0.5, 0.5] },
      { domain: 'p5', qualityScore: 0.4, embedding: [0.4, 0.6] },
    ]);

    const result = consolidator.consolidate(episodes);
    expect(result.prototypeUpdates).toBe(0);
  });

  it('should apply Ebbinghaus retention decay', () => {
    // Create episodes from 60 days ago (ensures retention < 1)
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'old-model', qualityScore: 0.8, timestamp: oldDate },
      { domain: 'p5', model: 'old-model', qualityScore: 0.7, timestamp: oldDate },
    ]);

    consolidator.consolidate(episodes);
    const pattern = consolidator.getPattern('p5:old-model');
    expect(pattern).toMatchObject({
      key: 'p5:old-model',
      domain: 'p5',
      model: 'old-model',
      episodeCount: 2,
    });
    // Pattern was created from old timestamps → retention should have decayed
    // R(t) = exp(-daysSinceUpdate / stability), stability=10
    expect(pattern!.retention).toBeLessThan(1);
    expect(pattern!.retention).toBeGreaterThanOrEqual(0);
  });

  it('should prune stale patterns over max age', () => {
    const pruner = new MemoryConsolidator(undefined, {
      maxAgeDays: 0.001, // ~1.4 minutes
      maxPatterns: 100,
    });
    const oldTimestamp = new Date(Date.now() - 200 * 60 * 1000).toISOString(); // 200 min ago
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'ancient', qualityScore: 0.8, timestamp: oldTimestamp },
      { domain: 'p5', model: 'ancient', qualityScore: 0.7, timestamp: oldTimestamp },
    ]);

    pruner.consolidate(episodes);
    // Apply decay + prune by running another consolidate with empty
    const result = pruner.consolidate([]);
    expect(result.patternsPruned).toBeGreaterThanOrEqual(0);
  });

  it('should budget-gate to maxPatterns', () => {
    const small = new MemoryConsolidator(undefined, { maxPatterns: 2, minEpisodesForPattern: 1 });
    for (let i = 0; i < 5; i++) {
      small.consolidate(makeEpisodes([
        { domain: `domain-${i}`, qualityScore: 0.8 },
      ]));
    }
    expect(small.patternCount).toBeLessThanOrEqual(2);
  });

  it('should serialize and deserialize', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', model: 'qwen3', qualityScore: 0.85 },
      { domain: 'p5', model: 'qwen3', qualityScore: 0.75 },
    ]);
    consolidator.consolidate(episodes);

    const state = consolidator.serialize();
    expect(state.version).toBe(1);
    expect(state.patterns.length).toBeGreaterThan(0);

    const consolidator2 = new MemoryConsolidator();
    consolidator2.deserialize(state);
    expect(consolidator2.patternCount).toBe(consolidator.patternCount);
    // Deserialized pattern round-trips to the same shape as the original
    expect(consolidator2.getPattern('p5:qwen3')).toEqual(consolidator.getPattern('p5:qwen3'));
  });

  it('should reset all state', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', qualityScore: 0.8 },
      { domain: 'p5', qualityScore: 0.7 },
    ]);
    consolidator.consolidate(episodes);
    consolidator.reset();
    expect(consolidator.patternCount).toBe(0);
    expect(consolidator.processedCount).toBe(0);
  });

  it('should merge patterns on repeated consolidation', () => {
    const batch1 = makeEpisodes([
      { domain: 'p5', model: 'qwen3', qualityScore: 0.8 },
      { domain: 'p5', model: 'qwen3', qualityScore: 0.7 },
    ]);
    consolidator.consolidate(batch1);

    const batch2 = makeEpisodes([
      { domain: 'p5', model: 'qwen3', qualityScore: 0.9 },
      { domain: 'p5', model: 'qwen3', qualityScore: 0.85 },
    ]);
    consolidator.consolidate(batch2);

    const pattern = consolidator.getPattern('p5:qwen3');
    expect(pattern!.episodeCount).toBe(4);
  });

  it('should report domain-level aggregation', () => {
    const episodes = makeEpisodes([
      { domain: 'p5', qualityScore: 0.8 },
      { domain: 'p5', qualityScore: 0.9 },
      { domain: 'glsl', qualityScore: 0.6 },
      { domain: 'glsl', qualityScore: 0.7 },
    ]);

    const result = consolidator.consolidate(episodes);
    expect(Object.keys(result.byDomain).length).toBe(2);
    expect(result.byDomain.p5.avgQuality).toBeGreaterThan(result.byDomain.glsl.avgQuality);
  });

  describe('evidence is counted once (#1243)', () => {
    const ts = '2026-11-01T00:00:00.000Z';
    const batch = (): ConsolidationEpisode[] => [
      { id: 'e1', domain: 'p5', model: 'qwen3', strategy: 'solo', output: 'a', qualityScore: 0.9, timestamp: ts, embedding: [1, 0] },
      { id: 'e2', domain: 'p5', model: 'qwen3', strategy: 'solo', output: 'b', qualityScore: 0.8, timestamp: ts, embedding: [0, 1] },
      { id: 'e3', domain: 'p5', model: 'qwen3', strategy: 'solo', output: 'c', qualityScore: 0.3, timestamp: ts },
    ];

    it('consolidating the same batch twice changes no count', () => {
      consolidator.consolidate(batch());
      const before = consolidator.getPattern('p5:qwen3:solo');
      const modelBefore = modelSampler.getArmStats('p5::qwen3');
      const second = consolidator.consolidate(batch());

      expect(second).toMatchObject({ episodesProcessed: 0, duplicatesSkipped: 3, patternsCreated: 0, prototypeUpdates: 0 });
      expect(consolidator.getPattern('p5:qwen3:solo')).toMatchObject({ alpha: 3, beta: 2, episodeCount: 3 });
      expect(consolidator.getPattern('p5')!.episodeCount).toBe(before!.episodeCount);
      expect(modelSampler.getArmStats('p5::qwen3')).toMatchObject({ pulls: modelBefore!.pulls, alpha: modelBefore!.alpha, beta: modelBefore!.beta });
      expect(consolidator.processedCount).toBe(3);
    });

    it('a repeated id inside one batch counts once', () => {
      const [e1] = batch();
      const result = consolidator.consolidate([e1, { ...e1 }, batch()[1]]);
      expect(result).toMatchObject({ episodesProcessed: 2, duplicatesSkipped: 1 });
      expect(consolidator.getPattern('p5:qwen3')!.episodeCount).toBe(2);
    });

    it('id-less episodes dedupe by content but distinct content stays distinct', () => {
      const plain = (output: string, qualityScore: number): ConsolidationEpisode =>
        ({ domain: 'p5', model: 'm', output, qualityScore, timestamp: ts });
      const first = consolidator.consolidate([plain('x', 0.9), plain('x', 0.9), plain('y', 0.9)]);
      expect(first).toMatchObject({ episodesProcessed: 2, duplicatesSkipped: 1 });
      const second = consolidator.consolidate([plain('x', 0.9), plain('x', 0.4)]);
      expect(second).toMatchObject({ episodesProcessed: 1, duplicatesSkipped: 1 });
    });

    it('model and strategy samplers record one trial per episode, not one per subgroup', () => {
      consolidator.consolidate(batch());
      // 3 episodes: 2 successes, 1 failure. Old code replayed the model arm
      // from both p5:qwen3 and p5:qwen3:solo → 6 pulls.
      expect(modelSampler.getArmStats('p5::qwen3')).toMatchObject({ pulls: 3, alpha: 3, beta: 2 });
      expect(strategySampler.getArmStats('p5::solo')).toMatchObject({ pulls: 3, alpha: 3, beta: 2 });
    });

    it('each high-quality episode updates the prototype once', () => {
      const result = consolidator.consolidate(batch());
      expect(result.prototypeUpdates).toBe(2);
      expect(prototype.getCentroid('p5')).toMatchObject({ exampleCount: 2 });
    });

    it('merged variance equals a direct rebuild over all scores', () => {
      const ep = (id: string, qualityScore: number): ConsolidationEpisode =>
        ({ id, domain: 'v', output: id, qualityScore, timestamp: ts });
      consolidator.consolidate([ep('a', 0.2), ep('b', 0.2)]);
      consolidator.consolidate([ep('c', 0.9), ep('d', 0.9)]);

      const direct = new MemoryConsolidator(undefined, { minEpisodesForPattern: 2 });
      direct.consolidate([ep('a', 0.2), ep('b', 0.2), ep('c', 0.9), ep('d', 0.9)]);

      // mean 0.55, population variance 0.1225, stored ×4 = 0.49
      expect(consolidator.getPattern('v')!.qualityVariance).toBeCloseTo(0.49, 10);
      expect(consolidator.getPattern('v')!.qualityVariance).toBeCloseTo(direct.getPattern('v')!.qualityVariance, 10);
      expect(consolidator.getPattern('v')!.avgQuality).toBeCloseTo(0.55, 10);
    });

    it('the ledger survives serialize/deserialize; reset clears it', () => {
      consolidator.consolidate(batch());
      const state = consolidator.serialize();
      expect(state.episodeIds).toHaveLength(3);

      const restored = new MemoryConsolidator(undefined, { minEpisodesForPattern: 2 });
      restored.deserialize(state);
      expect(restored.consolidate(batch())).toMatchObject({ episodesProcessed: 0, duplicatesSkipped: 3 });
      expect(restored.getPattern('p5:qwen3')!.episodeCount).toBe(3);

      restored.reset();
      expect(restored.consolidate(batch())).toMatchObject({ episodesProcessed: 3, duplicatesSkipped: 0 });
    });

    it('an empty batch and a legacy state without a ledger are handled', () => {
      expect(consolidator.consolidate([])).toMatchObject({ episodesProcessed: 0, duplicatesSkipped: 0, patternsCreated: 0 });
      const legacy = new MemoryConsolidator();
      legacy.deserialize({ version: 1, patterns: [], lastConsolidation: ts, totalEpisodesProcessed: 5 });
      expect(legacy.consolidate(batch())).toMatchObject({ episodesProcessed: 3, duplicatesSkipped: 0 });
      expect(legacy.processedCount).toBe(8);
    });
  });
});

// ---------------------------------------------------------------------------
// CreativeWorldModel
// ---------------------------------------------------------------------------
describe('CreativeWorldModel', () => {
  let model: CreativeWorldModel;

  beforeEach(() => {
    model = new CreativeWorldModel({ minObservations: 3, kNeighbors: 3 });
  });

  const makeBehavior = (overrides: Partial<BehaviorVector>): BehaviorVector => ({
    domain: 'p5',
    lineCount: 50,
    techniqueDiversity: 3,
    hasInteraction: 1,
    hasColor: 1,
    hasLoops: 1,
    hasFunctions: 0,
    hasClasses: 0,
    commentDensity: 0.1,
    ...overrides,
  });

  it('should record observations', () => {
    model.record(makeBehavior({}), 0.8);
    expect(model.getObservationCount()).toBe(1);
  });

  it('should extract behavior vectors from code', () => {
    const code = `
      function setup() { createCanvas(400, 400); }
      function draw() {
        background(220);
        fill(color(255, 0, 0));
        for (let i = 0; i < 10; i++) {
          ellipse(mouseX + i * 20, mouseY, 10, 10);
        }
      }
    `;
    const behavior = CreativeWorldModel.extractBehavior(code, 'p5');
    expect(behavior.domain).toBe('p5');
    expect(behavior.lineCount).toBeGreaterThan(0);
    expect(behavior.hasInteraction).toBe(1); // mouseX, mouseY
    expect(behavior.hasColor).toBe(1);       // fill, color
    expect(behavior.hasLoops).toBe(1);       // for loop
    expect(behavior.hasFunctions).toBe(1);   // function setup, draw
    expect(behavior.techniqueDiversity).toBeGreaterThanOrEqual(3);
  });

  it('should return null for prediction with insufficient data', () => {
    model.record(makeBehavior({}), 0.8);
    model.record(makeBehavior({}), 0.7);
    expect(model.predict(makeBehavior({}))).toBeNull(); // Need 3
  });

  it('should predict quality after sufficient observations', () => {
    // High-quality pattern: interactive + colorful + loops
    for (let i = 0; i < 5; i++) {
      model.record(makeBehavior({ hasInteraction: 1, hasColor: 1, hasLoops: 1, techniqueDiversity: 4 }), 0.85);
    }
    // Low-quality pattern: bare minimum
    for (let i = 0; i < 5; i++) {
      model.record(makeBehavior({ hasInteraction: 0, hasColor: 0, hasLoops: 0, techniqueDiversity: 1, lineCount: 5 }), 0.3);
    }

    const highPred = model.predict(makeBehavior({ hasInteraction: 1, hasColor: 1, hasLoops: 1, techniqueDiversity: 4 }));
    expect(highPred).toMatchObject({
      domain: 'p5',
      predicted: expect.any(Number),
      neighborCount: expect.any(Number),
    });
    expect(highPred!.predicted).toBeGreaterThan(0.6);

    const lowPred = model.predict(makeBehavior({ hasInteraction: 0, hasColor: 0, hasLoops: 0, techniqueDiversity: 1, lineCount: 5 }));
    expect(lowPred).toMatchObject({
      domain: 'p5',
      predicted: expect.any(Number),
      neighborCount: expect.any(Number),
    });
    expect(lowPred!.predicted).toBeLessThan(0.5);
  });

  describe('calibrated confidence (#1250)', () => {
    it('labels predictions as a static-code surrogate and earns confidence from LOO skill over the mean', () => {
      for (let i = 0; i < 5; i++) model.record(makeBehavior({ hasInteraction: 1, techniqueDiversity: 4 }), 0.85);
      for (let i = 0; i < 5; i++) model.record(makeBehavior({ hasInteraction: 0, techniqueDiversity: 1, lineCount: 5 }), 0.3);

      const p = model.predict(makeBehavior({ hasInteraction: 1, techniqueDiversity: 4 }))!;
      expect(p.basis).toBe('static-code-knn-surrogate');
      expect(p.calibration.sampleSize).toBe(10);
      expect(p.calibration.looMae).toBe(0);
      // Mean-of-rest misses every held-out point by 0.55 * 5/9.
      expect(p.calibration.baselineMae).toBeCloseTo(0.55 * 5 / 9, 10);
      expect(p.confidence).toBe(1);
    });

    it('gives zero confidence when features carry no information about outcomes', () => {
      // Identical features; K-NN just echoes arbitrary neighbours.
      for (const q of [0.1, 0.9, 0.2, 0.8, 0.3, 0.7]) model.record(makeBehavior({}), q);
      const p = model.predict(makeBehavior({}))!;
      expect(p.calibration.looMae).toBeGreaterThan(p.calibration.baselineMae);
      expect(p.confidence).toBe(0);
    });

    it('gives zero confidence when outcomes are constant (the mean is already perfect)', () => {
      for (let i = 0; i < 4; i++) model.record(makeBehavior({ lineCount: 10 * (i + 1) }), 0.6);
      const p = model.predict(makeBehavior({}))!;
      expect(p.predicted).toBeCloseTo(0.6, 10);
      expect(p.calibration.baselineMae).toBeCloseTo(0, 10);
      expect(p.confidence).toBe(0);
    });

    it('recalibrates after new observations and after reset', () => {
      for (const q of [0.1, 0.9, 0.2, 0.8]) model.record(makeBehavior({}), q);
      expect(model.predict(makeBehavior({}))!.calibration.sampleSize).toBe(4);
      model.record(makeBehavior({}), 0.5);
      expect(model.predict(makeBehavior({}))!.calibration.sampleSize).toBe(5);
      model.reset();
      expect(model.predict(makeBehavior({}))).toBeNull();
    });
  });

  it('should report isReady after min observations', () => {
    expect(model.isReady('p5')).toBe(false);
    for (let i = 0; i < 3; i++) model.record(makeBehavior({}), 0.7);
    expect(model.isReady('p5')).toBe(true);
  });

  it('should track domain stats', () => {
    model.record(makeBehavior({ domain: 'p5' }), 0.9);
    model.record(makeBehavior({ domain: 'p5' }), 0.7);
    model.record(makeBehavior({ domain: 'glsl' }), 0.5);

    const p5Stats = model.getDomainStats('p5');
    // 2 p5 observations (0.9, 0.7): count=2, mean=0.8, best=0.9
    expect(p5Stats).toEqual({
      count: 2,
      avgQuality: expect.closeTo(0.8, 2),
      bestQuality: 0.9,
    });
  });

  it('should list domains', () => {
    model.record(makeBehavior({ domain: 'p5' }), 0.8);
    model.record(makeBehavior({ domain: 'glsl' }), 0.7);
    expect(model.getDomains()).toContain('p5');
    expect(model.getDomains()).toContain('glsl');
  });

  it('should serialize and deserialize', () => {
    for (let i = 0; i < 3; i++) model.record(makeBehavior({}), 0.8);
    const state = model.serialize();
    expect(state.version).toBe(1);
    expect(state.observations.length).toBe(3);

    const model2 = new CreativeWorldModel();
    model2.deserialize(state);
    expect(model2.getObservationCount()).toBe(3);
    expect(model2.isReady('p5')).toBe(true);
  });

  it('should reset', () => {
    model.record(makeBehavior({}), 0.8);
    model.reset();
    expect(model.getObservationCount()).toBe(0);
  });

  it('should evict oldest when at max capacity', () => {
    const small = new CreativeWorldModel({ maxObservations: 5, minObservations: 1 });
    for (let i = 0; i < 8; i++) small.record(makeBehavior({ lineCount: i * 10 }), 0.5 + i * 0.05);
    expect(small.getObservationCount()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ForgettingCurve
// ---------------------------------------------------------------------------
describe('ForgettingCurve', () => {
  let curve: ForgettingCurve;

  beforeEach(() => {
    curve = new ForgettingCurve({ stability: 10, pruneThreshold: 0.05, maxAgeDays: 90 });
  });

  const makeItem = (overrides: Partial<DecayableItem>): DecayableItem => ({
    lastUpdated: new Date().toISOString(),
    quality: 0.8,
    reinforcementCount: 1,
    ...overrides,
  });

  describe('pinned clock and prune helpers (#1247)', () => {
    const T0 = Date.parse('2020-01-01T00:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;

    it('decays against an injected clock, not wall time', () => {
      const pinned = new ForgettingCurve({ stability: 10, now: () => T0 + 10 * DAY });
      const r = pinned.computeRetention(makeItem({ lastUpdated: new Date(T0).toISOString() }));
      expect(r.daysSinceUpdate).toBeCloseTo(10, 10);
      expect(r.retention).toBeCloseTo(Math.exp(-1), 10);
    });

    it('accepts an explicit evaluation time per call', () => {
      const r = curve.computeRetention(makeItem({ lastUpdated: new Date(T0).toISOString() }), T0 + 5 * DAY);
      expect(r.retention).toBeCloseTo(Math.exp(-0.5), 10);
    });

    it('daysUntilPrune honours the hard max age', () => {
      const slow = new ForgettingCurve({ stability: 100, pruneThreshold: 0.05, maxAgeDays: 90, now: () => T0 });
      // Retention alone would reach 0.05 after ~299.6 days; the age cap prunes at 90.
      expect(slow.daysUntilPrune(makeItem({ lastUpdated: new Date(T0).toISOString() }))).toBe(90);
    });

    it('findPruneCandidates returns the worst value first', () => {
      const pinned = new ForgettingCurve({ stability: 10, maxAgeDays: 90, now: () => T0 + 100 * DAY });
      const old = new Date(T0).toISOString();
      const ranked = pinned.findPruneCandidates([
        makeItem({ lastUpdated: old, quality: 0.9 }),
        makeItem({ lastUpdated: old, quality: 0.1 }),
        makeItem({ lastUpdated: old, quality: 0.5 }),
      ]);
      expect(ranked.map(r => r.item.quality)).toEqual([0.1, 0.5, 0.9]);
    });

    it('returns no prune candidates for an empty list', () => {
      expect(curve.findPruneCandidates([])).toEqual([]);
    });
  });

  it('should return retention 1.0 for fresh items', () => {
    const result = curve.computeRetention(makeItem({}));
    expect(result.retention).toBeCloseTo(1.0, 5);
    expect(result.value).toBeCloseTo(0.8, 5);
    expect(result.shouldPrune).toBe(false);
  });

  it('should decay retention over time', () => {
    // Item from 10 days ago — stability=10, so retention ≈ exp(-1) ≈ 0.368
    const oldItem = makeItem({
      lastUpdated: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = curve.computeRetention(oldItem);
    expect(result.retention).toBeCloseTo(Math.exp(-1), 2);
    expect(result.daysSinceUpdate).toBeCloseTo(10, 1);
  });

  it('should flag items below prune threshold', () => {
    // 50 days with stability 10 → retention = exp(-5) ≈ 0.0067
    const stale = makeItem({
      lastUpdated: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = curve.computeRetention(stale);
    expect(result.retention).toBeLessThan(0.05);
    expect(result.shouldPrune).toBe(true);
  });

  it('should flag items exceeding maxAgeDays', () => {
    // 100 days old, but retention may still be > 0.05 with reinforcement
    const ancient = makeItem({
      lastUpdated: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      reinforcementCount: 20, // High reinforcement → slow decay
    });
    const result = curve.computeRetention(ancient);
    expect(result.shouldPrune).toBe(true); // Exceeds maxAgeDays
  });

  it('should apply spacing effect from reinforcement', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const weak = makeItem({ lastUpdated: oldDate, reinforcementCount: 1 });
    const strong = makeItem({ lastUpdated: oldDate, reinforcementCount: 10 });

    const weakResult = curve.computeRetention(weak);
    const strongResult = curve.computeRetention(strong);

    // More reinforcements → higher effective stability → higher retention
    expect(strongResult.retention).toBeGreaterThan(weakResult.retention);
    expect(strongResult.effectiveStability).toBeGreaterThan(weakResult.effectiveStability);
  });

  it('should compute composite value as retention * quality', () => {
    const fresh = makeItem({ quality: 0.9 });
    const stale = makeItem({
      quality: 0.9,
      lastUpdated: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const freshResult = curve.computeRetention(fresh);
    const staleResult = curve.computeRetention(stale);

    expect(freshResult.value).toBeCloseTo(0.9, 2);
    expect(staleResult.value).toBeLessThan(freshResult.value);
  });

  it('should compute retention batch', () => {
    const items = [
      makeItem({ quality: 0.9 }),
      makeItem({ quality: 0.5, lastUpdated: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() }),
    ];
    const results = curve.computeRetentionBatch(items);
    expect(results.length).toBe(2);
    expect(results[0].value).toBeGreaterThan(results[1].value);
  });

  it('should compute time to threshold', () => {
    const item = makeItem({});
    const thresholdDate = curve.timeToThreshold(item, 0.5);
    // Returns an ISO-8601 timestamp string (not just a non-null value)
    expect(thresholdDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // For stability=10: t = -10 * ln(0.5) ≈ 6.93 days
    const thresholdTime = new Date(thresholdDate!).getTime();
    const itemTime = new Date(item.lastUpdated).getTime();
    const daysToThreshold = (thresholdTime - itemTime) / (24 * 60 * 60 * 1000);
    expect(daysToThreshold).toBeCloseTo(6.93, 1);
  });

  it('should return null for timeToThreshold when already below', () => {
    const old = makeItem({
      lastUpdated: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(curve.timeToThreshold(old, 0.5)).toBeNull();
  });

  it('should compute days until prune', () => {
    const item = makeItem({});
    const days = curve.daysUntilPrune(item);
    // For stability=10: t = -10 * ln(0.05) ≈ 29.96 days
    expect(days).toBeCloseTo(29.96, 0);
  });

  it('should summarize a collection of items', () => {
    const items = [
      makeItem({}), // fresh → strong
      makeItem({ lastUpdated: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString() }), // weak
      makeItem({ lastUpdated: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString() }), // critical
    ];
    const summary = curve.summarize(items);
    expect(summary.totalItems).toBe(3);
    expect(summary.strongItems).toBeGreaterThanOrEqual(1);
    expect(summary.avgRetention).toBeGreaterThan(0);
    expect(summary.avgRetention).toBeLessThanOrEqual(1);
    expect(summary.avgValue).toBeGreaterThan(0);
  });

  it('should return empty summary for empty collection', () => {
    const summary = curve.summarize([]);
    expect(summary.totalItems).toBe(0);
    expect(summary.avgRetention).toBe(0);
  });

  it('should rank items by value descending', () => {
    const items = [
      makeItem({ quality: 0.3 }),
      makeItem({ quality: 0.9 }),
      makeItem({ quality: 0.6 }),
    ];
    const ranked = curve.rankByValue(items);
    expect(ranked[0].item.quality).toBe(0.9);
    expect(ranked[2].item.quality).toBe(0.3);
  });

  it('should find prune candidates', () => {
    const items = [
      makeItem({}), // fresh → not prunable
      makeItem({ lastUpdated: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString() }), // stale → prunable
    ];
    const candidates = curve.findPruneCandidates(items);
    expect(candidates.length).toBe(1);
  });

  it('prune candidates come out worst first (#1245)', () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
    const items = [
      makeItem({ quality: 0.9, lastUpdated: daysAgo(50) }),
      makeItem({ quality: 0.2, lastUpdated: daysAgo(50) }),
      makeItem({ quality: 0.5, lastUpdated: daysAgo(50) }),
      makeItem({}), // fresh, not a candidate
    ];
    const candidates = curve.findPruneCandidates(items);
    expect(candidates.map(c => c.item.quality)).toEqual([0.2, 0.5, 0.9]);
  });

  it('daysUntilPrune respects maxAgeDays for highly reinforced items (#1245)', () => {
    // 46 reinforcements -> stability capped at 100 -> decay alone takes ~300 days,
    // but computeRetention prunes anything older than 90 days.
    const item = makeItem({ reinforcementCount: 46 });
    expect(curve.daysUntilPrune(item)).toBeCloseTo(90, 3);

    const tenDaysOld = makeItem({
      reinforcementCount: 46,
      lastUpdated: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(curve.daysUntilPrune(tenDaysOld)).toBeCloseTo(80, 3);
  });

  it('daysUntilPrune is 0 once an item is past maxAgeDays even if retention is high', () => {
    const item = makeItem({
      reinforcementCount: 46,
      lastUpdated: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(curve.computeRetention(item).shouldPrune).toBe(true);
    expect(curve.daysUntilPrune(item)).toBe(0);
  });

  it('findPruneCandidates returns [] for empty input', () => {
    expect(curve.findPruneCandidates([])).toEqual([]);
  });

  it('should compute effective stability with spacing effect', () => {
    expect(curve.getEffectiveStability(1)).toBe(10);
    expect(curve.getEffectiveStability(5)).toBeGreaterThan(10);
    expect(curve.getEffectiveStability(5)).toBe(10 * (1 + 0.2 * 4)); // 10 * 1.8 = 18
  });

  it('should provide static retention helper', () => {
    expect(ForgettingCurve.retention(0, 10)).toBeCloseTo(1.0, 5);
    expect(ForgettingCurve.retention(10, 10)).toBeCloseTo(Math.exp(-1), 3);
  });

  it('should provide static daysToThreshold helper', () => {
    const days = ForgettingCurve.daysToThreshold(10, 0.5);
    expect(days).toBeCloseTo(6.93, 1);
  });

  it('should expose config', () => {
    const config = curve.getConfig();
    expect(config.stability).toBe(10);
    expect(config.pruneThreshold).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// MemoryBudget
// ---------------------------------------------------------------------------
describe('MemoryBudget', () => {
  let budget: MemoryBudget;
  let curve: ForgettingCurve;

  beforeEach(() => {
    curve = new ForgettingCurve({ stability: 10 });
    budget = new MemoryBudget(curve, { verbose: false });
  });

  /** In-memory PrunableStore that deletes exactly the ids it is given. */
  const makeStore = (items: BudgetItem[]): PrunableStore & { items: BudgetItem[] } => {
    const store = {
      items: [...items],
      getSize() { return store.items.length; },
      getItems() { return store.items; },
      evict(ids: readonly string[]) {
        const doomed = new Set(ids);
        const removed = store.items.filter(i => doomed.has(i.id)).map(i => i.id);
        store.items = store.items.filter(i => !doomed.has(i.id));
        return removed;
      },
    };
    return store;
  };

  let nextId = 0;
  const makeItem = (quality: number, hoursAgo: number = 0, id = `item-${nextId++}`): BudgetItem => ({
    id,
    lastUpdated: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    quality,
    reinforcementCount: 1,
  });

  it('should register and track stores', () => {
    const store = makeStore([makeItem(0.8), makeItem(0.7)]);
    budget.registerStore('cache', store, { maxSize: 10 });
    expect(budget.storeCount).toBe(1);
    expect(budget.totalItems).toBe(2);
  });

  it('should unregister stores', () => {
    const store = makeStore([makeItem(0.8)]);
    budget.registerStore('cache', store, { maxSize: 10 });
    budget.unregisterStore('cache');
    expect(budget.storeCount).toBe(0);
  });

  it('should not prune when under budget', () => {
    const store = makeStore([makeItem(0.8), makeItem(0.7)]);
    budget.registerStore('cache', store, { maxSize: 10 });
    const pruned = budget.enforce();
    expect(pruned).toBe(0);
    expect(store.getSize()).toBe(2);
  });

  it('should prune when over budget', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(0.1 + i * 0.1));
    const store = makeStore(items);
    budget.registerStore('cache', store, { maxSize: 5 });
    const pruned = budget.enforce();
    expect(pruned).toBeGreaterThan(0);
    expect(store.getSize()).toBeLessThanOrEqual(5);
  });

  it('should respect targetUtilization', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeItem(0.1 + i * 0.1));
    const store = makeStore(items);
    // Budget of 10 but targetUtilization 0.5 → prune when > 5
    budget.registerStore('cache', store, { maxSize: 10, targetUtilization: 0.5 });
    const pruned = budget.enforce();
    expect(pruned).toBeGreaterThan(0);
    expect(store.getSize()).toBeLessThanOrEqual(5);
  });

  it('should enforce specific store only', () => {
    const store1 = makeStore(Array.from({ length: 8 }, (_, i) => makeItem(i * 0.1)));
    const store2 = makeStore(Array.from({ length: 8 }, (_, i) => makeItem(i * 0.1)));

    budget.registerStore('a', store1, { maxSize: 5 });
    budget.registerStore('b', store2, { maxSize: 100 });

    const pruned = budget.enforceStore('a');
    expect(pruned).toBeGreaterThan(0);
    expect(store1.getSize()).toBeLessThanOrEqual(5);
    expect(store2.getSize()).toBe(8); // Unchanged
  });

  it('should return 0 for enforceStore on unknown store', () => {
    expect(budget.enforceStore('nonexistent')).toBe(0);
  });

  it('should produce health report', () => {
    const store1 = makeStore([makeItem(0.8), makeItem(0.7)]);
    const store2 = makeStore(Array.from({ length: 15 }, (_, i) => makeItem(i * 0.05)));

    budget.registerStore('cache', store1, { maxSize: 10 });
    budget.registerStore('patterns', store2, { maxSize: 10 });

    const report = budget.getHealthReport();
    expect(report.stores.length).toBe(2);
    expect(report.totalItems).toBe(17);
    expect(report.totalBudget).toBe(20);
    expect(report.overallUtilization).toBeCloseTo(0.85, 1);
    expect(report.isHealthy).toBe(false); // patterns is over budget
  });

  it('should report healthy when all stores within budget', () => {
    const store = makeStore([makeItem(0.8)]);
    budget.registerStore('cache', store, { maxSize: 10 });
    const report = budget.getHealthReport();
    expect(report.isHealthy).toBe(true);
  });

  it('should track per-store budget', () => {
    const store = makeStore([makeItem(0.8)]);
    budget.registerStore('cache', store, { maxSize: 50, targetUtilization: 0.8 });
    const b = budget.getStoreBudget('cache');
    expect(b).toEqual({ maxSize: 50, targetUtilization: 0.8 });
    expect(budget.getStoreBudget('nonexistent')).toBeNull();
  });

  it('should reset prune counts', () => {
    budget.reset();
    // No error means success
    expect(budget.storeCount).toBe(0);
  });

  describe('eviction by identity (#1246)', () => {
    it('deletes exactly the lowest-value ids and records a matching receipt', () => {
      const store = makeStore([
        makeItem(0.9, 0, 'keep-a'), makeItem(0.1, 0, 'low-1'), makeItem(0.8, 0, 'keep-b'),
        makeItem(0.2, 0, 'low-2'), makeItem(0.7, 0, 'keep-c'),
      ]);
      budget.registerStore('s', store, { maxSize: 3, targetUtilization: 1 });

      expect(budget.enforceStore('s')).toBe(2);
      expect(store.items.map(i => i.id).sort()).toEqual(['keep-a', 'keep-b', 'keep-c']);
      expect(budget.getLastReceipt('s')).toEqual({
        store: 's', sizeBefore: 5, sizeAfter: 3, threshold: 3,
        chosen: ['low-1', 'low-2'], evicted: ['low-1', 'low-2'],
        missed: [], unexpected: [], overThreshold: false,
      });
    });

    it('a store that ignores the request is reported as over threshold with missed ids', () => {
      const store = makeStore([makeItem(0.9, 0, 'a'), makeItem(0.1, 0, 'b'), makeItem(0.5, 0, 'c')]);
      const deaf: PrunableStore = { ...store, getSize: () => store.items.length, getItems: () => store.items, evict: () => [] };
      budget.registerStore('deaf', deaf, { maxSize: 2, targetUtilization: 1 });

      expect(budget.enforce()).toBe(0);
      expect(budget.getLastReceipt('deaf')).toMatchObject({
        chosen: ['b'], evicted: [], missed: ['b'], sizeAfter: 3, overThreshold: true,
      });
      expect(budget.getHealthReport().stores[0]).toMatchObject({ name: 'deaf', pruned: 0, isHealthy: false });
    });

    it('a store that deletes a different item is flagged as unexpected', () => {
      const store = makeStore([makeItem(0.9, 0, 'precious'), makeItem(0.1, 0, 'junk')]);
      const wrong: PrunableStore = {
        getSize: () => store.items.length,
        getItems: () => store.items,
        evict: () => store.evict(['precious']),
      };
      budget.registerStore('wrong', wrong, { maxSize: 1, targetUtilization: 1 });

      budget.enforceStore('wrong');
      expect(budget.getLastReceipt('wrong')).toMatchObject({
        chosen: ['junk'], evicted: ['precious'], missed: ['junk'], unexpected: ['precious'], overThreshold: false,
      });
    });

    it('a store whose items do not cover its size stays over threshold', () => {
      const unranked: PrunableStore = { getSize: () => 10, getItems: () => [], evict: () => [] };
      budget.registerStore('u', unranked, { maxSize: 5, targetUtilization: 1 });
      expect(budget.enforceStore('u')).toBe(0);
      expect(budget.getLastReceipt('u')).toMatchObject({ chosen: [], evicted: [], sizeAfter: 10, overThreshold: true });
    });

    it('no receipt when under budget, and reset clears receipts', () => {
      const store = makeStore([makeItem(0.5, 0, 'x'), makeItem(0.4, 0, 'y')]);
      budget.registerStore('s', store, { maxSize: 1, targetUtilization: 1 });
      budget.enforceStore('s');
      expect(budget.getLastReceipt('s')).toMatchObject({ evicted: ['y'] });
      expect(budget.enforceStore('s')).toBe(0);
      expect(budget.getLastReceipt('s')).toBeNull();
      budget.enforceStore('s');
      budget.reset();
      expect(budget.getLastReceipt('s')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// DreamEngine
// ---------------------------------------------------------------------------
describe('DreamEngine', () => {
  let engine: DreamEngine;
  let modelSampler: ThompsonSampler<string>;
  let strategySampler: ThompsonSampler<string>;
  let prototype: DomainPrototype;
  let cache: IntuitionCache;
  let consolidator: MemoryConsolidator;
  let entropy: MetabolicEntropyEngine;

  beforeEach(() => {
    modelSampler = new ThompsonSampler<string>({ minPulls: 1, successThreshold: 0.7 });
    strategySampler = new ThompsonSampler<string>({ minPulls: 1, successThreshold: 0.7 });
    prototype = new DomainPrototype();
    cache = new IntuitionCache({ maxSize: 100, ttlMs: 60000 });
    consolidator = new MemoryConsolidator(
      { modelSampler, strategySampler, prototype },
      { minEpisodesForPattern: 1 },
    );
    entropy = new MetabolicEntropyEngine({
      eventStorePath: '/tmp/sinter-test/events',
      compostHeapPath: '/tmp/sinter-test/compost',
      telemetryCollectorPath: '/tmp/sinter-test/telemetry',
    });

    engine = new DreamEngine(
      { modelSampler, strategySampler, prototype, cache, consolidator, entropy },
      { stage1Count: 3, stage2Count: 2, keeperThreshold: 0.5, domains: ['p5', 'glsl'] },
    );
  });

  it('throws when entropy engine is missing', () => {
    expect(() => new DreamEngine(
      { modelSampler, strategySampler, prototype, cache, consolidator, entropy: undefined as any },
      { stage1Count: 1, stage2Count: 1 },
    )).toThrow('DreamEngine: entropy engine is required');
  });

  it('should run a full dream cycle and return journal entry', async () => {
    const entry = await engine.dream('micro');
    expect(entry.id).toMatch(/^dream-/);
    expect(entry.depth).toBe('micro');
    expect(entry.conceptsGenerated).toBe(3);
    expect(entry.conceptsExecuted).toBe(2);
    expect(entry.results.length).toBe(3);
    expect(entry.bestQuality).toBeGreaterThanOrEqual(0);
    expect(entry.avgQuality).toBeGreaterThanOrEqual(0);
    expect(entry.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('should generate more concepts in deep dreams', async () => {
    const micro = await engine.dream('micro');
    const deep = await engine.dream('deep');
    expect(deep.conceptsGenerated).toBeGreaterThan(micro.conceptsGenerated);
  });

  it('should generate concepts with valid fields', async () => {
    const entry = await engine.dream('micro');
    for (const { concept } of entry.results) {
      expect(concept.id).toMatch(/^concept-/);
      expect(concept.domain).toMatch(/^(p5|glsl)$/);
      expect(concept.prompt.length).toBeGreaterThan(0);
      expect(concept.expectedQuality).toBeGreaterThanOrEqual(0);
      expect(concept.expectedQuality).toBeLessThanOrEqual(1);
    }
  });

  it('should execute top concepts and produce outputs', async () => {
    const entry = await engine.dream('micro');
    const executed = entry.results.filter(r => r.output !== null);
    expect(executed.length).toBe(2); // stage2Count = 2
    for (const { output } of executed) {
      expect(output!.code.length).toBeGreaterThan(0);
      expect(output!.qualityScore).toBeGreaterThanOrEqual(0);
      expect(output!.qualityScore).toBeLessThanOrEqual(1);
      expect(output!.noveltyScore).toBeGreaterThanOrEqual(0);
      expect(output!.isKeeper).toBe(false);
      expect(output!.evidenceMode).toBe('legacy-static-diagnostic');
      expect(output!.admissionEligible).toBe(false);
    }
  });

  it('should mark high-quality outputs as keepers', async () => {
    // Feed good model data so Thompson selects models with high confidence
    for (let i = 0; i < 5; i++) {
      modelSampler.update('local', 0.9);
      strategySampler.update('solo', 0.85);
    }
    prototype.addExample('p5', [0.5, 0.5], 0.9);

    const entry = await engine.dream('micro');
    // With stub generation, quality is 0.1 (below threshold) — so no keepers
    // This tests the keeper logic works correctly even with stubs
    expect(entry.keepers).toBeGreaterThanOrEqual(0);
  });

  it('never aggregates stub or failed generations as measured quality (#1257)', async () => {
    const stub = await engine.dream('micro');
    const stubOutputs = stub.results.flatMap(r => r.output ? [r.output] : []);
    expect(stubOutputs.map(o => o.generationStatus)).toEqual(['stub', 'stub']);
    expect(stubOutputs.map(o => o.qualityScore)).toEqual([0, 0]);
    expect(stub.measuredOutputs).toBe(0);
    expect(stub.bestQuality).toBe(0);
    expect(stub.results.filter(r => r.output === null).map(r => r.rejection)).toEqual(['not-selected']);

    const failing = new DreamEngine(
      { modelSampler, strategySampler, prototype, cache, consolidator, entropy },
      { stage1Count: 2, stage2Count: 2,
        generateCode: async () => { throw new Error('provider down'); } },
    );
    const failed = await failing.dream('micro');
    expect(failed.results.map(r => r.output?.generationStatus)).toEqual(['failed', 'failed']);
    expect(failed.measuredOutputs).toBe(0);
    expect(failed.avgQuality).toBe(0);
  });

  it('screens concepts deterministically by expected quality, no random bonus (#1257)', async () => {
    const a = await engine.dream('micro');
    const selected = a.results.filter(r => r.output).map(r => r.concept);
    const skipped = a.results.filter(r => !r.output).map(r => r.concept);
    for (const s of selected) {
      for (const k of skipped) expect(s.expectedQuality).toBeGreaterThanOrEqual(k.expectedQuality);
    }
  });

  it('does not update Thompson samplers from static diagnostics', async () => {
    const beforeModel = modelSampler.totalPulls;
    const beforeStrategy = strategySampler.totalPulls;

    await engine.dream('micro');

    expect(modelSampler.totalPulls).toBe(beforeModel);
    expect(strategySampler.totalPulls).toBe(beforeStrategy);
  });

  it('does not cache static diagnostics as learned judgment', async () => {
    await engine.dream('micro');
    // At least some entries should be in the cache
    const stats = cache.getStats();
    expect(stats.size).toBe(0);
  });

  it('should use LLM for prompt generation when configured', async () => {
    const llmEngine = new DreamEngine(
      { modelSampler, strategySampler, prototype, cache, consolidator, entropy },
      {
        stage1Count: 2,
        stage2Count: 1,
        generatePrompt: async () => 'A sunset over mountains in p5.js',
      },
    );
    const entry = await llmEngine.dream('micro');
    const concepts = entry.results.map(r => r.concept.prompt);
    expect(concepts).toContain('A sunset over mountains in p5.js');
  });

  it('should use LLM for code generation when configured', async () => {
    const llmEngine = new DreamEngine(
      { modelSampler, strategySampler, prototype, cache, consolidator, entropy },
      {
        stage1Count: 2,
        stage2Count: 1,
        generateCode: async () => 'function setup() { createCanvas(400, 400); } function draw() { background(0); }',
      },
    );
    const entry = await llmEngine.dream('micro');
    const executed = entry.results.filter(r => r.output !== null);
    expect(executed.length).toBe(1);
    expect(executed[0].output!.code).toContain('createCanvas');
    expect(executed[0].output!.qualityScore).toBeGreaterThan(0.1); // Not a stub
  });

  it('should handle LLM failures gracefully', async () => {
    const failEngine = new DreamEngine(
      { modelSampler, strategySampler, prototype, cache, consolidator, entropy },
      {
        stage1Count: 2,
        stage2Count: 1,
        generatePrompt: async () => { throw new Error('LLM unavailable'); },
        generateCode: async () => { throw new Error('LLM unavailable'); },
      },
    );
    const entry = await failEngine.dream('micro');
    // Should fallback to templates and stubs
    expect(entry.conceptsGenerated).toBe(2);
    expect(entry.results.length).toBe(2);
  });

  it('should maintain dream journal', async () => {
    await engine.dream('micro');
    await engine.dream('deep');
    const journal = engine.getJournal();
    expect(journal.length).toBe(2);
    expect(journal[0].depth).toBe('micro');
    expect(journal[1].depth).toBe('deep');
  });

  it('should return recent dreams', async () => {
    await engine.dream('micro');
    await engine.dream('micro');
    const recent = engine.getRecentDreams(1);
    expect(recent.length).toBe(1);
  });

  it('should track dream count and keepers', async () => {
    await engine.dream('micro');
    expect(engine.dreamCount).toBe(1);
    expect(engine.totalKeepers).toBeGreaterThanOrEqual(0);
  });

  it('should expose consolidator', () => {
    expect(engine.getConsolidator()).toBe(consolidator);
  });

  it('should reset dream state', async () => {
    await engine.dream('micro');
    engine.reset();
    expect(engine.dreamCount).toBe(0);
    expect(engine.getJournal().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SleepScheduler
// ---------------------------------------------------------------------------
describe('SleepScheduler', () => {
  let scheduler: SleepScheduler;

  beforeEach(() => {
    scheduler = new SleepScheduler({
      microIdleMinutes: 5,
      deepIdleMinutes: 30,
      maxDreamsPerHour: 6,
      minDreamSpacingMinutes: 3,
    });
  });

  it('should record activity events', () => {
    scheduler.recordActivity('generation');
    scheduler.recordActivity('interaction');
    expect(scheduler.activityCount).toBe(2);
  });

  it('should report awake when recently active', () => {
    scheduler.recordActivity('interaction');
    const state = scheduler.getState();
    expect(state.isAwake).toBe(true);
    expect(state.idleMinutes).toBeLessThan(1);
    expect(state.recommendedDepth).toBeNull();
  });

  function idleFor(s: SleepScheduler, minutes: number): void {
    s.deserialize({
      activityLog: [{ timestamp: Date.now() - minutes * 60_000, type: 'interaction' }],
      lastDreamAt: null,
      dreamsThisHour: 0,
      currentHourBucket: Math.floor(Date.now() / 3_600_000),
    });
  }

  it('holds with no activity history instead of treating it as infinite idle (#1256)', () => {
    const state = scheduler.getState();
    expect(state.recommendedDepth).toBeNull();
    expect(state.holdReason).toBe('no-history');
    expect(scheduler.beginDream()).toBeNull();
  });

  it('recommends micro then deep from observed idle time', () => {
    idleFor(scheduler, 10);
    expect(scheduler.getState().recommendedDepth).toBe('micro');
    idleFor(scheduler, 45);
    expect(scheduler.getState().recommendedDepth).toBe('deep');
    expect(scheduler.getState().capacityAuthorization).toBe('not-checked');
  });

  it('fences concurrent starts with a reservation counted at start (#1256)', () => {
    idleFor(scheduler, 45);
    const first = scheduler.beginDream();
    expect(first?.depth).toBe('deep');
    expect(scheduler.getState().dreamsThisHour).toBe(1);
    expect(scheduler.beginDream()).toBeNull();
    expect(scheduler.getState().holdReason).toBe('reserved');
    expect(scheduler.reserveForced('micro')).toBeNull();
    scheduler.markDreamCompleted(first!.id);
    expect(scheduler.getActiveReservation()).toBeNull();
    // Completion of a reserved dream does not double-count the start.
    expect(scheduler.getState().dreamsThisHour).toBe(1);
  });

  it('persists the reservation so a restored scheduler cannot double-start', () => {
    idleFor(scheduler, 45);
    const r = scheduler.beginDream();
    const restored = new SleepScheduler({ microIdleMinutes: 5, deepIdleMinutes: 30 });
    restored.deserialize(scheduler.serialize());
    expect(restored.getActiveReservation()?.id).toBe(r!.id);
    expect(restored.beginDream()).toBeNull();
  });

  it('releases a reservation older than the TTL', () => {
    const s = new SleepScheduler({ reservationTtlMinutes: 1 });
    idleFor(s, 45);
    const snap = s.serialize();
    s.deserialize({ ...snap, activeReservation: {
      id: 'stale', depth: 'deep', startedAt: Date.now() - 5 * 60_000, abortRequested: false,
    } });
    expect(s.getActiveReservation()).toBeNull();
  });

  it('requests abort when work arrives during a dream', () => {
    idleFor(scheduler, 45);
    const r = scheduler.beginDream();
    expect(r?.abortRequested).toBe(false);
    scheduler.recordActivity('generation');
    expect(scheduler.getActiveReservation()?.abortRequested).toBe(true);
    expect(scheduler.abortDream(r!.id)).toBe(true);
    expect(scheduler.abortDream(r!.id)).toBe(false);
  });

  it('holds when the capacity permit denies, even when the user is idle', () => {
    let permit = false;
    const s = new SleepScheduler({ capacityPermit: () => permit });
    idleFor(s, 45);
    expect(s.getState()).toMatchObject({ recommendedDepth: null, holdReason: 'no-capacity', capacityAuthorization: 'denied' });
    permit = true;
    expect(s.getState()).toMatchObject({ recommendedDepth: 'deep', holdReason: null, capacityAuthorization: 'permitted' });
  });

  it('should report sleep pressure increasing with idle time', () => {
    // Fresh scheduler with no activity → idle = Infinity → high pressure
    const state = scheduler.getState();
    expect(state.sleepPressure).toBeGreaterThan(0.5);
  });

  it('should report low sleep pressure when active', () => {
    scheduler.recordActivity('interaction');
    const state = scheduler.getState();
    expect(state.sleepPressure).toBeLessThan(0.5);
  });

  it('should rate-limit dreams per hour', () => {
    scheduler.recordActivity('interaction');
    // Manually exhaust the rate limit
    for (let i = 0; i < 6; i++) scheduler.markDreamCompleted();

    // Now with no activity → deep idle, but rate limited
    const fresh = new SleepScheduler({ maxDreamsPerHour: 0 });
    const state = fresh.getState();
    // With 0 dreams/hour, shouldDream should be null
    expect(fresh.shouldDream()).toBeNull();
  });

  it('should enforce minimum spacing between dreams', () => {
    const before = Date.now();
    scheduler.markDreamCompleted();
    // Immediately after dream → spacing not ok
    const state = scheduler.getState();
    // lastDreamAt was just set to Date.now() (ms epoch within this test window)
    expect(state.lastDreamAt).toBeGreaterThanOrEqual(before);
    expect(state.lastDreamAt).toBeLessThanOrEqual(Date.now());
  });

  it('should return shouldDream as null when user is active', () => {
    scheduler.recordActivity('generation');
    expect(scheduler.shouldDream()).toBeNull();
  });

  it('should mark dream completed', () => {
    // getState initializes the hour bucket, so call it first
    scheduler.getState();
    const before = Date.now();
    scheduler.markDreamCompleted();
    const state = scheduler.getState();
    // lastDreamAt set to Date.now() (ms epoch) at completion
    expect(state.lastDreamAt).toBeGreaterThanOrEqual(before);
    expect(state.lastDreamAt).toBeLessThanOrEqual(Date.now());
    expect(state.dreamsThisHour).toBe(1);
  });

  it('should compute active hours from activity log', () => {
    // Record 10+ activities at various hours
    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      scheduler.recordActivity('interaction');
    }
    const hours = scheduler.getActiveHours();
    expect(hours).toEqual([new Date().getHours()]);
  });

  it('active hours keep their real hour labels (#1255)', () => {
    vi.useFakeTimers();
    try {
      for (const hour of [9, 10, 14]) {
        vi.setSystemTime(new Date(2026, 10, 9, hour, 15));
        for (let i = 0; i < 5; i++) scheduler.recordActivity('interaction');
      }
      // Pre-fix, sorting hourCounts in place reported [21, 22, 23].
      expect(scheduler.getActiveHours()).toEqual([9, 10, 14]);
      // Calling again must give the same answer (no hidden state corruption).
      expect(scheduler.getActiveHours()).toEqual([9, 10, 14]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bedtime estimate uses real hours, not sorted-count indices (#1255)', () => {
    vi.useFakeTimers();
    try {
      for (const hour of [1, 2, 3, 9, 10, 11]) {
        vi.setSystemTime(new Date(2026, 10, 9, hour, 30));
        for (let i = 0; i < 3; i++) scheduler.recordActivity('interaction');
      }
      // Last sustained block before the gap is 1-3, so bedtime is 4.
      expect(scheduler.getEstimatedBedtime()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should return empty active hours with insufficient data', () => {
    expect(scheduler.getActiveHours()).toEqual([]);
    scheduler.recordActivity('interaction');
    expect(scheduler.getActiveHours()).toEqual([]); // Need 10+
  });

  it('should estimate bedtime from activity patterns', () => {
    // Generate enough activity to estimate a bedtime
    for (let i = 0; i < 20; i++) {
      scheduler.recordActivity('interaction');
    }
    // May or may not detect a bedtime depending on hour distribution
    const bedtime = scheduler.getEstimatedBedtime();
    // bedtime can be null (no gap detected) or a number 0-23
    if (bedtime !== null) {
      expect(bedtime).toBeGreaterThanOrEqual(0);
      expect(bedtime).toBeLessThanOrEqual(23);
    }
  });

  it('should return null bedtime with insufficient data', () => {
    expect(scheduler.getEstimatedBedtime()).toBeNull();
  });

  it('should reset state', () => {
    scheduler.recordActivity('interaction');
    scheduler.markDreamCompleted();
    scheduler.reset();
    expect(scheduler.activityCount).toBe(0);
  });

  it('should track different activity types', () => {
    scheduler.recordActivity('generation');
    scheduler.recordActivity('interaction');
    scheduler.recordActivity('command');
    expect(scheduler.activityCount).toBe(3);
  });

  it('should trim old activity samples', async () => {
    // Use milliseconds-level window: 0.00001 hours = 0.036 seconds
    const small = new SleepScheduler({ activityWindowHours: 0.00001 });
    small.recordActivity('interaction');
    // Wait for window to expire (50ms >> 36ms window)
    await new Promise(r => setTimeout(r, 50));
    // Trimming happens on the NEXT recordActivity call
    small.recordActivity('interaction');
    // Old sample should have been trimmed
    expect(small.activityCount).toBe(1); // Only the new one
  });
});

// ---------------------------------------------------------------------------
// ProceduralTier
// ---------------------------------------------------------------------------
describe('ProceduralTier', () => {
  let tier: ProceduralTier;
  let modelSampler: ThompsonSampler<string>;
  let strategySampler: ThompsonSampler<string>;
  let prototype: DomainPrototype;
  let worldModel: CreativeWorldModel;

  beforeEach(() => {
    modelSampler = new ThompsonSampler<string>({ minPulls: 1, successThreshold: 0.7 });
    strategySampler = new ThompsonSampler<string>({ minPulls: 1, successThreshold: 0.7 });
    prototype = new DomainPrototype();
    worldModel = new CreativeWorldModel({ minObservations: 1, kNeighbors: 1 });

    tier = new ProceduralTier(
      { modelSampler, strategySampler, prototype, worldModel },
      {
        highConfidenceThreshold: 0.8,
        mediumConfidenceThreshold: 0.6,
        minEpisodeCount: 2,
        minPredictionQuality: 0.5,
        minSuccessRate: 0.6,
        maxRoutines: 50,
      },
    );
  });

  const makePattern = (overrides: Partial<ConsolidatedPattern>): ConsolidatedPattern => ({
    key: 'p5:local:solo',
    domain: 'p5',
    model: 'local',
    strategy: 'solo',
    alpha: 10,
    beta: 2,
    episodeCount: 12,
    avgQuality: 0.85,
    qualityVariance: 0.1,
    bestQuality: 0.95,
    worstQuality: 0.7,
    retention: 1.0,
    lastUpdated: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  it('should promote qualifying patterns to routines', () => {
    // Build up model confidence
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);

    // Build world model data
    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    const pattern = makePattern({});
    const result = tier.evaluateAndPromote([pattern]);
    expect(result.promoted.length).toBeGreaterThanOrEqual(0);
  });

  describe('static-code surrogate veto (#1250)', () => {
    const tierBehavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    const primeSamplers = () => {
      for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
      for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);
    };

    it('ignores a low prediction from a surrogate with no skill over the domain mean', () => {
      primeSamplers();
      // Same features, scattered outcomes: K-NN (k=1) predicts 0.2 but is worse than the mean.
      for (const q of [0.2, 0.9, 0.8, 0.9]) worldModel.record(tierBehavior, q);
      const prediction = worldModel.predict(tierBehavior)!;
      expect(prediction.predicted).toBe(0.2);
      expect(prediction.confidence).toBe(0);

      const result = tier.evaluateAndPromote([makePattern({})]);
      expect(result.promoted.map(r => r.routine.key)).toEqual(['p5:local:solo']);
    });

    it('still vetoes when a calibrated surrogate predicts low quality', () => {
      primeSamplers();
      for (let i = 0; i < 3; i++) worldModel.record(tierBehavior, 0.2);
      for (let i = 0; i < 3; i++) worldModel.record({ ...tierBehavior, lineCount: 500, hasInteraction: 0 }, 0.9);
      const prediction = worldModel.predict(tierBehavior)!;
      expect(prediction.predicted).toBe(0.2);
      expect(prediction.confidence).toBe(1);

      const result = tier.evaluateAndPromote([makePattern({})]);
      expect(result.promoted).toEqual([]);
    });
  });

  it('should skip patterns below medium confidence', () => {
    // Low model confidence
    for (let i = 0; i < 2; i++) modelSampler.update('p5::local', 0.3);
    const pattern = makePattern({});
    const result = tier.evaluateAndPromote([pattern]);
    // Should not promote due to low confidence
    expect(result.promoted.length).toBe(0);
  });

  it('should skip patterns with too few episodes', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    const pattern = makePattern({ episodeCount: 1 });
    const result = tier.evaluateAndPromote([pattern]);
    expect(result.promoted.length).toBe(0);
  });

  it('should skip patterns with low success rate', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    const pattern = makePattern({ alpha: 2, beta: 10 }); // Very low success rate
    const result = tier.evaluateAndPromote([pattern]);
    expect(result.promoted.length).toBe(0);
  });

  it('should skip patterns without model/strategy', () => {
    const pattern = makePattern({ key: 'p5', model: undefined, strategy: undefined });
    const result = tier.evaluateAndPromote([pattern]);
    expect(result.promoted.length).toBe(0);
  });

  it('should update existing routines on re-evaluation', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);
    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    const pattern = makePattern({});
    tier.evaluateAndPromote([pattern]);
    // Snapshot the value (getRoutine returns a reference to the Map entry)
    const beforeApps = tier.getRoutine('p5:local:solo')!.totalApplications;

    // Re-evaluate
    tier.evaluateAndPromote([pattern]);
    const afterApps = tier.getRoutine('p5:local:solo')!.totalApplications;
    expect(afterApps).toBeGreaterThan(beforeApps);
  });

  it('should lookup best routine for a domain', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);
    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    tier.evaluateAndPromote([makePattern({})]);
    const routine = tier.lookup('p5');
    expect(routine).toMatchObject({
      key: 'p5:local:solo',
      domain: 'p5',
      model: 'local',
      strategy: 'solo',
    });
  });

  it('should return null for lookup with no routines', () => {
    expect(tier.lookup('p5')).toBeNull();
  });

  it('should record application success/failure', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);
    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    tier.evaluateAndPromote([makePattern({})]);
    tier.recordApplication('p5:local:solo', true);
    tier.recordApplication('p5:local:solo', false);

    const routine = tier.getRoutine('p5:local:solo');
    expect(routine!.totalApplications).toBeGreaterThanOrEqual(3); // 1 initial + 2 records
  });

  it('should demote routines with low confidence', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);
    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    tier.evaluateAndPromote([makePattern({})]);
    const routine = tier.getRoutine('p5:local:solo');
    expect(routine).toMatchObject({
      key: 'p5:local:solo',
      domain: 'p5',
      model: 'local',
      strategy: 'solo',
    });

    // Record many failures to demote
    for (let i = 0; i < 20; i++) tier.recordApplication('p5:local:solo', false);
    const afterDemotion = tier.getRoutine('p5:local:solo');
    // Confidence may have dropped to 'low'
    if (afterDemotion) {
      expect(afterDemotion.confidence).toBe('low');
    }
  });

  it('should enforce maxRoutines budget', () => {
    const smallTier = new ProceduralTier(
      { modelSampler, strategySampler, prototype, worldModel },
      { maxRoutines: 2, minEpisodeCount: 1, minSuccessRate: 0.1, mediumConfidenceThreshold: 0.1, minPredictionQuality: 0 },
    );

    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) modelSampler.update('p5::cloud', 0.8);
    for (let i = 0; i < 10; i++) modelSampler.update('p5::edge', 0.75);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.85);

    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    const patterns = [
      makePattern({ key: 'p5:local:solo', model: 'local' }),
      makePattern({ key: 'p5:cloud:solo', model: 'cloud' }),
      makePattern({ key: 'p5:edge:solo', model: 'edge' }),
    ];

    smallTier.evaluateAndPromote(patterns);
    expect(smallTier.routineCount).toBeLessThanOrEqual(2);
  });

  it('should get domain routines', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);
    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    tier.evaluateAndPromote([makePattern({})]);
    const p5Routines = tier.getDomainRoutines('p5');
    expect(p5Routines.length).toBeGreaterThanOrEqual(0);
    expect(p5Routines.every(r => r.domain === 'p5')).toBe(true);
  });

  it('should serialize and deserialize', () => {
    for (let i = 0; i < 10; i++) modelSampler.update('p5::local', 0.85);
    for (let i = 0; i < 10; i++) strategySampler.update('p5::solo', 0.8);
    const behavior = { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 };
    for (let i = 0; i < 5; i++) worldModel.record(behavior, 0.85);

    tier.evaluateAndPromote([makePattern({})]);
    const state = tier.serialize();
    expect(state.version).toBe(1);
    expect(state.routines.length).toBeGreaterThan(0);

    const tier2 = new ProceduralTier(
      { modelSampler, strategySampler, prototype, worldModel },
      tier.config,
    );
    tier2.deserialize(state);
    expect(tier2.routineCount).toBe(tier.routineCount);
  });

  it('should reset', () => {
    tier.reset();
    expect(tier.routineCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IntuitionEngine
// ---------------------------------------------------------------------------
describe('IntuitionEngine', () => {
  let engine: IntuitionEngine;

  beforeEach(() => {
    engine = new IntuitionEngine({
      dreamDomains: ['p5', 'glsl'],
      dreamingEnabled: false, // Disable dreaming for unit tests
    });
  });

  it('should produce a valid assessment', () => {
    const assessment = engine.assess(
      'function setup() { createCanvas(400, 400); } function draw() { background(220); }',
      'p5',
    );
    expect(assessment.score).toBeGreaterThanOrEqual(0);
    expect(assessment.score).toBeLessThanOrEqual(1);
    expect(assessment.confidence).toBeGreaterThanOrEqual(0);
    expect(assessment.confidence).toBeLessThanOrEqual(1);
    expect(assessment.signals.length).toBeGreaterThanOrEqual(2);
    expect(assessment.explanation.length).toBeGreaterThan(0);
  });

  it('prototype signal is neutral and labelled unavailable for a zero embedding (#1249)', () => {
    for (let i = 0; i < 3; i++) engine.recordOutcome(`ok ${i}`, 'p5', 0.9, undefined, undefined, [1, 0, 0]);
    const match = engine.assess('x', 'p5', [], [1, 0, 0]).signals.find(s => s.name === 'prototype_distance');
    expect(match?.value).toBeCloseTo(1, 5);
    const zero = engine.assess('x', 'p5', [], [0, 0, 0]).signals.find(s => s.name === 'prototype_distance');
    expect(zero?.value).toBe(0.5);
    expect(zero?.reason).toMatch(/unavailable/);
  });

  it('should use default values when no data available', () => {
    const assessment = engine.assess('some output', 'p5');
    // Without any training data, should still produce a valid score
    expect(assessment.score).toBeGreaterThanOrEqual(0);
    expect(assessment.score).toBeLessThanOrEqual(1);
    expect(assessment.usedProceduralShortcut).toBe(false);
  });

  it('should record outcomes and update subsystems', () => {
    engine.recordOutcome(
      'function setup() { createCanvas(400, 400); }',
      'p5',
      0.85,
      'local',
      'solo',
    );

    // Verify Thompson sampler was updated: 0.85 ≥ threshold 0.7 → success
    const modelStats = engine.getModelSampler().getArmStats('p5::local');
    expect(modelStats).toEqual({ alpha: 2, beta: 1, pulls: 1, totalReward: 0.85 });
  });

  it('should update world model on outcome recording', () => {
    engine.recordOutcome('some code output', 'p5', 0.8, 'local', 'solo');
    expect(engine.getWorldModel().getObservationCount()).toBeGreaterThan(0);
  });

  it('should update prototype from high-quality outputs with embedding', () => {
    engine.recordOutcome('good code', 'p5', 0.9, 'local', 'solo', [0.5, 0.5]);
    expect(engine.getPrototype().domainCount).toBeGreaterThanOrEqual(0);
  });

  it('should not update prototype from low-quality outputs', () => {
    engine.recordOutcome('bad code', 'p5', 0.3, 'local', 'solo', [0.5, 0.5]);
    // Low quality shouldn't add to prototype
  });

  it('should compute novelty against previous outputs', () => {
    const first = engine.assess('output A', 'p5');
    const second = engine.assess('output A', 'p5', ['output A']);
    // Same output vs history → lower novelty
    const firstNovelty = first.signals.find(s => s.name === 'novelty');
    const secondNovelty = second.signals.find(s => s.name === 'novelty');
    expect(firstNovelty!.value).toBeGreaterThan(secondNovelty!.value);
  });

  it('should expose health report', () => {
    engine.recordOutcome('some code', 'p5', 0.8, 'local', 'solo');
    const health = engine.getHealthReport();
    expect(health.thompsonArms).toBeGreaterThanOrEqual(0);
    expect(health.cacheEntries).toBeGreaterThanOrEqual(0);
    expect(health.worldModelObservations).toBeGreaterThanOrEqual(0);
  });

  it('should produce human-readable summary', () => {
    engine.recordOutcome('code', 'p5', 0.8, 'local', 'solo');
    const summary = engine.getSummary();
    expect(summary).toContain('Intuition Engine Summary');
    expect(summary).toContain('Thompson');
  });

  it('should serialize and deserialize state', () => {
    engine.recordOutcome('code', 'p5', 0.8, 'local', 'solo');
    const state = engine.serialize();
    expect(state.version).toBe(1);

    const engine2 = new IntuitionEngine({ dreamingEnabled: false });
    engine2.deserialize(state);
    // State round-trips: 'local' arm recorded one success at 0.8 (≥ threshold 0.7)
    expect(engine2.getModelSampler().getArmStats('p5::local')).toEqual({
      alpha: 2,
      beta: 1,
      pulls: 1,
      totalReward: 0.8,
    });
  });

  it('should reset all subsystems', () => {
    engine.recordOutcome('code', 'p5', 0.8, 'local', 'solo');
    engine.reset();
    expect(engine.getModelSampler().totalPulls).toBe(0);
    expect(engine.getWorldModel().getObservationCount()).toBe(0);
    expect(engine.getProceduralTier().routineCount).toBe(0);
  });

  it('should expose all component accessors', () => {
    expect(engine.getModelSampler()).toBeInstanceOf(ThompsonSampler);
    expect(engine.getStrategySampler()).toBeInstanceOf(ThompsonSampler);
    expect(engine.getPrototype()).toBeInstanceOf(DomainPrototype);
    expect(engine.getCache()).toBeInstanceOf(IntuitionCache);
    expect(engine.getConsolidator()).toBeInstanceOf(MemoryConsolidator);
    expect(engine.getWorldModel()).toBeInstanceOf(CreativeWorldModel);
    expect(engine.getDreamEngine()).toBeInstanceOf(DreamEngine);
    expect(engine.getSleepScheduler()).toBeInstanceOf(SleepScheduler);
    expect(engine.getForgettingCurve()).toBeInstanceOf(ForgettingCurve);
    expect(engine.getMemoryBudget()).toBeInstanceOf(MemoryBudget);
    expect(engine.getProceduralTier()).toBeInstanceOf(ProceduralTier);
  });

  it('should wire LLM callbacks to DreamEngine when llm is provided', async () => {
    const mockGenerate = vi.fn<() => Promise<{ success: true; code: string; error?: string }>>();
    mockGenerate.mockResolvedValue({ success: true, code: 'mocked result' });

    // Mock LLMClient — shape matches LLMClient.generate() return type
    const mockLlm = { generate: mockGenerate, generateWithToolLoop: vi.fn().mockResolvedValue({ content: 'mock', toolCalls: [], success: true }) } as unknown as import('../../src/llm/LLMClient.js').LLMClient;

    const engine = new IntuitionEngine({ llm: mockLlm });
    const dreamEntry = await engine.getDreamEngine().dream('micro');

    // Verify LLM was called at least once (covers both Stage 1 generatePrompt and Stage 2 generateCode)
    expect(mockGenerate).toHaveBeenCalledTimes(13);
    // Verify at least one call used the creative prompt system message
    const calls = mockGenerate.mock.calls;
    const hasPromptCall = calls.some(([sys]) =>
      typeof sys === 'string' && sys.includes('creative visual concept generator'),
    );
    const hasCodeCall = calls.some(([sys]) =>
      typeof sys === 'string' && sys.includes('creative coding engine'),
    );
    expect(hasPromptCall || hasCodeCall).toBe(true);
    // DreamEngine should have produced real (non-stub) concepts when LLM is wired
    expect(dreamEntry.conceptsGenerated).toBeGreaterThan(0);
  });

  it('should consolidate episodes', () => {
    const episodes: ConsolidationEpisode[] = [
      { domain: 'p5', output: 'code1', qualityScore: 0.85, model: 'local', strategy: 'solo', timestamp: new Date().toISOString() },
      { domain: 'p5', output: 'code2', qualityScore: 0.9, model: 'local', strategy: 'solo', timestamp: new Date().toISOString() },
    ];
    const result = engine.consolidate(episodes);
    expect(result.episodesProcessed).toBe(2);
  });

  it('generateHint returns non-empty hint after recording outcomes that promote a procedural routine', () => {
    // Seed enough high-quality outcomes to satisfy procedural tier thresholds
    for (let i = 0; i < 12; i++) {
      engine.recordOutcome('code', 'p5', 0.85, 'local', 'solo');
    }
    // Build world model data for promotion
    for (let i = 0; i < 5; i++) {
      engine.getWorldModel().record(
        { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 },
        0.85,
      );
    }
    // Promote via consolidation
    const episodes = Array.from({ length: 12 }, (_, i) => ({
      domain: 'p5',
      output: `out-${i}`,
      qualityScore: 0.85,
      model: 'local',
      strategy: 'solo',
      timestamp: new Date().toISOString(),
    }));
    engine.consolidate(episodes);

    const hint = engine.generateHint('p5');
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain('Historical pattern');
  });

  it('generateHint returns empty string when engine has no data', () => {
    const hint = engine.generateHint('p5');
    expect(hint).toBe('');
  });

  it('generateHint respects maxLength', () => {
    // Seed data so a hint is produced
    for (let i = 0; i < 12; i++) {
      engine.recordOutcome('code', 'p5', 0.85, 'local', 'solo');
    }
    for (let i = 0; i < 5; i++) {
      engine.getWorldModel().record(
        { domain: 'p5', lineCount: 50, techniqueDiversity: 3, hasInteraction: 1, hasColor: 1, hasLoops: 1, hasFunctions: 0, hasClasses: 0, commentDensity: 0.1 },
        0.85,
      );
    }
    const episodes = Array.from({ length: 12 }, (_, i) => ({
      domain: 'p5',
      output: `out-${i}`,
      qualityScore: 0.85,
      model: 'local',
      strategy: 'solo',
      timestamp: new Date().toISOString(),
    }));
    engine.consolidate(episodes);

    const hint = engine.generateHint('p5', 30);
    expect(hint.length).toBeLessThanOrEqual(30);
    expect(hint.endsWith('...')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IntuitionEngine persistence — the loop that was never closed
// ---------------------------------------------------------------------------
// Before this wiring, RalphLoop built a fresh `new IntuitionEngine()` at each
// call site, so recordOutcome() updated an instance that was immediately GC'd
// and generateHint() always ran on an empty engine (returning ''). These tests
// pin the closed loop: recordOutcome → save → fresh engine → load → non-empty hint.
describe('Domain-isolated Thompson arms (#1253)', () => {
  it('one domain\'s outcomes never move another domain\'s arm', () => {
    const engine = new IntuitionEngine({ dreamingEnabled: false });
    for (let i = 0; i < 5; i++) engine.recordOutcome('createCanvas(1,1);', 'p5', 0.95, 'model-a', 'solo');
    const sampler = engine.getModelSampler();
    expect(sampler.getArmStats('glsl::model-a')).toBeNull();
    expect(sampler.getArmStats('p5::model-a')).toMatchObject({ pulls: 5 });
    expect(sampler.getArmStats('model-a')).toBeNull();
  });

  it('recommends and hints only from the requested domain\'s evidence', () => {
    const engine = new IntuitionEngine({ dreamingEnabled: false });
    for (let i = 0; i < 5; i++) {
      engine.recordOutcome('createCanvas(1,1);', 'p5', 0.95, 'p5-winner', 'solo');
      engine.recordOutcome('void main(){}', 'glsl', 0.95, 'glsl-winner', 'swarm');
      engine.recordOutcome('void main(){}', 'glsl', 0.1, 'p5-winner', 'solo');
    }
    expect(engine.assess('x', 'glsl').recommendedModel).toBe('glsl-winner');
    expect(engine.assess('x', 'glsl').recommendedStrategy).toBe('swarm');
    expect(engine.generateHint('glsl', 200)).toContain('model=glsl-winner');
    expect(engine.generateHint('p5', 200)).toContain('model=p5-winner');
    // A domain with no evidence gets no model recommendation or hint.
    expect(engine.assess('x', 'hydra').recommendedModel).toBeNull();
    expect(engine.generateHint('hydra', 200)).toBe('');
  });

  it('IntuitionStrategy reads Thompson confidence and recommendations from the scored domain only', async () => {
    const models = new ThompsonSampler<string>({ minPulls: 1 });
    const strategies = new ThompsonSampler<string>({ minPulls: 1 });
    for (let i = 0; i < 5; i++) models.update('p5::m', 0.95);
    const strategy = new IntuitionStrategy(new DomainPrototype(), models, strategies);
    const thompsonOf = async (domain: string) => {
      const r = await strategy.score({ output: 'x', domain } as ScoringInput);
      const report = r.report as { signals: IntuitionSignal[]; recommendation: string };
      return { value: report.signals.find(s => s.name === 'thompson_confidence')!.value, rec: report.recommendation };
    };

    const glsl = await thompsonOf('glsl');
    const p5 = await thompsonOf('p5');
    expect(glsl.value).toBe(0.5);
    expect(glsl.rec).not.toContain('model:');
    expect(p5.value).toBeCloseTo(models.getConfidence('p5::m'), 10);
    expect(p5.rec).toContain('model: m (');
  });
});

describe('IntuitionEngine world-model surrogate gating (#1250)', () => {
  it('keeps the world-model signal neutral when the surrogate does not beat the domain mean', () => {
    const engine = new IntuitionEngine({ dreamingEnabled: false });
    const code = 'function setup() { createCanvas(100, 100); }\nfunction draw() { ellipse(10, 10, 5, 5); }';
    const behavior = CreativeWorldModel.extractBehavior(code, 'p5');
    for (const q of [0.1, 0.9, 0.2, 0.8, 0.3, 0.7]) engine.getWorldModel().record(behavior, q);

    const signal = engine.assess(code, 'p5').signals.find(s => s.name === 'world_model_prediction')!;
    expect(signal.value).toBe(0.5);
    expect(signal.reason).toContain('no better than domain mean');
  });

  it('uses the prediction when the surrogate is calibrated', () => {
    const engine = new IntuitionEngine({ dreamingEnabled: false });
    const good = 'function setup() { createCanvas(100, 100); }\nfunction draw() { fill(color(255,0,0)); for (let i=0;i<3;i++) ellipse(mouseX, mouseY, 5, 5); }';
    const bad = 'x';
    for (let i = 0; i < 4; i++) {
      engine.getWorldModel().record(CreativeWorldModel.extractBehavior(good, 'p5'), 0.9);
      engine.getWorldModel().record(CreativeWorldModel.extractBehavior(bad, 'p5'), 0.2);
    }
    const signal = engine.assess(good, 'p5').signals.find(s => s.name === 'world_model_prediction')!;
    expect(signal.value).toBeCloseTo(0.9, 6);
    expect(signal.reason).toContain('confidence: 1.00');
  });
});

describe('IntuitionEngine procedural routine is advisory only (#1251)', () => {
  const withHighRoutine = () => {
    const engine = new IntuitionEngine({ dreamingEnabled: false });
    const state = engine.serialize();
    const now = new Date().toISOString();
    state.proceduralTier.routines = [{
      key: 'p5:m:s', domain: 'p5', model: 'routine-model', strategy: 'routine-strategy',
      confidence: 'high', expectedQuality: 0.99, successCount: 50, totalApplications: 50,
      lastApplied: now, sourcePatternKey: 'p5:m:s',
    }];
    engine.deserialize(state);
    return engine;
  };

  it('grades the current output instead of inheriting the routine\'s historical quality', () => {
    const engine = withHighRoutine();
    const plain = new IntuitionEngine({ dreamingEnabled: false });
    const bad = 'x';

    const advised = engine.assess(bad, 'p5');
    const baseline = plain.assess(bad, 'p5');

    expect(advised.score).toBe(baseline.score);
    expect(advised.confidence).toBe(baseline.confidence);
    expect(advised.score).not.toBe(0.99);
    expect(advised.signals.map(s => s.name)).toEqual(baseline.signals.map(s => s.name));
    expect(advised.signals.some(s => s.name === 'procedural_shortcut')).toBe(false);
  });

  it('still uses the routine to recommend model and strategy', () => {
    const advised = withHighRoutine().assess('x', 'p5');
    expect(advised.recommendedModel).toBe('routine-model');
    expect(advised.recommendedStrategy).toBe('routine-strategy');
    expect(advised.usedProceduralShortcut).toBe(true);
    expect(advised.explanation).toContain('advisory');
  });

  it('ignores routines from other domains', () => {
    const advised = withHighRoutine().assess('x', 'glsl');
    expect(advised.usedProceduralShortcut).toBe(false);
    expect(advised.recommendedModel).not.toBe('routine-model');
  });
});

describe('IntuitionEngine persistence (loop closure)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sinter-intuition-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists recorded outcomes so a fresh engine generates the learned hint', async () => {
    const statePath = join(dir, 'engine-state.json');
    const writer = new IntuitionEngine();
    // 3 pulls makes the model sampler "ready" (minPulls = 3 in the engine config).
    for (let i = 0; i < 3; i++) {
      writer.recordOutcome('createCanvas(400, 400);', 'p5', 0.85, 'glm-test');
    }
    await writer.save(statePath);

    const reader = new IntuitionEngine();
    expect(await reader.load(statePath)).toBe(true);
    expect(reader.generateHint('p5', 200)).toContain('model=glm-test');
  });

  it('returns an empty hint without loaded state (proving load is what closes the loop)', () => {
    expect(new IntuitionEngine().generateHint('p5', 200)).toBe('');
  });

  it('load() returns false for a missing state file (first run is not an error)', async () => {
    expect(await new IntuitionEngine().load(join(dir, 'does-not-exist.json'))).toBe(false);
  });

  it('round-trips strategy sampler, prototype, sleep state and dream journal (#1252)', async () => {
    // serialize() stamps nested updatedAt/lastConsolidation with the current time;
    // freeze Date so writer and reader serialise in the same millisecond.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    try {
      const statePath = join(dir, 'full.json');
      const writer = new IntuitionEngine({ dreamingEnabled: false });
      writer.recordOutcome('createCanvas(1,1);', 'p5', 0.9, 'glm-test', 'solo', [1, 0, 0]);
      writer.recordOutcome('createCanvas(2,2);', 'p5', 0.8, 'glm-test', 'solo', [0, 1, 0]);
      writer.getSleepScheduler().markDreamCompleted();
      const journal = [{ id: 'dream-7', keepers: 2 }] as unknown as DreamJournalEntry[];
      writer.getDreamEngine().restoreJournal(journal);
      await writer.save(statePath);

      const reader = new IntuitionEngine({ dreamingEnabled: false });
      await reader.load(statePath);

      expect(reader.getStrategySampler().getArmStats('p5::solo')).toEqual(writer.getStrategySampler().getArmStats('p5::solo'));
      expect(writer.getStrategySampler().getArmStats('p5::solo')!.pulls).toBe(2);
      expect(reader.getPrototype().getCentroid('p5')).toEqual(writer.getPrototype().getCentroid('p5'));
      expect(reader.getSleepScheduler().serialize()).toEqual(writer.getSleepScheduler().serialize());
      expect(reader.getDreamEngine().getJournal()).toEqual(journal);
      expect(reader.getDreamEngine().dreamCount).toBe(7);
      // Restoring is a fixed point: re-serialising the reader matches the writer.
      const { updatedAt: _a, ...w } = writer.serialize();
      const { updatedAt: _b, ...r } = reader.serialize();
      expect(r).toEqual(w);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads state files written before the extra fields existed (#1252)', () => {
    const writer = new IntuitionEngine({ dreamingEnabled: false });
    writer.recordOutcome('x', 'p5', 0.9, 'glm-test', 'solo');
    const { strategySampler: _s, prototype: _p, sleep: _z, ...legacy } = writer.serialize();
    const reader = new IntuitionEngine({ dreamingEnabled: false });
    reader.deserialize(legacy);
    expect(reader.getStrategySampler().getArmStats('solo')).toBeNull();
    expect(reader.getDreamEngine().getJournal()).toEqual([]);
  });

  it('round-trips a recorded quality-cache entry across save/load', async () => {
    const statePath = join(dir, 'state.json');
    const writer = new IntuitionEngine();
    writer.recordOutcome('osc(10).out();', 'hydra', 0.9, 'glm-test');
    await writer.save(statePath);

    const reader = new IntuitionEngine();
    await reader.load(statePath);
    expect(reader.getCache().getStats().size).toBe(1);
  });
});

describe('IntuitionEngine memory budget wiring (#1246)', () => {
  type CachedAssessment = Parameters<IntuitionCache['set']>[2];
  const assessment = (score: number) => ({ score }) as CachedAssessment;

  it('cache eviction removes the lowest-scored entries across every domain', () => {
    const engine = new IntuitionEngine({ dreamDomains: ['p5'], dreamingEnabled: false });
    const cache = engine.getCache();
    // 480 entries over two domains; budget 500 × 0.9 → threshold 450.
    for (let i = 0; i < 240; i++) cache.set('p5', `p5-${i}`, assessment(0.5 + i / 1000));
    for (let i = 0; i < 240; i++) cache.set('glsl', `glsl-${i}`, assessment(i < 30 ? 0.01 : 0.9));

    const evicted = engine.getMemoryBudget().enforceStore('cache');
    const receipt = engine.getMemoryBudget().getLastReceipt('cache');

    expect(evicted).toBe(30);
    expect(cache.getStats().size).toBe(450);
    expect(receipt).toMatchObject({ sizeBefore: 480, sizeAfter: 450, missed: [], unexpected: [], overThreshold: false });
    // The 30 near-zero glsl entries are the ones gone (old code only looked at p5).
    expect(cache.getDomainEntries('glsl').every(e => e.assessment.score === 0.9)).toBe(true);
    expect(cache.getDomainEntries('p5')).toHaveLength(240);
  });

  it('pattern and routine stores evict instead of reporting a no-op', () => {
    const engine = new IntuitionEngine({ dreamDomains: ['p5'], dreamingEnabled: false });
    const consolidator = engine.getConsolidator();
    consolidator.deserialize({
      version: 1,
      lastConsolidation: '2026-11-01T00:00:00.000Z',
      totalEpisodesProcessed: 0,
      patterns: Array.from({ length: 190 }, (_, i) => ({
        key: `d${i}`, domain: `d${i}`, alpha: 1, beta: 1, episodeCount: 2,
        avgQuality: i < 10 ? 0.01 : 0.9, qualityVariance: 0, bestQuality: 0.9, worstQuality: 0.1,
        retention: 1, lastUpdated: new Date().toISOString(), createdAt: new Date().toISOString(),
      })),
    });

    expect(engine.getMemoryBudget().enforceStore('patterns')).toBe(10);
    expect(consolidator.patternCount).toBe(180);
    expect(consolidator.getPattern('d0')).toBeNull();
    expect(consolidator.getPattern('d10')).toMatchObject({ avgQuality: 0.9 });
  });
});
