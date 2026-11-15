import { describe, it, expect } from 'vitest';
import { AudioAnalyzer } from '../../../src/audio/AudioAnalyzer.js';

describe('AudioAnalyzer', () => {
  it('chains extractor, pitch, timbre into full result', () => {
    const analyzer = new AudioAnalyzer();
    const buffer = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) buffer[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
    const result = analyzer.analyze(buffer, 44100);
    expect(result.features.rms).toBeGreaterThan(0);
    expect(result.timbre.brightness).toBeGreaterThanOrEqual(0);
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('getVisualMapping returns VisualMappingParams', () => {
    const analyzer = new AudioAnalyzer();
    const buffer = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) buffer[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
    const result = analyzer.analyze(buffer, 44100);
    const mapping = analyzer.getVisualMapping(result);
    expect(mapping.palette.hues).toEqual([0.75, expect.closeTo(1 / 3, 6), 0]);
    expect(mapping.palette.saturations).toEqual([expect.closeTo(0.9, 4), expect.closeTo(0.72, 4), expect.closeTo(0.72, 4)]);
    expect(mapping.palette.lightness).toEqual([expect.closeTo(0.22, 4), expect.closeTo(0.27, 4), expect.closeTo(0.32, 4)]);
    expect(mapping.motion).toEqual({"speed":1,"turbulence":0,"rhythm":"smooth"});
    expect(mapping.form).toEqual({ complexity: expect.closeTo(0.312, 3), sharpness: expect.closeTo(1, 4), scale: expect.closeTo(0.4329, 3) });
    expect(mapping.dynamics).toEqual({ energy: expect.closeTo(0.4329, 3), envelope: [expect.closeTo(0.4329, 3), 1, expect.closeTo(0.2559, 3)], onsets: [] });
    expect(mapping.composition).toEqual({ focalWeight: expect.closeTo(0.2165, 3), balance: expect.closeTo(0.6508, 3) });
  });

  it('handles silent buffer gracefully', () => {
    const analyzer = new AudioAnalyzer();
    const buffer = new Float32Array(2048);
    const result = analyzer.analyze(buffer, 44100);
    expect(result.features.rms).toBeLessThan(0.01);
    expect(result.pitch).toBeNull();
  });
});
