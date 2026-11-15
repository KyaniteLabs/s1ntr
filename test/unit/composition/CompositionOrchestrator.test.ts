import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const RESPONSE = JSON.stringify({
  title: 'Bright Stack',
  background: '#000',
  layers: [
    { domain: 'shader', prompt: 'bg', blendMode: 'screen', opacity: 1 },
    { domain: 'p5', prompt: 'fg', blendMode: 'screen', opacity: 1 },
  ],
});

vi.mock('../../../src/llm/LLMClient.js', () => ({
  LLMClient: class MockLLMClient {
    generate = vi.fn().mockResolvedValue({ code: RESPONSE });
  },
}));

import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';
import { Logger } from '../../../src/utils/Logger.js';

describe('CompositionOrchestrator code passthrough — keep the base as-is', () => {
  it('uses a layer\'s pre-existing code without regenerating it', async () => {
    const prev = process.env.SINTER_COMPOSITE_GATE;
    process.env.SINTER_COMPOSITE_GATE = '0'; // skip the puppeteer render gate
    try {
      const baseCode = 'function setup(){ createCanvas(400,400); /* MY_BASE_MARKER */ }';
      const overlayCode = 'function draw(){ /* OVERLAY_MARKER */ }';
      const result = await CompositionOrchestrator.compose({
        layers: [
          { domain: 'p5', prompt: 'this prompt must be ignored', code: baseCode },
          { domain: 'p5', prompt: 'also ignored', code: overlayCode, blendMode: 'screen' },
        ],
      });
      // Both layers are kept (generated:true) from their EXACT code — proven by
      // codeLength matching the input verbatim (a regeneration would differ).
      expect(result.successCount).toBe(2);
      expect(result.layers[0].generated).toBe(true);
      expect(result.layers[0].codeLength).toBe(baseCode.length);
      expect(result.layers[1].codeLength).toBe(overlayCode.length);
    } finally {
      if (prev === undefined) delete process.env.SINTER_COMPOSITE_GATE;
      else process.env.SINTER_COMPOSITE_GATE = prev;
    }
  });
});

describe('CompositionOrchestrator washout log (P2)', () => {
  it('logs opacity cap, not stale blendMode demotion, when bright layers exceed budget', async () => {
    await CompositionOrchestrator.decomposePrompt('bright layers');
    const infoCalls = (Logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c.join(' '));
    const washoutLog = infoCalls.find((m: string) => m.includes('Washout guard'));
    expect(typeof washoutLog).toBe('string');
    expect(washoutLog).toContain('capped opacity');
    expect(washoutLog).not.toContain('to normal');
    expect(washoutLog).toMatch(/capped opacity on \d+ over-budget bright layer\(s\)/);
  });
});
