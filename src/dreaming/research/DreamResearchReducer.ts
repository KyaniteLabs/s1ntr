import type { DreamExperimentPlan, DreamResearchEvent,
  DreamResearchSnapshot } from './DreamResearchTypes.js';

function planned(event: DreamResearchEvent): DreamResearchSnapshot {
  const plan = event.payload.plan as DreamExperimentPlan | undefined;
  if (!plan || plan.aggregateId !== event.aggregateId || plan.schemaVersion !== 1
    || !Number.isInteger(plan.budget.maximumAttempts) || plan.budget.maximumAttempts < 0) {
    throw new Error('DREAM_PLAN_INVALID');
  }
  return { aggregateId: event.aggregateId, revision: event.revision, state: 'planned',
    finding: 'none', maximumAttempts: plan.budget.maximumAttempts,
    attemptsStarted: 0, hasUnknownAttempt: false, leaseCancelled: false };
}

export function reduceDreamResearch(events: readonly DreamResearchEvent[]): DreamResearchSnapshot {
  const first = events[0];
  if (!first || first.type !== 'experiment-planned') throw new Error('DREAM_NOT_PLANNED');
  let state = planned(first);
  for (const event of events.slice(1)) state = applyEvent(state, event);
  return state;
}

function next(state: DreamResearchSnapshot, event: DreamResearchEvent,
  update: Partial<DreamResearchSnapshot>): DreamResearchSnapshot {
  if (event.revision !== state.revision + 1) throw new Error('DREAM_EVENT_SEQUENCE_INVALID');
  return { ...state, ...update, revision: event.revision };
}

function applyEvent(state: DreamResearchSnapshot,
  event: DreamResearchEvent): DreamResearchSnapshot {
  switch (event.type) {
    case 'experiment-frozen': return requireState(state, event, ['planned'], 'frozen');
    case 'baseline-observed': return requireState(state, event, ['frozen'], 'baseline-observed');
    case 'variants-observed': return requireState(state, event,
      ['baseline-observed'], 'variants-observed');
    case 'experiment-rejected':
    case 'experiment-inconclusive':
      return requireState(state, event, ['variants-observed'], 'completed');
    case 'finding-proposed': return next(requireCurrent(state, ['variants-observed']), event,
      { state: 'finding-proposed', finding: 'proposed' });
    case 'transfer-frozen': return requireState(state, event,
      ['finding-proposed'], 'transfer-frozen');
    case 'transfer-observed': return requireState(state, event,
      ['transfer-frozen'], 'transfer-observed');
    case 'finding-validated': return next(requireCurrent(state, ['transfer-observed']), event,
      { state: 'completed', finding: 'validated' });
    case 'finding-falsified': return next(requireCurrent(state, ['transfer-observed']), event,
      { state: 'completed', finding: 'falsified' });
    case 'finding-inconclusive': return next(requireCurrent(state, ['transfer-observed']), event,
      { state: 'completed', finding: 'inconclusive' });
    case 'operation-reserved':
    case 'operation-completed':
    case 'holdout-accessed':
    case 'historical-imported':
      return next(state, event, {});
    case 'transport-started': return next(state, event,
      { attemptsStarted: state.attemptsStarted + (event.payload.metered === false ? 0 : 1) });
    case 'operation-outcome-unknown': return next(state, event,
      { hasUnknownAttempt: true });
    case 'operation-outcome-resolved': return next(state, event,
      { hasUnknownAttempt: false });
    case 'lease-cancelled': return next(state, event, { leaseCancelled: true });
    case 'experiment-abandoned': return next(state, event, { state: 'completed' });
    case 'experiment-planned': throw new Error('DREAM_ALREADY_PLANNED');
  }
}

function requireCurrent(state: DreamResearchSnapshot,
  allowed: DreamResearchSnapshot['state'][]): DreamResearchSnapshot {
  if (!allowed.includes(state.state)) throw new Error('DREAM_STATE_INVALID');
  return state;
}

function requireState(state: DreamResearchSnapshot, event: DreamResearchEvent,
  allowed: DreamResearchSnapshot['state'][], target: DreamResearchSnapshot['state']) {
  return next(requireCurrent(state, allowed), event, { state: target });
}
