import {
  validateControlRecipe,
  type ControlRecipe,
  type DomainType,
} from '../composition/index.js';
import type { CompositionDreamMutation } from './CompositionDreamTypes.js';

function cloneRecipe(recipe: ControlRecipe): ControlRecipe {
  return JSON.parse(JSON.stringify(recipe)) as ControlRecipe;
}

function mutateMapping(recipe: ControlRecipe, mutation: Extract<CompositionDreamMutation, { kind: 'mapping' }>): void {
  const mapping = recipe.mappings.find(candidate => candidate.id === mutation.mappingId);
  if (!mapping) throw new Error(`Unknown mapping ${mutation.mappingId}`);
  if (!Number.isFinite(mutation.scale) || mutation.scale === mapping.scale) {
    throw new Error('Mapping mutation must provide a distinct finite scale');
  }
  mapping.scale = mutation.scale;
  if (mutation.offset !== undefined) {
    if (!Number.isFinite(mutation.offset)) throw new Error('Mapping offset must be finite');
    mapping.offset = mutation.offset;
  }
}

function mutateTiming(recipe: ControlRecipe, mutation: Extract<CompositionDreamMutation, { kind: 'timing' }>): void {
  const changes = Object.entries(mutation).filter(([key]) => key !== 'kind');
  if (changes.length === 0) throw new Error('Timing mutation must change at least one setting');
  for (const [key, value] of changes) {
    if (!Number.isFinite(value) || Number(value) <= 0) {
      throw new Error(`Timing mutation ${key} must be positive`);
    }
  }
  Object.assign(recipe.transport, mutation);
  delete (recipe.transport as Record<string, unknown>).kind;
}

function mutateDomain(recipe: ControlRecipe, mutation: Extract<CompositionDreamMutation, { kind: 'compatible-domain' }>): void {
  const layer = recipe.layers.find(candidate => candidate.id === mutation.layerId);
  if (!layer) throw new Error(`Unknown layer ${mutation.layerId}`);
  const compatible = new Set(['tone:music', 'music:tone']);
  if (!compatible.has(`${layer.domain}:${mutation.domain}`)) {
    throw new Error(`Unsupported domain mutation ${layer.domain} -> ${mutation.domain}`);
  }
  layer.domain = mutation.domain as DomainType;
}

export function mutateCompositionRecipe(
  parent: ControlRecipe,
  mutation: CompositionDreamMutation,
  taskId: string,
): ControlRecipe {
  const recipe = cloneRecipe(parent);
  if (mutation.kind === 'mapping') mutateMapping(recipe, mutation);
  if (mutation.kind === 'timing') mutateTiming(recipe, mutation);
  if (mutation.kind === 'compatible-domain') mutateDomain(recipe, mutation);
  recipe.id = `dream-${taskId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
  recipe.lineage = {
    parentRecipeIds: [...new Set([...parent.lineage.parentRecipeIds, parent.id])],
    createdAt: new Date().toISOString(),
  };
  validateControlRecipe(recipe);
  return recipe;
}
