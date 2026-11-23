import { PromptBuilder } from '../llm/PromptBuilder.js';
import { compileCreativeThesis, creativeThesisPromptContext } from '../creative-intelligence/CreativeIntelligence.js';

/**
 * Two sections the governed `sinter generate` brief was missing: the craft
 * contract (what makes a piece finished, per medium) and the creative plan
 * (the contract the thesis compiler derives from the request). Both were built,
 * tested and reachable only from the TUI, music and layered paths.
 * SINTER_BRIEF_CRAFT=off turns both off, so a test can prove the brief changes
 * because of them.
 */
export function briefCraftEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SINTER_BRIEF_CRAFT ?? env.LIMINAL_BRIEF_CRAFT) !== 'off';
}

/** The compact per-medium craft contract, for the system brief. */
export function craftSection(domain: string, env: NodeJS.ProcessEnv = process.env): string {
  return briefCraftEnabled(env) ? PromptBuilder.contractFor(domain, 'local') : '';
}

/** The plan derived from the request, for the user brief. An unsupported request carries none. */
export function creativePlanSection(prompt: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!briefCraftEnabled(env)) return '';
  try { return creativeThesisPromptContext(compileCreativeThesis(prompt)); } catch { return ''; }
}
