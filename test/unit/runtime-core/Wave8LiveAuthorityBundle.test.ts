import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWave8LiveAuthorityBundle,
  prepareLiveAuthorityReviewContext,
  type LiveAuthoritySpec,
} from '../../../src/runtime-core/Wave8LiveAuthorityBundle.js';
import { computeProofSourceFingerprint,
  readCurrentGitCommit } from '../../../src/runtime-core/ProofReceiptValidator.js';
import { digestLiveProtocol,
  liveAuthorityAttestationPayload } from '../../../src/runtime-core/LiveProtocol.js';
import {
  configureWave8LivePreSpendInterlockForTests as configureWave8LivePreSpendInterlock,
} from '../../../src/llm/PreSpendInterlock.js';
import { bootstrapHostAuthority } from '../../../src/identity/executorAuthorityBootstrap.js';
import { issueExecutorAttestation } from '../../../src/identity/executorAttestation.js';
import { subscriptionFunding } from '../../../src/identity/fundingTruth.js';

const roots: string[] = [];
let testHostAuthority: ReturnType<typeof bootstrapHostAuthority>;
let testTrustStorePath = '';
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type KeyPair = ReturnType<typeof generateKeyPairSync>;

function signed(role: 'owner' | 'sol-approval' | 'product-review', authorityId: string,
  subjectDigest: string, key: KeyPair) {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const unsigned = { schema: 'sinter.wave8-live-authority-attestation' as const,
    schemaVersion: 1 as const, authorityId, role, subjectDigest, issuedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: `${role}-${subjectDigest}` };
  return { ...unsigned, signatureBase64: sign(null,
    Buffer.from(liveAuthorityAttestationPayload(unsigned)), key.privateKey).toString('base64') };
}

function fixture(): { root: string; spec: LiveAuthoritySpec;
  keys: Record<'owner' | 'sol' | 'product', KeyPair> } {
  const repoRoot = process.cwd();
  const parent = path.join(repoRoot, '.quality', 'wave-8', 'live');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'authority-unit-'));
  roots.push(root);
  for (const [name, body] of [['plan.md', 'frozen plan\n'], ['schedule.md', 'review schedule\n'],
    ['brief.md', 'unseen brief\n'], ['manifest.json', '{}'], ['execution.json', '{}'],
    ['owner-review.json', '{}'], ['routes.json', '{}'], ['enforcement.md', 'bound\n']])
    fs.writeFileSync(path.join(root, name), body);
  // A hard link cannot cross filesystems. Keep this external to repoRoot but
  // on its filesystem so the security assertion is valid in CI containers.
  const trustRoot = fs.mkdtempSync(path.join(path.dirname(repoRoot), '.wave8-authority-trust-'));
  roots.push(trustRoot);
  const executorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wave8-executor-authority-'));
  roots.push(executorRoot);
  vi.stubEnv('SINTER_EXECUTOR_AUTHORITY_ROOT', executorRoot);
  testHostAuthority = bootstrapHostAuthority({ rootDir: executorRoot });
  const keys = { owner: generateKeyPairSync('ed25519'), sol: generateKeyPairSync('ed25519'),
    product: generateKeyPairSync('ed25519') };
  const pem = (key: KeyPair) => key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const trustStorePath = path.join(trustRoot, 'trust.json');
  testTrustStorePath = trustStorePath;
  fs.writeFileSync(trustStorePath, JSON.stringify({ schema: 'sinter.wave8-live-trust-store',
    schemaVersion: 1, keys: [
      { keyId: 'owner-key', authorityId: 'owner', role: 'owner', publicKeyPem: pem(keys.owner) },
      { keyId: 'sol-key', authorityId: 'sol-authority', role: 'sol-approval', publicKeyPem: pem(keys.sol) },
      { keyId: 'product-key', authorityId: 'product-authority', role: 'product-review', publicKeyPem: pem(keys.product) },
    ], credentialBindings: slots().map(slot => ({ bindingId: `binding-${slot.id}`,
      provider: slot.provider, model: slot.model, seatId: slot.seatId })) }), { mode: 0o600 });
  const relative = (name: string) => path.relative(repoRoot, path.join(root, name));
  const spec: LiveAuthoritySpec = { schema: 'sinter.wave8-live-authority-spec', schemaVersion: 1,
    planPath: relative('plan.md'), ownerApprovalPath: relative('owner.json'), trustStorePath,
    noSpendEvidencePath: relative('no-spend.json'),
    evidenceSchedulePath: relative('schedule.md'), expectedPlayableArtifactCount: 3,
    campaignArtifacts: { manifestPath: relative('manifest.json'), executionPath: relative('execution.json'),
      ownerReviewPackagePath: relative('owner-review.json'), subscriptionRouteAttestationPath: relative('routes.json'),
      phaseOneEnforcementPath: relative('enforcement.md') },
    maxActiveMinutes: 30, maxRetriesPerStage: 1,
    briefs: [{ id: 'unseen-one', path: relative('brief.md') }],
    slots: [] };
  fs.writeFileSync(path.join(root, 'no-spend.json'), JSON.stringify({
    gate: 'noSpendCirculationProof', passed: true, evidenceClass: 'deterministic-proof',
    livePass: false, head: readCurrentGitCommit(repoRoot),
    sourceFingerprint: computeProofSourceFingerprint(repoRoot)?.replace(/^sha256:/, ''),
    transportSentinel: { networkCalls: 0, ledgerReservations: 0, spendUsd: 0 } }));
  return { root, spec, keys };
}

function slots(): LiveAuthoritySpec['slots'] {
  const common = { subscriptionTransport: 'campaign-host' as const, minCalls: 1, maxCalls: 1,
    maxInputTokens: 4_000, maxOutputTokens: 2_000, minActiveMinutes: 1 };
  return [
    { ...common, id: 'sol-approval', purpose: 'sol-review-bootstrap', provider: 'kimi',
      model: 'kimi-k3', role: 'harness', pipe: 'kimi-k3', effort: 'high',
      seatId: 'seat-kimi-k3', requestDigest: 'a'.repeat(64) },
    { ...common, id: 'generate', purpose: 'product', provider: 'openai',
      model: 'gpt-5.6-luna', role: 'generator', pipe: 'luna-max', effort: 'max',
      seatId: 'seat-luna' },
    { ...common, id: 'review', purpose: 'product', provider: 'openai',
      model: 'gpt-5.6-terra', role: 'critic', pipe: 'terra-high', effort: 'high',
      seatId: 'seat-terra' },
  ];
}

function hash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function buildTestBundle(input: Parameters<typeof buildWave8LiveAuthorityBundle>[0]) {
  return buildWave8LiveAuthorityBundle({ ...input, testHostAuthority, testTrustStorePath });
}

function review(context: ReturnType<typeof prepareLiveAuthorityReviewContext>,
  kind: 'sol-approval' | 'product-review', key: KeyPair,
  productRole: 'critic' | 'evaluator' = 'critic') {
  const sol = kind === 'sol-approval';
  const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), `wave8-${kind}-`));
  roots.push(workerRoot);
  const artifact = path.join(workerRoot, 'review.log');
  fs.writeFileSync(artifact, `Reviewed SHA: ${context.exactHead}\nAPPROVE\n`);
  const workerId = `w-${sol ? 'kimi' : 'terra'}-unit`;
  const workerReceiptPath = path.join(workerRoot, 'status.json');
  fs.writeFileSync(workerReceiptPath, JSON.stringify({ schema_version: 3, worker_id: workerId,
    current_phase: 'done', exit_code: 0, executor: sol ? 'kimi-k3' : 'codex-terra',
    log_path: artifact }));
  const reviewer = sol
    ? { role: 'harness', provider: 'kimi', model: 'kimi-k3', pipe: 'kimi-k3',
      effort: 'high', identityVerified: true as const, seatId: 'seat-kimi-k3' }
    : { role: productRole, provider: 'openai', model: 'gpt-5.6-terra', pipe: 'terra-high',
      effort: 'high', identityVerified: true as const, seatId: 'seat-terra' };
  const bound = { passed: true, exactHead: context.exactHead, planDigest: context.planDigest,
    schemaDigest: context.schemaDigest, implementationDigest: context.implementationDigest,
    sourceDigest: context.sourceDigest, evidenceClass: 'live-provider' as const,
    artifactDigests: [hash(artifact), context.contextDigest,
      context.campaignArtifactBindingsDigest] };
  const evidence = sol ? { ...bound, critical: true as const, executor: reviewer }
    : { ...bound, reviewer, authorIndependent: true };
  const subjectDigest = digestLiveProtocol(evidence);
  const executorAttestationPath = path.join(workerRoot, 'executor-attestation.json');
  const identity = sol
    ? { provider: 'kimi' as const, model: reviewer.model, effort: 'high' as const }
    : { provider: 'openai' as const, model: reviewer.model, effort: 'high' as const };
  const seatDigest = createHash('sha256').update(reviewer.seatId).digest('hex');
  const executorAttestation = issueExecutorAttestation(bootstrapHostAuthority().registry, {
    attestationId: `executor-${kind}`, runDigest: context.exactHead,
    requestDigest: context.contextDigest, attemptDigest: subjectDigest,
    requestedIdentity: identity, resolvedIdentity: identity, effort: identity.effort,
    fallbackChain: [{ ordinal: 0, identity }],
    seat: { seatId: reviewer.seatId, seatDigest, surface: 'cliproxy-seat' },
    funding: subscriptionFunding({ seatDigest, quotaSurface: 'cliproxy-seat',
      quotaCounters: { calls: 1, inputTokens: 1, outputTokens: 1, activeSeconds: 1 } }),
    quotaSurface: 'cliproxy-seat', issuedAt: new Date(Date.now() - 1_000).toISOString(),
    nonce: `executor-${kind}-${subjectDigest}`, surface: 'cliproxy-seat',
    durationMs: 1, success: true, responseDigest: hash(artifact),
    quotaCounterDelta: { calls: 1, inputTokens: 1, outputTokens: 1, activeSeconds: 1 },
  });
  fs.writeFileSync(executorAttestationPath, JSON.stringify(executorAttestation), { mode: 0o600 });
  return { schema: 'sinter.wave8-external-review', schemaVersion: 1, kind, decision: 'approve',
    contextDigest: context.contextDigest, exactHead: context.exactHead,
    sourceDigest: context.sourceDigest, planDigest: context.planDigest, specDigest: context.specDigest,
    schemaDigest: context.schemaDigest, implementationDigest: context.implementationDigest,
    reviewer, authorIndependent: true, reviewedArtifactDigests: [...context.artifactDigests],
    workerId, workerReceiptPath, executorAttestationPath, reviewArtifactPath: artifact, findings: [],
    attestation: signed(kind, sol ? 'sol-authority' : 'product-authority', subjectDigest, key) };
}

function writeOwner(root: string, context: ReturnType<typeof prepareLiveAuthorityReviewContext>,
  configured: LiveAuthoritySpec['slots'], key: KeyPair): void {
  const rows = configured.map(slot => ({ role: slot.role, maxCalls: slot.maxCalls,
    maxInputTokens: slot.maxInputTokens, maxOutputTokens: slot.maxOutputTokens, maxRetries: 0 }));
  const approvedSeatIds = [...new Set(configured.map(slot => slot.seatId))];
  const budgets = { fundingMode: 'subscription-seat', approvedSeatIds, rows, maxActiveMinutes: 30,
    maxTotalCalls: 3, maxTotalInputTokens: 12_000, maxTotalOutputTokens: 6_000,
    maxRetriesPerStage: 1 };
  const body = { schema: 'sinter.owner-subscription-seat-approval', ownerId: 'owner',
    fundingMode: 'subscription-seat', approvedSeatIds,
    resourceBudgetDigest: digestLiveProtocol(budgets), planDigest: context.planDigest,
    approvedAt: new Date(Date.now() - 2_000).toISOString() };
  const approval = { ...body, approvalDigest: digestLiveProtocol(body) };
  const attestation = signed('owner', 'owner',
    digestLiveProtocol({ ownerApproval: approval, ownerCheckpoints: [] }), key);
  fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({
    schema: 'sinter.wave8-owner-authority', schemaVersion: 1, approval, attestation }));
}

function readyFixture(productRole: 'critic' | 'evaluator' = 'critic') {
  const prepared = fixture();
  prepared.spec.slots = slots().map(slot => slot.role === 'critic'
    ? { ...slot, role: productRole } : slot);
  const context = prepareLiveAuthorityReviewContext(process.cwd(), prepared.spec);
  writeOwner(prepared.root, context, prepared.spec.slots, prepared.keys.owner);
  fs.writeFileSync(path.join(prepared.root, 'sol.json'),
    JSON.stringify(review(context, 'sol-approval', prepared.keys.sol)));
  fs.writeFileSync(path.join(prepared.root, 'product.json'),
    JSON.stringify(review(context, 'product-review', prepared.keys.product, productRole)));
  return { ...prepared, context };
}

function useCollaborationReceipt(reviewPath: string,
  context: ReturnType<typeof prepareLiveAuthorityReviewContext>): void {
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const dispatch = JSON.parse(fs.readFileSync(review.workerReceiptPath, 'utf8'));
  fs.writeFileSync(review.workerReceiptPath, JSON.stringify({
    schema: 'sinter.codex-collaboration-review-receipt', schemaVersion: 1,
    workerId: review.workerId, status: 'done', exitCode: 0, executor: dispatch.executor,
    reviewArtifactPath: review.reviewArtifactPath,
    exactHead: context.exactHead, contextDigest: context.contextDigest,
  }));
}

describe('Wave8LiveAuthorityBundle', () => {
  it('binds every governed campaign artifact into the independent-review context', () => {
    const { root, spec } = fixture();
    spec.slots = slots();
    const paths = Object.values(spec.campaignArtifacts);
    const digests = [prepareLiveAuthorityReviewContext(process.cwd(), spec).contextDigest];
    for (const [index, artifactPath] of paths.entries()) {
      fs.appendFileSync(path.resolve(process.cwd(), artifactPath), `mutation-${index}`);
      digests.push(prepareLiveAuthorityReviewContext(process.cwd(), spec).contextDigest);
    }
    expect(new Set(digests).size).toBe(digests.length);
    expect(paths).toHaveLength(5);
    expect(root).toContain(path.join('.quality', 'wave-8', 'live'));
  });

  it('builds an exact-source subscription authority bundle from independent review evidence', () => {
    const { root, spec } = readyFixture();
    const bundle = buildTestBundle({ repoRoot: process.cwd(), outputDir: root,
      spec, solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), path.join(root, 'product.json')) });
    expect(bundle.receipt.freeze.roles.map(role => role.model)).toEqual([
      'kimi-k3', 'gpt-5.6-luna', 'gpt-5.6-terra']);
    expect(bundle.config.preSpendPolicy.feasibilityProof).toMatchObject({
      passed: true, fundingMode: 'subscription-seat' });
    expect(bundle.releaseRoot.receipts.map(receipt => receipt.kind)).toEqual(['schema-invalidation']);
    fs.writeFileSync(path.join(root, 'live-protocol.json'), JSON.stringify(bundle.receipt));
    fs.writeFileSync(path.join(root, 'bootstrap-release-root.json'), JSON.stringify(bundle.releaseRoot));
    fs.writeFileSync(path.join(root, 'execution-config.json'), JSON.stringify(bundle.config));
    const uninstall = configureWave8LivePreSpendInterlock(
      path.join(root, 'execution-config.json'), bundle.trustStorePath);
    uninstall();
    spec.slots[1] = { ...spec.slots[1]!, maxCalls: 2 };
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: root,
      spec, solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), path.join(root, 'product.json')) }))
      .toThrow('not bound to the exact review context');
  });

  it('accepts an evaluator-shaped independent product reviewer', () => {
    const { root, spec } = readyFixture('evaluator');
    const bundle = buildTestBundle({ repoRoot: process.cwd(), outputDir: root,
      spec, solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), path.join(root, 'product.json')) });
    expect(bundle.receipt.freeze.roles).toContainEqual(expect.objectContaining({
      role: 'evaluator', model: 'gpt-5.6-terra', effort: 'high',
    }));
  });

  it('accepts exact-context Codex collaboration receipts without relabeling them as Dispatch', () => {
    const { root, spec, context } = readyFixture();
    const solPath = path.join(root, 'sol.json');
    const productPath = path.join(root, 'product.json');
    useCollaborationReceipt(solPath, context);
    useCollaborationReceipt(productPath, context);
    const bundle = buildTestBundle({ repoRoot: process.cwd(), outputDir: root, spec,
      solReviewPath: path.relative(process.cwd(), solPath),
      productReviewPath: path.relative(process.cwd(), productPath) });
    expect(bundle.receipt.freeze.roles.map(role => role.model)).toContain('kimi-k3');
  });

  it('rejects a collaboration receipt bound to another review context', () => {
    const { root, spec, context } = readyFixture();
    const solPath = path.join(root, 'sol.json');
    useCollaborationReceipt(solPath, context);
    const review = JSON.parse(fs.readFileSync(solPath, 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(review.workerReceiptPath, 'utf8'));
    fs.writeFileSync(review.workerReceiptPath, JSON.stringify({
      ...receipt, contextDigest: 'f'.repeat(64),
    }));
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: root, spec,
      solReviewPath: path.relative(process.cwd(), solPath),
      productReviewPath: path.relative(process.cwd(), path.join(root, 'product.json')) }))
      .toThrow('review receipt is incomplete or failed');
  });

  it('rejects Luna in the harness role before issuing authority', () => {
    const { spec } = fixture();
    spec.slots = slots().map(slot => slot.role === 'harness'
      ? { ...slot, model: 'gpt-5.6-luna' } : slot);
    const context = prepareLiveAuthorityReviewContext(process.cwd(), spec);
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: '.', spec,
      solReviewPath: spec.planPath, productReviewPath: spec.planPath }))
      .toThrow('reserves the harness role for Kimi K3');
    expect(context.exactHead).toMatch(/^[a-f0-9]{40}$/);
  });

  it('requires a harness slot rather than treating critical review as review-only', () => {
    const { spec } = fixture();
    spec.slots = slots().map(slot => slot.role === 'harness'
      ? { ...slot, role: 'evaluator' as const, identityId: 'kimi-review-only' } : slot);
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: '.', spec,
      solReviewPath: spec.planPath, productReviewPath: spec.planPath }))
      .toThrow('requires exactly one Kimi-K3-high harness slot');
  });

  it('rejects duplicate Kimi harness slots even when their identity fields match', () => {
    const { spec } = fixture();
    const configured = slots();
    spec.slots = [...configured, { ...configured[0]!, id: 'sol-approval-duplicate' }];
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: '.', spec,
      solReviewPath: spec.planPath, productReviewPath: spec.planPath }))
      .toThrow('requires exactly one Kimi-K3-high harness slot');
  });

  it('rejects a forged review signature even when the identity fields claim Terra-high', () => {
    const { root, spec } = readyFixture();
    const reviewPath = path.join(root, 'product.json');
    const forged = JSON.parse(fs.readFileSync(reviewPath, 'utf8')) as {
      attestation: { signatureBase64: string } };
    forged.attestation.signatureBase64 = Buffer.from('forged').toString('base64');
    fs.writeFileSync(reviewPath, JSON.stringify(forged));
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: root, spec,
      solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), reviewPath) }))
      .toThrow('product-review signature is invalid');
  });

  it('rejects an untrusted executor attestation behind valid review fields', () => {
    const { root, spec } = readyFixture();
    const reviewPath = path.join(root, 'product.json');
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8')) as {
      executorAttestationPath: string };
    const executor = JSON.parse(fs.readFileSync(review.executorAttestationPath, 'utf8')) as {
      signature: string };
    executor.signature = 'forged';
    fs.writeFileSync(review.executorAttestationPath, JSON.stringify(executor), { mode: 0o600 });
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: root, spec,
      solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), reviewPath) }))
      .toThrow('executor attestation is invalid');
  });

  it('rejects approval text not returned by the attested executor call', () => {
    const { root, spec } = readyFixture();
    const reviewPath = path.join(root, 'product.json');
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8')) as { reviewArtifactPath: string };
    fs.writeFileSync(review.reviewArtifactPath,
      `Reviewed SHA: ${readCurrentGitCommit(process.cwd())}\nAPPROVE\nchanged\n`);
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: root, spec,
      solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), reviewPath) }))
      .toThrow('executor attestation does not bind');
  });

  it('rejects an approval that still reports findings', () => {
    const { root, spec } = readyFixture();
    const reviewPath = path.join(root, 'product.json');
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8')) as { findings: string[] };
    review.findings = ['unresolved security defect'];
    fs.writeFileSync(reviewPath, JSON.stringify(review));
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: root, spec,
      solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), reviewPath) })).toThrow();
  });

  it('rejects an external trust store hard-linked inside the repository', () => {
    const { root, spec } = readyFixture();
    try {
      fs.linkSync(spec.trustStorePath, path.join(root, 'trust-hardlink.json'));
    } catch (error) {
      // Split-mount CI makes this attack physically unrepresentable.
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') return;
      throw error;
    }
    expect(() => buildTestBundle({ repoRoot: process.cwd(), outputDir: root, spec,
      solReviewPath: path.relative(process.cwd(), path.join(root, 'sol.json')),
      productReviewPath: path.relative(process.cwd(), path.join(root, 'product.json')) }))
      .toThrow('trust store must be owner-only');
  });
});
