import { generatorRegistry } from '../generators/GeneratorRegistry.js';
import { registerAllGenerators } from '../generators/registerGenerators.js';
import { Domain, normalizeDomain } from '../types/domains.js';

/**
 * Map a generator-registry entry name to the loop's Domain value.
 * `shader` → GLSL (the loop/validators treat the shader family as GLSL).
 */
const ENTRY_TO_DOMAIN: Record<string, Domain> = {
  shader: Domain.GLSL,
  three: Domain.THREE,
  hydra: Domain.HYDRA,
  tone: Domain.TONE,
  strudel: Domain.STRUDEL,
  ascii: Domain.ASCII,
  kinetic: Domain.KINETIC,
  p5: Domain.P5,
  // `custom` (formerly `meta`) is the explicit-only custom-domain catch-all. It only wins dispatch
  // when the prompt explicitly asks for a custom/arbitrary medium (or --domain
  // custom is forced); a normal prompt scores 0 for custom and routes elsewhere, so
  // default/unknown routing is unchanged.
  custom: Domain.CUSTOM,
  blender: Domain.BLENDER,
  nbe: Domain.NBE,
};

/**
 * Detect the creative domain of a free-form prompt so the generation loop can
 * route BOTH generation and validation to the right generator.
 *
 * Without this, the CLI never sets `collabDomain`, so `run()` defaults to p5 —
 * a "GLSL fragment shader" prompt generates as p5 and fails p5 validation
 * ("missing setup()"). Uses the same registry confidence scoring as dispatch.
 *
 * @returns the detected Domain, or undefined if no generator is confident enough
 *          (caller then keeps the default).
 */
export async function detectPromptDomain(
  prompt: string,
  minConfidence = 0.6,
): Promise<Domain | undefined> {
  await registerAllGenerators();
  const dispatched = generatorRegistry.dispatch(prompt);
  if (!dispatched || dispatched.confidence < minConfidence) return undefined;
  const name = dispatched.entry.name;
  return ENTRY_TO_DOMAIN[name] ?? normalizeDomain(name);
}
