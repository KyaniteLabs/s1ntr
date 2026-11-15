import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VotingEngine } from '../../src/swarm/VotingEngine.js';
import { SwarmOrchestrator } from '../../src/swarm/SwarmOrchestrator.js';
import type { SwarmPersona, SwarmOutput, SwarmConfig } from '../../src/swarm/types.js';

function persona(id: string, model: string, votingPower = 1): SwarmPersona {
  return {
    id, name: id, displayName: id, model, temperature: 0.7, maxTokens: 100,
    systemPrompt: '', voice: '', thinkingStyle: '', votingBias: '', constraints: [], votingPower,
  };
}

function outputsFor(ids: string[]): Map<string, SwarmOutput> {
  return new Map(ids.map(id => [id, { personaId: id, content: `art by ${id}` } as SwarmOutput]));
}

const config = {} as SwarmConfig;

describe('VotingEngine gold-anchored calibration (#1295)', () => {
  let dir: string;
  beforeEach(() => {
    VotingEngine.clearPerformanceHistory();
    dir = mkdtempSync(join(tmpdir(), 'voting-ledger-'));
  });
  afterEach(() => {
    VotingEngine.clearPerformanceHistory();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('log-odds calibration factor', () => {
    it('is exactly 1 for an uncalibrated voter', () => {
      expect(VotingEngine.getCalibrationFactor('nobody', 'general', 7)).toBe(1);
    });

    it('matches ln((K-1)p/(1-p)) normalised to the prior', () => {
      // 2 correct of 2 -> p = 3/4; K = 7 -> ln(18)/ln(6)
      VotingEngine.recordOutcome('a', 'general', 'x', 'x');
      VotingEngine.recordOutcome('a', 'general', 'x', 'x');
      expect(VotingEngine.getCalibrationFactor('a', 'general', 7)).toBeCloseTo(Math.log(18) / Math.log(6), 10);
    });

    it('clips a strong voter at 2 and a chance-level voter at 0 (never negative)', () => {
      for (let i = 0; i < 20; i++) VotingEngine.recordOutcome('strong', 'general', 'x', 'x');
      for (let i = 0; i < 20; i++) VotingEngine.recordOutcome('bad', 'general', 'y', 'x');
      expect(VotingEngine.getCalibrationFactor('strong', 'general', 7)).toBe(2);
      expect(VotingEngine.getCalibrationFactor('bad', 'general', 7)).toBe(0);
    });

    it('treats fewer than 3 candidates (or garbage K) as K=3', () => {
      VotingEngine.recordOutcome('a', 'general', 'x', 'x');
      const k3 = VotingEngine.getCalibrationFactor('a', 'general', 3);
      expect(VotingEngine.getCalibrationFactor('a', 'general', 2)).toBe(k3);
      expect(VotingEngine.getCalibrationFactor('a', 'general', Number.NaN)).toBe(k3);
    });
  });

  describe('gold-source guard', () => {
    it('rejects calibration without a gold source', () => {
      const result = { rounds: [{ votes: new Map([['a', { voterId: 'a', firstChoice: 'b', secondChoice: '', reasoning: '' }]]) }] };
      expect(() => VotingEngine.calibrateFromResult(result, 'b', 'p', { source: 'self-vote' as never, outcomeId: 'o' }))
        .toThrow(/must be 'human' or 'external-oracle'/);
      expect(() => VotingEngine.calibrateFromResult(result, 'b', 'p', { source: 'human', outcomeId: '  ' }))
        .toThrow(/outcomeId must be a non-empty string/);
      expect(() => VotingEngine.calibrateFromResult(result, '', 'p', { source: 'human', outcomeId: 'o' }))
        .toThrow(/goldWinner must be a non-empty/);
      expect(VotingEngine.getAllPerformanceRecords()).toEqual([]);
    });
  });

  describe('durable idempotent ledger', () => {
    const result = {
      rounds: [{
        votes: new Map([
          ['a', { voterId: 'a', firstChoice: 'b', secondChoice: '', reasoning: '' }],
          ['b', { voterId: 'b', firstChoice: 'c', secondChoice: '', reasoning: '' }],
          ['c', { voterId: 'c', firstChoice: '', secondChoice: '', reasoning: '' }],
        ]),
      }],
    };

    it('persists gold outcomes and survives a restart', () => {
      const path = join(dir, 'nested', 'ledger.json');
      VotingEngine.attachLedger(path);
      expect(VotingEngine.calibrateFromResult(result, 'b', 'geometric grid', { source: 'human', outcomeId: 's1' })).toBe(2);
      expect(existsSync(path)).toBe(true);

      VotingEngine.clearPerformanceHistory(); // simulate a new process
      VotingEngine.attachLedger(path);
      expect(VotingEngine.getExpertAccuracy('a', 'geometric')).toBeCloseTo(2 / 3, 10);
      expect(VotingEngine.getExpertAccuracy('b', 'geometric')).toBeCloseTo(1 / 3, 10);
      expect(VotingEngine.getExpertAccuracy('c', 'geometric')).toBe(0.5);
    });

    it('ignores a replay of the same outcomeId, across restarts', () => {
      const path = join(dir, 'ledger.json');
      VotingEngine.attachLedger(path);
      VotingEngine.calibrateFromResult(result, 'b', 'geometric grid', { source: 'human', outcomeId: 's1' });
      VotingEngine.clearPerformanceHistory();
      VotingEngine.attachLedger(path);
      expect(VotingEngine.calibrateFromResult(result, 'b', 'geometric grid', { source: 'human', outcomeId: 's1' })).toBe(0);
      expect(VotingEngine.recordOutcome('z', 'general', 'x', 'x', { source: 'external-oracle', outcomeId: 'o1' })).toBe(true);
      expect(VotingEngine.recordOutcome('z', 'general', 'x', 'x', { source: 'external-oracle', outcomeId: 'o1' })).toBe(false);
      const a = VotingEngine.getAllPerformanceRecords().find(r => r.expertId === 'a');
      expect(a?.totalVotes).toBe(1);
    });

    it('refuses a corrupt or foreign ledger instead of starting empty', () => {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{not json');
      expect(() => VotingEngine.attachLedger(bad)).toThrow(/not valid JSON/);
      writeFileSync(bad, JSON.stringify({ schema: 'other', records: [], outcomes: [] }));
      expect(() => VotingEngine.attachLedger(bad)).toThrow(/does not match schema/);
      writeFileSync(bad, JSON.stringify({ schema: 'liminal.voting-calibration.v1', records: [{ expertId: 'a', domain: 'g', correctVotes: 3, totalVotes: 1 }], outcomes: [] }));
      expect(() => VotingEngine.attachLedger(bad)).toThrow(/invalid record/);
    });

    it('conductVoting never writes the ledger (no live update from the vote)', async () => {
      const path = join(dir, 'ledger.json');
      VotingEngine.attachLedger(path);
      VotingEngine.recordOutcome('a', 'general', 'x', 'x', { source: 'human', outcomeId: 'seed' });
      const before = readFileSync(path, 'utf-8');
      const personas = [persona('a', 'm1'), persona('b', 'm2')];
      await VotingEngine.conductVoting(outputsFor(['a', 'b']), personas, 1, config, async () => '1st: A\n2nd: B', 'x');
      expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it('SwarmOrchestrator loads the ledger from calibrationLedgerPath', () => {
      const path = join(dir, 'ledger.json');
      VotingEngine.attachLedger(path);
      VotingEngine.recordOutcome('a', 'audio', 'x', 'x', { source: 'human', outcomeId: 'o' });
      VotingEngine.clearPerformanceHistory();
      new SwarmOrchestrator({}, { callOllama: async () => '', calibrationLedgerPath: path });
      expect(VotingEngine.getExpertAccuracy('a', 'audio')).toBeCloseTo(2 / 3, 10);
    });
  });

  describe('heuristic self-votes never calibrate (voteSource)', () => {
    function vote(firstChoice: string, voteSource?: 'llm' | 'heuristic' | 'fallback') {
      return { voterId: '', firstChoice, secondChoice: '', reasoning: '', ...(voteSource ? { voteSource } : {}) };
    }

    const twoRounds = {
      rounds: [
        {
          votes: new Map([
            ['a', vote('a', 'heuristic')],
            ['b', vote('b', 'heuristic')],
            ['c', vote('c', 'heuristic')],
          ]),
        },
        {
          votes: new Map([
            ['a', vote('b', 'llm')],
            ['b', vote('b', 'llm')],
            ['c', vote('a', 'llm')],
          ]),
        },
      ],
    };

    it('scores only llm votes, keeps the original round index, and skips fallback votes', () => {
      const path = join(dir, 'ledger.json');
      VotingEngine.attachLedger(path);

      expect(VotingEngine.calibrateFromResult(twoRounds, 'b', 'geometric grid', {
        source: 'human', outcomeId: 'swarm:s2',
      })).toBe(3);

      const records = Object.fromEntries(VotingEngine.getAllPerformanceRecords()
        .map(record => [record.expertId, `${record.correctVotes}/${record.totalVotes}`]));
      expect(records).toEqual({ a: '1/1', b: '1/1', c: '0/1' });

      const ledger = JSON.parse(readFileSync(path, 'utf-8')) as { outcomes: string[] };
      expect([...ledger.outcomes].sort()).toEqual(['swarm:s2#r1:a', 'swarm:s2#r1:b', 'swarm:s2#r1:c']);
    });

    it('marks parsed LLM votes as llm and the no-caller placeholder as fallback', async () => {
      const personas = [persona('a', 'm1'), persona('b', 'm2')];
      const llm = await VotingEngine.conductVoting(
        outputsFor(['a', 'b']), personas, 1, config, async () => '1st: A\n2nd: B', 'x',
      );
      expect(llm.votes.get('a')?.voteSource).toBe('llm');
      expect(llm.votes.get('b')?.voteSource).toBe('llm');

      const fallback = await VotingEngine.conductVoting(
        outputsFor(['a', 'b']), personas, 1, config, undefined, 'x',
      );
      expect(fallback.votes.get('a')?.voteSource).toBe('fallback');
      expect(fallback.votes.get('b')?.voteSource).toBe('fallback');
    });
  });

  describe('hasOutcome (replay detection helper)', () => {
    const result = {
      rounds: [{
        votes: new Map([
          ['a', { voterId: 'a', firstChoice: 'b', secondChoice: '', reasoning: '' }],
          ['b', { voterId: 'b', firstChoice: 'c', secondChoice: '', reasoning: '' }],
        ]),
      }],
    };

    it('is false before any outcome and true after calibrateFromResult', () => {
      const path = join(dir, 'ledger.json');
      VotingEngine.attachLedger(path);
      expect(VotingEngine.hasOutcome('swarm:s1')).toBe(false);
      VotingEngine.calibrateFromResult(result, 'b', 'geometric grid', { source: 'human', outcomeId: 'swarm:s1' });
      expect(VotingEngine.hasOutcome('swarm:s1')).toBe(true);
      // Still true after a restart, and it does not mutate the dedupe state.
      VotingEngine.clearPerformanceHistory();
      VotingEngine.attachLedger(path);
      expect(VotingEngine.hasOutcome('swarm:s1')).toBe(true);
      expect(VotingEngine.calibrateFromResult(result, 'b', 'geometric grid', { source: 'human', outcomeId: 'swarm:s1' })).toBe(0);
    });

    it('matches recordOutcome keys and rejects foreign/blank ids', () => {
      VotingEngine.attachLedger(join(dir, 'ledger.json'));
      VotingEngine.recordOutcome('a', 'general', 'x', 'x', { source: 'human', outcomeId: 'swarm:s2' });
      expect(VotingEngine.hasOutcome('swarm:s2')).toBe(true);
      expect(VotingEngine.hasOutcome('swarm:s3')).toBe(false);
      expect(VotingEngine.hasOutcome('')).toBe(false);
      expect(VotingEngine.hasOutcome('swarm:s')).toBe(false);
    });
  });

  describe('correlated-voter discount', () => {
    it('gives each model family equal total influence', async () => {
      // Three personas on model m1 all vote A; one persona on m2 votes D (= b).
      // Undiscounted A would win 6-2; with family equalisation it is a 4-4 tie
      // per first-choice weight ((4/2)/3 = 2/3 each for m1, (4/2)/1 = 2 for m2).
      const personas = [persona('a', 'm1'), persona('a2', 'm1'), persona('a3', 'm1'), persona('b', 'm2')];
      const caller = async (model: string) => (model === 'm1' ? '1st: A' : '1st: D');
      const out = await VotingEngine.conductVoting(outputsFor(['a', 'a2', 'a3', 'b']), personas, 1, config, caller, 'x');
      expect(out.scores.get('a')).toBeCloseTo(4, 10);
      expect(out.scores.get('b')).toBeCloseTo(4, 10);
      expect(out.decision.basis).toBe('tie-insertion-order');
    });

    it('is a no-op when every voter shares one model', async () => {
      const personas = [persona('a', 'm1'), persona('b', 'm1')];
      const out = await VotingEngine.conductVoting(outputsFor(['a', 'b']), personas, 1, config, async () => '1st: A', 'x');
      expect(out.scores.get('a')).toBe(4);
      expect(out.decision.electedByVote).toBe(true);
    });
  });
});
