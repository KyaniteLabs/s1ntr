import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ok, type Result } from 'neverthrow';
import {
  configurePreSpendInterlock,
  configureWave8LivePreSpendInterlockForTests as configureWave8LivePreSpendInterlock,
  createPreSpendFeasibilityProof,
  digestProviderRequest,
  getPreSpendCallLedger,
  resetPreSpendInterlockForTests,
  runWithPreSpendCallContext,
  ensureWave8LivePreSpendInterlockConfigured,
  assertWave8GovernedCampaignPreflight,
  assertWave8GovernedCampaignArtifacts,
  wave8GovernedCampaignStageIds,
  authorizeCanonicalStudioInvocation,
  completeCanonicalStudioInvocation,
  invokeCanonicalStudioProvider,
  validateSubscriptionCredentialBindings,
  type PreSpendInterlockPolicy,
  SubscriptionHostAdapterRegistry,
} from '../../../src/llm/PreSpendInterlock.js';
import { createWave8EvidenceReceipt, createWave8ReleaseRoot,
  parseWave8ReleaseRoot } from '../../../src/runtime-core/Wave8ReleaseRoot.js';
import { BaseProvider } from '../../../src/llm/providers/BaseProvider.js';
import type {
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
} from '../../../src/llm/ProviderTypes.js';
import type { LLMError } from '../../../src/llm/errors.js';
import { EmbeddingService } from '../../../src/embeddings/EmbeddingService.js';
import { CanonicalStudioLivingLoopProviderBoundary,
  type StudioLivingLoopLiveTransport } from '../../../src/cortex/StudioLivingLoopExecutor.js';
import { createWave8LiveProtocolFixture } from '../../fixtures/wave8LiveProtocol.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const baseRequest: ProviderRequest = {
  systemPrompt: 'Review only the frozen Wave 7 plan.',
  userPrompt: 'Return APPROVE or required amendments.',
  thinking: { enabled: true, effort: 'high' },
  maxTokens: 2_000,
};

class BoundaryProvider extends BaseProvider {
  readonly name = 'openai';
  calls = 0;
  mutateConfigDuringCall = false;
  configMutationSucceeded: boolean | undefined;
  usage = { inputTokens: 10, outputTokens: 2 };
  get capabilities(): ProviderCapabilities {
    return {
      thinking: true, streaming: true, jsonMode: true, toolUse: true,
      maxContextTokens: 128_000, thinkingStyle: 'effort_level', streamingStyle: 'sse',
    };
  }
  protected async generateImpl(): Promise<Result<ProviderResponse, LLMError>> {
    this.calls += 1;
    if (this.mutateConfigDuringCall) {
      this.configMutationSucceeded = Reflect.set(this, 'config', Object.freeze({
        baseUrl: 'https://attacker.invalid/v1', model: 'substituted', apiKey: 'wrong-secret',
      }));
    }
    return ok({ content: 'APPROVE', model: this.config.model, success: true, usage: this.usage });
  }
  protected async *streamImpl(): AsyncGenerator<StreamEvent> {
    this.calls += 1;
    yield { type: 'content', content: 'APPROVE' };
  }
}

function proof(gate: 'noSpendCirculationProof' | 'solHighPreSpendApproval') {
  const shared = {
    gate,
    passed: true,
    planHash: HASH_A,
    sourceFingerprint: HASH_B,
    artifactDigest: HASH_C,
  };
  if (gate === 'noSpendCirculationProof') {
    return { ...shared, gate, evidenceClass: 'deterministic-proof' as const };
  }
  return {
    ...shared,
    gate,
    evidenceClass: 'live-provider' as const,
    executor: { model: 'kimi-k3', effort: 'high' as const, identityVerified: true },
  };
}

function policy(overrides: Partial<PreSpendInterlockPolicy> = {}): PreSpendInterlockPolicy {
  const slots = [
    {
      id: 'sol-approval', purpose: 'sol-review-bootstrap' as const,
      // BoundaryProvider test double reports provider name "openai"; model is the identity gate.
      provider: 'openai', model: 'kimi-k3', role: 'harness' as const,
      minCalls: 1, maxCalls: 1, maxInputTokens: 4_000, maxOutputTokens: 2_000,
      minActiveMinutes: 2, requestDigest: digestProviderRequest(baseRequest),
    },
    {
      id: 'create-1', purpose: 'product' as const,
      provider: 'openai', model: 'gpt-5.6-sol', role: 'generator' as const,
      minCalls: 1, maxCalls: 2, maxInputTokens: 8_000, maxOutputTokens: 8_000,
      minActiveMinutes: 3,
    },
  ];
  const feasibilityProof = createPreSpendFeasibilityProof({
    planHash: HASH_A, sourceFingerprint: HASH_B, priceReceiptDigest: HASH_D,
    declaredSlots: slots,
    budgetRows: slots.map(slot => ({
      slotId: slot.id, maxCalls: slot.maxCalls,
      maxInputTokens: slot.maxInputTokens, maxOutputTokens: slot.maxOutputTokens,
      minActiveMinutes: slot.minActiveMinutes, inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    })),
    approvedUsdCeiling: 10,
  });
  return {
    expectedPlanHash: HASH_A, expectedSourceFingerprint: HASH_B,
    declaredSlots: slots, noSpendProof: proof('noSpendCirculationProof'),
    solApproval: proof('solHighPreSpendApproval'), feasibilityProof, ...overrides,
  };
}

function liveExecutionFixture(): { configPath: string; trustStorePath: string; planPath: string;
  releaseRootPath: string; authorizationLedgerPath: string; cleanup(): void } {
  return createWave8LiveProtocolFixture();
}

afterEach(() => {
  resetPreSpendInterlockForTests();
  vi.restoreAllMocks();
});

describe('PreSpendInterlock final provider boundary', () => {
  it('keeps the provider transport immutable from reservation through the actual call', async () => {
    configurePreSpendInterlock(policy());
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const transport = provider.reserveTransport();
    provider.mutateConfigDuringCall = true;
    expect(() => provider.setModel('substituted')).toThrow('reserved or in-flight');
    await expect(provider.generate({ ...baseRequest,
      preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'cli' },
    }, transport)).resolves.toMatchObject({ value: { success: true, model: 'gpt-5.6-sol' } });
    expect(provider.configMutationSucceeded).toBe(false);
    expect(() => provider.setModel('substituted')).not.toThrow();
  });

  it('lets only the host registry select the adapter behind an opaque binding ID', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const registry = new SubscriptionHostAdapterRegistry(new Map([['binding-approved', { invoke }]]));
    await expect(registry.invoke('binding-approved', { prompt: 'sealed' })).resolves.toEqual({ ok: true });
    expect(() => registry.invoke('binding-substituted', { prompt: 'sealed' })).toThrow('unavailable');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('never treats an explicit governed-call context as permission when no policy is active', async () => {
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    await expect(provider.generate({
      ...baseRequest,
      preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'studio' },
    })).rejects.toThrow('no active policy');
    expect(provider.calls).toBe(0);
  });

  it('refuses overlapping governed runs instead of replacing their authority', () => {
    configurePreSpendInterlock(policy());
    expect(() => configurePreSpendInterlock(policy())).toThrow('already has an active governed run');
  });

  it('blocks every caller class before a direct adapter can reach transport', async () => {
    configurePreSpendInterlock(policy({ solApproval: undefined }));
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const callerClasses = [
      'studio', 'cli', 'script', 'retry', 'creative', 'domain-smoke',
      'assimilate', 'dream', 'autoresearch', 'independent-review',
      'product-review', 'recovery',
    ] as const;

    for (const callerClass of callerClasses) {
      await expect(provider.generate({
        ...baseRequest,
        preSpend: { slotId: 'create-1', purpose: 'product', callerClass },
      })).rejects.toThrow('solHighPreSpendApproval');
    }
    expect(provider.calls).toBe(0);
  });

  it('can require the frozen live protocol before any paid provider call', async () => {
    configurePreSpendInterlock(policy({ requireLiveProtocol: true }));
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    await expect(provider.generate({
      ...baseRequest,
      preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'studio' },
    })).rejects.toThrow('live protocol is missing');
    expect(provider.calls).toBe(0);
  });

  it('fails closed when the production Wave 8 config is absent', () => {
    const previous = process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
    delete process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
    try { expect(() => ensureWave8LivePreSpendInterlockConfigured()).toThrow('is required'); }
    finally {
      if (previous === undefined) delete process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
      else process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG = previous;
    }
  });

  it('loads authenticated production state and rejects a replayed authorization', async () => {
    const fixture = liveExecutionFixture();
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    try {
      const dispose = configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      await expect(provider.generate({ ...baseRequest,
        preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'studio' } }))
        .resolves.toMatchObject({ value: { content: 'APPROVE', success: true } });
      const durable = JSON.parse(readFileSync(fixture.authorizationLedgerPath, 'utf8')) as {
        runStartedAt?: string; runDeadline?: string;
      };
      expect(Date.parse(durable.runDeadline!)).toBeGreaterThan(Date.parse(durable.runStartedAt!));
      dispose();
      resetPreSpendInterlockForTests();
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      await expect(provider.generate({ ...baseRequest,
        preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'studio' } })).rejects.toThrow('replay');
    } finally { fixture.cleanup(); }
  });

  it('does not burn a durable authorization when bootstrap validation rejects the request', async () => {
    const fixture = createWave8LiveProtocolFixture({
      bootstrapRequestDigest: digestProviderRequest(baseRequest),
    });
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'kimi-k3' });
    const authorization = {
      slotId: 'sol-approval', purpose: 'sol-review-bootstrap' as const,
      callerClass: 'independent-review' as const,
    };
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      await expect(provider.generate({ ...baseRequest, userPrompt: 'drifted', preSpend: authorization }))
        .rejects.toThrow('request digest');
      await expect(provider.generate({ ...baseRequest, preSpend: authorization }))
        .resolves.toMatchObject({ value: { content: 'APPROVE', success: true } });
      expect(provider.calls).toBe(1);
    } finally { fixture.cleanup(); }
  });

  it('requires host-issued campaign authority for adapter-free subscription CLI slots', async () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat',
      includeCanonicalStudioSlot: false });
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      expect(assertWave8GovernedCampaignPreflight()).toMatchObject({ releaseHead: expect.any(String) });
      await expect(provider.generate({ ...baseRequest,
        preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'cli' } }))
        .rejects.toThrow('exact host-issued campaign binding');
      expect(provider.calls).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it('rejects substituted governed campaign inputs before provider execution', () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat',
      includeCanonicalStudioSlot: false });
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      expect(() => assertWave8GovernedCampaignArtifacts({
        manifestPath: fixture.campaignArtifacts.manifest,
        executionPath: fixture.campaignArtifacts.execution,
        ownerReviewPackagePath: fixture.campaignArtifacts.ownerReviewPackage,
      })).not.toThrow();
      writeFileSync(fixture.campaignArtifacts.execution, '{"substituted":true}');
      expect(() => assertWave8GovernedCampaignArtifacts({
        manifestPath: fixture.campaignArtifacts.manifest,
        executionPath: fixture.campaignArtifacts.execution,
        ownerReviewPackagePath: fixture.campaignArtifacts.ownerReviewPackage,
      })).toThrow('does not match reviewed authority');
    } finally { fixture.cleanup(); }
  });

  it('rejects campaign bindings substituted in the mutable execution config', () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat',
      includeCanonicalStudioSlot: false });
    try {
      const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
        campaignArtifacts: { execution: { path: string; digest: string } };
      };
      config.campaignArtifacts.execution = { path: fixture.planPath, digest: HASH_A };
      writeFileSync(fixture.configPath, JSON.stringify(config));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('campaignArtifacts.execution digest mismatch');
    } finally { fixture.cleanup(); }
  });

  it('rejects a same-budget recovery stage ID swapped after signing', () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat',
      includeCanonicalStudioSlot: false });
    try {
      const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
        credentialBindingRefs: Record<string, string>;
        preSpendPolicy: { declaredSlots: Array<{ id: string }>;
          feasibilityProof: { budgetRows: Array<{ slotId: string }> } } };
      const slot = config.preSpendPolicy.declaredSlots.find(item => item.id === 'create-1')!;
      slot.id = 'recover-swapped';
      config.preSpendPolicy.feasibilityProof.budgetRows
        .find(row => row.slotId === 'create-1')!.slotId = 'recover-swapped';
      config.credentialBindingRefs['recover-swapped'] = config.credentialBindingRefs['create-1']!;
      delete config.credentialBindingRefs['create-1'];
      writeFileSync(fixture.configPath, JSON.stringify(config));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('executable product stages do not match signed authority');
    } finally { fixture.cleanup(); }
  });

  it('rejects omission of a required generation or review stage', () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat',
      includeCanonicalStudioSlot: false });
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      const stages = [
        { id: 'create-1', kind: 'generation' },
        { id: 'generate-required-but-omitted', kind: 'generation' },
        { id: 'product-review', kind: 'review' },
        { id: 'recover-optional', kind: 'recovery' },
      ];
      expect(() => wave8GovernedCampaignStageIds({ stages } as never))
        .toThrow('phase-one stage allowlist is incomplete');
    } finally { fixture.cleanup(); }
  });

  it('rejects subscription slots whose transport authority is omitted', () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat' });
    try {
      const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
        preSpendPolicy: { declaredSlots: Array<{ subscriptionTransport?: string }> };
      };
      delete config.preSpendPolicy.declaredSlots[0]!.subscriptionTransport;
      writeFileSync(fixture.configPath, JSON.stringify(config));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('transport authority is missing or invalid');
    } finally { fixture.cleanup(); }
  });

  it('requires exact adapters and blocks direct transport for adapter-bound subscription slots', async () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat' });
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    try {
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('subscription host adapter registry is incomplete');
      const registry = new SubscriptionHostAdapterRegistry(new Map([
        ['binding-create-1', { invoke: async () => ({ content: 'host-owned' }) }],
      ]));
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath, registry);
      expect(assertWave8GovernedCampaignPreflight()).toMatchObject({ releaseHead: expect.any(String) });
      await expect(provider.generate({ ...baseRequest,
        preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'cli' } }))
        .rejects.toThrow('cannot use direct provider transport');
      expect(provider.calls).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it('reserves a canonical subscription capability before adapter dispatch', async () => {
    const fixture = createWave8LiveProtocolFixture({ fundingMode: 'subscription-seat' });
    let release!: (value: unknown) => void;
    const response = { provider: 'openai', model: 'gpt-5.6-sol',
      usage: { tokens: 2, inputTokens: 1, outputTokens: 1 } };
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const invoke = vi.fn(() => pending);
    const registry = new SubscriptionHostAdapterRegistry(new Map([
      ['binding-create-1', { invoke }],
    ]));
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath, registry);
      const capability = authorizeCanonicalStudioInvocation('create-evidence');
      const first = invokeCanonicalStudioProvider(capability, { prompt: 'first' }, async () => response);
      await expect(invokeCanonicalStudioProvider(capability, { prompt: 'duplicate' }, async () => response))
        .rejects.toThrow('in-flight');
      release(response);
      await expect(first).resolves.toEqual(response);
      completeCanonicalStudioInvocation(capability, response, 'success');
      expect(invoke).toHaveBeenCalledOnce();
    } finally { fixture.cleanup(); }
  });

  it.each([['diagnostic', 'diagnostic'], ['legacy generic', undefined]] as const)(
    'blocks %s evidence at the live pre-spend root boundary', (_label, purpose) => {
    const fixture = liveExecutionFixture();
    try {
      const root = parseWave8ReleaseRoot(JSON.parse(readFileSync(fixture.releaseRootPath, 'utf8')) as unknown);
      const diagnostic = createWave8EvidenceReceipt({ receiptId: 'diagnostic-product', kind: 'product',
        generatedAt: new Date().toISOString(), sourceFingerprint: root.sourceFingerprint,
        purpose, evidenceClass: 'execution', passed: true, deterministic: false,
        spendUsd: 0, providerCalls: 0, artifactDigests: [HASH_A],
        schemaDigest: root.activeDigests.schema, implementationDigest: root.activeDigests.implementation,
        payload: { productDelta: {}, inheritedFrom: 'prior', priorReceiptId: 'prior', userVisible: true } });
      const { schema: _schema, schemaVersion: _version, wave: _wave,
        releaseRootDigest: _digest, ...input } = root;
      writeFileSync(fixture.releaseRootPath, JSON.stringify(createWave8ReleaseRoot({
        ...input, receipts: [...root.receipts, diagnostic],
      })));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('product-evidence-purpose-invalid');
    } finally { fixture.cleanup(); }
  });

  it.each(['schemaDigest', 'implementationDigest'] as const)(
    'blocks bootstrap %s drift at the live pre-spend root boundary', (field) => {
    const fixture = liveExecutionFixture();
    try {
      const root = parseWave8ReleaseRoot(JSON.parse(readFileSync(fixture.releaseRootPath, 'utf8')) as unknown);
      const current = root.receipts[0]!;
      const { schema: _schema, schemaVersion: _version, resultDigest: _digest, ...input } = current;
      const drifted = createWave8EvidenceReceipt({ ...input, [field]: 'f'.repeat(64) });
      const { schema: _rootSchema, schemaVersion: _rootVersion, wave: _wave,
        releaseRootDigest: _rootDigest, ...rootInput } = root;
      writeFileSync(fixture.releaseRootPath, JSON.stringify(createWave8ReleaseRoot({
        ...rootInput, receipts: [drifted],
      })));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow(field === 'schemaDigest' ? 'schema-digest-drift' : 'implementation-digest-drift');
    } finally { fixture.cleanup(); }
  });

  it('derives retry attempts from the governed ordinal, not callerClass claims', async () => {
    const fixture = liveExecutionFixture();
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      const request = { ...baseRequest,
        preSpend: { slotId: 'create-1', purpose: 'product' as const, callerClass: 'studio' as const } };
      await provider.generate(request);
      await expect(provider.generate(request)).rejects.toThrow('frozen resource budget');
      expect(provider.calls).toBe(1);
    } finally { fixture.cleanup(); }
  });

  it('derives current bindings from disk instead of trusting caller-supplied context', async () => {
    const fixture = liveExecutionFixture();
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      writeFileSync(fixture.planPath, 'changed after configuration\n');
      const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
      await expect(provider.generate({ ...baseRequest,
        preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'studio' } })).rejects.toThrow('planDigest is stale');
      expect(provider.calls).toBe(0);
    } finally { fixture.cleanup(); }
  });

  it('does not let the execution config substitute signing keys', () => {
    const fixture = liveExecutionFixture();
    try {
      const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as Record<string, unknown>;
      const original = structuredClone(config);
      config.trust = { owner: { publicKeyPem: 'attacker-selected' } };
      writeFileSync(fixture.configPath, JSON.stringify(config));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('live config is invalid');
      delete config.trust;
      ((config.trustRefs as { ownerKeyId: string }).ownerKeyId) = 'attacker-key';
      writeFileSync(fixture.configPath, JSON.stringify(config));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('pinned owner key is unavailable');
      writeFileSync(fixture.configPath, JSON.stringify(original));
      chmodSync(fixture.trustStorePath, 0o644);
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('owner-only');
    } finally { fixture.cleanup(); }
  });

  it('rejects an external trust store hard-linked back into the repository', () => {
    const fixture = liveExecutionFixture();
    try {
      try {
        linkSync(fixture.trustStorePath,
          path.join(path.dirname(fixture.configPath), 'trust-hardlink.json'));
      } catch (error) {
        // Split-mount CI makes this attack physically unrepresentable.
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') return;
        throw error;
      }
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('owner-only');
    } finally { fixture.cleanup(); }
  });

  it('rejects hard-linked and symlinked live runtime artifacts', () => {
    const fixture = liveExecutionFixture();
    const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
      receiptPath: string; planPath: string };
    try {
      linkSync(config.receiptPath, path.join(path.dirname(config.receiptPath), 'receipt-alias.json'));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('non-aliased repository file');
    } finally { fixture.cleanup(); }
    const symlinkFixture = liveExecutionFixture();
    try {
      const next = JSON.parse(readFileSync(symlinkFixture.configPath, 'utf8')) as { planPath: string };
      const external = path.join(path.dirname(symlinkFixture.trustStorePath), 'outside-plan.md');
      writeFileSync(external, 'outside\n');
      const alias = path.join(path.dirname(next.planPath), 'plan-alias.md');
      symlinkSync(external, alias);
      next.planPath = alias;
      writeFileSync(symlinkFixture.configPath, JSON.stringify(next));
      expect(() => configureWave8LivePreSpendInterlock(
        symlinkFixture.configPath, symlinkFixture.trustStorePath)).toThrow('non-aliased repository file');
    } finally { symlinkFixture.cleanup(); }
  });

  it('rejects executable policy caps that exceed the owner-signed freeze before transport', () => {
    const fixture = liveExecutionFixture();
    try {
      const config = JSON.parse(readFileSync(fixture.configPath, 'utf8')) as {
        preSpendPolicy: { declaredSlots: Array<{ role: string; maxCalls: number }> };
      };
      config.preSpendPolicy.declaredSlots.find(slot => slot.role === 'generator')!.maxCalls += 1;
      writeFileSync(fixture.configPath, JSON.stringify(config));
      expect(() => configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath))
        .toThrow('exactly match frozen budget');
    } finally { fixture.cleanup(); }
  });

  it('authorizes inside the canonical Studio boundary before transport and blocks unmapped bypasses', async () => {
    const fixture = liveExecutionFixture();
    let calls = 0;
    const transport: StudioLivingLoopLiveTransport = { invoke: async (_request, capability) => {
      expect(capability).toBeTypeOf('object');
      calls += 1;
      return { content: 'live result', provider: 'openai', model: 'gpt-5.6-sol', artifactRefs: ['artifact'],
        usage: { tokens: 1, costUsd: 0.01, wallClockMs: 1 } };
    } };
    try {
      configureWave8LivePreSpendInterlock(fixture.configPath, fixture.trustStorePath);
      const boundary = new CanonicalStudioLivingLoopProviderBoundary('live', transport);
      await expect(boundary.invoke({ cycleId: 'cycle', lineageId: 'lineage', sourceFingerprint: HASH_A,
        step: 'create-evidence', idempotencyKey: HASH_B })).resolves.toMatchObject({ content: 'live result' });
      await expect(boundary.invoke({ cycleId: 'cycle', lineageId: 'lineage', sourceFingerprint: HASH_A,
        step: 'consolidate', idempotencyKey: HASH_C })).rejects.toThrow('not uniquely declared');
      expect(calls).toBe(1);
    } finally { fixture.cleanup(); }
  });

  it('also blocks the paid OpenAI embedding side channel before fetch', async () => {
    configurePreSpendInterlock(policy());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const embeddings = new EmbeddingService({
      useLocal: false,
      openAIApiKey: 'test-only',
      openAIModel: 'text-embedding-3-small',
    });
    await expect(embeddings.embed('compost memory')).rejects.toThrow('no authorization context');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('authorizes a declared product call only when all current proofs pass', async () => {
    configurePreSpendInterlock(policy());
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const result = await provider.generate({
      ...baseRequest,
      preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'studio' },
    });

    expect(result.isOk()).toBe(true);
    expect(provider.calls).toBe(1);
    expect(getPreSpendCallLedger()).toMatchObject([{
      slotId: 'create-1', callerClass: 'studio', provider: 'openai', model: 'gpt-5.6-sol',
      status: 'success', usage: { inputTokens: 10, outputTokens: 2 },
    }]);
    expect(getPreSpendCallLedger()[0].id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects subscription-seat policy through the generic interlock before transport', async () => {
    const metered = policy();
    const slots = metered.declaredSlots.map(slot => ({ ...slot, seatId: `seat-${slot.id}` }));
    const feasibilityProof = createPreSpendFeasibilityProof({ fundingMode: 'subscription-seat',
      planHash: HASH_A, sourceFingerprint: HASH_B, declaredSlots: slots,
      budgetRows: slots.map(slot => ({ slotId: slot.id, maxCalls: slot.maxCalls,
        maxInputTokens: slot.maxInputTokens, maxOutputTokens: slot.maxOutputTokens,
        minActiveMinutes: slot.minActiveMinutes })), approvedSeatIds: slots.map(slot => slot.seatId) });
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    expect(() => configurePreSpendInterlock({ ...metered, declaredSlots: slots, feasibilityProof }))
      .toThrow('authenticated Wave 8 host configuration');
    expect(provider.calls).toBe(0);
  });

  it('carries authorization through an async caller tree without changing LLM APIs', async () => {
    configurePreSpendInterlock(policy());
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const result = await runWithPreSpendCallContext(
      { slotId: 'create-1', purpose: 'product', callerClass: 'studio' },
      async () => provider.generate(baseRequest),
    );
    expect(result.isOk()).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('enforces the internal slot call cap across retries', async () => {
    configurePreSpendInterlock(policy());
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const req: ProviderRequest = {
      ...baseRequest,
      preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'retry' },
    };
    await provider.generate(req);
    await provider.generate(req);
    await expect(provider.generate(req)).rejects.toThrow('call cap');
    expect(provider.calls).toBe(2);
  });

  it('blocks declared and observed token overruns at the provider boundary', async () => {
    configurePreSpendInterlock(policy());
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const authorization = { slotId: 'create-1', purpose: 'product' as const, callerClass: 'studio' as const };
    await expect(provider.generate({ ...baseRequest, maxTokens: 8_001, preSpend: authorization }))
      .rejects.toThrow('output token cap');
    expect(provider.calls).toBe(0);
    provider.usage = { inputTokens: 8_001, outputTokens: 2 };
    await expect(provider.generate({ ...baseRequest, preSpend: authorization }))
      .rejects.toThrow('exceeded token cap');
    expect(getPreSpendCallLedger()[0].status).toBe('error');
    provider.usage = { inputTokens: Number.NaN, outputTokens: 2 };
    await expect(provider.generate({ ...baseRequest, preSpend: authorization }))
      .rejects.toThrow('exceeded token cap');
  });
});

describe('PreSpendInterlock bootstrap and feasibility', () => {
  it('permits only the frozen Kimi-K3 approval request before critical approval exists', async () => {
    configurePreSpendInterlock(policy({ solApproval: undefined }));
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'kimi-k3' });
    const result = await provider.generate({
      ...baseRequest,
      preSpend: {
        slotId: 'sol-approval', purpose: 'sol-review-bootstrap', callerClass: 'independent-review',
      },
    });
    expect(result.isOk()).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('rejects bootstrap request drift, wrong identity, product purpose, and extra calls', async () => {
    configurePreSpendInterlock(policy({ solApproval: undefined }));
    const wrongModel = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra' });
    const authorization = {
      slotId: 'sol-approval', purpose: 'sol-review-bootstrap' as const,
      callerClass: 'independent-review' as const,
    };
    await expect(wrongModel.generate({ ...baseRequest, preSpend: authorization })).rejects.toThrow('model');

    const harness = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'kimi-k3' });
    await expect(harness.generate({ ...baseRequest, userPrompt: 'Write product code.', preSpend: authorization }))
      .rejects.toThrow('request digest');
    await expect(harness.generate({ ...baseRequest, preSpend: { ...authorization, purpose: 'product' } }))
      .rejects.toThrow('purpose');
    await harness.generate({ ...baseRequest, preSpend: authorization });
    await expect(harness.generate({ ...baseRequest, preSpend: authorization })).rejects.toThrow('call cap');
  });

  it('blocks streaming before the concrete adapter starts', async () => {
    configurePreSpendInterlock(policy({ noSpendProof: undefined }));
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const stream = provider.stream({
      ...baseRequest,
      preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'cli' },
    });
    await expect(stream.next()).rejects.toThrow('noSpendCirculationProof');
    expect(provider.calls).toBe(0);
  });

  it('rejects stale and internally tampered proof artifacts', async () => {
    const provider = new BoundaryProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' });
    const req: ProviderRequest = {
      ...baseRequest,
      preSpend: { slotId: 'create-1', purpose: 'product', callerClass: 'studio' },
    };
    configurePreSpendInterlock(policy({
      noSpendProof: { ...proof('noSpendCirculationProof'), sourceFingerprint: HASH_D },
    }));
    await expect(provider.generate(req)).rejects.toThrow('source fingerprint is stale');
    resetPreSpendInterlockForTests();

    const valid = policy();
    configurePreSpendInterlock(policy({
      feasibilityProof: {
        ...valid.feasibilityProof,
        totals: { ...valid.feasibilityProof.totals, calls: 0 },
      },
    }));
    await expect(provider.generate(req)).rejects.toThrow('preSpendFeasibilityProof failed');
    expect(provider.calls).toBe(0);
  });
});

describe('createPreSpendFeasibilityProof', () => {
  it('fails closed on omitted, extra, unknown-price, and over-cap rows', () => {
    const valid = policy().feasibilityProof;
    expect(valid.passed).toBe(true);

    const inputs = {
      planHash: HASH_A,
      sourceFingerprint: HASH_B,
      priceReceiptDigest: HASH_D,
      declaredSlots: policy().declaredSlots,
      approvedUsdCeiling: 10,
    };
    expect(createPreSpendFeasibilityProof({ ...inputs, budgetRows: valid.budgetRows.slice(0, 1) }).passed)
      .toBe(false);
    expect(createPreSpendFeasibilityProof({
      ...inputs,
      budgetRows: [...valid.budgetRows, { ...valid.budgetRows[0], slotId: 'undeclared' }],
    }).passed).toBe(false);
    expect(createPreSpendFeasibilityProof({
      ...inputs,
      budgetRows: valid.budgetRows.map((row, index) => index === 0
        ? { ...row, inputUsdPerMillion: undefined }
        : row),
    }).passed).toBe(false);
    expect(createPreSpendFeasibilityProof({
      ...inputs,
      budgetRows: valid.budgetRows.map(row => ({ ...row, maxCalls: 121 })),
    }).passed).toBe(false);
  });

  it('governs subscription seats by identity and resources without inventing a USD cost', () => {
    const slots = policy().declaredSlots.map((slot, index) => ({ ...slot, seatId: `subscription-seat-${index}` }));
    const budgetRows = slots.map(slot => ({ slotId: slot.id, maxCalls: slot.maxCalls,
      maxInputTokens: slot.maxInputTokens, maxOutputTokens: slot.maxOutputTokens,
      minActiveMinutes: slot.minActiveMinutes }));
    const valid = createPreSpendFeasibilityProof({ fundingMode: 'subscription-seat',
      planHash: HASH_A, sourceFingerprint: HASH_B, declaredSlots: slots, budgetRows,
      approvedSeatIds: slots.map(slot => slot.seatId) });
    expect(valid).toMatchObject({ passed: true, fundingMode: 'subscription-seat' });
    expect(valid.totals).not.toHaveProperty('usdUpperBound');
    expect(valid).not.toHaveProperty('priceReceiptDigest');

    expect(createPreSpendFeasibilityProof({ fundingMode: 'subscription-seat',
      planHash: HASH_A, sourceFingerprint: HASH_B, declaredSlots: slots, budgetRows,
      approvedSeatIds: ['subscription-seat-0'] }).passed).toBe(false);
    expect(createPreSpendFeasibilityProof({ fundingMode: 'subscription-seat',
      planHash: HASH_A, sourceFingerprint: HASH_B,
      declaredSlots: slots.map((slot, index) => index === 0 ? { ...slot, seatId: undefined } : slot),
      budgetRows, approvedSeatIds: slots.map(slot => slot.seatId) }).passed).toBe(false);
    expect(createPreSpendFeasibilityProof({ fundingMode: 'subscription-seat',
      planHash: HASH_A, sourceFingerprint: HASH_B, declaredSlots: slots,
      budgetRows: budgetRows.map(row => ({ ...row, inputUsdPerMillion: 1 })),
      approvedSeatIds: slots.map(slot => slot.seatId) }).passed).toBe(false);
  });

  it('resolves host credential bindings and rejects credential or policy substitution before transport', () => {
    const slots = policy().declaredSlots.map(slot => ({ ...slot, seatId: `seat-${slot.id}` }));
    const refs = Object.fromEntries(slots.map(slot => [slot.id, `binding-${slot.id}`]));
    const registry = slots.map(slot => ({ bindingId: refs[slot.id]!, provider: slot.provider,
      model: slot.model, seatId: slot.seatId }));
    expect(validateSubscriptionCredentialBindings(slots, refs, registry,
      slots.map(slot => slot.seatId)).size).toBe(slots.length);
    expect(() => validateSubscriptionCredentialBindings(slots, refs,
      registry.map((binding, index) => index === 0 ? { ...binding, seatId: 'wrong-seat' } : binding),
      slots.map(slot => slot.seatId))).toThrow('credential binding');
    expect(() => validateSubscriptionCredentialBindings(
      slots.map((slot, index) => index === 0 ? { ...slot, maxCalls: slot.maxCalls + 1 } : slot),
      refs, registry, slots.map(slot => slot.seatId))).not.toThrow();
    const substituted = createPreSpendFeasibilityProof({ fundingMode: 'subscription-seat',
      planHash: HASH_A, sourceFingerprint: HASH_B,
      declaredSlots: slots.map((slot, index) => index === 0 ? { ...slot, maxCalls: slot.maxCalls + 1 } : slot),
      budgetRows: slots.map(slot => ({ slotId: slot.id, maxCalls: slot.maxCalls,
        maxInputTokens: slot.maxInputTokens, maxOutputTokens: slot.maxOutputTokens,
        minActiveMinutes: slot.minActiveMinutes })), approvedSeatIds: slots.map(slot => slot.seatId) });
    expect(substituted.passed).toBe(false);
  });
});
