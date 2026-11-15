import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Draft best-of-N selection. The Studio's fast-preview path generates
 * `candidateCount` artifacts in parallel and keeps the strongest by static
 * quickScore, so a broken or truncated roll never reaches the canvas. These
 * tests assert the behaviour through the public bridge input, mocking only the
 * retired test-only generator boundary and the preview emitter.
 */

const { draftGenerate } = vi.hoisted(() => ({
  draftGenerate: vi.fn(),
}));

const { mockEmitPreviewArtifacts } = vi.hoisted(() => ({
  mockEmitPreviewArtifacts: vi.fn(async (ctx: any, sessionId: string, _code: string, domain: string) => {
    ctx.emit(sessionId, { type: 'artifact.found', sessionId, artifactLabel: `${domain} HTML preview`, artifactPath: `.omx/proof/live-previews/${sessionId}.html` });
    ctx.emit(sessionId, { type: 'preview.completed', sessionId, previewType: 'html', content: '<html></html>', artifactPath: `.omx/proof/live-previews/${sessionId}.html` });
  }),
}));

vi.mock('../../src/tui-bridge/PreviewService.js', () => ({
  emitPreviewArtifacts: mockEmitPreviewArtifacts,
}));

const {
  TuiBridgeService,
  installRetiredDraftTestAdapter,
  resolveDraftCandidateTimeoutMinutes,
} = await import('../../src/tui-bridge/TuiBridgeService.js');
const { quickScore } = await import('../../src/collab/Scoring.js');
installRetiredDraftTestAdapter({ create: () => ({ generate: draftGenerate }),
  score: (code, domain) => quickScore(code, domain as never) });

function fakeLlm() {
  return {
    getConfig: () => ({ baseUrl: 'https://api.openai.com/v1', model: 'test-model' }),
    generate: vi.fn().mockResolvedValue({ code: '', explanation: '', success: true }),
  };
}

// A short, near-empty p5 roll — the kind of dud a single coin-flip sometimes
// returns. Low quickScore (penalised for length, no logic/structure).
const WEAK_P5 = 'function setup(){createCanvas(100,100);}';

// A rich, multi-line p5 sketch: length bonus + code keywords + logic keyword +
// line-count bonus push quickScore to the top of the band.
const STRONG_P5 = [
  'function setup() {',
  '  createCanvas(640, 640);',
  '  noStroke();',
  '}',
  'function draw() {',
  '  background(8, 10, 18);',
  '  for (let i = 0; i < 120; i++) {',
  '    const a = (frameCount * 0.01) + i;',
  '    fill(180 + 60 * sin(a), 120, 255, 200);',
  '    circle(width / 2 + cos(a) * i * 2, height / 2 + sin(a) * i * 2, 6);',
  '  }',
  '}',
].join('\n');

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 1500; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for event');
}

function p5Session(service: InstanceType<typeof TuiBridgeService>) {
  return service.createSession({
    provider: 'openai',
    model: 'test-model',
    roles: {
      generator: {
        role: 'generator',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'qwen3.6-35b-a3b',
        source: 'active-provider',
        multimodal: 'unknown',
        purpose: 'Writes the creative code candidates.',
      },
    } as never,
  });
}

describe('draft best-of-N selection', () => {
  beforeEach(() => {
    draftGenerate.mockReset();
    mockEmitPreviewArtifacts.mockClear();
  });

  it('generates candidateCount candidates and commits the highest-scoring one', async () => {
    // Three parallel rolls: two weak, one strong. The strong one must win even
    // though it is returned last.
    draftGenerate
      .mockResolvedValueOnce({ needsClarification: false, code: WEAK_P5, model: 'gen' })
      .mockResolvedValueOnce({ needsClarification: false, code: WEAK_P5, model: 'gen' })
      .mockResolvedValueOnce({ needsClarification: false, code: STRONG_P5, model: 'gen', thinking: 'Chose a dense particle field with slow outward drift for depth.' });

    const service = new TuiBridgeService();
    const session = p5Session(service);

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'p5 sketch of a spiral of luminous particles drifting outward',
        clientIntent: 'creative',
        executionMode: 'draft',
        maxIterations: 1,
        candidateCount: 3,
        timeoutMinutes: 1,
      },
      fakeLlm() as never,
    );

    await waitFor(() => service.getEvents(session.sessionId).find(event => event.type === 'response.committed'));

    // Best-of-3 fired three real generations.
    expect(draftGenerate).toHaveBeenCalledTimes(3);

    // Each candidate got a DISTINCT diversity-perturbed prompt (not the same
    // prompt three times) — so best-of-N selects among genuinely different rolls.
    const prompts = draftGenerate.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(new Set(prompts).size).toBe(3);
    for (const prompt of prompts) {
      expect(prompt).toContain('Variation hint:');
    }

    // The committed artifact is the strong candidate, not a weak roll.
    const committed = service.getEvents(session.sessionId).find(event => event.type === 'response.committed') as { content?: string } | undefined;
    expect(committed?.content).toBe(STRONG_P5);

    // F3: the WINNER's reasoning survives best-of-N selection (its thinking is
    // emitted as a generator-thinking trace, not dropped with the losing rolls).
    const trace = service.getEvents(session.sessionId).find(
      event => event.type === 'generation.reasoning_trace' && (event as { phase?: string }).phase === 'generator-thinking',
    ) as { detail?: string; thought?: string } | undefined;
    expect(`${trace?.thought ?? ''} ${trace?.detail ?? ''}`).toContain('slow outward drift');
  }, 30000);

  it('prefers the candidate that honors the request among comparable-quality rolls (F10)', async () => {
    // Two structurally-identical p5 rolls (equal quickScore); only one mentions
    // the requested subject. The adherence tiebreak must pick it.
    const SAME = 'function setup(){createCanvas(400,400);}\nfunction draw(){background(8);for(let i=0;i<50;i++){circle(i*8,200,4);}}';
    const OFF_PROMPT = `// blocks in a grey room\n${SAME}`;
    const ADHERENT = `// pines in a calm forest\n${SAME}`;
    draftGenerate
      .mockResolvedValueOnce({ needsClarification: false, code: OFF_PROMPT, model: 'gen' })
      .mockResolvedValueOnce({ needsClarification: false, code: ADHERENT, model: 'gen' });

    const service = new TuiBridgeService();
    const session = p5Session(service);

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'a calm forest of tall pines',
        clientIntent: 'creative',
        executionMode: 'draft',
        maxIterations: 1,
        candidateCount: 2,
        timeoutMinutes: 1,
      },
      fakeLlm() as never,
    );

    await waitFor(() => service.getEvents(session.sessionId).find(event => event.type === 'response.committed'));
    const committed = service.getEvents(session.sessionId).find(event => event.type === 'response.committed') as { content?: string } | undefined;
    // Without the adherence tiebreak the first (off-prompt) roll would win the tie.
    expect(committed?.content).toBe(ADHERENT);
  }, 30000);

  it('commits a usable candidate without blocking on a stalled straggler', async () => {
    // The regression: best-of-N used Promise.allSettled, so one parallel
    // provider call that stalls held the whole batch for the full per-candidate
    // timeout (up to 30m) — the Studio showed "still working" forever even with
    // a good candidate already in hand. Now: candidate 0 returns fast; candidate
    // 1 hangs until its attempt is aborted. The draft must still commit the fast
    // one (after the straggler grace) and abort the stall instead of waiting it
    // out. A truly-blocking implementation would never reach response.committed.
    let stragglerAborted = false;
    draftGenerate
      .mockResolvedValueOnce({ needsClarification: false, code: STRONG_P5, model: 'gen' })
      .mockImplementationOnce((_p: unknown, _p2: unknown, _stream: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal) signal.addEventListener('abort', () => { stragglerAborted = true; reject(new Error('aborted')); }, { once: true });
        }),
      );

    const service = new TuiBridgeService();
    const session = p5Session(service);

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'p5 sketch of drifting embers over a slow dark current',
        clientIntent: 'creative',
        executionMode: 'draft',
        maxIterations: 1,
        candidateCount: 2,
        timeoutMinutes: 1,
      },
      fakeLlm() as never,
    );

    // Commit must arrive on the straggler grace (~7s), not the per-candidate
    // timeout (60s) — a generous budget below the timeout proves it didn't block.
    const committed = await waitFor(() => service.getEvents(session.sessionId).find(event => event.type === 'response.committed')) as { content?: string };
    expect(committed.content).toBe(STRONG_P5);
    expect(stragglerAborted).toBe(true);
  }, 25000);

  it('fires exactly one generation when candidateCount is 1 (unchanged fast path)', async () => {
    draftGenerate.mockResolvedValue({ needsClarification: false, code: STRONG_P5, model: 'gen' });

    const service = new TuiBridgeService();
    const session = p5Session(service);

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'p5 sketch of a slow tide of overlapping rings at dusk',
        clientIntent: 'creative',
        executionMode: 'draft',
        maxIterations: 1,
        candidateCount: 1,
        timeoutMinutes: 1,
      },
      fakeLlm() as never,
    );

    await waitFor(() => service.getEvents(session.sessionId).find(event => event.type === 'response.committed'));
    expect(draftGenerate).toHaveBeenCalledTimes(1);
  }, 30000);
});

describe('draft candidate timeout', () => {
  it('gives K3 five minutes while retaining the three-minute default cap', () => {
    expect(resolveDraftCandidateTimeoutMinutes(30, 'moonshotai/kimi-k3')).toBe(5);
    expect(resolveDraftCandidateTimeoutMinutes(2, 'moonshotai/kimi-k3')).toBe(2);
    expect(resolveDraftCandidateTimeoutMinutes(30, 'qwen3.6-35b-a3b')).toBe(3);
  });
});
