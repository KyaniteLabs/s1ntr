import type { ProductionAuthorityPath } from './types.js';
import { controlAuthorityRows } from './control.js';
import { learningAuthorityRows } from './learning.js';
import { providerAuthorityRows } from './provider.js';
import { renderAuthorityRows } from './render.js';
import { reviewAuthorityRows } from './review.js';
import { surfaceAuthorityRows } from './surface.js';

/** Composed inventory: one file per area, concatenated in this order. */
export const productionAuthorityInventory: readonly ProductionAuthorityPath[] = Object.freeze([
  ...providerAuthorityRows,
  ...renderAuthorityRows,
  ...reviewAuthorityRows,
  ...learningAuthorityRows,
  ...controlAuthorityRows,
  ...surfaceAuthorityRows,
]);
