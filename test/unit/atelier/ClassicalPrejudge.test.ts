import { describe, expect, it } from 'vitest';
import { preJudgeArtifact } from '../../../scripts/atelier/classical-prejudge.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('classical pre-judge gate', () => {
  it('rejects junk before a judge call with deterministic reasons', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prejudge-')), 'junk.html');
    fs.writeFileSync(file, 'junk');
    const result = await preJudgeArtifact({ artifactPath: file, validatorResult: { valid: false }, browserBootEvidence: false, frameStats: [{ luminance: 0, variance: 0 }], timedOut: true });
    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['VALIDATOR_FAILED', 'BROWSER_BOOT_MISSING', 'PIXEL_VARIANCE_TOO_LOW', 'RENDER_TIMEOUT']));
  });

  it('reports missing frames instead of crashing on an absent capture', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prejudge-'));
    const file = path.join(dir, 'good.html');
    fs.writeFileSync(file, '<canvas>good</canvas>');
    const result = await preJudgeArtifact({
      artifactPath: file, validatorResult: { valid: true }, browserBootEvidence: false,
      framePaths: [path.join(dir, 'missing-shot.png')],
    });
    expect(result.reasons).toContain('RENDER_FRAMES_MISSING');
    expect(result.reasons).toContain('BROWSER_BOOT_MISSING');
  });

  it('passes a good fixture without invoking a model', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prejudge-')), 'good.html');
    fs.writeFileSync(file, '<canvas>good</canvas>');
    const result = await preJudgeArtifact({ artifactPath: file, validatorResult: { valid: true }, browserBootEvidence: true, frameStats: [{ luminance: 120, variance: 900 }], audioEvidence: { required: false } });
    expect(result.pass).toBe(true);
    expect(result.artifactIdentity).toMatch(/^[a-f0-9]{64}$/);
  });
});
