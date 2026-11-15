export type CreateModeId =
  | 'auto'
  | 'p5'
  | 'three'
  | 'svg'
  | 'glsl'
  | 'hydra'
  | 'strudel'
  | 'tone'
  | 'hyperframes'
  | 'kinetic'
  | 'ascii'
  | 'text'
  | 'revideo'
  | 'organism';

export type WorkbenchExecutionMode = 'draft' | 'prove';

/** What a medium produces, so the UI can label sound vs picture clearly. */
export type CreateModeKind = 'auto' | 'visual' | 'audio' | 'audiovisual';

export interface CreateModeOption {
  id: CreateModeId;
  label: string;
  stageLabel: string;
  promptHint?: string;
  /** Plain-language: what this medium does and what it looks/sounds like. */
  blurb?: string;
  kind?: CreateModeKind;
}

export const CREATE_MODE_OPTIONS: CreateModeOption[] = [
  { id: 'auto', label: 'Auto', stageLabel: 'Automatic domain routing', kind: 'auto', blurb: 'Sinter picks the medium from your prompt.' },
  { id: 'p5', label: 'p5.js sketch', stageLabel: 'p5.js sketch', promptHint: 'Create a p5.js generative sketch.', kind: 'visual', blurb: '2D generative canvas — particles, flow fields, patterns, organic motion.' },
  { id: 'three', label: 'Three.js scene', stageLabel: 'Three.js scene', promptHint: 'Create a Three.js 3D scene.', kind: 'visual', blurb: 'Real-time 3D — objects, lighting, depth, and cameras that orbit the scene.' },
  { id: 'svg', label: 'SVG vector', stageLabel: 'SVG vector asset', promptHint: 'Create a raw SVG vector asset.', kind: 'visual', blurb: 'Crisp flat vector art — clean geometric lines, infinitely scalable.' },
  { id: 'glsl', label: 'GLSL shader', stageLabel: 'GLSL fragment shader', promptHint: 'Create a GLSL fragment shader.', kind: 'visual', blurb: 'Every pixel computed live on the GPU — plasma, fractals, fluid light fields.' },
  { id: 'hydra', label: 'Hydra visual', stageLabel: 'Hydra video synth', promptHint: 'Create a Hydra video synth sketch.', kind: 'visual', blurb: 'Live video synth — feedback loops, kaleidoscopes, warping analog texture.' },
  { id: 'strudel', label: 'Strudel music', stageLabel: 'Strudel music pattern', promptHint: 'Create a Strudel live-coding music pattern.', kind: 'audio', blurb: 'Live-coded music you can hear — beats and melodies. Sound, not a picture.' },
  { id: 'tone', label: 'Tone.js audio', stageLabel: 'Tone.js audio', promptHint: 'Create a Tone.js Web Audio sketch.', kind: 'audio', blurb: 'Web Audio synthesis — synths, drones, and tones. Sound, not a picture.' },
  { id: 'hyperframes', label: 'HyperFrames', stageLabel: 'HyperFrames composition', promptHint: 'Create a HyperFrames composition with HTML, CSS, GSAP timeline clips, data-composition-id, and window.__timelines registration.', kind: 'visual', blurb: 'HTML/CSS/GSAP motion graphics — title cards, animated layouts, promos.' },
  { id: 'kinetic', label: 'Kinetic type', stageLabel: 'CSS kinetic typography', promptHint: 'Create CSS kinetic typography as a complete animated HTML artifact.', kind: 'visual', blurb: 'Animated typography — words that move, pulse, and assemble themselves.' },
  { id: 'ascii', label: 'ASCII art', stageLabel: 'ASCII art', promptHint: 'Create ASCII art.', kind: 'visual', blurb: 'Art built from text characters — a glowing retro-terminal aesthetic.' },
  // 'text' is intentionally NOT offered: its promptHint never matched the ASCII/TEXTGEN
  // routing, so it silently produced p5 sketches. 'ascii' and 'kinetic' cover text art and
  // route correctly. Re-add only once TEXTGEN has a real preview path.
  { id: 'revideo', label: 'Revideo', stageLabel: 'Revideo composition', promptHint: 'Create a Revideo composition.', kind: 'visual', blurb: 'Rendered video compositions — timeline-based motion graphics.' },
  { id: 'organism', label: 'Organism (Strudel + Hydra)', stageLabel: 'Strudel + Hydra organism', kind: 'audiovisual', blurb: 'Strudel + Hydra together — music and visuals that react to each other.' },
];

/** Short human label for a medium's output kind. */
export function createModeKindLabel(kind?: CreateModeKind): string {
  switch (kind) {
    case 'audio': return 'Sound';
    case 'audiovisual': return 'Sound + visuals';
    case 'auto': return 'Smart pick';
    default: return 'Visual';
  }
}

export function getCreateModeOption(mode: string): CreateModeOption {
  return CREATE_MODE_OPTIONS.find((option) => option.id === mode) ?? CREATE_MODE_OPTIONS[0];
}

export function detectPromptCreateMode(prompt: string): CreateModeId | null {
  const lower = prompt.toLowerCase();
  if (/\bhydra\b|\bvideo synth\b/.test(lower)) return 'hydra';
  if (/\brevideo\b|\bvideo\b|\btimeline\b|\bmp4\b|\bmotion graphics?\b|\brender video\b|\bshot sequence\b|\bstoryboard\b/.test(lower)) return 'revideo';
  if (/\btone(?:\.js)?\b|\bweb audio\b|\bsynth\b/.test(lower)) return 'tone';
  if (/\bstrudel\b|\blive coding\b/.test(lower)) return 'strudel';
  if (/\bthree(?:\.js)?\b|\b3d\b|\bwebgl scene\b/.test(lower)) return 'three';
  if (/\bglsl\b|\bfragment shader\b|\bshader\b/.test(lower)) return 'glsl';
  if (/\bkinetic\b|\bkinetic typography\b|\bmoving typography\b|\banimated text\b/.test(lower)) return 'kinetic';
  if (/\bhyperframes?\b|\b(promo|trailer|slideshow|title\s*card|subtitle|caption|social\s*media)\b|\bhtml\b|\bcss\b/.test(lower)) return 'hyperframes';
  if (/\bsvg\b|\bvector\b/.test(lower)) return 'svg';
  if (/\bp5(?:\.js)?\b|\bcreative coding sketch\b/.test(lower)) return 'p5';
  if (/\bascii\b/.test(lower)) return 'ascii';
  return null;
}

export function buildWorkbenchPrompt(mode: CreateModeId, prompt: string): string {
  const trimmed = prompt.trim();
  const promptMode = detectPromptCreateMode(trimmed);
  const option = getCreateModeOption(promptMode ?? mode);
  if (!trimmed || !option.promptHint) return trimmed;
  return `${option.promptHint}\n\nUser prompt: ${trimmed}`;
}

export function usesOrganismApi(mode: CreateModeId): boolean {
  return mode === 'organism';
}

export function requiresBridgeSession(mode: CreateModeId): boolean {
  return !usesOrganismApi(mode);
}

export function buildWorkbenchRunOptions(executionMode: WorkbenchExecutionMode, maxIterations: number) {
  return buildWorkbenchRunOptionsForMode(executionMode, maxIterations, 'auto');
}

function normalizeDraftTimeout(timeoutMinutes: number | undefined, fallbackMinutes: number): number {
  const parsed = Number(timeoutMinutes);
  if (!Number.isFinite(parsed)) return fallbackMinutes;
  return Math.min(30, Math.max(1, Math.round(parsed)));
}

export function buildWorkbenchRunOptionsForMode(
  executionMode: WorkbenchExecutionMode,
  maxIterations: number,
  mode: CreateModeId,
  configuredTimeoutMinutes?: number,
  minQualityScore?: number,
) {
  const slowerDraftModes: CreateModeId[] = ['hydra', 'strudel', 'tone', 'revideo', 'hyperframes'];
  const gate = typeof minQualityScore === 'number' ? { minQualityScore } : {};
  if (executionMode === 'draft') {
    const fallbackTimeoutMinutes = slowerDraftModes.includes(mode) ? 3 : 1;
    return {
      executionMode: 'draft' as const,
      // Pass the real iteration count through. The bridge runs the fast single
      // pass at 1 and honors the Iterations slider above 1 by escalating to the
      // iterating, evaluator-scored loop — so the control is no longer inert.
      maxIterations,
      // Generate the best of 3 candidates, not a single coin-flip. The engine
      // runs them in parallel and picks the highest-scoring one, so wall-clock is
      // roughly unchanged while the output stops being hit-or-miss.
      candidateCount: 3,
      // Generate should respect the visible Studio loop timeout; hidden one-minute caps make local models fail without recourse.
      timeoutMinutes: normalizeDraftTimeout(configuredTimeoutMinutes, fallbackTimeoutMinutes),
      ...gate,
    };
  }

  return {
    executionMode: 'prove' as const,
    maxIterations,
    // Prove (Polish) refines the best of 3 across iterations.
    candidateCount: 3,
    timeoutMinutes: 3,
    ...gate,
  };
}
