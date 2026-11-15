import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  buildLiveProtocol,
  digestLiveProtocol,
  validateLiveProtocol,
  assertLiveProtocolAllowsPaidExecution,
  liveAuthorityAttestationPayload,
  parseLiveProtocolReceipt,
  type LiveAuthorityAttestation,
  type LiveProtocolInput,
  type LiveProtocolReceipt,
  type LiveRoleIdentity,
  type LiveCheckpoint,
  type LiveConjunctEvidence,
} from '../../../src/runtime-core/LiveProtocol.js';

const HEAD = 'a'.repeat(40);
const d = (char: string) => char.repeat(64);
const NOW = '2026-08-01T12:00:00.000Z';
const EXPIRES = '2026-08-02T12:00:00.000Z';
const ownerKeys = generateKeyPairSync('ed25519');
const priceKeys = generateKeyPairSync('ed25519');
const solKeys = generateKeyPairSync('ed25519');
const reviewKeys = generateKeyPairSync('ed25519');
const trust = { owner: { authorityId: 'owner-authority', publicKeyPem: ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  providers: [
    { authorityId: 'price-authority', role: 'price' as const, publicKeyPem: priceKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    { authorityId: 'sol-authority', role: 'sol-approval' as const, publicKeyPem: solKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    { authorityId: 'review-authority', role: 'product-review' as const, publicKeyPem: reviewKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  ] };

const sol: LiveRoleIdentity = {
  role: 'harness', provider: 'kimi', model: 'kimi-k3', pipe: 'kimi-k3', effort: 'high', identityVerified: true,
};
const terra: LiveRoleIdentity = {
  role: 'product-reviewer', provider: 'cliproxy', model: 'gpt-5.6-terra', pipe: 'terra-high', effort: 'high', identityVerified: true,
};
const generator: LiveRoleIdentity = {
  role: 'generator', provider: 'cliproxy', model: 'gpt-5.6-luna', pipe: 'luna-max', effort: 'max', identityVerified: true,
};

function signed<T extends Record<string, unknown>>(body: T, key: keyof T): T & Record<string, string> {
  const unsigned = { ...body };
  delete unsigned[key];
  return { ...body, [key]: digestLiveProtocol(unsigned) } as T & Record<string, string>;
}

function checkpoint(id: LiveCheckpoint['id'], decision: LiveCheckpoint['decision']): LiveCheckpoint {
  return signed({ id, decision, contactSheetDigest: d('f'), playableArtifactDigests: [d('0')] }, 'decisionDigest');
}

function attest(
  role: LiveAuthorityAttestation['role'], authorityId: string, subjectDigest: string,
  privateKey: typeof ownerKeys.privateKey,
): LiveAuthorityAttestation {
  const unsigned = { schema: 'sinter.wave8-live-authority-attestation' as const, schemaVersion: 1 as const,
    authorityId, role, subjectDigest, issuedAt: NOW, expiresAt: EXPIRES, nonce: `${role}-nonce` };
  return { ...unsigned, signatureBase64: sign(null,
    Buffer.from(liveAuthorityAttestationPayload(unsigned)), privateKey).toString('base64') };
}

function fixture(): LiveProtocolInput {
  const frozen = {
    schema: 'sinter.wave8-live-protocol' as const, schemaVersion: 1 as const, frozenAt: NOW,
    exactHead: HEAD, planDigest: d('1'), schemaDigest: d('2'), implementationDigest: d('3'), sourceDigest: d('4'),
    roles: [{ ...sol }, { ...terra }, { ...generator }],
    briefs: [{ id: 'unseen-brief', briefDigest: d('5'), unseen: true as const }],
    budgets: {
      rows: [
        { role: 'harness', maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxRetries: 0 },
        { role: 'product-reviewer', maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxRetries: 0 },
        { role: 'generator', maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 100, maxRetries: 1 },
      ],
      maxActiveMinutes: 20, maxTotalCalls: 10, maxTotalInputTokens: 1_000,
      maxTotalOutputTokens: 1_000, maxRetriesPerStage: 1, approvedUsdCeiling: 10,
    },
    artifacts: { contactSheetDigest: d('f'), playableArtifactDigests: [d('0')] },
    evidenceRequirements: {
      noSpendClass: 'deterministic-proof' as const, liveClass: 'live-provider' as const,
      criticalSolApproval: true as const, productReviewBeforeMergeOrRelease: true as const,
    },
  };
  const ownerApproval = signed({ schema: 'sinter.owner-usd-ceiling-approval' as const,
    ownerId: 'owner-from-authority-boundary', approvedUsdCeiling: 10, planDigest: d('1'), approvedAt: NOW }, 'approvalDigest');
  const priceReceipt = signed({ schema: 'sinter.current-price-receipt' as const, schemaVersion: 1 as const,
    generatedAt: NOW, prices: [sol, terra, generator].map(role => ({ provider: role.provider, model: role.model,
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, sourceUrl: 'https://pricing.example/current', verifiedAt: NOW })) }, 'receiptDigest');
  const bound = { evidenceClass: 'execution' as const, passed: true, exactHead: HEAD, planDigest: d('1'), schemaDigest: d('2'),
    implementationDigest: d('3'), sourceDigest: d('4'), artifactDigests: [d('f')] };
  const conjuncts = Object.fromEntries(['merged-main', 'forgejo-ci', 'compound-artifacts', 'leak-audit', 'semantic-audit', 'shared-terminal-truth']
    .map((id, index) => [id, { ...bound, id, detailDigest: d('6abcde'[index]!) }])) as Record<string, LiveConjunctEvidence>;
  const ownerCheckpoints = [checkpoint('preference', 'winner'), checkpoint('release-worthiness', 'release-worthy'), checkpoint('learning-authorization', 'allow'),
    checkpoint('promotion', 'promote'), checkpoint('merge', 'merge'), checkpoint('final-release', 'release')];
  const solApprovalBody = { ...bound, evidenceClass: 'live-provider' as const, critical: true as const,
    executor: { ...sol } };
  const solApproval = { ...solApprovalBody, approvalDigest: digestLiveProtocol(solApprovalBody) };
  const productReviewBody = { ...bound, evidenceClass: 'live-provider' as const, reviewer: { ...terra },
    authorIndependent: false };
  const productReview = { ...productReviewBody, reviewDigest: digestLiveProtocol(productReviewBody) };
  return {
    frozen, ownerApproval, priceReceipt,
    noSpendEvidence: { ...bound, evidenceClass: 'deterministic-proof', providerLedgerCallIds: [] },
    solApproval, productReview, ownerCheckpoints,
    conjuncts,
    attestations: [
      attest('owner', 'owner-authority', digestLiveProtocol({ ownerApproval, ownerCheckpoints }), ownerKeys.privateKey),
      attest('price', 'price-authority', priceReceipt.receiptDigest, priceKeys.privateKey),
      attest('sol-approval', 'sol-authority', solApproval.approvalDigest, solKeys.privateKey),
      attest('product-review', 'review-authority', productReview.reviewDigest, reviewKeys.privateKey),
    ],
  };
}

function resignOwner(input: LiveProtocolInput): void {
  const subject = digestLiveProtocol({ ownerApproval: input.ownerApproval, ownerCheckpoints: input.ownerCheckpoints });
  (input as { attestations?: readonly LiveAuthorityAttestation[] }).attestations = [
    attest('owner', 'owner-authority', subject, ownerKeys.privateKey),
    ...input.attestations!.filter(item => item.role !== 'owner'),
  ];
}

function subscriptionFixture(): LiveProtocolInput {
  const input = fixture();
  const seatIds = ['seat-sol', 'seat-review', 'seat-generator'];
  const roles = input.frozen.roles.map((role, index) => ({ ...role, seatId: seatIds[index]! }));
  const budgets = { ...input.frozen.budgets, fundingMode: 'subscription-seat' as const,
    approvedSeatIds: seatIds };
  delete (budgets as { approvedUsdCeiling?: number }).approvedUsdCeiling;
  (input as { frozen: LiveProtocolInput['frozen'] }).frozen = { ...input.frozen, roles, budgets };
  const approvalBody = { schema: 'sinter.owner-subscription-seat-approval' as const,
    ownerId: 'owner-from-authority-boundary', fundingMode: 'subscription-seat' as const,
    approvedSeatIds: seatIds, resourceBudgetDigest: digestLiveProtocol(budgets),
    planDigest: d('1'), approvedAt: NOW };
  (input as { ownerApproval?: LiveProtocolInput['ownerApproval'] }).ownerApproval = {
    ...approvalBody, approvalDigest: digestLiveProtocol(approvalBody),
  };
  delete (input as { priceReceipt?: unknown }).priceReceipt;
  (input.solApproval!.executor as { seatId?: string }).seatId = seatIds[0];
  (input.productReview!.reviewer as { seatId?: string }).seatId = seatIds[1];
  const solBody = { ...input.solApproval! };
  delete (solBody as { approvalDigest?: string }).approvalDigest;
  (input.solApproval as { approvalDigest: string }).approvalDigest = digestLiveProtocol(solBody);
  const reviewBody = { ...input.productReview! };
  delete (reviewBody as { reviewDigest?: string }).reviewDigest;
  (input.productReview as { reviewDigest: string }).reviewDigest = digestLiveProtocol(reviewBody);
  (input as { attestations?: readonly LiveAuthorityAttestation[] }).attestations = input.attestations!
    .filter(item => !['price', 'sol-approval', 'product-review'].includes(item.role));
  (input as { attestations?: readonly LiveAuthorityAttestation[] }).attestations = [
    ...input.attestations!,
    attest('sol-approval', 'sol-authority', input.solApproval!.approvalDigest, solKeys.privateKey),
    attest('product-review', 'review-authority', input.productReview!.reviewDigest, reviewKeys.privateKey),
  ];
  resignOwner(input);
  return input;
}

describe('LiveProtocol', () => {
  it('accepts a complete fixture only when all live gates and conjuncts are present', () => {
    const receipt = buildLiveProtocol(fixture());
    const report = validateLiveProtocol(receipt, {
      now: NOW, exactHead: HEAD, planDigest: d('1'), schemaDigest: d('2'), implementationDigest: d('3'), sourceDigest: d('4'),
      trust,
    });
    expect(report.paidExecutionAllowed).toBe(true);
    expect(report.mergeAllowed).toBe(true);
    expect(report.finalReleaseAllowed).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(() => assertLiveProtocolAllowsPaidExecution(receipt, { now: NOW, trust })).not.toThrow();
  });

  it('authorizes planned outputs before generation but blocks merge until they materialize', () => {
    const input = fixture();
    const materializedArtifacts = input.frozen.artifacts;
    (input as { frozen: LiveProtocolInput['frozen'] }).frozen = {
      ...input.frozen,
      artifacts: {
        mode: 'planned',
        evidenceScheduleDigest: d('e'),
        expectedPlayableArtifactCount: 1,
      },
    };

    const planned = validateLiveProtocol(buildLiveProtocol(input), { now: NOW, trust });
    expect(planned.paidExecutionAllowed).toBe(true);
    expect(planned.mergeAllowed).toBe(false);
    expect(planned.finalReleaseAllowed).toBe(false);
    expect(planned.blockers).toContain('artifacts: generated contact sheet and playables are missing');

    (input as { materializedArtifacts?: typeof materializedArtifacts }).materializedArtifacts = materializedArtifacts;
    const complete = validateLiveProtocol(buildLiveProtocol(input), { now: NOW, trust });
    expect(complete.paidExecutionAllowed).toBe(true);
    expect(complete.mergeAllowed).toBe(true);
    expect(complete.finalReleaseAllowed).toBe(true);
  });

  it('rejects a materialized playable count that differs from the frozen plan', () => {
    const input = fixture();
    (input as { frozen: LiveProtocolInput['frozen'] }).frozen = {
      ...input.frozen,
      artifacts: {
        mode: 'planned',
        evidenceScheduleDigest: d('e'),
        expectedPlayableArtifactCount: 2,
      },
    };
    (input as { materializedArtifacts?: LiveProtocolReceipt['materializedArtifacts'] }).materializedArtifacts = {
      contactSheetDigest: d('f'),
      playableArtifactDigests: [d('0')],
    };

    const report = validateLiveProtocol(buildLiveProtocol(input), { now: NOW, trust });
    expect(report.paidExecutionAllowed).toBe(true);
    expect(report.mergeAllowed).toBe(false);
    expect(report.blockers).toContain('artifacts: materialized playable count does not match the frozen commitment');
  });

  it('rejects shadow materialized artifacts on a legacy exact-artifact freeze', () => {
    const input = fixture();
    (input as { materializedArtifacts?: LiveProtocolReceipt['materializedArtifacts'] }).materializedArtifacts = {
      contactSheetDigest: d('f'),
      playableArtifactDigests: [d('0')],
    };

    const report = validateLiveProtocol(buildLiveProtocol(input), { now: NOW, trust });
    expect(report.mergeAllowed).toBe(false);
    expect(report.blockers).toContain('artifacts: post-generation artifacts require a planned freeze commitment');
  });

  it('accepts signed subscription-seat funding without USD pricing and rejects mixed or unknown seats', () => {
    const input = subscriptionFixture();
    expect(validateLiveProtocol(buildLiveProtocol(input), { now: NOW, trust }).paidExecutionAllowed).toBe(true);

    const unknownSeat = subscriptionFixture();
    (unknownSeat.solApproval!.executor as { seatId: string }).seatId = 'seat-unapproved';
    expect(validateLiveProtocol(buildLiveProtocol(unknownSeat), { now: NOW, trust }).paidExecutionAllowed).toBe(false);

    const mixed = subscriptionFixture();
    (mixed as { priceReceipt?: LiveProtocolInput['priceReceipt'] }).priceReceipt = fixture().priceReceipt;
    expect(validateLiveProtocol(buildLiveProtocol(mixed), { now: NOW, trust }).paidExecutionAllowed).toBe(false);

    const forged = subscriptionFixture();
    (forged.ownerApproval as { approvedSeatIds: string[] }).approvedSeatIds = ['seat-forged'];
    expect(validateLiveProtocol(buildLiveProtocol(forged), { now: NOW, trust }).paidExecutionAllowed).toBe(false);
  });

  it.each([
    ['missing owner ceiling', (input: LiveProtocolInput) => { delete (input as { ownerApproval?: unknown }).ownerApproval; }],
    ['missing price receipt', (input: LiveProtocolInput) => { delete (input as { priceReceipt?: unknown }).priceReceipt; }],
    ['deterministic Sol approval', (input: LiveProtocolInput) => { (input.solApproval as { evidenceClass: string }).evidenceClass = 'deterministic-proof'; }],
    ['unverified Sol identity', (input: LiveProtocolInput) => { (input.solApproval!.executor as { identityVerified: boolean }).identityVerified = false; }],
    ['stale source', (input: LiveProtocolInput) => { (input.solApproval as { sourceDigest: string }).sourceDigest = d('9'); }],
    ['stale price', (input: LiveProtocolInput) => { (input.priceReceipt as { generatedAt: string }).generatedAt = '2026-07-30T12:00:00.000Z'; }],
  ])('blocks paid execution on %s', (_label, mutate) => {
    const input = fixture();
    mutate(input);
    const receipt = buildLiveProtocol(input);
    expect(validateLiveProtocol(receipt, { now: NOW }).paidExecutionAllowed).toBe(false);
    expect(() => assertLiveProtocolAllowsPaidExecution(receipt, { now: NOW })).toThrow('Live protocol blocked paid execution');
  });

  it('keeps owner decisions independent and requires exact ordered artifacts', () => {
    const input = fixture();
    (input as { ownerCheckpoints?: readonly LiveCheckpoint[] }).ownerCheckpoints = input.ownerCheckpoints!.slice(0, 5);
    resignOwner(input);
    const receipt = buildLiveProtocol(input);
    const report = validateLiveProtocol(receipt, { now: NOW, trust });
    expect(report.paidExecutionAllowed).toBe(true);
    expect(report.mergeAllowed).toBe(true);
    expect(report.finalReleaseAllowed).toBe(false);
    expect(report.blockers.some(blocker => blocker.includes('final-release'))).toBe(true);

    const denied = fixture();
    denied.ownerCheckpoints![4] = checkpoint('merge', 'do-not-merge');
    resignOwner(denied);
    expect(validateLiveProtocol(buildLiveProtocol(denied), { now: NOW, trust }).mergeAllowed).toBe(false);

    const altered = fixture();
    (altered.ownerCheckpoints![0]!.playableArtifactDigests as string[]).push(d('9'));
    resignOwner(altered);
    const alteredReport = validateLiveProtocol(buildLiveProtocol(altered), { now: NOW, trust });
    expect(alteredReport.mergeAllowed).toBe(false);
    expect(alteredReport.finalReleaseAllowed).toBe(false);
  });

  it('keeps merged-main, Forgejo CI, compound, leak, semantic, and terminal truth separate', () => {
    const input = fixture();
    delete input.conjuncts!['forgejo-ci'];
    const report = validateLiveProtocol(buildLiveProtocol(input), { now: NOW });
    expect(report.conjuncts.find(conjunct => conjunct.id === 'forgejo-ci')?.passed).toBe(false);
    expect(report.conjuncts.filter(conjunct => conjunct.id !== 'forgejo-ci').every(conjunct => conjunct.passed)).toBe(true);
    expect(report.finalReleaseAllowed).toBe(false);
  });

  it('invalidates exact-head, schema, implementation, and model/provider drift', () => {
    const cases: Array<[string, (input: LiveProtocolInput) => void]> = [
      ['head', input => { (input as { frozen: LiveProtocolInput['frozen'] }).frozen = { ...input.frozen, exactHead: 'b'.repeat(40) }; }],
      ['schema digest', input => { (input as { frozen: LiveProtocolInput['frozen'] }).frozen = { ...input.frozen, schemaDigest: d('9') }; }],
      ['implementation digest', input => { (input as { frozen: LiveProtocolInput['frozen'] }).frozen = { ...input.frozen, implementationDigest: d('9') }; }],
      ['model/provider', input => { (input.solApproval!.executor as { model: string }).model = 'invented-model'; }],
    ];
    for (const [label, mutate] of cases) {
      const input = fixture(); mutate(input);
      const report = validateLiveProtocol(buildLiveProtocol(input), { now: NOW, exactHead: HEAD, planDigest: d('1'), schemaDigest: d('2'), implementationDigest: d('3'), sourceDigest: d('4') });
      expect(report.paidExecutionAllowed, label).toBe(false);
    }
  });

  it('rejects forged live evidence and the wrong owner authority', () => {
    const forged = fixture();
    const solAttestation = forged.attestations!.find(item => item.role === 'sol-approval')!;
    (forged as { attestations?: readonly LiveAuthorityAttestation[] }).attestations = [
      ...forged.attestations!.filter(item => item.role !== 'sol-approval'),
      { ...solAttestation, signatureBase64: Buffer.from('forged').toString('base64') },
    ];
    expect(validateLiveProtocol(buildLiveProtocol(forged), { now: NOW, trust }).paidExecutionAllowed).toBe(false);

    const otherOwner = generateKeyPairSync('ed25519');
    const wrongTrust = { ...trust, owner: { ...trust.owner,
      publicKeyPem: otherOwner.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
    expect(validateLiveProtocol(buildLiveProtocol(fixture()), { now: NOW, trust: wrongTrust }).paidExecutionAllowed).toBe(false);
  });

  it('strictly parses receipts and rejects unknown or tampered fields', () => {
    const receipt = structuredClone(buildLiveProtocol(fixture())) as LiveProtocolReceipt & { invented?: boolean };
    receipt.invented = true;
    expect(() => parseLiveProtocolReceipt(receipt)).toThrow('LIVE_PROTOCOL_RECEIPT_INVALID');
    delete receipt.invented;
    (receipt.solApproval as { passed: boolean }).passed = false;
    expect(() => parseLiveProtocolReceipt(receipt)).not.toThrow();
    expect(validateLiveProtocol(receipt, { now: NOW, trust }).paidExecutionAllowed).toBe(false);
  });
});
