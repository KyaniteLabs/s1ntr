import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RalphLoop } from '../../src/core/RalphLoop.js';
import { run } from '../../src/index.js';
import { bootstrapHostAuthority, pinnedProductionHostAuthorityRoot }
  from '../../src/identity/executorAuthorityBootstrap.js';
import { INTEGRATION_PROOF_MODEL, startIntegrationProofLLMServer }
  from './helpers/proof-llm-server.js';

let proof;
let isolatedHome;
const plan = { maxProviderCalls: 1, stages: ['generate'],
  plannedMinimumCalls: 1, plannedMaximumCalls: 1 };

beforeAll(async () => {
  proof = await startIntegrationProofLLMServer();
  isolatedHome = mkdtempSync(join(tmpdir(), 'wave8-r1-'));
  process.env.HOME = isolatedHome;
  process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = pinnedProductionHostAuthorityRoot();
  bootstrapHostAuthority({ rootDir: process.env.SINTER_EXECUTOR_AUTHORITY_ROOT });
});

// The shared isolation hook clears provider variables before each test.
beforeEach(() => {
  for (const prefix of ['SINTER', 'LIMINAL']) {
    process.env[`${prefix}_LLM_PROVIDER`] = 'openai';
    process.env[`${prefix}_LLM_BASE_URL`] = proof.baseUrl;
    process.env[`${prefix}_LLM_MODEL`] = INTEGRATION_PROOF_MODEL;
    process.env[`${prefix}_LLM_API_KEY`] = 'wave8-r1-fake';
  }
  process.env.LIMINAL_ALLOW_LOCALHOST_LLM = 'true';
  process.env.SINTER_METERED_APPROVED_USD_CEILING = '1';
  process.env.SINTER_METERED_PRICE_RECEIPT_DIGEST = 'wave8-r1-fake';
});

afterAll(async () => {
  await proof?.close();
  rmSync(isolatedHome, { recursive: true, force: true });
});

test('generation-only saves one candidate through the real loop with one call', async () => {
  const galleryDir = join(isolatedHome, '.sinter', 'gallery');
  const result = await run('Create one playable p5 artifact.', {
    maxIterations: 1, evalMode: 'legacy', galleryDir,
    output: join(isolatedHome, '.sinter', 'output'), project: 'r1-candidate', providerCallBudget: plan,
  });
  expect(proof.requests).toHaveLength(1);
  expect(result.code).toContain('createCanvas');
  expect(existsSync(galleryDir)).toBe(true);
  expect(readdirSync(galleryDir, { recursive: true }).some((entry) => String(entry).endsWith('v1.js'))).toBe(true);
  expect(result.providerCallBudget).toMatchObject({ attemptedCalls: 1, remainingCalls: 0 });
  expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(result.jsPath)).toBe(true);
  expect(existsSync(result.htmlPath)).toBe(true);
});

test('the original five-candidate fanout aborts before call two', async () => {
  proof.requests.length = 0;
  await expect(RalphLoop.run('Create candidates.', {
    maxIterations: 1, numCandidates: 5, maxParallelism: 1, evalMode: 'legacy',
    galleryDir: join(isolatedHome, 'blocked'), providerCallBudget: plan,
  })).rejects.toThrow('blocked before call 2');
  expect(proof.requests).toHaveLength(1);
});
