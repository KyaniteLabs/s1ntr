import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parseAxes } from '../../../src/atelier/SpuScorer.js';
import { resolveSecondEye } from '../../../scripts/atelier/second-eye.mjs';

// Legacy judge-response fix (2026-09-08): a GLM judge reply that failed parse
// was discarded — rc4 stopped the batch and the raw body (the only evidence
// that could confirm or kill the thinking-starvation hypothesis) was lost.
// sss-score must persist private judge-response evidence (body/status/model)
// on EVERY discard path — including the acceptJudge parse reject, where a
// valid HTTP 200 + JSON envelope can still carry nothing scoreable
// (thinking-only content blocks, token-stop mid-JSON, refusal prose) — and
// must NEVER persist auth headers, API keys or the request image.
//
// Two layers, per the independent-review blocker:
// 1. Static contract (structure of bin/sinter, same approach as
//    third-judge-lanes.test.ts: bin/sinter is a single-file dispatch surface).
// 2. FUNCTIONAL execution: the judge helpers (persistJudgeEvidence,
//    readJudgeJson, anthropicText, acceptJudge) and the lane call sites are
//    extracted VERBATIM from bin/sinter and executed in a node:vm sandbox
//    with the REAL parseAxes, a mocked HTTP 200 response and a temp cwd.
//    Grep alone cannot prove the evidence file is written with the original
//    envelope — this does. Test-only vm isolation; no production eval.
describe('sss-score judge evidence persistence', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
  const start = source.indexOf("cmd === 'sss-score'");
  const end = source.indexOf("cmd === 'gui-evolve'");
  it('found the sss-score block (sanity — extraction anchors exist, in order)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });
  const block = source.slice(start, end);

  // ─── Static contract ────────────────────────────────────────────────────

  it('persists raw judge replies best-effort under .omx/atelier/judge-evidence', () => {
    expect(block).toMatch(/const persistJudgeEvidence = \(vendor, model, status, failureClass, body\) =>/);
    expect(block).toContain("'atelier', 'judge-evidence'");
    expect(block).toMatch(/} catch \{ \}\s*\n\s*};/); // best-effort: evidence never blocks scoring
  });

  it('evidence payload carries vendor/model/status/class/body/timestamp only — never secrets or request images', () => {
    const payload = block.match(/const evidence = \{[\s\S]*?\};/);
    expect(payload?.length, 'evidence object literal not found').toBe(1);
    for (const key of ['vendor', 'model', 'httpStatus', 'failureClass', 'body', 'capturedAt']) {
      expect(payload![0]).toContain(key);
    }
    for (const secret of ['apiKey', 'Authorization', 'headers', 'imgB64', 'image_url', 'base64']) {
      expect(payload![0]).not.toContain(secret);
    }
  });

  it('readJudgeJson keeps 4 transport-malformed discard paths, each persisting evidence', () => {
    const calls = block.match(/persistJudgeEvidence\(vendor, model, res\.status, [^\n]*\)/g);
    expect(calls?.length).toBe(4);
    expect(block).toMatch(/persistJudgeEvidence\(vendor, model, res\.status, .http_/); // non-2xx keeps the error body
    expect(block).toContain("persistJudgeEvidence(vendor, model, res.status, 'empty', raw)");
    expect(block.match(/persistJudgeEvidence\(vendor, model, res\.status, 'parse', raw\)/g)?.length).toBe(2); // non-object payload + JSON.parse throw
  });

  it('acceptJudge persists the ORIGINAL envelope on its parse reject (the fifth discard path)', () => {
    expect(block).toContain('const acceptJudge = (vendor, text, context) =>');
    expect(block).toContain("persistJudgeEvidence(vendor, context?.model, context?.status, 'parse', context?.raw)");
    expect(block).toContain('return { payload, raw };'); // readJudgeJson threads the raw envelope out for that persist
  });

  it('all judge lanes thread model/status/raw and keep their token budgets', () => {
    // M-20261008-14 (judgeEyePlan): planned eyes iterate in ONE for-loop with a
    // single try/catch, so the evaluator lane calls with eye.vendor rather than
    // evaluatorVendor, and a 4th lane exists (glm-5.3 flagship text eye).
    expect(block).toContain('readJudgeJson(eye.vendor, res, ev.model)');
    expect(block).toContain("readJudgeJson(eye.vendor, res, 'glm-5.3')");
    // 2026-11-12: the second eye is config-driven (sssScore.secondEye), so its
    // model and token budget come from the resolved eye — pinned in
    // test/unit/cli/second-eye.test.ts.
    expect(block).toContain('readJudgeJson(secondEyeVendor, res, secondEye.model)');
    expect(block).toContain("readJudgeJson(glmVendor, res, 'glm-5.3-flash')");
    expect(block.match(/if \(d\?\.payload\) acceptJudge/g)).toHaveLength(4);
    expect(block.match(/raw: d\.raw/g)).toHaveLength(4);
    expect(block.match(/status: res\.status/g)).toHaveLength(4);
    expect(block.match(/max_tokens: 1500/g)).toHaveLength(2); // evaluator vision lane + glm-flash lane; the 2nd eye's budget lives in second-eye.mjs
  });

  // ─── Functional execution (node:vm, mocked HTTP 200, temp cwd) ─────────

  // Slice bin/sinter from `const persistJudgeEvidence =` through the end of
  // acceptJudge's braced body: the helpers under test, verbatim.
  const extractHelpers = (): string => {
    const segStart = block.indexOf('const persistJudgeEvidence =');
    const acceptStart = block.indexOf('const acceptJudge =');
    if (segStart < 0 || acceptStart < 0 || acceptStart <= segStart) {
      throw new Error('judge evidence helpers not found in sss-score block');
    }
    let i = block.indexOf('{', block.indexOf('=>', acceptStart));
    let depth = 0;
    for (; i < block.length; i++) {
      if (block[i] === '{') depth += 1;
      else if (block[i] === '}') {
        depth -= 1;
        if (depth === 0) return block.slice(segStart, i + 1);
      }
    }
    throw new Error('acceptJudge body has no terminator');
  };

  // Extract a lane's ACTUAL call-site lines (readJudgeJson → acceptJudge) so
  // the functional run exercises production wiring, not a test re-creation.
  const extractLane = (readCall: string): string => {
    const s = block.indexOf(readCall);
    if (s < 0) throw new Error(`lane call not found: ${readCall}`);
    // judgeEyePlan (M-20261008-14) runs every planned eye inside ONE for-loop
    // with a single try/catch, so a lane ends at the next lane boundary
    // (`} else if` / the loop's closing brace) rather than its own `} catch`.
    const e = block.indexOf('\n      }', s);
    if (e < 0) throw new Error(`lane terminator not found after: ${readCall}`);
    return block.slice(s, e);
  };

  const mockRes = (status: number, raw: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
  });

  const runLane = async (laneSource: string, bindings: Record<string, unknown>) => {
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-judge-evidence-'));
    const failures: string[] = [];
    const sandbox: Record<string, unknown> = {
      fs,
      path,
      randomUUID,
      Buffer,
      process: { cwd: () => evidenceRoot, pid: 424242 },
      recordJudgeFailure: (vendor: string, failureClass: string) => failures.push(`${vendor}:${failureClass}`),
      parseAxes,
      ...bindings,
    };
    const script = `
const judges = [];
${extractHelpers()}
(async () => {
${laneSource}
return judges.map(j => ({ vendor: j.vendor, axes: j.axes, defects: j.defects }));
})()
`;
    const judges = await vm.runInContext(script, vm.createContext(sandbox));
    return { evidenceRoot, failures, judges: judges as Array<{ vendor: string; axes: { D: number; A: number; R: number; N: number } }> };
  };

  it('FUNCTIONAL: repeated failures cannot overwrite evidence and retained files are private and byte-bounded', async () => {
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-judge-evidence-'));
    const sandbox = {
      fs,
      path,
      randomUUID,
      Buffer,
      process: { cwd: () => evidenceRoot, pid: 424242 },
      recordJudgeFailure: () => undefined,
      parseAxes,
    };
    const oversized = 'é'.repeat(40_000); // 80,000 UTF-8 bytes
    const script = `${extractHelpers()}
persistJudgeEvidence('glm-5.3-flash', 'glm-5.3-flash', 500, 'http_500', oversized);
persistJudgeEvidence('glm-5.3-flash', 'glm-5.3-flash', 500, 'http_500', oversized);`;
    try {
      vm.runInContext(script, vm.createContext({ ...sandbox, oversized }));
      const files = readEvidenceFiles(evidenceRoot);
      expect(files).toHaveLength(2);
      expect(new Set(files.map(file => file.name)).size).toBe(2);
      for (const file of files) {
        expect(Buffer.byteLength(String(file.parsed.body), 'utf8')).toBeLessThanOrEqual(65_536);
        expect(fs.statSync(path.join(evidenceRoot, '.omx', 'atelier', 'judge-evidence', file.name)).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });

  const readEvidenceFiles = (root: string): Array<{ name: string; text: string; parsed: Record<string, unknown> }> => {
    const dir = path.join(root, '.omx', 'atelier', 'judge-evidence');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().map(name => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, text, parsed: JSON.parse(text) as Record<string, unknown> };
    });
  };

  it('FUNCTIONAL: thinking-only HTTP 200 envelope (glm lane) retains the full original reply as parse evidence', async () => {
    // The motivating case: valid HTTP 200, valid JSON, zero text blocks.
    // anthropicText extracts ''; parseAxes('') → null; acceptJudge rejects.
    // The empty extracted text cannot diagnose thinking-starvation/token-stop —
    // the ORIGINAL envelope (thinking block, stop_reason, usage) must survive.
    const envelope = {
      id: 'msg_glm_thinkonly_01',
      type: 'message',
      role: 'assistant',
      model: 'glm-5.3-flash',
      content: [
        { type: 'thinking', thinking: 'Composition reads as three dark bands; craft near 6 but I still need to' },
      ],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 1150, output_tokens: 1500 },
    };
    const lane = extractLane("const d = await readJudgeJson(glmVendor, res, 'glm-5.3-flash');");
    const run = await runLane(lane, { res: mockRes(200, JSON.stringify(envelope)), glmVendor: 'glm-5.3-flash' });
    try {
      expect(run.failures).toEqual(['glm-5.3-flash:parse']);
      expect(run.judges).toEqual([]);
      const files = readEvidenceFiles(run.evidenceRoot);
      expect(files).toHaveLength(1);
      const ev = files[0].parsed;
      expect(ev.vendor).toBe('glm-5.3-flash');
      expect(ev.model).toBe('glm-5.3-flash'); // model reaches the reject path
      expect(ev.httpStatus).toBe(200); // status reaches the reject path
      expect(ev.failureClass).toBe('parse');
      expect(ev.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(JSON.parse(String(ev.body))).toEqual(envelope); // FULL envelope, not the empty extracted text
      // Privacy: response-only evidence — no auth headers, no request image.
      expect(Object.keys(ev).sort()).toEqual(['body', 'capturedAt', 'failureClass', 'httpStatus', 'model', 'vendor']);
      for (const secret of ['Authorization', 'apiKey', 'imgB64', 'data:image/png', 'base64']) {
        expect(files[0].text).not.toContain(secret);
      }
    } finally {
      fs.rmSync(run.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('FUNCTIONAL: valid-JSON judge text with invalid axes (kilo lane) retains the reply as parse evidence', async () => {
    // Kilo/OpenAI wire: choices[0].message.content IS a string, so the lane
    // extracts it — but the axes are strings, not finite numbers, so
    // parseAxes rejects. The full chat.completion envelope must be kept.
    const replyText = '{"D":"9","A":"8","R":"7","N":"6","level":"A","defects":[]}';
    const envelope = {
      id: 'cmpl_kimi_axes_01',
      object: 'chat.completion',
      model: 'kimi-k3',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: replyText } }],
      usage: { prompt_tokens: 900, completion_tokens: 110, total_tokens: 1010 },
    };
    const lane = extractLane('const d = await readJudgeJson(eye.vendor, res, ev.model);');
    const run = await runLane(lane, {
      res: mockRes(200, JSON.stringify(envelope)),
      evaluatorVendor: 'kimi-k3',
      eye: { vendor: 'kimi-k3' },
      ev: { model: 'kimi-k3' },
    });
    try {
      expect(run.failures).toEqual(['kimi-k3:parse']);
      expect(run.judges).toEqual([]);
      const files = readEvidenceFiles(run.evidenceRoot);
      expect(files).toHaveLength(1);
      const ev = files[0].parsed;
      expect(ev.model).toBe('kimi-k3');
      expect(ev.httpStatus).toBe(200);
      expect(ev.failureClass).toBe('parse');
      expect(JSON.parse(String(ev.body))).toEqual(envelope); // envelope retained, not just the unscoreable text
      expect(Object.keys(ev).sort()).toEqual(['body', 'capturedAt', 'failureClass', 'httpStatus', 'model', 'vendor']);
    } finally {
      fs.rmSync(run.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('FUNCTIONAL: scorable reply still accepts silently — evidence is failure-only', async () => {
    const envelope = {
      id: 'msg_glm_scored_01',
      type: 'message',
      role: 'assistant',
      model: 'glm-5.3-flash',
      content: [{ type: 'text', text: '{"D":7.25,"A":6.5,"R":8,"N":5.75,"level":"B","defects":[]}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1150, output_tokens: 140 },
    };
    const lane = extractLane("const d = await readJudgeJson(glmVendor, res, 'glm-5.3-flash');");
    const run = await runLane(lane, { res: mockRes(200, JSON.stringify(envelope)), glmVendor: 'glm-5.3-flash' });
    try {
      expect(run.failures).toEqual([]);
      expect(run.judges).toEqual([{
        vendor: 'glm-5.3-flash',
        axes: { D: 7.25, A: 6.5, R: 8, N: 5.75 },
        defects: [],
      }]);
      expect(readEvidenceFiles(run.evidenceRoot)).toEqual([]); // success writes no evidence
    } finally {
      fs.rmSync(run.evidenceRoot, { recursive: true, force: true });
    }
  });

  it('FUNCTIONAL: a configured non-minimax second eye is the eye that runs (config → lane)', async () => {
    // 2026-11-12: the second vision eye used to be minimax-m3 in code. Resolve
    // a glm-4.6v eye from config, then run the REAL second-eye lane against a
    // mock reply: the accepted judge must carry the configured vendor, not a
    // silent minimax fallback.
    const secondEye = resolveSecondEye({
      providers: { glm: { baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'glm-test-key' } },
      sssScore: { secondEye: { provider: 'glm', model: 'glm-4.6v' } },
    });
    const envelope = {
      id: 'msg_glm46v_01',
      type: 'message',
      role: 'assistant',
      model: 'glm-4.6v',
      content: [{ type: 'text', text: '{"D":7.5,"A":6.25,"R":8,"N":5,"level":"B","defects":[]}' }],
      stop_reason: 'end_turn',
    };
    const lane = extractLane('const d = await readJudgeJson(secondEyeVendor, res, secondEye.model);');
    const run = await runLane(lane, {
      res: mockRes(200, JSON.stringify(envelope)),
      secondEyeVendor: 'glm-4.6v',
      secondEye,
    });
    try {
      expect(run.failures).toEqual([]);
      expect(run.judges).toEqual([{
        vendor: 'glm-4.6v',
        axes: { D: 7.5, A: 6.25, R: 8, N: 5 },
        defects: [],
      }]);
      expect(readEvidenceFiles(run.evidenceRoot)).toEqual([]); // success writes no evidence
    } finally {
      fs.rmSync(run.evidenceRoot, { recursive: true, force: true });
    }
  });
});
