export type CognitiveRunLane = 'creative' | 'self-improvement' | 'model-assimilation';
export type CognitiveRunStatus = 'success' | 'failed' | 'suspended';

export interface CognitiveRunReceiptInput {
  prompt: string;
  lane: CognitiveRunLane;
  status: CognitiveRunStatus;
  artifactPaths: string[];
  failures: string[];
  mutatedFiles: string[];
  /**
   * Receipts emitted by the organs that actually participated in the run
   * (e.g. PostGenerationCognitiveWriter). Memory and intuition are only
   * reported as `observed` when a matching receipt says so; they are never
   * inferred from run status or artifact counts.
   */
  organReceipts?: CognitiveOrganParticipation[];
}

export type CognitiveOrganName = 'memory' | 'compost' | 'dreaming' | 'intuition';

export interface CognitiveOrganParticipation {
  organ: string;
  status: CognitiveOrganReceipt['status'];
  detail: string;
}

export interface CognitiveOrganReceipt {
  status: 'observed' | 'pending' | 'unavailable';
  detail: string;
}

export interface CognitiveRunReceipt {
  loop: CognitiveRunLane;
  prompt: string;
  status: CognitiveRunStatus;
  artifactPaths: string[];
  mutatedFiles: string[];
  organs: {
    memory: CognitiveOrganReceipt;
    compost: CognitiveOrganReceipt;
    dreaming: CognitiveOrganReceipt;
    intuition: CognitiveOrganReceipt;
  };
  nextAction: {
    kind: 'repeat' | 'repair' | 'ship' | 'investigate';
    reason: string;
  };
}

function participationFor(
  receipts: CognitiveOrganParticipation[] | undefined,
  organ: CognitiveOrganName,
): CognitiveOrganReceipt | undefined {
  const match = receipts?.find((receipt) => receipt.organ === organ);
  return match ? { status: match.status, detail: match.detail } : undefined;
}

function noParticipation(organ: CognitiveOrganName): CognitiveOrganReceipt {
  return { status: 'unavailable', detail: `No ${organ} participation receipt for this run.` };
}

export function buildCognitiveRunReceipt(input: CognitiveRunReceiptInput): CognitiveRunReceipt {
  const failed = input.status !== 'success' || input.failures.length > 0;
  const failureText = input.failures.length > 0 ? input.failures.join('; ') : 'no explicit failure';
  const memory = participationFor(input.organReceipts, 'memory') ?? noParticipation('memory');
  const intuition = participationFor(input.organReceipts, 'intuition') ?? noParticipation('intuition');
  const compost = participationFor(input.organReceipts, 'compost') ?? {
    status: failed ? 'observed' : 'pending',
    detail: failed ? failureText : 'No failure compost; keep successful motifs as reusable seed material.',
  };
  const dreaming = participationFor(input.organReceipts, 'dreaming') ?? {
    status: 'pending',
    detail: failed
      ? `Dream a smaller repair around: ${failureText}`
      : 'Dream one adjacent variation from the successful run.',
  };
  const shippable = !failed && input.artifactPaths.length > 0 && memory.status === 'observed';

  return {
    loop: input.lane,
    prompt: input.prompt,
    status: input.status,
    artifactPaths: [...input.artifactPaths],
    mutatedFiles: [...input.mutatedFiles],
    organs: { memory, compost, dreaming, intuition },
    nextAction: failed
      ? { kind: 'repair', reason: `Run ${input.status}; repair the failure before broadening: ${failureText}` }
      : shippable
        ? { kind: 'ship', reason: 'Run succeeded with artifacts and a memory participation receipt; eligible for product receipt display.' }
        : {
          kind: 'investigate',
          reason: input.artifactPaths.length === 0
            ? 'Run reported success but produced no artifacts; investigate before shipping.'
            : 'Run reported success without a memory participation receipt; investigate before shipping.',
        },
  };
}
