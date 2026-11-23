import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JUDGE_HARD_NEGATIVE_BELOW, JUDGE_POSITIVE_FLOOR, JUDGE_SCORE_RULE_ID, classifyJudgeScore }
  from '../../../src/learning/JudgeFloor.js';

interface Row { id: string; score: number; label: 'good' | 'bad' }
const fixture = JSON.parse(readFileSync(
  new URL('../../fixtures/judge-calibration-simon40.json', import.meta.url), 'utf8')) as { n: number; rows: Row[] };

describe('judge floor v2 against Simon\'s 40 labels', () => {
  it('names the policy and pins the thresholds', () => {
    expect(JUDGE_SCORE_RULE_ID).toBe('judge-score-floor-v2-simon40');
    expect(JUDGE_POSITIVE_FLOOR).toBe(0.3);
    expect(JUDGE_HARD_NEGATIVE_BELOW).toBe(0.2);
  });
  it('classifies the three zones at their edges', () => {
    expect(classifyJudgeScore(0.3)).toBe('accepted');
    expect(classifyJudgeScore(0.2999)).toBe('gray');
    expect(classifyJudgeScore(0.2)).toBe('gray');
    expect(classifyJudgeScore(0.1999)).toBe('rejected');
    expect(() => classifyJudgeScore(Number.NaN)).toThrow('JUDGE_SCORE_INVALID');
  });
  it('matches Simon on at least 75% of his labels (fails if the floor drifts)', () => {
    expect(fixture.rows).toHaveLength(40);
    const match = fixture.rows.filter(r => (r.score >= JUDGE_POSITIVE_FLOOR) === (r.label === 'good')).length;
    expect(match / fixture.rows.length).toBeGreaterThanOrEqual(0.75);
    expect(match).toBe(33);
  });
  it('never turns a piece Simon called good into a hard negative', () => {
    const wronglyNegative = fixture.rows.filter(r => r.label === 'good' && classifyJudgeScore(r.score) === 'rejected');
    expect(wronglyNegative).toEqual([]);
  });
});
