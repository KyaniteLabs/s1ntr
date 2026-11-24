import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { scoreRenderedEvidence } from '../../../src/core/ScoringEngine.js';
import type { LLMClient } from '../../../src/llm/LLMClient.js';
import type { RenderEvidence } from '../../../src/core/types/GenerationEvaluation.js';

async function encodePngBase64(width: number, height: number, rawRgb: Buffer): Promise<string> {
  const png = await sharp(rawRgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return png.toString('base64');
}

function makeFakeJudge(score = 0.82) {
  const generate = vi.fn().mockResolvedValue({
    code: JSON.stringify({ score, confidence: 0.9, reasoning: 'Judge evaluated visible pixels.' }),
    success: true,
  });
  const generateWithImages = vi.fn().mockResolvedValue({
    code: JSON.stringify({ score, confidence: 0.9, reasoning: 'Vision judge evaluated visible pixels.' }),
    success: true,
  });
  const llm = {
    generate,
    generateWithImages,
    getConfig: () => ({ model: 'mock-text-judge', provider: 'glm', baseUrl: '' }),
  } as unknown as LLMClient;
  return { llm, generate, generateWithImages };
}

function evidenceWithPng(dataBase64: string, width = 800, height = 600): RenderEvidence {
  return {
    timingMs: 150,
    infraUnavailable: false,
    candidateFailure: false,
    screenshot: { mimeType: 'image/png', dataBase64, width, height },
  };
}

describe('Create-path pixel gates (#1744 & #1746)', () => {
  it('gates near-flat PNG (brightnessStd < 4) before calling the LLM judge (0 judge calls)', async () => {
    const width = 800;
    const height = 600;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      const v = y % 2 === 0 ? 120 : 122;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        raw[i] = v;
        raw[i + 1] = v;
        raw[i + 2] = v;
      }
    }
    const pngBase64 = await encodePngBase64(width, height, raw);

    for (const domain of ['p5', undefined] as const) {
      const { llm, generate, generateWithImages } = makeFakeJudge();
      const result = await scoreRenderedEvidence(
        evidenceWithPng(pngBase64, width, height),
        'function setup() { createCanvas(800, 600); }',
        'make a bold geometric composition',
        llm,
        domain,
      );

      expect(result.failureClass).toBe('render');
      expect(result.score).toBe(0);
      expect(result.confidence).toBe(1);
      expect(result.renderMeasure?.brightnessStd).toBeLessThan(4);
      expect(result.repairAdvice?.issue).toContain('near-flat');
      expect(generate).toHaveBeenCalledTimes(0);
      expect(generateWithImages).toHaveBeenCalledTimes(0);
    }
  });

  it('gates near-black / too-dark PNG (meanLuminance < 12/255) before calling the LLM judge (0 judge calls)', async () => {
    const width = 800;
    const height = 600;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      const v = y % 2 === 0 ? 3 : 7;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        raw[i] = v;
        raw[i + 1] = v;
        raw[i + 2] = v;
      }
    }
    const pngBase64 = await encodePngBase64(width, height, raw);

    for (const domain of ['p5', undefined] as const) {
      const { llm, generate, generateWithImages } = makeFakeJudge();
      const result = await scoreRenderedEvidence(
        evidenceWithPng(pngBase64, width, height),
        'function setup() { createCanvas(800, 600); background(5); }',
        'make a luminous night scene',
        llm,
        domain,
      );

      expect(result.failureClass).toBe('render');
      expect(result.score).toBe(0);
      expect(result.confidence).toBe(1);
      expect(result.renderMeasure?.verdict).toBe('too-dark');
      expect(result.renderMeasure?.meanLuminance).toBeLessThan(12 / 255);
      expect(result.repairAdvice?.issue).toContain('too-dark');
      expect(generate).toHaveBeenCalledTimes(0);
      expect(generateWithImages).toHaveBeenCalledTimes(0);
    }
  });

  it('lets a healthy full-frame PNG reach the judge with non-sparse frameCoverage', async () => {
    const width = 800;
    const height = 600;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        // Saturated fields with a bright highlight band: full coverage AND real value structure, so the
        // overmixed (lost value structure, ValueStructure.ts) cap does not apply to this healthy frame.
        if (x >= 40 && x < 760 && y >= 140 && y < 170) {
          raw[i] = 255; raw[i + 1] = 250; raw[i + 2] = 235;
        } else if (x >= 40 && x < 760 && y >= 40 && y < 300) {
          raw[i] = 255; raw[i + 1] = 120; raw[i + 2] = 20;
        } else if (x >= 60 && x < 740 && y >= 310 && y < 560) {
          raw[i] = 20; raw[i + 1] = 210; raw[i + 2] = 200;
        } else {
          raw[i] = 24; raw[i + 1] = 28; raw[i + 2] = 40;
        }
      }
    }
    const pngBase64 = await encodePngBase64(width, height, raw);
    const { llm, generate } = makeFakeJudge(0.84);

    const result = await scoreRenderedEvidence(
      evidenceWithPng(pngBase64, width, height),
      'function setup() { createCanvas(800, 600); }',
      'make a full-frame color-field poster',
      llm,
      'p5',
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.failureClass).toBe('none');
    expect(result.score).toBe(0.84);
    expect(result.renderMeasure?.verdict).toBe('ok');
    expect(result.renderMeasure?.frameCoverage?.sparse).toBe(false);
    expect(result.renderMeasure?.frameCoverage?.coverageShare).toBeGreaterThan(0.5);
    expect(result.repairAdvice).toBeUndefined();
  });

  it('attaches sparse frameCoverage and repairAdvice for a centered 40x40 sprite on 800x600', async () => {
    const width = 800;
    const height = 600;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        const inSprite = x >= 380 && x < 420 && y >= 280 && y < 320;
        if (inSprite) {
          raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255;
        } else {
          raw[i] = 36; raw[i + 1] = 42; raw[i + 2] = 54;
        }
      }
    }
    const pngBase64 = await encodePngBase64(width, height, raw);
    const { llm, generate } = makeFakeJudge(0.75);

    const result = await scoreRenderedEvidence(
      evidenceWithPng(pngBase64, width, height),
      'function setup() { createCanvas(800, 600); }',
      'make a bold architectural field',
      llm,
      'p5',
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.failureClass).toBe('none');
    expect(result.renderMeasure?.verdict).toBe('ok');
    expect(result.renderMeasure?.frameCoverage?.sparse).toBe(true);
    expect(result.renderMeasure?.frameCoverage?.coverageShare).toBeLessThan(0.06);
    expect(result.repairAdvice?.issue).toContain('Sparse frame coverage');
    // The warning is advice, not judge words: it must not leak into the archived judge reasoning.
    expect(result.reasoning).not.toContain('Sparse frame coverage');
  });
});
