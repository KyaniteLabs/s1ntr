import { createHash } from 'node:crypto';
import { generateControlArtifact, type ControlRecipe } from '../composition/index.js';
import {
  CompositionEvaluator,
  type CompositionEvaluationAttempt,
} from '../evaluation/index.js';
import type { DreamQueue, DreamTask } from './DreamQueue.js';
import type {
  CompositionDreamPlan,
  CompositionDreamRecord,
  DreamFailureRecord,
} from './CompositionDreamTypes.js';
import { mutateCompositionRecipe } from './CompositionRecipeMutator.js';

export interface CompositionDreamCognitiveSink {
  record(input: {
    task: DreamTask;
    plan: CompositionDreamPlan;
    recipe?: ControlRecipe;
    artifact?: string;
    evaluation?: CompositionDreamRecord['evaluation'];
    verdict: CompositionDreamRecord['verdict'] | 'failed';
    reason: string;
  }): Promise<Array<{ organ: string; status: string; detail: string }>>;
}

export type CompositionDreamEvidenceProvider = (
  recipe: ControlRecipe,
  artifact: string,
  task: DreamTask,
) => Promise<CompositionEvaluationAttempt[]>;

export interface CompositionDreamRunResult {
  task: DreamTask;
  record: CompositionDreamRecord;
}

function emptyReceipts(): Array<{ organ: string; status: string; detail: string }> {
  return [];
}

async function recordCognition(
  sink: CompositionDreamCognitiveSink | undefined,
  input: Parameters<CompositionDreamCognitiveSink['record']>[0],
): Promise<Array<{ organ: string; status: string; detail: string }>> {
  if (!sink) return emptyReceipts();
  try {
    return await sink.record(input);
  } catch (error) {
    return [{
      organ: 'cognition',
      status: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    }];
  }
}

export async function runNextCompositionDream(
  queue: DreamQueue,
  provideEvidence: CompositionDreamEvidenceProvider,
  cognitiveSink?: CompositionDreamCognitiveSink,
  evaluator = new CompositionEvaluator(),
): Promise<CompositionDreamRunResult | null> {
  const task = queue.dequeue('composition');
  if (!task) return null;
  const plan = task.compositionPlan;
  if (!plan) {
    queue.fail(task.id);
    throw new Error(`Composition dream ${task.id} has no plan`);
  }

  let recipe: ControlRecipe | undefined;
  let artifact: string | undefined;
  try {
    recipe = mutateCompositionRecipe(plan.parentRecipe, plan.mutation, task.id);
    artifact = generateControlArtifact(recipe);
    const evaluation = evaluator.evaluate(
      recipe,
      await provideEvidence(recipe, artifact, task),
    );
    const verdict = evaluation.outcome === 'PASS' ? 'admitted' : 'rejected';
    const receipts = await recordCognition(cognitiveSink, {
      task, plan, recipe, artifact, evaluation, verdict,
      reason: `Composition dream ${evaluation.outcome}`,
    });
    const record: CompositionDreamRecord = {
      parentRecipeId: plan.parentRecipe.id,
      mutation: plan.mutation,
      recipe,
      artifact,
      artifactDigest: createHash('sha256').update(artifact).digest('hex'),
      evaluation,
      verdict,
      provenance: plan.provenance,
      cognitiveReceipts: receipts,
    };
    queue.complete(task.id, {
      candidateDescriptor: task.sources[0]?.descriptor ?? [],
      parentIds: [plan.parentRecipe.id],
      composition: record,
    });
    return { task, record };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const receipts = await recordCognition(cognitiveSink, {
      task,
      plan,
      recipe,
      artifact,
      verdict: 'failed',
      reason,
    });
    const failure: DreamFailureRecord = {
      parentRecipeId: plan.parentRecipe.id,
      mutation: plan.mutation,
      reason,
      provenance: plan.provenance,
      cognitiveReceipts: receipts,
    };
    queue.fail(task.id, {
      candidateDescriptor: task.sources[0]?.descriptor ?? [],
      parentIds: [plan.parentRecipe.id],
      failure,
    });
    throw error;
  }
}
