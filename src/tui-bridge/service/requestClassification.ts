/**
 * Extracted from TuiBridgeService.ts: request classification helpers and the TUI system prompt.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */

export const TUI_SYSTEM_PROMPT = `You are Sinter's Meta-Harness operator interface.

Primary role:
- Help inspect, debug, repair, and improve the Sinter codebase and harness.
- Treat self-improvement, CI fixes, dogfood diagnostics, TUI fixes, generator hardening, and repo maintenance as first-class tasks.
- You are allowed and expected to discuss how the system should improve itself.

Secondary role:
- Support creative coding requests when the user explicitly asks for art/music/code generation.

Operating rules:
- Be direct and technical.
- Do not refuse self-improvement work or narrow your identity to creative-only help.
- If you do not have tool execution in the current path, say what needs to be inspected or changed rather than pretending it is impossible.
- Prefer root cause, exact files, verification steps, and small patches.
- Generated code is untrusted until verified.`;

/** Keywords that indicate a generation request */
export const GENERATION_KEYWORDS = [
  'generate', 'create', 'make', 'sketch', 'draw', 'code',
  'p5', 'three.js', 'shader', 'glsl', 'hydra', 'strudel',
  'visualization', 'animation', 'pattern', 'art',
];

export const SELF_IMPROVEMENT_KEYWORDS = [
  'self-improve', 'self improve', 'self-improvement', 'improve itself',
  'fix', 'debug', 'diagnose', 'repair', 'refactor', 'cleanup',
  'harness', 'meta-harness', 'bubble tea', 'tui', 'ci', 'build',
  'test', 'dogfood', 'repo', 'codebase', 'generator hardening',
];

export const OPERATOR_INSPECTION_PATTERNS = [
  /\bread-only\b/,
  /\bdo not modify\b/,
  /\bdo not create files?\b/,
  /\bdo not commit\b/,
  /\bdo not push\b/,
  /\buse tool calls only\b/,
  /\btelemetry-friendly\b/,
  /\bdogfood checkpoint\b/,
  /\brepository state\b/,
  /\bprovider\/model truth\b/,
  /\btool schema recovery\b/,
];

/** Check if input indicates repo/harness repair rather than creative generation. */
export function isSelfImprovementRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return SELF_IMPROVEMENT_KEYWORDS.some(kw => lower.includes(kw));
}

/** Check if input is an operator inspection/checkpoint, not creative generation. */
export function isOperatorInspectionRequest(text: string): boolean {
  const lower = text.toLowerCase();
  const matchCount = OPERATOR_INSPECTION_PATTERNS
    .filter(pattern => pattern.test(lower))
    .length;
  return matchCount >= 2;
}

/** Check if input indicates creative generation intent */
export function isGenerationRequest(text: string): boolean {
  if (isSelfImprovementRequest(text)) return false;

  const lower = text.toLowerCase();
  const operatorLike = /\b(fix|debug|diagnose|repair|refactor|cleanup|harness|meta-harness|bubble tea|tui|ci|build|test|dogfood|repo|codebase)\b/.test(lower);
  if (operatorLike) return false;
  return GENERATION_KEYWORDS.some(kw => lower.includes(kw));
}

/** Keep Studio responsive while allowing K3's larger reasoning budget to finish. */
export function resolveDraftCandidateTimeoutMinutes(
  timeoutMinutes: number,
  generatorModelName: string,
): number {
  const providerCap = generatorModelName.toLowerCase().includes('kimi-k3') ? 5 : 3;
  return Math.min(providerCap, timeoutMinutes);
}
