import { describe, it, expect, vi } from 'vitest';

import sharp from 'sharp';

import {
  DECISION_PANEL, DECISION_QUALITY_LABELS, composeDecisionFrames, scoreRenderedEvidenceWithDecisionModel,
} from '../../../src/core/ScoringEngine.js';
import { DecisionModelClient } from '../../../src/llm/DecisionModelClient.js';
import type { RenderEvidence } from '../../../src/core/types/GenerationEvaluation.js';

const legend = Object.fromEntries(DECISION_QUALITY_LABELS.map((label, i) => [String(i), label]));

function d1(fetchImpl: ReturnType<typeof vi.fn>): DecisionModelClient {
  return new DecisionModelClient({ baseUrl: 'http://127.0.0.1:9931', model: 'LiquidAI/d1-2B',
    fetchImpl: fetchImpl as unknown as typeof fetch });
}

const audible: RenderEvidence = {
  timingMs: 120, errors: [],
  audio: { success: true, peakAmplitude: 0.5, rmsAmplitude: 0.39 },
} as RenderEvidence;

describe('scoreRenderedEvidenceWithDecisionModel', () => {
  it('maps the d1 score onto 0..1 with P(coherent) as confidence', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answers: {
      coherent: { noul: 0.7 }, quality: { score: 4, legend } } })));
    const result = await scoreRenderedEvidenceWithDecisionModel(audible, 'brief', d1(fetchImpl), 'tone');
    expect(result).toMatchObject({ score: 1, confidence: 0.7, failureClass: 'none' });
    expect(result.reasoning).toBe('decision model LiquidAI/d1-2B: P(coherent)=0.700, quality=gallery-grade (4.00/4)');
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.state).toBe('Domain: tone.\nBrief: brief.\nNo frames were captured.\nRender time: 120 ms. Runtime errors: 0.');
    expect(Object.keys(body.questions)).toEqual(['coherent', 'quality']);
  });

  it.each([
    [{ ...audible, infraUnavailable: true }, { score: 0, confidence: 0, failureClass: 'infra' }],
    [{ ...audible, candidateFailure: true }, { score: 0, confidence: 1, failureClass: 'render' }],
  ])('short-circuits judge-independent gates without a decision call (%#)', async (evidence, expected) => {
    const fetchImpl = vi.fn();
    const result = await scoreRenderedEvidenceWithDecisionModel(evidence as RenderEvidence, '', d1(fetchImpl), 'tone');
    expect(result).toMatchObject(expected);
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it('propagates a malformed decision answer instead of scoring neutral', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answers: {
      coherent: { noul: 0.7 }, quality: { score: 9, legend } } })));
    await expect(scoreRenderedEvidenceWithDecisionModel(audible, '', d1(fetchImpl), 'tone'))
      .rejects.toThrow('DECISION_ANSWER_INVALID: quality score does not map to a label');
  });

  it('sends two frames as ONE side-by-side composite so the request fits a 512-token batch', async () => {
    // Stripes (one colour band at mid-height over black) so the frames pass the blank-render gate.
    const frame = async (rgb: [number, number, number]) => {
      const raw = Buffer.alloc(800 * 600 * 3);
      for (let y = 0; y < 600; y++) {
        if (y % 40 >= 20 && y !== 300) continue;
        for (let x = 0; x < 800; x++) raw.set(rgb, (y * 800 + x) * 3);
      }
      return (await (sharp as unknown as (b: Buffer, o: object) => ReturnType<typeof sharp>)(raw,
        { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer({ resolveWithObject: true })).data.toString('base64');
    };
    const evidence = { ...audible,
      screenshot: { mimeType: 'image/png', width: 800, height: 600, dataBase64: await frame([255, 0, 0]) },
      lateScreenshot: { mimeType: 'image/png', width: 800, height: 600, dataBase64: await frame([0, 0, 255]) } } as unknown as RenderEvidence;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answers: {
      coherent: { noul: 0.9 }, quality: { score: 2, legend } } })));
    const result = await scoreRenderedEvidenceWithDecisionModel(evidence, 'b', d1(fetchImpl), 'p5');
    expect(result.score).toBe(0.5);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.images.length).toBe(1);
    expect(body.state).toContain('Attached: one image, early frame (left) and late frame (right).');
    const png = Buffer.from(String(body.images[0]).replace('data:image/png;base64,', ''), 'base64');
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([DECISION_PANEL.width * 2, DECISION_PANEL.height]);
    const px = (x: number) => [...data.subarray((5 * info.width + x) * info.channels, (5 * info.width + x) * info.channels + 3)];
    expect(px(10)).toEqual([255, 0, 0]);
    expect(px(DECISION_PANEL.width + 10)).toEqual([0, 0, 255]);
  });

  it('rejects undecodable frames instead of sending a broken composite', async () => {
    await expect(composeDecisionFrames([
      { mimeType: 'image/png', data: Buffer.from('not a png') },
      { mimeType: 'image/png', data: Buffer.from('nor this') },
    ])).rejects.toThrow(/unsupported image format|Input buffer/);
  });
});
