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

describe('CompositionOrchestrator standalone composite', () => {
  it('inlines vendored libraries so layer iframes need no /vendor/ URL', async () => {
    const prev = process.env.SINTER_COMPOSITE_GATE;
    process.env.SINTER_COMPOSITE_GATE = '0';
    try {
      const result = await CompositionOrchestrator.compose({
        layers: [{ domain: 'p5', prompt: 'ignored',
          code: 'function setup(){createCanvas(200,200);}function draw(){circle(100,100,50);}' }],
      });
      expect(result.successCount).toBe(1);
      const b64 = [...result.html.matchAll(/src="data:text\/html;base64,([^"]+)"/g)].map((m) => m[1]);
      expect(b64.length).toBeGreaterThan(0);
      const frame = Buffer.from(b64[0], 'base64').toString('utf8');
      expect(frame).not.toMatch(/<script[^>]+src="\/vendor\//);
      expect(frame).toContain('p5.js');
      expect(frame.length).toBeGreaterThan(500_000);
      // the state bridge must be a real script outside the library body (after it, in head)
      const bridgeAt = frame.lastIndexOf('sinter:state');
      expect(bridgeAt).toBeGreaterThan(frame.indexOf('p5.js'));
      expect(bridgeAt).toBeLessThan(frame.lastIndexOf('<body'));
    } finally {
      if (prev === undefined) delete process.env.SINTER_COMPOSITE_GATE;
      else process.env.SINTER_COMPOSITE_GATE = prev;
    }
  });
});

describe('CompositionOrchestrator creative thesis identity', () => {
  it('stamps the layer document, not a "<body>" string inside the inlined p5 library', async () => {
    const { compileCreativeThesis } = await import('../../../src/creative-intelligence/CreativeIntelligence.js');
    const { readFileSync } = await import('node:fs');
    const prev = process.env.SINTER_COMPOSITE_GATE;
    process.env.SINTER_COMPOSITE_GATE = '0';
    try {
      const result = await CompositionOrchestrator.compose({
        creativeThesis: compileCreativeThesis('A restrained field opens into luminous release.'),
        layers: [{ domain: 'p5', prompt: 'ignored', code: 'function setup(){createCanvas(200,200);}function draw(){circle(100,100,50);}' }],
      });
      const b64 = /src="data:text\/html;base64,([^"]+)"/.exec(result.html)![1];
      const frame = Buffer.from(b64, 'base64').toString('utf8');
      const lib = readFileSync('vendor/p5/1.9.0/p5.min.js', 'utf8').replace(/<\/script/g, '<\\/script');
      expect(frame).toContain(lib); // the library is byte-intact
      expect(frame).toContain('data-creative-thesis-id=');
      expect(frame.indexOf('data-creative-thesis-id=')).toBeGreaterThan(frame.indexOf(lib) + lib.length);
    } finally {
      if (prev === undefined) delete process.env.SINTER_COMPOSITE_GATE;
      else process.env.SINTER_COMPOSITE_GATE = prev;
    }
  });
});

describe('CompositionOrchestrator browser-domain layers', () => {
  it('accepts svg, kinetic, nbe, custom and glsl layers from the planner', () => {
    const spec = CompositionOrchestrator.parseSpec(JSON.stringify({
      title: 'Six Mediums',
      layers: ['svg', 'kinetic', 'nbe', 'custom', 'glsl', 'p5'].map((domain) => ({ domain, prompt: `${domain} layer` })),
    }), 'six mediums');
    expect(spec.layers.map((l) => l.domain)).toEqual(['svg', 'kinetic', 'nbe', 'custom', 'glsl', 'p5']);
  });

  it('composes supplied svg, kinetic and glsl code into one stack', async () => {
    const prev = process.env.SINTER_COMPOSITE_GATE;
    process.env.SINTER_COMPOSITE_GATE = '0';
    try {
      const result = await CompositionOrchestrator.compose({ layers: [
        { domain: 'glsl', prompt: 'x', code: 'precision mediump float;uniform float u_time;uniform vec2 u_resolution;void main(){gl_FragColor=vec4(.1,.2,.4+.2*sin(u_time),1.);}' },
        { domain: 'svg', prompt: 'x', blendMode: 'screen', code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="#fff"/></svg>' },
        { domain: 'kinetic', prompt: 'x', blendMode: 'screen', code: '<div id="k" style="color:#fff;font:48px monospace">HELLO</div>' },
      ] });
      expect(result.successCount).toBe(3);
      expect(result.layers.map((l) => l.domain)).toEqual(['glsl', 'svg', 'kinetic']);
      expect(result.layers.every((l) => l.generated)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SINTER_COMPOSITE_GATE;
      else process.env.SINTER_COMPOSITE_GATE = prev;
    }
  });
});
