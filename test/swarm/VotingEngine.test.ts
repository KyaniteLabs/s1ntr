import { describe, it, expect } from 'vitest';
/**
 * VotingEngine tests
 */

import { VotingEngine } from '../../src/swarm/VotingEngine.js';
import { DEFAULT_PERSONAS } from '../../src/swarm/personas.js';
import type { SwarmOutput, SwarmConfig } from '../../src/swarm/types.js';
import { SwarmMode } from '../../src/swarm/types.js';
import path from 'path';
import os from 'os';

describe('VotingEngine', () => {
  const mockConfig: SwarmConfig = {
    ollamaHost: 'http://localhost:11434',
    ollamaTimeout: 60,
    maxRounds: 10,
    convergenceThreshold: 3,
    musicalChairs: false,
    mode: SwarmMode.COMPETITIVE,
    personas: DEFAULT_PERSONAS,
    refinementConstraints: ['constraint1'],
    streamDir: path.join(os.tmpdir(), 'sinter-test-stream'),
  };

  describe('parseVote', () => {
    it('should parse structured vote with 1st and 2nd choice', () => {
      const candidateMap = new Map<string, string>([
        ['A', 'max'],
        ['B', 'rex'],
        ['C', 'sam'],
      ]);

      const result = VotingEngine.parseVote(
        '1st choice: B\n2nd choice: A\nSam had more emotion.',
        candidateMap
      );

      expect(result.first).toBe('rex');
      expect(result.second).toBe('max');
      expect(result.reasoning).toContain('emotion');
    });

    it('should parse vote with shorthand format', () => {
      const candidateMap = new Map<string, string>([
        ['A', 'max'],
        ['B', 'rex'],
      ]);

      const result = VotingEngine.parseVote('1st: A\n2nd: B\nMax was brief.', candidateMap);

      expect(result.first).toBe('max');
      expect(result.second).toBe('rex');
    });

    it('should fallback to finding any letter when structured parsing fails', () => {
      const candidateMap = new Map<string, string>([
        ['A', 'max'],
        ['B', 'rex'],
        ['C', 'sam'],
      ]);

      // 'A' appears in "was" before 'C', so fallback finds 'A' first
      const result = VotingEngine.parseVote('I choose C because it was interesting.', candidateMap);

      expect(result.first).toBe('max');
    });

    it('should return null for first/second when no candidate letter found', () => {
      const candidateMap = new Map<string, string>([
        ['A', 'max'],
      ]);

      // 'A' appears in "clear" — fallback finds it
      const result = VotingEngine.parseVote('No clear choice here.', candidateMap);

      expect(result.first).toBe('max');
    });

    it('should extract reasoning from last line', () => {
      const candidateMap = new Map<string, string>([
        ['A', 'max'],
        ['B', 'rex'],
      ]);

      const result = VotingEngine.parseVote('1st: A\n2nd: B\nBrief and precise.', candidateMap);

      expect(result.reasoning).toBe('Brief and precise.');
    });

    it('should handle case-insensitive letters', () => {
      const candidateMap = new Map<string, string>([
        ['A', 'max'],
        ['B', 'rex'],
      ]);

      const result = VotingEngine.parseVote('1st choice: a\n2nd choice: b\nLower case.', candidateMap);

      expect(result.first).toBe('max');
      expect(result.second).toBe('rex');
    });
  });

  describe('conductVoting', () => {
    const makeOutputs = (contents: Record<string, string>): Map<string, SwarmOutput> => {
      const outputs = new Map<string, SwarmOutput>();
      for (const [id, content] of Object.entries(contents)) {
        outputs.set(id, {
          personaId: id,
          personaName: id,
          content,
          model: 'test-model',
          tokensUsed: content.length,
          latencyMs: 100,
          roundNum: 1,
        });
      }
      return outputs;
    };

    it('should use fallback voting when no Ollama caller provided', async () => {
      const outputs = makeOutputs({
        max: 'Brief.',
        rex: 'Contrarian view.',
        sam: 'A story unfolds.',
      });

      const result = await VotingEngine.conductVoting(
        outputs,
        DEFAULT_PERSONAS.slice(0, 3),
        1,
        mockConfig
      );

      expect(result.winnerId).toBe('max');
      expect(result.scores.size).toBeGreaterThan(0);
      expect(result.votes.size).toBe(3);
    });

    it('should use provided Ollama caller for voting', async () => {
      const mockOllama = async (_model: string, _prompt: string): Promise<string> => {
        // All voters choose A (max)
        return '1st choice: A\n2nd choice: B\nMax was the best.';
      };

      const outputs = makeOutputs({
        max: 'Brief.',
        rex: 'Contrarian.',
        sam: 'Story time.',
      });

      const result = await VotingEngine.conductVoting(
        outputs,
        DEFAULT_PERSONAS.slice(0, 3),
        1,
        mockConfig,
        mockOllama
      );

      expect(result.winnerId).toBe('max');
    });

    it('should apply weighted scoring correctly', async () => {
      // Nova has votingPower 2, Max has 2 — both are voters AND candidates
      const nova = DEFAULT_PERSONAS.find(p => p.id === 'nova')!;
      const max = DEFAULT_PERSONAS.find(p => p.id === 'max')!;
      const voters = [nova, max];

      const mockOllama = async (_model: string, _prompt: string): Promise<string> => {
        return '1st choice: A\n2nd choice: B\nGood choice.';
      };

      // A = nova, B = max (voters are also in outputs)
      const outputs = makeOutputs({
        nova: 'Bridging worlds together.',
        max: 'Brief.',
      });

      const result = await VotingEngine.conductVoting(outputs, voters, 1, mockConfig, mockOllama);

      // Nova (power 2) votes A (nova): 2*2=4, B (max): 2*1=2
      // Max (power 2) votes A (nova): 2*2=4, B (max): 2*1=2
      // nova total: 8, max total: 4
      expect(result.scores.get('nova')).toBe(8);
      expect(result.scores.get('max')).toBe(4);
      expect(result.winnerId).toBe('nova');
    });

    it('should handle Ollama errors gracefully', async () => {
      const mockOllama = async (): Promise<string> => {
        throw new Error('Ollama not running');
      };

      const outputs = makeOutputs({
        kai: 'Systems connect.',
        nova: 'Bridging worlds.',
      });

      const result = await VotingEngine.conductVoting(
        outputs,
        DEFAULT_PERSONAS.slice(0, 2),
        1,
        mockConfig,
        mockOllama
      );

      // Should still have votes even if they errored
      expect(result.votes.size).toBe(2);
    });
    describe('decision receipt (#1297)', () => {
      const ids = (ps: { id: string }[]) => ps.map(p => p.id);

      it('labels the no-caller path as a fallback with zero valid votes', async () => {
        const voters = DEFAULT_PERSONAS.slice(0, 3);
        const result = await VotingEngine.conductVoting(
          makeOutputs({ [voters[0].id]: 'a', [voters[1].id]: 'b', [voters[2].id]: 'c' }), voters, 1, mockConfig,
        );
        expect(result.decision).toEqual({
          basis: 'no-caller-fallback', electedByVote: false, declaredVoters: 3, validVotes: 0,
          abstainedVoterIds: ids(voters), tiedIds: [], calibratedVoterIds: [],
        });
      });

      it('marks a unique top score from parsed votes as a weighted majority', async () => {
        const voters = DEFAULT_PERSONAS.slice(0, 3);
        const result = await VotingEngine.conductVoting(
          makeOutputs({ [voters[0].id]: 'a', [voters[1].id]: 'b', [voters[2].id]: 'c' }), voters, 1, mockConfig,
          async () => '1st choice: A\n2nd choice: B\nA.',
        );
        expect(result.winnerId).toBe(voters[0].id);
        expect(result.decision).toEqual({
          basis: 'weighted-majority', electedByVote: true, declaredVoters: 3, validVotes: 3,
          abstainedVoterIds: [], tiedIds: [], calibratedVoterIds: [],
        });
      });

      it('reports a tie instead of passing insertion order off as a vote', async () => {
        const nova = DEFAULT_PERSONAS.find(p => p.id === 'nova')!;
        const max = DEFAULT_PERSONAS.find(p => p.id === 'max')!;
        let call = 0;
        // nova votes A only, max votes B only: equal power, equal scores.
        const replies = ['1st choice: A\nA.', '1st choice: B\nB.'];
        const result = await VotingEngine.conductVoting(
          makeOutputs({ nova: 'Bridging.', max: 'Brief.' }), [nova, max], 1, mockConfig,
          async () => replies[call++],
        );
        expect(result.scores.get('nova')).toBe(result.scores.get('max'));
        expect(result.winnerId).toBe('nova');
        expect(result.decision.basis).toBe('tie-insertion-order');
        expect(result.decision.electedByVote).toBe(false);
        expect(result.decision.tiedIds).toEqual(['nova', 'max']);
      });

      it('counts call errors as abstentions and labels the viable-output fallback', async () => {
        const voters = DEFAULT_PERSONAS.slice(0, 2);
        const result = await VotingEngine.conductVoting(
          makeOutputs({ [voters[0].id]: '[Generation error: x]', [voters[1].id]: 'real output' }), voters, 1, mockConfig,
          async () => { throw new Error('Ollama not running'); },
        );
        expect(result.winnerId).toBe(voters[1].id);
        expect(result.decision).toEqual({
          basis: 'no-valid-votes-fallback', electedByVote: false, declaredVoters: 2, validVotes: 0,
          abstainedVoterIds: ids(voters), tiedIds: [], calibratedVoterIds: [],
        });
      });

      it('names only voters whose weight came from recorded outcomes in the prompt domain (#1295)', async () => {
        const voters = DEFAULT_PERSONAS.slice(0, 2);
        const prompt = 'zz-calibration-probe';
        const domain = VotingEngine.inferDomain(prompt);
        VotingEngine.recordOutcome(voters[1].id, domain, voters[0].id, voters[0].id);
        VotingEngine.recordOutcome(voters[0].id, 'some-other-domain-1295', voters[0].id, voters[0].id);
        const result = await VotingEngine.conductVoting(
          makeOutputs({ [voters[0].id]: 'a', [voters[1].id]: 'b' }), voters, 1, mockConfig,
          async () => '1st choice: A\nA.', prompt,
        );
        expect(result.decision.calibratedVoterIds).toEqual([voters[1].id]);
      });

      it('keeps voters without an output in the declared denominator as abstentions', async () => {
        const voters = DEFAULT_PERSONAS.slice(0, 3);
        const result = await VotingEngine.conductVoting(
          makeOutputs({ [voters[0].id]: 'a', [voters[1].id]: 'b' }), voters, 1, mockConfig,
          async () => '1st choice: A\nA.',
        );
        expect(result.decision.declaredVoters).toBe(3);
        expect(result.decision.validVotes).toBe(2);
        expect(result.decision.abstainedVoterIds).toEqual([voters[2].id]);
      });
    });
  });
});
