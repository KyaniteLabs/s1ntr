/**
 * Per-seat adversarial-audit stance blocks.
 *
 * Compact, shared spine + role-specific stance. Injected into each role's
 * existing prompt surface (PromptBuilder, evaluation, chat, harness) — not a
 * new framework. No secrets; pure static text.
 *
 * Owner directive (seats-401 / #379 resolution follow-up).
 */

import type { ModelRole } from '../config/RoleConfig.js';

/** Shared spine — every seat. Claims honesty + counterfactuals + can't-tell. */
export const SHARED_AUDIT_SPINE = [
  'Claims: tag each as observed / inferred / guessed. Do not blur the three.',
  'For every proposed fix, name one counterfactual (what would prove you wrong).',
  '"Can\'t tell" is valid and preferred over guessing.',
].join(' ');

/** Generator: self-audit before return. */
export const GENERATOR_AUDIT_STANCE = [
  'Self-audit before returning: brief adherence, swallowed errors, edge cases,',
  'what deterministic gates will catch. Fix first, then return code.',
].join(' ');

/** Evaluator: adversarial judging of code + pixels. */
export const EVALUATOR_AUDIT_STANCE = [
  'Relentless adversarial judging of code AND pixels. Evidence per claim.',
  '"Can\'t tell" beats guessing. Never inflate scores.',
].join(' ');

/** Chat / studio: audit the answer before sending. */
export const STUDIO_AUDIT_STANCE = [
  'Audit each answer before sending: true? useful? what is the user not seeing?',
  'Say the hard thing helpfully.',
].join(' ');

/**
 * Harness: rules of engagement from the K3 tour-leg brief (#401 dogfood leg 1).
 * Fail loud on wrong seat; no silent local fallback; verify before claim.
 */
export const HARNESS_AUDIT_STANCE = [
  'K3 tour-leg rules of engagement: fail loud if the harness seat is wrong or',
  'falls to a local default; attribute the resolved model in receipts; never',
  'claim success without build/test/render evidence; JSON tool contract only.',
].join(' ');

const ROLE_STANCE: Record<ModelRole, string> = {
  generator: GENERATOR_AUDIT_STANCE,
  evaluator: EVALUATOR_AUDIT_STANCE,
  harness: HARNESS_AUDIT_STANCE,
  studio: STUDIO_AUDIT_STANCE,
};

/** Upper bound for a single assembled audit block (chars). Enforced in tests. */
export const AUDIT_STANCE_MAX_CHARS = 700;

/**
 * Assemble the compact audit_stance block for a role. Deterministic, no I/O,
 * no secret interpolation.
 */
export function auditStanceBlock(role: ModelRole): string {
  const body = [
    SHARED_AUDIT_SPINE,
    ROLE_STANCE[role],
  ].join(' ');
  return `<audit_stance role="${role}">\n${body}\n</audit_stance>`;
}
