import type { PostGenerationCognitiveWriter } from '../tui-bridge/PostGenerationCognitiveWriter.js';
import type { StudioLineageLedger } from '../tui-bridge/StudioLineage.js';
import type { CompositionDreamCognitiveSink } from './CompositionDreamRunner.js';

function failureArtifact(reason: string): string {
  const safe = reason.replace(/[&<>]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  })[character]!);
  return `<!doctype html><meta charset="utf-8"><pre>Composition dream failed: ${safe}</pre>`;
}

export class CompositionDreamCognitiveAdapter implements CompositionDreamCognitiveSink {
  constructor(
    private readonly writer: PostGenerationCognitiveWriter,
    private readonly lineage: StudioLineageLedger,
  ) {}

  async record(
    input: Parameters<CompositionDreamCognitiveSink['record']>[0],
  ): ReturnType<CompositionDreamCognitiveSink['record']> {
    const { provenance } = input.plan;
    await this.lineage.append(provenance.lineageId, {
      stage: 'dream',
      status: input.verdict === 'failed' ? 'unavailable' : 'observed',
      origin: provenance.origin,
      trust: provenance.trust,
      taint: provenance.taint,
      taintSources: provenance.taintSources,
      corroboration: provenance.corroboration,
      payload: {
        taskId: input.task.id,
        parentRecipeId: input.plan.parentRecipe.id,
        mutation: input.plan.mutation,
        sourceDigest: provenance.sourceDigest,
        verdict: input.verdict,
        reason: input.reason,
      },
    });
    const artifact = input.artifact ?? failureArtifact(input.reason);
    const writeBack = await this.writer.writeBackGeneration({
      sessionId: input.task.id,
      lineageId: provenance.lineageId,
      userText: `Dream mutation of ${input.plan.parentRecipe.id}`,
      domain: 'html',
      code: artifact,
      // Structural PASS is diagnostic only; canonical transfer admission owns learning.
      finalScore: 0,
      iterations: 1,
      model: 'composition-dream-runner',
      reason: input.reason,
      executionMode: 'prove',
      evaluationStatus: 'unavailable',
      evaluationDetail: `legacy-structural-diagnostic:${input.evaluation?.outcome ?? input.reason}`,
    });
    return [
      {
        organ: 'lineage',
        status: 'observed',
        detail: `Preserved dream provenance for ${provenance.lineageId}.`,
      },
      ...writeBack.receipts,
    ];
  }
}
