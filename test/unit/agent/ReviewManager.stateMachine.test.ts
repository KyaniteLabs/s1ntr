/**
 * ReviewManager candidate lifecycle as an explicit state machine.
 */

import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_STATUSES,
  CANDIDATE_TRANSITIONS,
  IllegalReviewTransitionError,
  ReviewManager,
  type CandidateStatus,
} from '../../../src/agent/ReviewManager.js';
import { pick, runModel } from '../../helpers/stateMachineModel.js';

const EXPECTED_TABLE: Record<CandidateStatus, CandidateStatus[]> = {
  pending: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
};

function decide(rm: ReviewManager, id: string, to: CandidateStatus): unknown {
  if (to === 'accepted') return rm.accept(id);
  if (to === 'rejected') return rm.reject(id);
  throw new Error('no public move into pending');
}

describe('ReviewManager state machine', () => {
  it('declares a transition row for every status and no others', () => {
    expect(Object.keys(CANDIDATE_TRANSITIONS).sort()).toEqual([...CANDIDATE_STATUSES].sort());
    for (const s of CANDIDATE_STATUSES) {
      expect([...CANDIDATE_TRANSITIONS[s]].sort()).toEqual([...EXPECTED_TABLE[s]].sort());
    }
  });

  for (const from of CANDIDATE_STATUSES) {
    for (const to of ['accepted', 'rejected'] as const) {
      const legal = EXPECTED_TABLE[from].includes(to);
      it(`${from} -> ${to} is ${legal ? 'allowed' : 'refused'}`, () => {
        const rm = new ReviewManager();
        const c = rm.addCandidate('s', 'c', 'x', 0.5);
        if (from !== 'pending') decide(rm, c.id, from);
        if (legal) {
          expect(decide(rm, c.id, to)).toMatchObject({ status: to });
        } else {
          expect(() => decide(rm, c.id, to)).toThrow(IllegalReviewTransitionError);
          expect(rm.get(c.id)!.status).toBe(from);
        }
      });
    }
  }

  it('unknown candidates still return null', () => {
    const rm = new ReviewManager();
    expect(rm.accept('nope')).toBeNull();
    expect(rm.reject('nope')).toBeNull();
  });

  it('model: random decisions match the transition table', () => {
    runModel<{ rm: ReviewManager; model: Map<string, CandidateStatus> }>({
      runs: 20,
      steps: 40,
      setup: () => ({ rm: new ReviewManager(), model: new Map() }),
      commands: [
        { name: 'add', run: w => { w.model.set(w.rm.addCandidate('s', 'c', 'x', 0.5).id, 'pending'); } },
        ...(['accepted', 'rejected'] as const).map(to => ({
          name: to,
          run: (w: { rm: ReviewManager; model: Map<string, CandidateStatus> }, rand: () => number) => {
            const ids = [...w.model.keys()];
            if (ids.length === 0) return;
            const id = pick(rand, ids);
            if (EXPECTED_TABLE[w.model.get(id)!].includes(to)) {
              decide(w.rm, id, to);
              w.model.set(id, to);
            } else {
              expect(() => decide(w.rm, id, to)).toThrow(IllegalReviewTransitionError);
            }
          },
        })),
        {
          name: 'clearSession',
          run: w => { w.rm.clearSession('s'); w.model.clear(); },
        },
      ],
      invariant: w => {
        expect(new Map(w.rm.list().map(c => [c.id, c.status]))).toEqual(w.model);
      },
    });
  });
});
