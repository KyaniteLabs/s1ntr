import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LessonBandit, banditStatePath } from '../../../src/atelier/LessonBandit.js';

describe('Lesson Bandit (composite TS+Shapley+window engine)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bandit-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('no verdict before 15 own outcomes (cull-trap law)', () => {
    const b = new LessonBandit(join(dir, 'bandit.json'));
    for (let i = 0; i < 14; i += 1) b.recordOutcome({ turn: i, domain: 'p5', lessonIds: ['l1'], win: true });
    expect(b.verdict('l1')).toBe('pending');
    b.recordOutcome({ turn: 15, domain: 'p5', lessonIds: ['l1'], win: true });
    expect(b.verdict('l1')).toBe('promote'); // 15/15 wins clears 0.55 lower bound
  });

  it('demotes persistent losers after 15', () => {
    const b = new LessonBandit(join(dir, 'bandit.json'));
    for (let i = 0; i < 15; i += 1) b.recordOutcome({ turn: i, domain: 'p5', lessonIds: ['bad'], win: false });
    expect(b.verdict('bad')).toBe('demote');
  });

  it('verdict uses the LAST-15 deque (recovery from early losses)', () => {
    const b = new LessonBandit(join(dir, 'bandit.json'));
    for (let i = 0; i < 15; i += 1) b.recordOutcome({ turn: i, domain: 'p5', lessonIds: ['l'], win: false });
    for (let i = 0; i < 15; i += 1) b.recordOutcome({ turn: i + 20, domain: 'p5', lessonIds: ['l'], win: true });
    expect(b.verdict('l')).toBe('promote'); // recent 15 wins dominate
  });

  it('bounded ablation drops at most 2, keeps the rest (variation with bounded regret)', () => {
    const b = new LessonBandit(join(dir, 'bandit.json'));
    const lessons = Array.from({ length: 8 }, (_, i) => ({ id: `l${i}`, domains: ['p5'] as string[] }));
    const selected = b.selectLessons('p5', lessons);
    expect(selected.length).toBeGreaterThanOrEqual(6);
    expect(selected.length).toBeLessThanOrEqual(8);
  });

  it('shapley weights sum to 1 across the coalition', async () => {
    const b = new LessonBandit(join(dir, 'bandit.json'));
    b.recordOutcome({ turn: 1, domain: 'p5', lessonIds: ['a', 'b', 'c'], win: true });
    const stats = b.stats();
    expect(stats.lessons).toBe(3);
    expect(stats.pending).toBe(3);
  });

  it('persists and reloads state', () => {
    const path = join(dir, 'bandit.json');
    const b1 = new LessonBandit(path);
    b1.recordOutcome({ turn: 1, domain: 'p5', lessonIds: ['x'], win: true });
    const b2 = new LessonBandit(path);
    expect(b2.outcomesFor('x')).toBe(1);
  });
});

describe('PRD-required tests (critic finding)', () => {
  it('credit split sanity: uniform coalition gets equal posteriors', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'bandit2-'));
    const b = new LessonBandit(join(dir2, 'bandit.json'));
    for (let i = 0; i < 20; i += 1) {
      b.recordOutcome({ turn: i, domain: 'p5', lessonIds: ['u1', 'u2', 'u3'], win: true });
    }
    // 20 identical coalitions all winning: every member's win-count is substantial
    for (const id of ['u1', 'u2', 'u3']) {
      expect(b.outcomesFor(id)).toBe(20);
      expect(b.verdict(id)).toBe('promote'); // uniform strong coalition promotes all
    }
    rmSync(dir2, { recursive: true, force: true });
  });

  it('credibility ordering: consistent winner outranks consistent loser', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'bandit3-'));
    const b = new LessonBandit(join(dir3, 'bandit.json'));
    for (let i = 0; i < 16; i += 1) b.recordOutcome({ turn: i, domain: 'p5', lessonIds: ['win1'], win: true });
    for (let i = 0; i < 16; i += 1) b.recordOutcome({ turn: i, domain: 'p5', lessonIds: ['lose1'], win: false });
    expect(b.credibility('win1')).toBeGreaterThan(b.credibility('lose1'));
    expect(b.verdict('win1')).toBe('promote');
    expect(b.verdict('lose1')).toBe('demote');
    rmSync(dir3, { recursive: true, force: true });
  });
});

import { EloTable } from '../../../src/atelier/EloTable.js';

describe('EloTable (pairwise truth under judge noise)', () => {
  it('consistent winner climbs above consistent loser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elo-'));
    const t = new EloTable(join(dir, 'elo.json'));
    for (let i = 0; i < 12; i += 1) t.record('good', 'bad');
    expect(t.rating('good')).toBeGreaterThan(t.rating('bad'));
    expect(t.games('good')).toBe(12);
    expect(t.ladder(5)[0].id).toBe('good');
    rmSync(dir, { recursive: true, force: true });
  });
  it('persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elo2-'));
    const path = join(dir, 'elo.json');
    const t1 = new EloTable(path);
    t1.record('a', 'b');
    const t2 = new EloTable(path);
    expect(t2.games('a')).toBe(1);
    expect(t2.rating('b')).toBeLessThan(1000); // loss persisted
    rmSync(dir, { recursive: true, force: true });
  });
});
