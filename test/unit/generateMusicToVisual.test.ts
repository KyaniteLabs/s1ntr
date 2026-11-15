import { describe, it, expect } from 'vitest';
/**
 * generateMusicToVisual tests - Music-to-visual bridge API
 *
 * TDD: generateMusicToVisual('ambient glitch') returns both musicCode and visualCode;
 * audioInput is present when music generates something.
 */

import { generateMusicToVisual } from '../../src/musicToVisual/generateMusicToVisual.js';

describe('generateMusicToVisual', () => {
  it("returns both musicCode and visualCode for prompt 'ambient glitch'", async () => {
    const result = await generateMusicToVisual('ambient glitch');

    expect(typeof result.musicCode).toBe('string');
    expect(result.musicCode?.length).toBeGreaterThan(0);

    expect(typeof result.visualCode).toBe('string');
    expect(result.visualCode?.length).toBeGreaterThan(0);
    expect(result.audioEvidence.provenance.thesisId).toBe(result.creativeThesis.thesisId);
    expect(result.audioArtifact.code).toContain('data:audio/wav;base64,');
    expect(result.musicCode).toBe(result.audioArtifact.code);
    expect(result.audioEvidence).toBe(result.audioArtifact.evidence);
    expect(result.audioInput?.artifactDigest).toBe(result.audioEvidence.artifactDigest);
    expect(result.audioInput?.bpm).toBe(result.audioEvidence.target.bpm);
    expect(result.audioInput?.features?.rms).toBe(result.audioEvidence.observed.rms);
  });

  it('rejects unsupported source prompts before music or visual generation', async () => {
    await expect(generateMusicToVisual('Use Sample Manipulation for this music artifact.')).rejects.toThrow(/unsupported/);
  });

  it('rejects an external audio source that would split artifact identity', async () => {
    await expect(generateMusicToVisual('Music with a strong rhythmic pulse.', {
      audioFilePath: '/tmp/different-audio.wav',
    })).rejects.toThrow(/cannot replace the governed generated audio artifact/);
  });

  it('includes audioInput when music generates something', async () => {
    const result = await generateMusicToVisual('ambient glitch');

    expect(result.audioInput).toHaveProperty('bpm');
    expect(typeof (result.audioInput as { bpm?: number }).bpm).toBe('number');
    expect(result.audioInput).toHaveProperty('fft');
    expect(Array.isArray((result.audioInput as { fft?: number[] }).fft)).toBe(true);
  });

  it('accepts options with musicPlatform and visualPlatform', async () => {
    const result = await generateMusicToVisual('ambient glitch', {
      musicPlatform: 'strudel',
      visualPlatform: 'hydra',
    });

    expect(result.musicCode).toMatch(/^<!DOCTYPE html>/);
    expect(result.visualCode).toMatch(/osc\(/);
  });

  it('accepts traits (bpm, palette) and passes them to generators', async () => {
    const result = await generateMusicToVisual('ambient', {
      traits: { bpm: 90, palette: 'mono' },
    });

    expect(result.musicCode).toMatch(/^<!DOCTYPE html>/);
    expect(result.visualCode).toMatch(/osc\(/);

    expect(result.audioInput!.bpm).toBe(result.audioEvidence.target.bpm);
    expect(result.audioInput!.artifactDigest).toBe(result.audioEvidence.artifactDigest);
  });

  it('causally changes artifact-bound visual inputs when the governed music principle changes', async () => {
    const rhythm = await generateMusicToVisual('Music with a strong rhythmic pulse.');
    const timbre = await generateMusicToVisual('Music with a shaped spectral timbre.');

    expect(rhythm.audioArtifact.audioBase64).not.toBe(timbre.audioArtifact.audioBase64);
    expect(rhythm.audioInput?.artifactDigest).not.toBe(timbre.audioInput?.artifactDigest);
    expect(rhythm.audioInput?.fft).not.toEqual(timbre.audioInput?.fft);
    expect(rhythm.visualCode).not.toBe(timbre.visualCode);
  });
});
