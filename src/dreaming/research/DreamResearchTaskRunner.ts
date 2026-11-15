import type { DreamQueue, DreamTask } from '../DreamQueue.js';
import type { DreamResearchControllerState,
  DreamResearchHypothesis } from './DreamHypothesisSelector.js';
import type { DreamExperimentPlan } from './DreamResearchTypes.js';
import type { DreamResearchRuntime } from './DreamResearchRuntime.js';

export interface CanonicalDreamTaskRunnerOptions {
  hypotheses(task: DreamTask): readonly DreamResearchHypothesis[];
  controllerState(): DreamResearchControllerState;
  updateControllerState(state: DreamResearchControllerState): void;
  buildPlan(task: DreamTask, hypothesis: DreamResearchHypothesis): DreamExperimentPlan;
  assertAuthorized(): void;
}

export class CanonicalDreamTaskRunner {
  constructor(private readonly queue: DreamQueue,
    private readonly runtime: DreamResearchRuntime,
    private readonly options: CanonicalDreamTaskRunnerOptions) {}

  async runNext(): Promise<{ task: DreamTask; aggregateId: string;
    state: string } | null> {
    this.options.assertAuthorized();
    const task = this.queue.dequeue();
    if (!task) return null;
    try {
      if (task.sources.some(source => !source.artifact)) {
        throw new Error('DREAM_TASK_SOURCE_ARTIFACT_REQUIRED');
      }
      const controllerState = this.options.controllerState();
      const result = await this.runtime.run(this.options.hypotheses(task),
        controllerState, hypothesis => this.options.buildPlan(task, hypothesis));
      if (result.kind === 'stopped') {
        this.queue.fail(task.id, { candidateDescriptor: [],
          parentIds: task.sources.map(source => source.id) });
        return null;
      }
      this.options.updateControllerState(this.runtime.updateControllerState(
        controllerState, result.hypothesis, result.outcome));
      this.queue.complete(task.id, {
        candidateDescriptor: meanDescriptor(task),
        parentIds: task.sources.map(source => source.id),
      });
      return { task, aggregateId: result.aggregateId, state: result.state };
    } catch (error) {
      this.queue.fail(task.id);
      throw error;
    }
  }
}

function meanDescriptor(task: DreamTask): number[] {
  const width = Math.max(0, ...task.sources.map(source => source.descriptor.length));
  return Array.from({ length: width }, (_, index) => task.sources.reduce(
    (sum, source) => sum + (source.descriptor[index] ?? 0), 0) / task.sources.length);
}
