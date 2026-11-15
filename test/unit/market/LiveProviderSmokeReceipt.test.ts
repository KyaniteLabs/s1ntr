import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildLiveProviderSmokeReceipt, selectLiveSmokeProvider } from '../../../src/market/LiveProviderSmokeReceipt.js';
import { computeProofSourceFingerprint, validateProofReceipt } from '../../../src/runtime-core/ProofReceiptValidator.js';

function git(repoRoot: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function createRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sinter-live-smoke-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.name', 'Sinter Test']);
  git(repoRoot, ['config', 'user.email', 'liminal@example.test']);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');
  git(repoRoot, ['add', 'src/app.ts']);
  git(repoRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'source', '--no-gpg-sign']);
  return repoRoot;
}

describe('LiveProviderSmokeReceipt', () => {
  it('prefers configured cloud providers for market smoke', () => {
    expect(selectLiveSmokeProvider(['ollama', 'minimax', 'glm'])).toBe('glm');
    expect(selectLiveSmokeProvider(['ollama', 'minimax'])).toBe('minimax');
  });

  it('records a pass only when provider generation returns usable p5 code', () => {
    const receipt = buildLiveProviderSmokeReceipt({
      provider: 'glm',
      model: 'GLM-5v-turbo',
      durationMs: 123,
      artifactPath: '.omx/proof/live-provider-smoke/p5.js',
      code: 'function setup(){ createCanvas(400, 400); }',
    });

    expect(receipt.status).toBe('pass');
    expect(receipt.checks.nonEmptyCode).toBe(true);
    expect(receipt.checks.p5Setup).toBe(true);
    expect(receipt.checks.p5Canvas).toBe(true);
  });

  it('fails incomplete provider output instead of treating any text as ready', () => {
    const receipt = buildLiveProviderSmokeReceipt({
      provider: 'glm',
      model: 'GLM-5v-turbo',
      durationMs: 123,
      artifactPath: '.omx/proof/live-provider-smoke/p5.js',
      code: 'hello world',
    });

    expect(receipt.status).toBe('fail');
    expect(receipt.blockers).toContain('Generated p5 code is missing setup()');
    expect(receipt.blockers).toContain('Generated p5 code is missing createCanvas()');
  });

  it('emits a sourceFingerprint that matches the tree so docs-only commits do not invalidate it', () => {
    const repoRoot = createRepo();
    try {
      const receipt = buildLiveProviderSmokeReceipt({
        repoRoot,
        provider: 'glm',
        model: 'GLM-5v-turbo',
        durationMs: 123,
        artifactPath: '.omx/proof/live-provider-smoke/p5.js',
        code: 'function setup(){ createCanvas(400, 400); }',
      });

      expect(receipt.sourceFingerprint).toBe(computeProofSourceFingerprint(repoRoot));
      expect(receipt.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('records the artifact digest so the validator can detect swapped bytes (#1324)', () => {
    const repoRoot = createRepo();
    try {
      const rel = '.omx/proof/live-provider-smoke/p5.js';
      mkdirSync(join(repoRoot, '.omx', 'proof', 'live-provider-smoke'), { recursive: true });
      writeFileSync(join(repoRoot, rel), 'function setup(){ createCanvas(400, 400); }\n');
      const receipt = buildLiveProviderSmokeReceipt({
        repoRoot, provider: 'glm', model: 'GLM-5v-turbo', durationMs: 1, artifactPath: rel,
        code: 'function setup(){ createCanvas(400, 400); }',
      });
      expect(Object.keys(receipt.artifactDigests)).toEqual([rel]);
      const opts = { requireProviderModel: true, requireArtifactPaths: true, requireArtifactDigests: true };
      expect(validateProofReceipt(repoRoot, receipt, opts).failures).toEqual([]);

      writeFileSync(join(repoRoot, rel), '// not what the provider produced\n');
      expect(validateProofReceipt(repoRoot, receipt, opts).failures[0]).toMatch(/^artifact digest mismatch: /);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('omits the digest when the artifact was never written', () => {
    const repoRoot = createRepo();
    try {
      const receipt = buildLiveProviderSmokeReceipt({
        repoRoot, provider: 'glm', model: 'm', durationMs: 1, artifactPath: 'missing.js', code: '',
      });
      expect(receipt.artifactDigests).toEqual({});
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
