import type { ControlRecipe, DomainType } from '../composition/index.js';
import type { CompositionEvaluationResult } from '../evaluation/index.js';
import type { StudioLineageInput } from '../tui-bridge/StudioLineage.js';

export type CompositionDreamMutation =
  | { kind: 'mapping'; mappingId: string; scale: number; offset?: number }
  | { kind: 'timing'; cadenceMs?: number; bufferSize?: number; staleAfterMs?: number }
  | { kind: 'compatible-domain'; layerId: string; domain: DomainType };

export interface CompositionDreamProvenance {
  lineageId: string;
  sourceDigest: string;
  origin: string;
  trust: StudioLineageInput['trust'];
  taint: NonNullable<StudioLineageInput['taint']>;
  taintSources: string[];
  corroboration: string[];
}

export interface CompositionDreamPlan {
  parentRecipe: ControlRecipe;
  mutation: CompositionDreamMutation;
  provenance: CompositionDreamProvenance;
}

export interface CompositionDreamRecord {
  parentRecipeId: string;
  mutation: CompositionDreamMutation;
  recipe: ControlRecipe;
  artifact: string;
  artifactDigest: string;
  evaluation: CompositionEvaluationResult;
  verdict: 'admitted' | 'rejected';
  provenance: CompositionDreamProvenance;
  cognitiveReceipts: Array<{ organ: string; status: string; detail: string }>;
}

export interface DreamFailureRecord {
  parentRecipeId: string;
  mutation: CompositionDreamMutation;
  reason: string;
  provenance: CompositionDreamProvenance;
  cognitiveReceipts: Array<{ organ: string; status: string; detail: string }>;
}
