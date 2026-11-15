/**
 * Live AC6 oracle: render fixed flat vs layered fixtures, run dual transfer evaluators.
 *
 * Env (same seats as Wave 8 dream studies):
 *   CODEX_PROXY_API_KEY, LIMINAL_EVALUATOR_* (Grok), LIMINAL_STUDIO_* (Gemini)
 *   SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST (64-hex)
 *
 * Usage:
 *   pnpm exec tsx scripts/quality/wave8-transfer-oracle-live.ts
 *   pnpm exec tsx scripts/quality/wave8-transfer-oracle-live.ts --out .quality/wave-8/oracle-live/receipt.json
 *
 * Exit 0 = dual-validated (holdouts allowed); exit 1 = abort.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  LLMClient,
  withLiminalProductTransportAuthority,
  type LiminalProductTransportGrant,
} from '../../src/llm/LLMClient.js';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';
import { HeadlessDreamObserver } from '../../src/dreaming/research/HeadlessDreamObserver.js';
import { createDreamRenderedEvidenceAuthority } from '../../src/dreaming/research/DreamResearchEvidence.js';
import { LLMDreamEvaluator } from '../../src/runtime-core/ProductionDreamHostAdapters.js';
import {
  buildOracleReceipt,
  oracleControlCandidate,
  oracleTreatmentCandidate,
} from '../../src/runtime-core/DreamTransferOracle.js';
import type { DreamExperimentPlan } from '../../src/dreaming/research/DreamResearchTypes.js';
import { bootstrapProductionCreativeAdmissionSigner } from '../../src/runtime-core/CreativeAdmissionAuthority.js';

const sha256 = (value: unknown) => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function outPath(): string | null {
  const idx = process.argv.indexOf('--out');
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
}

async function evaluationGrant(purposeTag: string): Promise<LiminalProductTransportGrant> {
  const keyFile = path.join(os.homedir(), '.sinter', 'authority', 'liminal-command-receipt.key');
  const signer = await bootstrapProductionCreativeAdmissionSigner(keyFile);
  const scope = Object.freeze({
    schema: 'sinter.product-transport-scope' as const,
    schemaVersion: 1 as const,
    operationId: `oracle-ac6-${purposeTag}`,
    effectId: `oracle-eval-${purposeTag}`,
    reservationDigest: sha256({ oracle: purposeTag }),
    purpose: 'evaluation' as const,
    role: 'evaluator' as const,
  });
  return Object.freeze({ scope, proof: signer.sealAdmission(scope) });
}

async function main(): Promise<void> {
  const rendererDigest = process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST
    ?? 'dd28bd24f826c3ca1154869b1c75f1f046a6958f910e4550d0f6cdedd9822924';
  if (!/^[a-f0-9]{64}$/.test(rendererDigest)) {
    throw new Error('SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST must be 64 hex');
  }

  // Evaluator seats: Grok primary, Gemini second (studio seat pattern)
  const evalClient = new LLMClient({
    role: 'evaluator',
    baseUrl: process.env.LIMINAL_EVALUATOR_BASE_URL ?? 'grok-cli://local',
    model: process.env.LIMINAL_EVALUATOR_MODEL ?? 'grok-4.5',
    apiKey: process.env.LIMINAL_EVALUATOR_API_KEY,
    provider: process.env.LIMINAL_EVALUATOR_PROVIDER as never,
  });
  const studioClient = new LLMClient({
    role: 'evaluator',
    baseUrl: process.env.LIMINAL_STUDIO_BASE_URL ?? process.env.LIMINAL_HARNESS_BASE_URL
      ?? 'http://localhost:8317/v1',
    model: process.env.LIMINAL_STUDIO_MODEL ?? 'gemini-3.1-pro-low',
    apiKey: process.env.LIMINAL_STUDIO_API_KEY
      ?? process.env.CODEX_PROXY_API_KEY
      ?? process.env.LIMINAL_HARNESS_API_KEY,
    provider: (process.env.LIMINAL_STUDIO_PROVIDER ?? 'openai') as never,
  });

  const renderer = HeadlessRenderer.getInstance();
  const evidence = createDreamRenderedEvidenceAuthority(sha256({ oracle: 'wave8-ac6' }));
  const observer = new HeadlessDreamObserver(
    renderer,
    { timeoutMs: 45_000, maximumOutputBytes: 2_000_000 },
    evidence.issuer,
  );

  const plan = {
    aggregateId: 'oracle-live-ac6',
    schemaVersion: 1 as const,
    campaignId: 'wave8-transfer-oracle-live',
    hypothesis: {
      id: sha256({ oracle: 'visual-depth' }),
      statement: 'Layered depth should beat flat control',
      principle: 'visual-depth',
      expectedEffect: 'treatment preferred',
    },
    context: {
      knowledgeProfileDigest: sha256({ k: 'oracle' }),
      operatorDigest: sha256({ op: 'oracle' }),
      policyDigest: sha256({ p: 'oracle' }),
      rendererEnvironmentDigest: rendererDigest,
      evaluatorManifestDigests: [] as string[],
      transferCommitmentDigest: sha256({ t: 'oracle' }),
      sourceDigests: [] as string[],
      parentSetDigest: sha256({ parent: 'oracle' }),
    },
    budget: { maximumAttempts: 7 },
    requiredModalities: ['visual', 'motion'] as const,
    lease: { token: 'oracle-lease', fencingSequence: 1 },
  } satisfies DreamExperimentPlan;

  process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST = rendererDigest;

  const control = oracleControlCandidate();
  const treatment = oracleTreatmentCandidate();
  console.error('[oracle-live] rendering control (flat)…');
  const controlEv = await observer.observe(control, plan as DreamExperimentPlan);
  console.error('[oracle-live] rendering treatment (layered)…');
  const treatmentEv = await observer.observe(treatment, plan as DreamExperimentPlan);

  if (controlEv.degraded || treatmentEv.degraded
    || !controlEv.identityValid || !treatmentEv.identityValid) {
    throw new Error(`Render degraded/invalid: control.degraded=${controlEv.degraded} treatment.degraded=${treatmentEv.degraded}`);
  }
  console.error('[oracle-live] eval1 Grok…');
  const eval1 = await withLiminalProductTransportAuthority(
    await evaluationGrant('grok'),
    () => new LLMDreamEvaluator(evalClient).compare(treatmentEv, controlEv),
  );
  console.error('[oracle-live] eval2 Gemini…');
  const eval2 = await withLiminalProductTransportAuthority(
    await evaluationGrant('gemini'),
    () => new LLMDreamEvaluator(studioClient).compare(treatmentEv, controlEv),
  );

  const receipt = {
    ...buildOracleReceipt(eval1, eval2),
    live: true,
    controlArtifactDigest: controlEv.artifactDigest,
    treatmentArtifactDigest: treatmentEv.artifactDigest,
    controlEvidenceDigest: controlEv.frames?.[0],
    treatmentEvidenceDigest: treatmentEv.frames?.[0],
    evaluator1: {
      model: evalClient.getConfig().model,
      baseUrl: evalClient.getConfig().baseUrl,
      outcome: eval1,
    },
    evaluator2: {
      model: studioClient.getConfig().model,
      baseUrl: studioClient.getConfig().baseUrl,
      outcome: eval2,
    },
    at: new Date().toISOString(),
  };

  const target = outPath();
  if (target) {
    await mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await writeFile(path.resolve(target), `${JSON.stringify(receipt, null, 2)}\n`);
    console.error(`[oracle-live] wrote ${target}`);
  }
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.gate === 'pass' ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
