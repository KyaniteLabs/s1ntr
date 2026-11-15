import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('sss-score independent-judge contract', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
  const start = source.indexOf("cmd === 'sss-score'");
  const end = source.indexOf("cmd === 'gui-evolve'");
  const block = source.slice(start, end);

  it('rejects one-judge runs before scorecard or trend persistence', () => {
    const guard = block.indexOf('requireIndependentJudges(judges)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(block.indexOf('buildScorecard('));
    expect(guard).toBeLessThan(block.indexOf("event_type: 'artifact_scored'"));
    expect(block).toContain('process.exit(4)');
  });

  it('surfaces only sanitized per-judge failure classes', () => {
    expect(block).toContain('judgeFailures.join');
    expect(block).toContain("recordJudgeFailure(vendor, 'empty')");
    expect(block).toContain("recordJudgeFailure(vendor, 'parse')");
    expect(block).toContain("recordJudgeFailure(vendor, `http_${res.status}`)");
  });

  it('binds judge identity to configured model and endpoint', () => {
    expect(block).toContain('const evaluatorVendor = configuredJudgeIdentity(ev)');
    // judgeEyePlan (M-20261008-14) replaced the ad-hoc `eyeBase` string and the
    // inline `includes(evaluatorVendor)` dedupe: the plan now derives every
    // running eye, so identity/endpoint binding is asserted through the plan.
    expect(block).toContain('const evBase = `${(ev.baseUrl ||');
    expect(block).toContain('judgeEyePlan({');
    expect(block).toContain('evaluatorVendor, minimaxVendor: secondEyeVendor, glmFlashVendor: glmVendor');
    expect(block).not.toContain("vendor: 'gemini-3.7'");
    expect(block).not.toContain("includes('localhost') ||");
  });

  // SECOND VISION EYE (2026-11-12): minimax-m3 was hardcoded; the eye now comes
  // from sssScore.secondEye while the family-quorum plan stays in SpuScorer.
  it('takes the second vision eye from config with the minimax default preserved', () => {
    expect(block).toContain("const { resolveSecondEye, buildSecondEyeRequest } = await import('../scripts/atelier/second-eye.mjs')");
    expect(block).toContain('const secondEye = resolveSecondEye(sinterCfg)');
    expect(block).toContain('const secondEyeVendor = configuredJudgeIdentity(secondEye)');
    expect(block).toContain('minimaxVendor: secondEyeVendor');
    // No hardcoded minimax model/endpoint survives in the sss-score block.
    expect(block).not.toContain("model: 'minimax-m3'");
    expect(block).not.toContain('api.minimax.io/anthropic/v1/messages');
    // The second eye is dispatched as one lane, not re-created inline.
    expect(block).toContain('buildSecondEyeRequest({ eye: secondEye, imageB64: imgB64, prompt: judgePrompt })');
    expect(block).toContain('readJudgeJson(secondEyeVendor, res, secondEye.model)');
    // A configured eye that aliases the glm-flash eye would collapse the
    // ensemble to one judge — refused before the render, with the fix named.
    expect(block).toContain('SSS_SCORE_SECOND_EYE_DUPLICATE');
    expect(block).toContain('process.exit(7)');
  });

  // DERIVED_STATE_TEST_APPEND_20260905
  it('requires contract-backed prior state before best or Elo comparison', () => {
    expect(block).toContain('const verifiedPrior = prior && hasScoreContract(prior)');
    expect(block).toContain('const isImprovement = !verifiedPrior || mine > verifiedPrior.mean');
    expect(block).toContain('scoreScale: 10');
    expect(block).toContain("scoringContract: SPU_SCORING_CONTRACT");
    expect(block).toContain('.archive-');
    expect(block).toContain('if (verifiedPrior && !sameArtifact)');
  });
});
