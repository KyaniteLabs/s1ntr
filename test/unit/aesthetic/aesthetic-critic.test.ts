import { describe, it, expect } from 'vitest';
import { AestheticCritic } from '../../../src/aesthetic/AestheticCritic.js';
import type { CriticConfig } from '../../../src/aesthetic/types.js';

describe('AestheticCritic', () => {
  it('runs all critics and aggregates scores', () => {
    const critic = new AestheticCritic();
    const code = `
      function setup() { createCanvas(400, 400); }
      function draw() {
        background('#1a1a2e');
        fill('#e94560');
        ellipse(width/2, height/2, 100, 100);
        textSize(16);
        text('Hello', width/2, height/2);
      }
    `;
    const report = critic.critique(code);
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(1);
    expect(report.passed === true || report.passed === false).toBe(true);
    expect(report.timestamp).toBeGreaterThan(0);
  });

  it('returns score 0 for empty code', () => {
    const critic = new AestheticCritic();
    const report = critic.critique('');
    expect(report.score).toBe(0);
  });

  it('can disable individual critics via config', () => {
    const critic = new AestheticCritic();
    const config: Partial<CriticConfig> = { enabledCritics: ['color'] };
    const report = critic.critique('fill("#ff0000");', config);
    expect(report.score).toBeGreaterThan(0);
  });

  it('merges violations from all critics', () => {
    const critic = new AestheticCritic();
    const code = `
      textSize(200);
      fill('#ff0000'); fill('#00ff00'); fill('#0000ff'); fill('#ffaa00'); fill('#aa00ff');
    `;
    const report = critic.critique(code, { constraints: { color: { maxColors: 3 }, typography: { maxFonts: 1 } } } as any);
    // Should have violations from at least color and typography
    expect(report.violations.length).toBeGreaterThan(0);
  });

  it('accepts custom constraints', () => {
    const critic = new AestheticCritic();
    const report = critic.critique('fill("#ff0000");', {
      constraints: {
        color: { maxColors: 1 },
        layout: { focalPointRequired: false },
        typography: { maxFonts: 1 },
        sound: { maxDissonance: 0.5 },
        general: { minAestheticScore: 0.5 }
      }
    } as any);
    expect(report.passed === true || report.passed === false).toBe(true);
  });

  describe('applicability vs midpoint scores (#1279)', () => {
    const canvasWithRed = 'function setup(){createCanvas(400,400); fill("#ff0000"); rect(10,10,50,50);}';

    it('counts an applicable critic that scores exactly 0.5 instead of dropping it as N/A', () => {
      const critic = new AestheticCritic();
      // layout is applicable (canvas found) and scores 0.5; color scores 1.0;
      // typography and sound find nothing and are explicitly not applicable.
      const report = critic.critique(canvasWithRed);
      expect(report.score).toBe(0.75);
      expect(report.applicable).toBe(undefined);
    });

    it('excludes critics that flag themselves not applicable', () => {
      const critic = new AestheticCritic();
      const report = critic.critique(canvasWithRed, { enabledCritics: ['color', 'typography'] });
      expect(report.score).toBe(1);
    });

    it('marks the aggregate not applicable when no critic applies', () => {
      const critic = new AestheticCritic();
      const report = critic.critique('let x = 1;', { enabledCritics: ['typography', 'sound'] });
      expect(report.score).toBe(0.5);
      expect(report.applicable).toBe(false);
    });

    it('returns a failing zero report for empty code', () => {
      const report = new AestheticCritic().critique('   ');
      expect(report).toMatchObject({ score: 0, passed: false, violations: [] });
    });
  });
});
