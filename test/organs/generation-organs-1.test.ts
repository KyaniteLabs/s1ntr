/**
 * Generation-path organs, group 1: entropy, evaluation (HybridJudge + ConfidenceSynthesizer), guardrails (flash + code guard),
 * quality (CreativeProofGate). Real classes, real inputs, perturbation per organ. No LLM involved.
 * Wiring findings are recorded in registry.json (decision point each organ should feed).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MetabolicEntropyEngine } from '../../src/entropy/MetabolicEntropyEngine.js';
import { HybridJudge } from '../../src/evaluation/HybridJudge.js';
import { synthesize, isTrustworthy } from '../../src/evaluation/ConfidenceSynthesizer.js';
import { judgePhotosensitivity, REGION_GRID, WINDOW_COUNT } from '../../src/guardrails/FlashMeasure.js';
import { findGeneratedCodeViolations } from '../../src/guardrails/GeneratedCodeGuard.js';
import { evaluateCreativeProof, CREATIVE_PROOF_SCHEMA_VERSION } from '../../src/quality/CreativeProofGate.js';

const deps = (events: unknown[], files: string[], tasks = 1) => ({
  eventStore: { getRecent: () => events }, heap: { listFiles: async () => files },
  telemetry: { getSummary: () => ({ successRate: 1, avgDurationMs: 5, totalTasks: tasks, totalViolations: 0 }) },
});

describe('organ: entropy', () => {
  it('seed follows the harvested world: same inputs same seed, any source change moves it, empty sources are labelled degraded', async () => {
    const a = await new MetabolicEntropyEngine(deps([{ k: 1 }], ['a.js'])).harvest();
    const again = await new MetabolicEntropyEngine(deps([{ k: 1 }], ['a.js'])).harvest();
    const moved = await new MetabolicEntropyEngine(deps([{ k: 2 }], ['a.js'])).harvest();
    expect(a.quality).toBe('harvested'); expect(a.seed).toBe(again.seed); expect(a.seed).not.toBe(moved.seed);
    const empty = await new MetabolicEntropyEngine(deps([], [], 0)).harvest();
    expect(empty.quality).toBe('degraded');
    const e = new MetabolicEntropyEngine(deps([{ k: 1 }], ['a.js']));
    await e.harvest(); const d1 = e.nextFloat(); const d2 = e.nextFloat();
    expect(d1).not.toBe(d2);
  });
  it('a failing harvest falls back to a labelled genesis/emergency seed, never an unlabelled one', async () => {
    const broken = { ...deps([], []), eventStore: { getRecent: () => { throw new Error('boom'); } } };
    const r = await new MetabolicEntropyEngine(broken as never).harvest();
    expect(['genesis', 'fallback']).toContain(r.source); expect(r.quality).not.toBe('harvested');
  });
});

describe('organ: evaluation', () => {
  const rich = `function setup(){createCanvas(400,400);} function draw(){background(10);for(let i=0;i<60;i++){stroke(255*noise(i),120,200);line(i*6,0,200+100*sin(frameCount*0.02+i),400);}}`;
  it('HybridJudge scores real code, and a stub or empty candidate scores lower than a rich one', async () => {
    const judge = new HybridJudge();
    const good = await judge.judge({ code: rich, prompt: 'noise lines', domain: 'p5' });
    const poor = await judge.judge({ code: 'x', prompt: 'noise lines', domain: 'p5' });
    expect(good.score).toBeGreaterThan(poor.score);
    expect(good.confidence.confidence).toBeGreaterThan(0);
  });
  it('synthesize: critic divergence lowers confidence and untrustworthy at the floor', () => {
    const mk = (s: number) => ({ score: s, dimensions: {}, violations: [] }) as never;
    const agree = synthesize(mk(0.8), mk(0.78));
    const split = synthesize(mk(0.9), mk(0.1));
    expect(agree.agreement).toBe('consensus'); expect(split.agreement).toBe('major-divergence');
    expect(split.confidence).toBeLessThan(agree.confidence);
    expect(isTrustworthy(agree)).toBe(true);
  });
});

describe('organ: guardrails', () => {
  const regions = (v: number) => Array.from({ length: WINDOW_COUNT + 1 }, () => v);
  it('photosensitivity: a strobe fails, a calm page passes, a capture that saw nothing fails', () => {
    const strobe = { frames: Array.from({ length: 12 }, (_, i) => ({ t: i * 80, regions: regions(i % 2 ? 0.05 : 0.9) })), error: null };
    const calm = { frames: Array.from({ length: 12 }, (_, i) => ({ t: i * 80, regions: regions(0.4) })), error: null };
    expect(judgePhotosensitivity(strobe).pass).toBe(false);
    expect(judgePhotosensitivity(calm).pass).toBe(true);
    expect(judgePhotosensitivity({ frames: [], error: null }).pass).toBe(false);
    expect(REGION_GRID).toBeGreaterThan(0);
  });
  it('generated code guard: network and eval escapes are reported, plain drawing code is not', () => {
    expect(findGeneratedCodeViolations('fetch("http://x"); eval("1")').length).toBeGreaterThan(0);
    expect(findGeneratedCodeViolations('const a = 1 + 2;')).toEqual([]);
  });
});

describe('organ: quality (CreativeProofGate)', () => {
  const bytes = new TextEncoder().encode('frame');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const verdict = (status: 'pass' | 'fail') => ({ status, evidenceRefs: ['e1'], evaluatorRef: 'judge', rubricRef: 'rubric' });
  const input = (creative: 'pass' | 'fail') => ({ schemaVersion: CREATIVE_PROOF_SCHEMA_VERSION,
    domains: [{ name: 'p5', requiredModalities: ['visual' as const] }],
    evidence: [{ ref: 'e1', kind: 'image' as const, modalities: ['visual' as const], sha256: sha, bytes: bytes.length }],
    verdicts: { technical: verdict('pass'), coordination: verdict('pass'), creativeQuality: verdict(creative) },
    requestedClaims: { technicalSuccess: true, coordinationImproved: true, creativeQualityImproved: true } });
  it('claims need proof: verified bytes + passing verdict pass; failing creative verdict or tampered bytes fail', () => {
    const read = (b: Uint8Array) => (_: string) => b;
    expect(evaluateCreativeProof(input('pass') as never, { readEvidence: read(bytes) }).outcome).toBe('PASS');
    expect(evaluateCreativeProof(input('fail') as never, { readEvidence: read(bytes) }).violations).toContain('CREATIVE_QUALITY_NOT_PROVEN');
    expect(evaluateCreativeProof(input('pass') as never, { readEvidence: read(new TextEncoder().encode('tampered')) }).violations).toContain('EVIDENCE_DIGEST_MISMATCH');
  });
});

describe('organ: quality is wired into owner-review capture', () => {
  const frame = (s: string) => ({ mimeType: 'image/png', dataBase64: Buffer.from(s).toString('base64'), width: 8, height: 8 });
  const render = (candidateFailure: boolean) => ({ rendered: true, infraUnavailable: false, candidateFailure, timingMs: 5,
    screenshot: frame('early'), lateScreenshot: frame('late'), errors: [] }) as never;
  it('capture proof verifies frame bytes and only claims technical success; a failed render does not claim it', async () => {
    const { ownerCaptureFromRender } = await import('../../src/cli/OwnerReviewCapture.js');
    const ok = ownerCaptureFromRender('c1', render(false), null).proof!;
    expect(ok.evidenceBytesVerified).toBe(true);
    expect(ok.claimable).toMatchObject({ technicalSuccess: true, creativeQualityImproved: false });
    const bad = ownerCaptureFromRender('c2', render(true), null);
    expect(bad.proof!.claimable.technicalSuccess).toBe(false);
    expect(bad.limitations.join()).toContain('capture-proof-failed');
  });
});
