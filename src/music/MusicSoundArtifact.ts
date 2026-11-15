import { createHash } from 'node:crypto';

import {
  CHORD_INTERVALS,
  generateProgression,
  getScaleNotes,
  noteToMidi,
} from './TheoryEngine.js';
import { generateEuclideanPattern } from './EuclideanRhythm.js';
import {
  MUSIC_SOUND_SUPPORTED_CONTRACT_IDS,
  creativeThesisIdentity,
  CREATIVE_PRINCIPLE_MANIFEST,
  projectCreativePrinciple,
  type CreativeThesis,
} from '../creative-intelligence/CreativeIntelligence.js';

export const MUSIC_SOUND_ARTIFACT_SCHEMA = 'sinter.music-sound-artifact' as const;
export const MUSIC_SOUND_ARTIFACT_VERSION = 1 as const;
export const MUSIC_SOUND_RUNTIME_ID = 'sinter.deterministic-audio-runtime/v1' as const;
export const MUSIC_SOUND_AUDIO_CLOCK_ID = 'sample-clock:8000hz/mono/pcm16' as const;
export const MUSIC_SOUND_REVISION_MAX = 1 as const;

export interface MusicSoundTarget {
  readonly bpm: number;
  readonly key: string;
  readonly scale: string;
  readonly progression: string;
  readonly rhythm: { readonly steps: number; readonly pulses: number; readonly pattern: readonly number[] };
  readonly dynamics: { readonly baselineAccent: number; readonly revisedAccent: number };
  readonly timbre: { readonly waveform: 'additive-sine'; readonly harmonics: readonly number[] };
}

export interface MusicSoundMeasurements {
  readonly sampleRate: number;
  readonly durationSeconds: number;
  readonly sampleCount: number;
  readonly rms: number;
  readonly peak: number;
  readonly dynamicRangeDb: number;
  readonly onsetCount: number;
  readonly spectralCentroidHz: number;
}

export interface MusicSoundProvenance {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly runtimeId: typeof MUSIC_SOUND_RUNTIME_ID;
  readonly audioClockId: typeof MUSIC_SOUND_AUDIO_CLOCK_ID;
  readonly capture: { readonly sampleRate: number; readonly channels: 1; readonly format: 'pcm16-le'; readonly schedule: string };
  readonly thesisId: string;
  readonly selectedContractIds: readonly string[];
  readonly contractProjectionDigests: Readonly<Record<string, string>>;
}

export interface MusicSoundEvidence {
  readonly schema: typeof MUSIC_SOUND_ARTIFACT_SCHEMA;
  readonly artifactDigest: string;
  readonly target: MusicSoundTarget;
  readonly observed: MusicSoundMeasurements;
  readonly provenance: MusicSoundProvenance;
  readonly observedDimensions: readonly ['rhythm', 'dynamics', 'spectral-content'];
  readonly unmeasuredDimensions: readonly ['harmony', 'timbre'];
}

export interface MusicSoundRevisionEvidence {
  readonly attempted: boolean;
  readonly revisionCount: number;
  readonly maximum: typeof MUSIC_SOUND_REVISION_MAX;
  readonly trigger: string;
  readonly before: MusicSoundEvidence;
  readonly after: MusicSoundEvidence;
}

export interface DeterministicMusicArtifact {
  readonly schema: typeof MUSIC_SOUND_ARTIFACT_SCHEMA;
  readonly version: typeof MUSIC_SOUND_ARTIFACT_VERSION;
  readonly mimeType: 'audio/wav';
  readonly audioBase64: string;
  readonly playableDataUri: string;
  readonly code: string;
  readonly evidence: MusicSoundEvidence;
  readonly revision: MusicSoundRevisionEvidence;
}

const SAMPLE_RATE = 8000;
const DURATION_SECONDS = 4;
const BPM = 96;
const KEY = 'C';
const SCALE = 'major';
const PROGRESSION = 'I-V-vi-IV';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function target(principleId: string): MusicSoundTarget {
  const rhythm = principleId === 'music-rhythm'
    ? { bpm: 132, steps: 12, pulses: 5 }
    : { bpm: BPM, steps: 8, pulses: 3 };
  return freeze({
    bpm: rhythm.bpm,
    key: principleId === 'music-harmony' ? 'D' : KEY,
    scale: principleId === 'music-harmony' ? 'minor' : SCALE,
    progression: principleId === 'music-harmony' ? 'I-vi-IV-V' : PROGRESSION,
    rhythm: { steps: rhythm.steps, pulses: rhythm.pulses, pattern: generateEuclideanPattern(rhythm.steps, rhythm.pulses) },
    dynamics: principleId === 'music-dynamics'
      ? { baselineAccent: 0.08, revisedAccent: 0.95 }
      : { baselineAccent: 0.15, revisedAccent: 0.65 },
    timbre: { waveform: 'additive-sine', harmonics: principleId === 'music-timbre' ? [1, 0.7, 0.45, 0.3] : [1, 0.2, 0.06] },
  });
}

function contractProvenance(id: string): Readonly<Record<string, string>> {
  return { [id]: createHash('sha256').update(projectCreativePrinciple(CREATIVE_PRINCIPLE_MANIFEST.contracts[id])).digest('hex') };
}

function selectedContract(thesis: CreativeThesis): { thesisId: string; principleId: string } {
  const identity = creativeThesisIdentity(thesis);
  if (!(MUSIC_SOUND_SUPPORTED_CONTRACT_IDS as readonly string[]).includes(identity.principleId)) throw new Error('Music artifact requires an exact supported music/sound Creative Thesis');
  return { thesisId: identity.thesisId, principleId: identity.principleId };
}

function frequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function harmonicVoice(freq: number, time: number, harmonics: readonly number[]): number {
  return harmonics.reduce((sum, weight, index) => sum + weight * Math.sin(2 * Math.PI * freq * (index + 1) * time), 0);
}

export function renderSamples(accent: number, musicalTarget: MusicSoundTarget = target('music-dynamics')): Float32Array {
  const samples = new Float32Array(SAMPLE_RATE * DURATION_SECONDS);
  const progression = generateProgression(musicalTarget.key, musicalTarget.progression, 2);
  const scaleNotes = getScaleNotes(musicalTarget.key, musicalTarget.scale, 3, 5);
  const stepSeconds = 60 / musicalTarget.bpm / 2;
  const chordNotes = progression.map((chord) => {
    const root = noteToMidi(chord.root, 3);
    return (CHORD_INTERVALS[chord.type] ?? CHORD_INTERVALS.major).map((interval) => root + interval);
  });
  for (let index = 0; index < samples.length; index++) {
    const time = index / SAMPLE_RATE;
    const beat = time * musicalTarget.bpm / 60;
    const step = Math.floor(beat * 2);
    const phase = (time % stepSeconds) / stepSeconds;
    const isOnset = musicalTarget.rhythm.pattern[step % musicalTarget.rhythm.steps] === 1 && phase < 0.92;
    const chord = chordNotes[Math.floor(beat / 2) % chordNotes.length];
    const chordRoot = frequency(chord[0]);
    const note = scaleNotes[Math.floor(beat * 2) % scaleNotes.length];
    const attack = Math.min(1, phase / 0.08);
    const release = Math.max(0, 1 - Math.max(0, phase - 0.6) / 0.32);
    const envelope = isOnset ? attack * release : 0;
    const pad = harmonicVoice(chordRoot / 2, time, [0.4, 0.12]) * 0.08;
    const harmony = chord.reduce((sum, midi) => sum + harmonicVoice(frequency(midi), time, musicalTarget.timbre.harmonics), 0) / chord.length;
    const melody = harmonicVoice(frequency(note), time, musicalTarget.timbre.harmonics) * envelope * (0.22 + accent * 0.42);
    const bass = Math.sin(2 * Math.PI * chordRoot / 2 * time) * (0.06 + envelope * 0.08);
    samples[index] = Math.max(-0.95, Math.min(0.95, pad + harmony * envelope * (0.08 + accent * 0.14) + melody + bass));
  }
  return samples;
}

export function measureAudio(samples: Float32Array): MusicSoundMeasurements {
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const windowSize = 80;
  const windows: number[] = [];
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    const window = samples.subarray(start, start + windowSize);
    windows.push(Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / window.length));
  }
  const nonZero = windows.filter((value) => value > 0.0001);
  const dynamicRangeDb = nonZero.length === 0 ? 0 : 20 * Math.log10(Math.max(...nonZero) / Math.min(...nonZero));
  let onsetCount = 0;
  for (let index = 1; index < windows.length; index++) if (windows[index] > windows[index - 1] * 1.35) onsetCount++;
  const fftSize = 256;
  let weightedFrequency = 0;
  let magnitudeTotal = 0;
  for (let bin = 1; bin < fftSize / 2; bin++) {
    let real = 0;
    let imag = 0;
    for (let index = 0; index < fftSize; index++) {
      const angle = 2 * Math.PI * bin * index / fftSize;
      real += samples[index] * Math.cos(angle);
      imag -= samples[index] * Math.sin(angle);
    }
    const magnitude = Math.sqrt(real * real + imag * imag);
    weightedFrequency += magnitude * bin * SAMPLE_RATE / fftSize;
    magnitudeTotal += magnitude;
  }
  return freeze({ sampleRate: SAMPLE_RATE, durationSeconds: DURATION_SECONDS, sampleCount: samples.length, rms, peak, dynamicRangeDb, onsetCount, spectralCentroidHz: magnitudeTotal === 0 ? 0 : weightedFrequency / magnitudeTotal });
}

function wavBytes(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.round(sample * 32767), true));
  return bytes;
}

function evidenceFor(bytes: Uint8Array, samples: Float32Array, thesis: CreativeThesis, musicalTarget: MusicSoundTarget): MusicSoundEvidence {
  const artifactDigest = createHash('sha256').update(bytes).digest('hex');
  const selected = selectedContract(thesis);
  const provenance = freeze({
    artifactId: `${MUSIC_SOUND_ARTIFACT_SCHEMA}:${artifactDigest.slice(0, 24)}`, artifactDigest,
    runtimeId: MUSIC_SOUND_RUNTIME_ID, audioClockId: MUSIC_SOUND_AUDIO_CLOCK_ID,
    capture: { sampleRate: SAMPLE_RATE, channels: 1 as const, format: 'pcm16-le' as const, schedule: 'sample-index = floor(time * 8000), fixed 80-sample RMS windows, 256-sample centroid DFT' },
    thesisId: selected.thesisId, selectedContractIds: [selected.principleId], contractProjectionDigests: contractProvenance(selected.principleId),
  });
  return freeze({ schema: MUSIC_SOUND_ARTIFACT_SCHEMA, artifactDigest, target: musicalTarget, observed: measureAudio(samples), provenance, observedDimensions: ['rhythm', 'dynamics', 'spectral-content'], unmeasuredDimensions: ['harmony', 'timbre'] });
}

function htmlForEvidence(evidence: MusicSoundEvidence, audioBase64: string): string {
  const ids = evidence.provenance.selectedContractIds.join(',');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sinter deterministic music</title></head><body><audio controls preload="auto" data-artifact-digest="${evidence.artifactDigest}" data-runtime-id="${MUSIC_SOUND_RUNTIME_ID}" data-audio-clock-id="${MUSIC_SOUND_AUDIO_CLOCK_ID}" data-contract-ids="${ids}" src="data:audio/wav;base64,${audioBase64}"></audio></body></html>`;
}

export function createDeterministicMusicArtifact(thesis: CreativeThesis): DeterministicMusicArtifact {
  const selected = selectedContract(thesis);
  const musicalTarget = target(selected.principleId);
  const baselineSamples = renderSamples(musicalTarget.dynamics.baselineAccent, musicalTarget);
  const baselineBytes = wavBytes(baselineSamples);
  const before = evidenceFor(baselineBytes, baselineSamples, thesis, musicalTarget);
  const trigger = before.observed.dynamicRangeDb < 16 ? 'observed.dynamicRangeDb < 16; increase-accent operator selected' : 'observed evidence met the dynamics floor; bounded revision not required';
  const shouldRevise = before.observed.dynamicRangeDb < 16;
  const finalAccent = shouldRevise ? musicalTarget.dynamics.revisedAccent : musicalTarget.dynamics.baselineAccent;
  const finalSamples = shouldRevise ? renderSamples(finalAccent, musicalTarget) : baselineSamples;
  const finalBytes = shouldRevise ? wavBytes(finalSamples) : baselineBytes;
  const after = evidenceFor(finalBytes, finalSamples, thesis, musicalTarget);
  const revision = freeze({ attempted: shouldRevise, revisionCount: shouldRevise ? 1 : 0, maximum: MUSIC_SOUND_REVISION_MAX, trigger, before, after });
  if (revision.revisionCount > MUSIC_SOUND_REVISION_MAX) throw new Error('Music sound revision bound exceeded');
  const audioBase64 = Buffer.from(finalBytes).toString('base64');
  return freeze({ schema: MUSIC_SOUND_ARTIFACT_SCHEMA, version: MUSIC_SOUND_ARTIFACT_VERSION, mimeType: 'audio/wav', audioBase64, playableDataUri: `data:audio/wav;base64,${audioBase64}`, code: htmlForEvidence(after, audioBase64), evidence: after, revision });
}
