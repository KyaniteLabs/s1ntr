/**
 * Music-to-visual bridge: run generateMusic, analyze result (BPM/FFT),
 * pass audioInput to generateVisuals, return combined result.
 * 
 * The visual input is derived from the exact governed audio artifact returned.
 */

import { compileMusicCreativeThesis, generateMusic } from '../music/generateMusic.js';
import { generateVisuals } from '../generateVisuals.js';
import type { CreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';
import type { DeterministicMusicArtifact, MusicSoundEvidence } from '../music/MusicSoundArtifact.js';

export interface GenerateMusicToVisualOptions {
  musicPlatform?: string;
  visualPlatform?: string;
  /** Optional traits (bpm, palette) passed to music/visual generators */
  traits?: { bpm?: number; palette?: string };
  /** External audio cannot be mixed with the governed generated artifact. */
  audioFilePath?: string;
}

export interface AudioInput {
  bpm: number;
  fft: number[];
  /** Exact governed audio artifact from which these features were derived. */
  artifactDigest: string;
  /** Additional audio features (if available) */
  features?: {
    spectralCentroid?: number;
    rms?: number;
    zcr?: number;
  };
}

function audioInputFromArtifact(artifact: DeterministicMusicArtifact): AudioInput {
  const { evidence } = artifact;
  const nyquist = evidence.observed.sampleRate / 2;
  const centroid = Math.max(0, Math.min(1, evidence.observed.spectralCentroidHz / nyquist));
  const rhythm = evidence.target.rhythm.pattern;
  const fft = Array.from({ length: DEFAULT_FFT_LEN }, (_, index) => {
    const rhythmicEnergy = rhythm[index % rhythm.length] ? evidence.observed.rms : evidence.observed.rms * 0.35;
    const spectralShape = 1 - Math.abs(index / (DEFAULT_FFT_LEN - 1) - centroid);
    return Math.max(0, Math.min(1, rhythmicEnergy + spectralShape * 0.2));
  });
  return {
    bpm: evidence.target.bpm,
    fft,
    artifactDigest: evidence.artifactDigest,
    features: {
      spectralCentroid: evidence.observed.spectralCentroidHz,
      rms: evidence.observed.rms,
    },
  };
}

export interface GenerateMusicToVisualResult {
  musicCode: string;
  visualCode: string;
  audioInput?: AudioInput;
  audioArtifact: DeterministicMusicArtifact;
  audioEvidence: MusicSoundEvidence;
  creativeThesis: CreativeThesis;
}

const DEFAULT_BPM = 120;
const DEFAULT_FFT_LEN = 16;

/**
 * Generate music from prompt, analyze to get audioInput, then generate visuals
 * with that input. Returns musicCode, visualCode, and audioInput when music produced something.
 */
export async function generateMusicToVisual(
  prompt: string,
  options?: GenerateMusicToVisualOptions
): Promise<GenerateMusicToVisualResult> {
  if (options?.audioFilePath) {
    throw new Error('External audio cannot replace the governed generated audio artifact');
  }
  const musicPlatform = options?.musicPlatform;
  const visualPlatform = options?.visualPlatform;
  const traits = options?.traits;
  const bpm = traits?.bpm ?? DEFAULT_BPM;
  const creativeThesis = compileMusicCreativeThesis(prompt);

  const musicResult = await generateMusic({
    prompt,
    bpm,
    platform: musicPlatform === 'strudel' || musicPlatform === 'p5-webaudio' ? musicPlatform : 'strudel',
    creativeThesis,
    deterministicArtifact: true,
  });
  if (!musicResult.artifact || !musicResult.evidence) {
    throw new Error('Governed music-to-visual generation requires artifact-bound audio evidence');
  }
  const audioArtifact = musicResult.artifact;
  const musicCode = musicResult.code;

  const audioInput = audioInputFromArtifact(audioArtifact);

  const visualResult = await generateVisuals({
    prompt,
    audioInput,
    platform: visualPlatform === 'hydra' || visualPlatform === 'p5' ? visualPlatform : 'hydra',
    // This bridge is deterministic by design: the governed music artifact is
    // generated locally, so the matching visual may use the explicit template
    // when no LLM is configured. source stays visible on the result.
    allowTemplateFallback: true,
  });
  const visualCode = visualResult.code;

  const result: GenerateMusicToVisualResult = {
    musicCode,
    visualCode,
    audioInput: musicCode ? audioInput : undefined,
    audioArtifact,
    audioEvidence: musicResult.evidence,
    creativeThesis,
  };

  return result;
}
