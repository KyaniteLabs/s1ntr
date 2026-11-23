// UNIT TEST WITH A MOCKED SCORER (Sol L3-18): scoreRenderedEvidence and image I/O are replaced, so this proves the
// staged rule only, not the shipped Create path (which does not run the staged judge by default).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const scoreMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/ScoringEngine.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/ScoringEngine.js')>()),
  scoreRenderedEvidence: scoreMock,
}));

vi.mock('../../src/core/EvaluatorIO.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/EvaluatorIO.js')>()),
  boundedEvaluatorImages: async (images: unknown[]) => images,
}));

import {
  judgeTwoStage, combineVerdict, parseAuditorReply, parseBugsReply, JudgeSeatMissingError,
  JudgeStageReplyError, DEFECT_SCORE_CAP, type JudgeSeat,
} from '../../src/core/TwoStageJudge.js';

const evidence = {
  screenshot: { mimeType: 'image/png', dataBase64: 'AAAA' },
  lateScreenshot: { mimeType: 'image/png', dataBase64: 'BBBB' },
  timingMs: 10,
} as never;

function seat(model: string, reply: (system: string, user: string) => string, calls: string[] = [], optsLog: unknown[] = []): JudgeSeat {
  const respond = async (system: string, user: string, opts?: unknown) => {
    calls.push(user); optsLog.push(opts);
    return { success: true, code: reply(system, user) };
  };
  return {
    reasoning: 'high', strictness: 'standard',
    client: {
      getConfig: () => ({ provider: 'glm', model }),
      generate: (s: string, u: string, _sig?: unknown, _b?: unknown, _i?: unknown, o?: unknown) => respond(s, u, o),
      generateWithImages: (s: string, u: string, _im?: unknown, _sig?: unknown, _b?: unknown, o?: unknown) => respond(s, u, o),
    } as never,
  };
}

const ZOOM_SOURCE = ['uniform float zoom;', 'void main(){', '  vec2 p = uv / zoom;', '}'].join('\n');
const auditReply = JSON.stringify({ findings: [{ severity: 'wrong-per-brief', line: 3,
  note: 'p = uv / zoom zooms out as zoom shrinks; the brief moves inward' }], score: 0.4 });

beforeEach(() => { scoreMock.mockReset(); });

describe('two-stage judge (#1731)', () => {
  it('names the line of a known code defect and keeps the vision stages blind to it', async () => {
    const auditCalls: string[] = []; const visionCalls: string[] = [];
    scoreMock.mockResolvedValue({ score: 0.7, confidence: 0.8, failureClass: 'none', reasoning: 'ok' });
    const result = await judgeTwoStage(
      { evidence, source: ZOOM_SOURCE, brief: 'camera dollies inward', domain: 'glsl' },
      { auditor: seat('glm-5.3', () => auditReply, auditCalls),
        vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}', visionCalls) });
    expect(auditCalls[0]).toContain('3:   vec2 p = uv / zoom;');
    expect(result.receipt.audit.findings[0]).toMatchObject({ severity: 'wrong-per-brief', line: 3 });
    expect(result.evaluation.reasoning).toContain('L3');
    // Neither vision stage was told what the auditor found or scored.
    expect(visionCalls.join('\n')).not.toMatch(/zooms out|0\.4|uv \/ zoom/);
    expect(String(scoreMock.mock.calls[0][2])).not.toMatch(/zooms out|0\.4|uv \/ zoom/);
    expect(String(scoreMock.mock.calls[0][1])).toBe('');
  });

  it('carries the aesthetics stage\'s brief difficulty onto the evaluation, and omits it when absent', async () => {
    const seats = { auditor: seat('glm-5.3', () => auditReply), vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') };
    const run = () => judgeTwoStage({ evidence, source: ZOOM_SOURCE, brief: 'camera dollies inward', domain: 'glsl' }, seats);
    scoreMock.mockResolvedValue({ score: 0.7, confidence: 0.8, failureClass: 'none', reasoning: 'ok', difficulty: 8 });
    expect((await run()).evaluation.difficulty).toBe(8);
    scoreMock.mockResolvedValue({ score: 0.7, confidence: 0.8, failureClass: 'none', reasoning: 'ok' });
    expect('difficulty' in (await run()).evaluation).toBe(false);
  });

  it('fails a blank canvas at B1 and never runs B2', async () => {
    const result = await judgeTwoStage(
      { evidence, source: 'x', brief: 'swirl', domain: 'p5' },
      { auditor: seat('glm-5.3', () => '{"findings":[],"score":0.9}'),
        vision: seat('glm-5.3-flash', () => '{"pass":false,"bugs":["frame is entirely black"]}') });
    expect(scoreMock).not.toHaveBeenCalled();
    expect(result.receipt.aesthetics).toBeNull();
    expect(result.receipt.stages.find(s => s.stage === 'aesthetics')?.ran).toBe(false);
    expect(result.evaluation.score).toBeLessThanOrEqual(DEFECT_SCORE_CAP);
    expect(result.evaluation.failureClass).toBe('render');
  });

  it('records both seats with model id and reasoning level in the receipt', async () => {
    scoreMock.mockResolvedValue({ score: 0.7, confidence: 0.8, failureClass: 'none', reasoning: 'ok' });
    const auditor = { ...seat('glm-5.3', () => '{"findings":[],"score":1}'), reasoning: 'xhigh' as const, strictness: 'harsh' as const };
    const { receipt } = await judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' },
      { auditor, vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') });
    expect(receipt.stages.map(s => [s.stage, s.model, s.reasoning, s.strictness])).toEqual([
      ['audit', 'glm/glm-5.3', 'xhigh', 'harsh'],
      ['visual-bugs', 'glm/glm-5.3-flash', 'high', 'standard'],
      ['aesthetics', 'glm/glm-5.3-flash', 'high', 'standard'],
    ]);
    // L3-10: the blend is bounded by aesthetics. 0.6*0.7+0.4*1 = 0.82 used to stand; the audit may now only lower a
    // piece, never lift it above what the vision seat saw, so the final is the aesthetics score 0.7.
    expect(receipt.finalScore).toBeCloseTo(0.7, 6);
    expect(receipt.capped).toBe(false); // `capped` still means a defect cap; the aesthetics bound is in the rule text
  });

  it('fails closed without an auditor seat', async () => {
    await expect(judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' },
      { auditor: undefined, vision: seat('glm-5.3-flash', () => '{}') })).rejects.toBeInstanceOf(JudgeSeatMissingError);
  });

  it('never turns an unparseable stage reply or a failed scorer into a score', async () => {
    await expect(judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' },
      { auditor: seat('a', () => 'sorry, no json'), vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') }))
      .rejects.toBeInstanceOf(JudgeStageReplyError);
    scoreMock.mockResolvedValue({ score: 0.5, confidence: 0, failureClass: 'scorer' });
    await expect(judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' },
      { auditor: seat('a', () => '{"findings":[],"score":1}'), vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') }))
      .rejects.toThrow(/aesthetics/);
  });
});

describe('two-stage judge review fixes (GLM on #1793)', () => {
  it('refuses a vision seat that cannot see the frames', async () => {
    await expect(judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' },
      { auditor: seat('glm-5.3', () => '{"findings":[],"score":1}'), vision: seat('glm-5.3', () => '{"pass":true,"bugs":[]}') }))
      .rejects.toThrow(/JUDGE_SEAT_MISSING: .*vision-capable/);
  });

  it('turns a render-gate rejection inside B2 into a capped verdict with its repair advice', async () => {
    const repairAdvice = { issue: 'canvas stayed blank after 2 s', fix: 'draw on the first frame', constraint: 'keep the brief' };
    scoreMock.mockResolvedValue({ score: 0, confidence: 1, failureClass: 'render', reasoning: 'blank late frame', repairAdvice });
    const result = await judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' },
      { auditor: seat('glm-5.3', () => '{"findings":[],"score":0.9}'), vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') });
    expect(result.evaluation.failureClass).toBe('render');
    expect(result.evaluation.score).toBeLessThanOrEqual(DEFECT_SCORE_CAP);
    expect(result.evaluation.repairAdvice).toEqual(repairAdvice);
    expect(result.receipt.visualBugs.bugs).toContain('render gate: blank late frame');
    expect(result.receipt.stages.find(s => s.stage === 'aesthetics')?.ran).toBe(true);
  });

  it('parses stage replies whose notes quote unescaped backslashes', () => {
    const raw = String.raw`{"findings":[{"severity":"perf","note":"ascii row /\_/\ repeats"}],"score":0.6}`;
    expect(parseAuditorReply(raw).findings[0].note).toBe(String.raw`ascii row /\_/\ repeats`);
    expect(parseBugsReply(String.raw`{"pass":false,"bugs":["glyph \_ clipped"]}`).bugs).toEqual([String.raw`glyph \_ clipped`]);
  });
});

describe('two-stage B2 source (Sol L3-10)', () => {
  it('gives B2 the source for music and ASCII, where it is the artwork, and withholds it for visual domains', async () => {
    scoreMock.mockResolvedValue({ score: 0.7, confidence: 0.8, failureClass: 'none', reasoning: 'ok' });
    const seats = { auditor: seat('glm-5.3', () => auditReply), vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') };
    await judgeTwoStage({ evidence, source: 'Tone.start()', brief: 'b', domain: 'tone' }, seats);
    expect(scoreMock.mock.calls[0][1]).toBe('Tone.start()');
    await judgeTwoStage({ evidence, source: ZOOM_SOURCE, brief: 'b', domain: 'glsl' }, seats);
    expect(scoreMock.mock.calls[1][1]).toBe('');
  });
});

describe('combine rule and parsers', () => {
  const clean = { pass: true, bugs: [], raw: '' };
  it('a crash finding caps even a beautiful piece', () => {
    const audit = { findings: [{ severity: 'crash' as const, note: 'throws' }], score: 0.2, raw: '' };
    expect(combineVerdict({ audit, bugs: clean, aesthetics: 0.95 })).toMatchObject({ capped: true, score: DEFECT_SCORE_CAP });
  });
  it('non-crash findings do not cap', () => {
    const audit = { findings: [{ severity: 'perf' as const, note: 'slow' }], score: 0.8, raw: '' };
    expect(combineVerdict({ audit, bugs: clean, aesthetics: 0.5 }).capped).toBe(false);
  });
  it('a pass that lists bugs is a fail', () => {
    expect(parseBugsReply('{"pass":true,"bugs":["banding"]}').pass).toBe(false);
  });
  it('rejects an unknown severity', () => {
    expect(() => parseAuditorReply('{"findings":[{"severity":"meh","note":"x"}],"score":1}')).toThrow(JudgeStageReplyError);
  });
});

describe('two-stage judge: reasoning dial, one budget, bounded blend, class (Sol L3-10)', () => {
  const ok = { score: 0.7, confidence: 0.8, failureClass: 'none', reasoning: 'ok' };

  it('configures every request from the seat reasoning dial (audit, B1 and the B2 scorer client)', async () => {
    const auditOpts: unknown[] = []; const visionOpts: unknown[] = [];
    scoreMock.mockImplementation(async (_e: unknown, _c: unknown, _b: unknown, client: { generate: (...a: unknown[]) => Promise<unknown> }) => {
      await client.generate('s', 'u', undefined, true, undefined, { jsonMode: true });
      return ok;
    });
    const auditor = { ...seat('glm-5.3', () => '{"findings":[],"score":1}', [], auditOpts), reasoning: 'xhigh' as const };
    const vision = { ...seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}', [], visionOpts), reasoning: 'medium' as const };
    await judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' }, { auditor, vision });
    expect(auditOpts[0]).toMatchObject({ jsonMode: true, thinking: { effort: 'xhigh', budgetTokens: 32_000 } });
    expect(visionOpts.length).toBe(2); // B1, then the B2 scorer call
    for (const o of visionOpts) expect(o).toMatchObject({ thinking: { effort: 'medium', budgetTokens: 8_000 } });
  });

  it('shares one deadline: B2 gets only what the earlier stages left, and a spent budget stops before B2', async () => {
    scoreMock.mockResolvedValue(ok);
    await judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5', timeoutMs: 60_000 },
      { auditor: seat('glm-5.3', () => '{"findings":[],"score":1}'), vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') });
    const b2Timeout = (scoreMock.mock.calls[0][5].deadlineAt as number) - Date.now();
    expect(b2Timeout).toBeGreaterThan(0); expect(b2Timeout).toBeLessThanOrEqual(60_000);
    scoreMock.mockClear();
    const slow = seat('glm-5.3', () => '{"findings":[],"score":1}');
    const inner = slow.client.generate.bind(slow.client);
    (slow.client as { generate: unknown }).generate = async (...a: unknown[]) => { await new Promise(r => setTimeout(r, 40)); return (inner as (...x: unknown[]) => unknown)(...a); };
    await expect(judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5', timeoutMs: 10 },
      { auditor: slow, vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') })).rejects.toThrow(/action budget/);
    expect(scoreMock).not.toHaveBeenCalled();
  });

  it('an auditor cannot lift a B2-capped piece over the admission floor', () => {
    const v = combineVerdict({ audit: { findings: [], score: 1, raw: '' }, bugs: { pass: true, bugs: [], raw: '' }, aesthetics: 0.29 });
    expect(v.score).toBeCloseTo(0.29, 6); expect(v.score).toBeLessThan(0.4);
  });

  it('a crash finding with B1 passing is a render-class defect, not none', async () => {
    scoreMock.mockResolvedValue(ok);
    const crash = JSON.stringify({ findings: [{ severity: 'crash', line: 1, note: 'throws on load' }], score: 0.9 });
    const { evaluation } = await judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'p5' },
      { auditor: seat('glm-5.3', () => crash), vision: seat('glm-5.3-flash', () => '{"pass":true,"bugs":[]}') });
    expect(evaluation.score).toBeLessThanOrEqual(DEFECT_SCORE_CAP);
    expect(evaluation.failureClass).toBe('render');
  });
});

describe('two-stage judge: glitch is beauty (owner rule, #1731)', () => {
  const fixture = (name: string) => {
    const buf = readFileSync(new URL(`../fixtures/glitch-alive/${name}.png`, import.meta.url));
    return { mimeType: 'image/png', dataBase64: buf.toString('base64'), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };
  const datamosh = { screenshot: fixture('organic-xhigh-r2-r3-early'), lateScreenshot: fixture('organic-xhigh-r2-r3-late'), timingMs: 10 } as never;
  const lowAudit = '{"findings":[],"score":0.2}';
  const looksBroken = '{"pass":false,"bugs":["frame looks like corrupted static and datamosh artifacts"]}';

  it('a rendered, moving, saturated datamosh frame is not capped or floored by B1 or a weak audit', async () => {
    // The scorer mimics the real engine, which lifts a measured-alive frame to the 0.4 line.
    scoreMock.mockResolvedValue({ score: 0.4, confidence: 0.8, failureClass: 'none', reasoning: 'alive glitch' });
    const { evaluation, receipt } = await judgeTwoStage({ evidence: datamosh, source: 'x', brief: 'datamosh feedback', domain: 'hydra' },
      { auditor: seat('glm-5.3', () => lowAudit), vision: seat('glm-5.3-flash', () => looksBroken) });
    expect(scoreMock).toHaveBeenCalledTimes(1);                    // B2 ran although B1 said "corrupted"
    expect(receipt.capped).toBe(false);
    expect(evaluation.score).toBeGreaterThan(DEFECT_SCORE_CAP);
    expect(evaluation.score).toBeGreaterThanOrEqual(0.4);
    expect(evaluation.failureClass).toBe('none');
    expect(evaluation.reasoning).toContain('corrupted static'); // B1 stays visible as advice
  });

  it('control: the same B1 verdict on a frame that is NOT alive still caps', async () => {
    const { evaluation, receipt } = await judgeTwoStage({ evidence, source: 'x', brief: 'b', domain: 'hydra' },
      { auditor: seat('glm-5.3', () => lowAudit), vision: seat('glm-5.3-flash', () => looksBroken) });
    expect(receipt.capped).toBe(true);
    expect(evaluation.score).toBeLessThanOrEqual(DEFECT_SCORE_CAP);
  });

  it('a real code crash still caps an alive glitch (the carve-out is for look, not for exceptions)', async () => {
    scoreMock.mockResolvedValue({ score: 0.4, confidence: 0.8, failureClass: 'none', reasoning: 'alive' });
    const crash = JSON.stringify({ findings: [{ severity: 'crash', note: 'uncaught TypeError at load' }], score: 0.2 });
    const { evaluation } = await judgeTwoStage({ evidence: datamosh, source: 'x', brief: 'b', domain: 'hydra' },
      { auditor: seat('glm-5.3', () => crash), vision: seat('glm-5.3-flash', () => looksBroken) });
    expect(evaluation.score).toBeLessThanOrEqual(DEFECT_SCORE_CAP);
  });
});
