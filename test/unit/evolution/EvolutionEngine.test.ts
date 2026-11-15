import { describe, it, expect, afterEach, vi } from 'vitest';

import { EvolutionEngine } from '../../../src/evolution/EvolutionEngine.js';

// EvolutionEngine.propose() gates on Math.random() twice: first the mutation
// gate (`random > rate`), then the proposal-type pick (`floor(random * 3)`).
// Stub Math.random to make both deterministic. clamp() is pure and needs no stub.
describe('EvolutionEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('propose', () => {
    it('returns null when the mutation gate does not fire', () => {
      // rate 0.1, random 0.9 → 0.9 > 0.1 → gated off
      vi.spyOn(Math, 'random').mockReturnValue(0.9);
      const engine = new EvolutionEngine({ tunables: { mutationRate: 0.1 } });
      expect(engine.propose()).toBeNull();
    });

    it('injects an exploratory prompt prefix when recent scores are low', () => {
      // gate random 0 (0 > 1 false → proposes), type random 0 → index 0 → "prompt"
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);
      const engine = new EvolutionEngine({ recentScores: [0.2, 0.3], tunables: { mutationRate: 1 } });
      expect(engine.propose()).toEqual({
        type: 'prompt',
        description: 'Inject exploratory creative direction',
        delta: { promptPrefix: 'Try a radically different approach. ', promptSuffix: undefined },
      });
    });

    it('injects a polishing prompt suffix when recent scores are high', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0);
      const engine = new EvolutionEngine({ recentScores: [0.8, 0.9], tunables: { mutationRate: 1 } });
      expect(engine.propose()).toEqual({
        type: 'prompt',
        description: 'Inject exploratory creative direction',
        delta: { promptPrefix: undefined, promptSuffix: ' Refine and polish this direction.' },
      });
    });

    it('bumps temperature up for a role proposal when scores are very low', () => {
      // type random 0.4 → floor(1.2) → index 1 → "role"
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.4);
      const engine = new EvolutionEngine({ recentScores: [0.2], tunables: { mutationRate: 1 } });
      const proposal = engine.propose();
      expect(proposal?.type).toBe('role');
      expect(proposal?.delta.temperatureAdjustment).toBe(0.1);
    });

    it('nudges temperature down for a role proposal when scores are adequate', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.4);
      const engine = new EvolutionEngine({ recentScores: [0.7], tunables: { mutationRate: 1 } });
      expect(engine.propose()?.delta.temperatureAdjustment).toBe(-0.05);
    });

    it('drops the quality threshold for a policy proposal when scores are very low', () => {
      // type random 0.7 → floor(2.1) → index 2 → "policy"
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.7);
      const engine = new EvolutionEngine({ recentScores: [0.3], tunables: { mutationRate: 1 } });
      const proposal = engine.propose();
      expect(proposal?.type).toBe('policy');
      expect(proposal?.delta.minQualityScoreAdjustment).toBe(-0.05);
    });

    it('defaults avgScore to 0.5 when there are no recent scores', () => {
      // role proposal; avg 0.5 is not < 0.5 → -0.05
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.4);
      const engine = new EvolutionEngine({ tunables: { mutationRate: 1 } });
      expect(engine.propose()?.delta.temperatureAdjustment).toBe(-0.05);
    });
  });

  describe('clamp', () => {
    it('bounds an over-ceiling temperature adjustment to +0.2 when a temperature range is set', () => {
      const engine = new EvolutionEngine({ tunables: { temperatureRange: { min: 0, max: 1 } } });
      expect(engine.clamp({ temperatureAdjustment: 0.9 }).temperatureAdjustment).toBe(0.2);
    });

    it('bounds an under-floor temperature adjustment to -0.2', () => {
      const engine = new EvolutionEngine({ tunables: { temperatureRange: { min: 0, max: 1 } } });
      expect(engine.clamp({ temperatureAdjustment: -5 }).temperatureAdjustment).toBe(-0.2);
    });

    it('leaves temperature adjustment untouched when no temperature range is configured', () => {
      const engine = new EvolutionEngine({ tunables: {} });
      expect(engine.clamp({ temperatureAdjustment: 0.9 }).temperatureAdjustment).toBe(0.9);
    });

    it('bounds maxTokens adjustment to +/-512 when a maxTokens range is set', () => {
      const engine = new EvolutionEngine({ tunables: { maxTokensRange: { min: 0, max: 4096 } } });
      expect(engine.clamp({ maxTokensAdjustment: 5000 }).maxTokensAdjustment).toBe(512);
      expect(engine.clamp({ maxTokensAdjustment: -5000 }).maxTokensAdjustment).toBe(-512);
    });

    it('always bounds minQualityScore adjustment to +/-0.1 regardless of tunables', () => {
      const engine = new EvolutionEngine();
      expect(engine.clamp({ minQualityScoreAdjustment: 0.5 }).minQualityScoreAdjustment).toBe(0.1);
      expect(engine.clamp({ minQualityScoreAdjustment: -0.5 }).minQualityScoreAdjustment).toBe(-0.1);
    });

    it('preserves non-numeric fields and invents no adjustments', () => {
      const engine = new EvolutionEngine({ tunables: { temperatureRange: { min: 0, max: 1 } } });
      expect(engine.clamp({ promptPrefix: 'x' })).toEqual({ promptPrefix: 'x' });
    });
  });
});
