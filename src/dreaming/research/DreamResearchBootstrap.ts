import type { DreamTaskConsumer } from '../DreamTaskRunner.js';
import type { DreamQueue } from '../DreamQueue.js';
import { DreamHypothesisSelector } from './DreamHypothesisSelector.js';
import { DreamResearchJournal } from './DreamResearchJournal.js';
import { DreamResearchRuntime, type DreamExperimentExecutor } from './DreamResearchRuntime.js';
import { DreamResearchService, type DreamLeaseAuthority } from './DreamResearchService.js';
import { CanonicalDreamTaskRunner,
  type CanonicalDreamTaskRunnerOptions } from './DreamResearchTaskRunner.js';
import { createDreamDecisionAuthority,
  type DreamDecisionIssuer } from './DreamDecisionAuthority.js';
import type { DreamRecoveryResolver } from './DreamRecoveryAuthority.js';

export interface DreamResearchBootstrapOptions {
  queue: DreamQueue;
  journalPath: string;
  leaseAuthority: DreamLeaseAuthority;
  recoveryAuthority: DreamRecoveryResolver;
  controllerPolicy: ConstructorParameters<typeof DreamHypothesisSelector>[0];
  executor(decisions: DreamDecisionIssuer): DreamExperimentExecutor;
  task: CanonicalDreamTaskRunnerOptions;
}

/** The single product composition root for journal-backed Dream execution. */
export function createCanonicalDreamResearchConsumer(
  options: DreamResearchBootstrapOptions): CanonicalDreamTaskRunner {
  const journal = new DreamResearchJournal(options.journalPath);
  const decisions = createDreamDecisionAuthority();
  const service = new DreamResearchService(journal, options.leaseAuthority,
    decisions.resolver, options.recoveryAuthority);
  const controller = new DreamHypothesisSelector(options.controllerPolicy);
  const executor = options.executor(decisions.issuer);
  if (executor.kind === 'fake' && process.env.NODE_ENV !== 'test') {
    throw new Error('DREAM_FAKE_EXECUTOR_PRODUCT_FORBIDDEN');
  }
  const runtime = new DreamResearchRuntime(service, controller, executor);
  return new CanonicalDreamTaskRunner(options.queue, runtime, options.task);
}

/** Product default: explicit refusal is safer than an unbootstrapped silent no-op. */
export class UnavailableDreamResearchConsumer implements DreamTaskConsumer {
  runNext(): Promise<never> {
    return Promise.reject(new Error('DREAM_RESEARCH_BOOTSTRAP_REQUIRED: configure journal, active campaign lease, operator, isolated renderer, and independent evaluators'));
  }
}
