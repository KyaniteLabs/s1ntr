import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VotingEngine } from '../../src/swarm/VotingEngine.js';

const run = promisify(execFile);
const TSX = resolve('node_modules/.bin/tsx');
const CHILD = resolve('test/swarm/fixtures/record-outcomes-child.ts');
const goldLabel = (outcomeId: string) => ({ source: 'human' as const, outcomeId });

describe('VotingEngine ledger across processes (#1295)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    VotingEngine.clearPerformanceHistory();
    dir = mkdtempSync(join(tmpdir(), 'voting-ledger-mp-'));
    path = join(dir, 'ledger.json');
  });
  afterEach(() => {
    VotingEngine.clearPerformanceHistory();
    rmSync(dir, { recursive: true, force: true });
  });

  it('run 2 loads run 1 counts and weights reflect them exactly', async () => {
    await run(TSX, [CHILD, path, 'run1', '4']); // run 1: voter a right 4 of 4
    VotingEngine.attachLedger(path); // run 2: a fresh engine
    expect(VotingEngine.getExpertAccuracy('a', 'general')).toBe(5 / 6); // (4+1)/(4+2)
    // K=3 log-odds normalised to the 0.5 prior: ln(2*(5/6)/(1/6))/ln(2) = ln(10)/ln(2) = 3.32, clipped to 2
    expect(VotingEngine.getCalibrationFactor('a', 'general')).toBe(2);
  });

  it('a mid-strength voter gets the exact unclipped factor after run 1', async () => {
    await run(TSX, [CHILD, path, 'run1', '1']); // 1 of 1 -> p = 2/3
    VotingEngine.attachLedger(path);
    expect(VotingEngine.getExpertAccuracy('a', 'general')).toBeCloseTo(2 / 3, 12);
    expect(VotingEngine.getCalibrationFactor('a', 'general')).toBeCloseTo(Math.log(4) / Math.log(2), 12);
  });

  it("keeps another process's counts when this process writes after attaching", async () => {
    VotingEngine.attachLedger(path); // loaded empty
    await run(TSX, [CHILD, path, 'other', '3']); // another process writes meanwhile
    expect(VotingEngine.recordOutcome('a', 'general', 'w', 'w', goldLabel('mine-0'))).toBe(true);
    VotingEngine.clearPerformanceHistory();
    VotingEngine.attachLedger(path);
    expect(VotingEngine.getAllPerformanceRecords().find(r => r.expertId === 'a')?.totalVotes).toBe(4);
    expect(VotingEngine.hasOutcome('other-2')).toBe(true);
  });

  it('loses no outcome when 4 processes write concurrently', async () => {
    await Promise.all([0, 1, 2, 3].map(n => run(TSX, [CHILD, path, `p${n}`, '5'])));
    VotingEngine.attachLedger(path);
    const a = VotingEngine.getAllPerformanceRecords().find(r => r.expertId === 'a');
    expect(a?.totalVotes).toBe(20);
    expect(a?.correctVotes).toBe(20);
    const ledger = JSON.parse(readFileSync(path, 'utf-8'));
    expect(ledger.outcomes).toHaveLength(20);
  });

  it('fails loudly, leaving the file untouched, when the ledger is corrupt at write time', () => {
    VotingEngine.attachLedger(path);
    writeFileSync(path, '{corrupt');
    expect(() => VotingEngine.recordOutcome('a', 'general', 'w', 'w', goldLabel('x'))).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf-8')).toBe('{corrupt');
  });
});
