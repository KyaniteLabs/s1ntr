import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonBandit } from '../../../src/atelier/LessonBandit.js';
import { EloTable } from '../../../src/atelier/EloTable.js';
import { writeAtomicSync } from '../../../src/shared/fsAtomic.js';

describe('atomic state writes (audit M2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sinter-atomic-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeAtomicSync never leaves a torn file', () => {
    const file = join(dir, 'state.json');
    writeAtomicSync(file, JSON.stringify({ a: 1 }));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    writeAtomicSync(file, JSON.stringify({ a: 2 }));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    // no temp strays left behind
    expect(readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('LessonBandit quarantines a corrupt state file instead of wiping it on save', () => {
    const statePath = join(dir, 'bandit.json');
    writeFileSync(statePath, '{"posteriors": [ TRUNCATED');

    const bandit = new LessonBandit(statePath);
    bandit.recordOutcome({ turn: 1, domain: 'p5', lessonIds: ['some_lesson'], win: true });
    bandit.save();

    // the corrupt original survives as a quarantine copy, never overwritten
    const quarantined = readdirSync(dir).filter(name => name.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
    expect(readFileSync(join(dir, quarantined[0]), 'utf8')).toContain('TRUNCATED');
    // and the new state parses clean
    const fresh = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(fresh.schema).toBe('sinter.lesson-bandit.v1');
  });

  it('EloTable quarantines a corrupt table instead of wiping it on save', () => {
    const tablePath = join(dir, 'elo.json');
    writeFileSync(tablePath, '{"artifact-a": { torn');

    const elo = new EloTable(tablePath);
    elo.record('x', 'y');
    elo.save();

    const quarantined = readdirSync(dir).filter(name => name.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
    expect(JSON.parse(readFileSync(tablePath, 'utf8'))).toHaveProperty('x');
  });

  it('healthy state still round-trips untouched', () => {
    const tablePath = join(dir, 'elo.json');
    const elo = new EloTable(tablePath);
    elo.record('challenger', 'champion');
    elo.save();
    const reloaded = new EloTable(tablePath);
    expect(reloaded.rating('challenger')).toBe(elo.rating('challenger'));
    expect(existsSync(tablePath)).toBe(true);
  });
});
