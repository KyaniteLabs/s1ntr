import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import {
  MUSIC_SOUND_ARTIFACT_SCHEMA,
  MUSIC_SOUND_AUDIO_CLOCK_ID,
  MUSIC_SOUND_REVISION_MAX,
  MUSIC_SOUND_RUNTIME_ID,
  createDeterministicMusicArtifact,
} from '../../../src/music/MusicSoundArtifact.js';
import { generateMusic } from '../../../src/music/generateMusic.js';

describe('deterministic music sound artifact', () => {
  it('renders a playable, theory-aware artifact with exact deterministic identity', () => {
    const thesis = compileCreativeThesis('A theory-aware music pulse with chord movement, expressive dynamics, and shaped timbre.');
    const first = createDeterministicMusicArtifact(thesis);
    const second = createDeterministicMusicArtifact(thesis);
    const bytes = Buffer.from(first.audioBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(first.schema).toBe(MUSIC_SOUND_ARTIFACT_SCHEMA);
    expect(first.audioBase64).toBe(second.audioBase64);
    expect(first.evidence).toEqual(second.evidence);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(bytes.readUInt16LE(20)).toBe(1);
    expect(bytes.readUInt16LE(22)).toBe(1);
    expect(first.evidence.artifactDigest).toBe(digest);
    expect(first.playableDataUri).toBe(`data:audio/wav;base64,${first.audioBase64}`);
    expect(first.code).toContain(`data-artifact-digest="${digest}"`);
  });

  it('separates declared targets from measured dimensions and records one bounded revision', () => {
    const artifact = createDeterministicMusicArtifact(compileCreativeThesis('Music with expressive audio dynamics and a shaped envelope.'));
    const { evidence, revision } = artifact;
    expect(evidence.target.progression).toBe('I-V-vi-IV');
    expect(evidence.target.rhythm).toEqual({ steps: 8, pulses: 3, pattern: [1, 0, 1, 0, 0, 1, 0, 0] });
    expect(evidence.observedDimensions).toEqual(['rhythm', 'dynamics', 'spectral-content']);
    expect(evidence.unmeasuredDimensions).toEqual(['harmony', 'timbre']);
    expect(evidence.observed.sampleRate).toBe(8000);
    expect(evidence.observed.sampleCount).toBe(32000);
    expect(evidence.provenance.runtimeId).toBe(MUSIC_SOUND_RUNTIME_ID);
    expect(evidence.provenance.audioClockId).toBe(MUSIC_SOUND_AUDIO_CLOCK_ID);
    expect(evidence.provenance.capture).toEqual({ sampleRate: 8000, channels: 1, format: 'pcm16-le', schedule: 'sample-index = floor(time * 8000), fixed 80-sample RMS windows, 256-sample centroid DFT' });
    expect(evidence.provenance.selectedContractIds).toEqual(['music-dynamics']);
    expect(revision.attempted).toBe(true);
    expect(revision.revisionCount).toBe(1);
    expect(revision.maximum).toBe(MUSIC_SOUND_REVISION_MAX);
    expect(revision.before.artifactDigest).not.toBe(revision.after.artifactDigest);
    expect(revision.after.observed.dynamicRangeDb).toBeGreaterThan(revision.before.observed.dynamicRangeDb);
    expect(revision.trigger).toContain('dynamicRangeDb < 16');
  });

  it('makes each selected music principle causally change controls and exact bytes', () => {
    const prompts = [
      'Music with a strong rhythmic pulse.',
      'Music with a coherent chord harmony.',
      'Music with expressive audio dynamics.',
      'Music with a shaped spectral timbre.',
    ];
    const artifacts = prompts.map((prompt) => createDeterministicMusicArtifact(compileCreativeThesis(prompt)));
    expect(new Set(artifacts.map((artifact) => artifact.audioBase64)).size).toBe(4);
    expect(new Set(artifacts.map((artifact) => JSON.stringify(artifact.evidence.target))).size).toBe(4);
    expect(artifacts.map((artifact) => artifact.evidence.provenance.selectedContractIds[0])).toEqual([
      'music-rhythm', 'music-harmony', 'music-dynamics', 'music-timbre',
    ]);
    expect(artifacts.every((artifact) => Boolean(artifact.evidence.provenance.thesisId))).toBe(true);
  });

  it('rejects missing, non-music, and mismatched theses', async () => {
    expect(() => createDeterministicMusicArtifact(undefined as never)).toThrow(/Creative Thesis|music\/sound/);
    expect(() => createDeterministicMusicArtifact(compileCreativeThesis('A visual color harmony palette.'))).toThrow(/music\/sound/);
    await expect(generateMusic({
      prompt: 'Music with a strong rhythmic pulse.',
      creativeThesis: compileCreativeThesis('Music with a different rhythmic pulse.'),
      deterministicArtifact: true,
    })).rejects.toThrow(/exactly match/);
  });

  it('uses the deterministic artifact at the production generator seam', async () => {
    const prompt = 'A theory-aware music pulse with chord movement, expressive dynamics, and shaped timbre.';
    const thesis = compileCreativeThesis(prompt);
    const result = await generateMusic({ prompt, creativeThesis: thesis, deterministicArtifact: true, platform: 'p5-webaudio' });
    expect(result.artifact?.schema).toBe(MUSIC_SOUND_ARTIFACT_SCHEMA);
    expect(result.evidence?.artifactDigest).toBe(result.artifact?.evidence.artifactDigest);
    expect(result.code).toBe(result.artifact?.code);
  });

  it('does not let a supplied supported thesis bypass an unsupported prompt', async () => {
    const thesis = compileCreativeThesis('A theory-aware music pulse with chord movement, expressive dynamics, and shaped timbre.');
    await expect(generateMusic({
      prompt: 'Use Sample Manipulation for this music artifact.',
      creativeThesis: thesis,
      deterministicArtifact: true,
    })).rejects.toThrow(/unsupported/);
  });

  it('enforces prompt and thesis governance without deterministic opt-in', async () => {
    const rhythmThesis = compileCreativeThesis('Music with a strong rhythmic pulse.');
    await expect(generateMusic({
      prompt: 'Use Sample Manipulation for this music artifact.',
      creativeThesis: rhythmThesis,
    })).rejects.toThrow(/unsupported/);
    await expect(generateMusic({
      prompt: 'Music with expressive audio dynamics.',
      creativeThesis: rhythmThesis,
    })).rejects.toThrow(/exactly match/);
  });
});
