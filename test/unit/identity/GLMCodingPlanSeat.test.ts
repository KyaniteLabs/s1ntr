import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { GLM_CODING_PLAN_MODEL } from '../../../src/identity/GLMCodingPlanSeat.js';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyProviderSurface } from '../../../src/identity/executorAuthorityBootstrap.js';
import { quotaSurfaceFor } from '../../../src/identity/capabilityProbe.js';
import { HostAdapterRegistry, mintTrustKey, sha256Hex } from '../../../src/identity/hostAdapterRegistry.js';
import {
  GLM_CODING_PLAN_ENDPOINT,
  assertGLMCodingPlanCapacity,
  loadGLMCodingPlanSeat,
  provisionGLMCodingPlanOwnerProvenance,
  provisionGLMCodingPlanSeat,
} from '../../../src/identity/GLMCodingPlanSeat.js';
import {
  createGLMCodingPlanHostAdapter,
  createGLMCodingPlanAdapterRegistry,
  GLMCodingPlanReviewClient,
  verifyGLMCodingPlanInvocation,
  type GLMCodingPlanInvocationRequest,
} from '../../../src/llm/GLMCodingPlanHostAdapter.js';
import type {
  CampaignFundingAllocation,
  CampaignFundingCapacity,
} from '../../../src/creative-run/CampaignExecutionAuthority.js';
import { runGLMCodingPlanProvision } from '../../../src/cli/GLMCodingPlanProvision.js';

const now = new Date('2026-08-03T06:00:00.000Z');
const key = 'dedicated-coding-plan-secret';
const registry = () => new HostAdapterRegistry(mintTrustKey('test-host'), [{
  adapterId: 'host-glm-coding-plan-seat', surface: 'glm-coding-plan-seat',
  provider: 'glm', canEnforceNoSubstitution: true,
}]);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'glm-coding-plan-'));
  const bindingPath = join(root, 'binding.json');
  const provenancePath = join(root, 'owner-provenance.json');
  const ownerPublicKeyPath = join(root, 'owner-public.pem');
  const host = registry();
  const owner = generateKeyPairSync('ed25519');
  provisionGLMCodingPlanOwnerProvenance({ seatId: 'specialist-review',
    expiresAt: '2026-08-04T06:00:00.000Z', now, credentialResolver: () => key,
    ownerPrivateKeyPem: owner.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    ownerPublicKeyPem: owner.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    provenancePath, ownerPublicKeyPath });
  const binding = provisionGLMCodingPlanSeat({ registry: host, seatId: 'specialist-review',
    expiresAt: '2026-08-04T06:00:00.000Z', now, credentialResolver: () => key,
    outputPath: bindingPath, provenancePath, ownerPublicKeyPath });
  return { root, bindingPath, provenancePath, ownerPublicKeyPath, host, binding };
}

describe('GLM Coding Plan seat', () => {
  it('provisions owner trust through the guarded operator callsite', () => {
    const root = mkdtempSync(join(tmpdir(), 'glm-coding-plan-provision-'));
    const owner = generateKeyPairSync('ed25519');
    const privateKeyPath = join(root, 'owner-private.pem');
    const publicKeyPath = join(root, 'owner-public-source.pem');
    writeFileSync(privateKeyPath,
      owner.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(publicKeyPath,
      owner.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const outputPaths = { provenance: join(root, 'owner-provenance.json'),
      publicKey: join(root, 'owner-public.pem'), binding: join(root, 'seat-binding.json') };
    expect(() => runGLMCodingPlanProvision({ confirmedOwnerAuthorizedSubscription: false,
      seatId: 'specialist-review', expiresAt: '2026-08-04T06:00:00.000Z',
      ownerPrivateKeyPath: privateKeyPath, ownerPublicKeyPath: publicKeyPath,
      registry: registry(), credentialResolver: () => key, now, outputPaths }))
      .toThrow('CONFIRMATION_REQUIRED');
    const other = generateKeyPairSync('ed25519');
    writeFileSync(publicKeyPath,
      other.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    expect(() => runGLMCodingPlanProvision({ confirmedOwnerAuthorizedSubscription: true,
      seatId: 'specialist-review', expiresAt: '2026-08-04T06:00:00.000Z',
      ownerPrivateKeyPath: privateKeyPath, ownerPublicKeyPath: publicKeyPath,
      registry: registry(), credentialResolver: () => key, now, outputPaths }))
      .toThrow('OWNER_KEY_PAIR_INVALID');
    expect(existsSync(outputPaths.publicKey)).toBe(false);
    writeFileSync(publicKeyPath,
      owner.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const result = runGLMCodingPlanProvision({ confirmedOwnerAuthorizedSubscription: true,
      seatId: 'specialist-review', expiresAt: '2026-08-04T06:00:00.000Z',
      ownerPrivateKeyPath: privateKeyPath, ownerPublicKeyPath: publicKeyPath,
      registry: registry(), credentialResolver: () => key, now, outputPaths });
    expect(result).toMatchObject({ bindingId: 'glm-coding-plan:specialist-review',
      credentialDigest: sha256Hex(key), ...{
        ownerProvenancePath: outputPaths.provenance,
        ownerPublicKeyPath: outputPaths.publicKey,
        seatBindingPath: outputPaths.binding,
      } });
  });

  it('keeps every endpoint-only Z.ai route direct and metered', () => {
    expect(classifyProviderSurface('glm', GLM_CODING_PLAN_ENDPOINT)).toBe('glm-direct');
    expect(classifyProviderSurface('glm', 'https://api.z.ai/api/coding/paas')).toBe('glm-direct');
    expect(quotaSurfaceFor('glm-direct')).toBe('metered-api');
    expect(quotaSurfaceFor('glm-coding-plan-seat')).toBe('glm-coding-plan-seat');
  });

  it('accepts only the signed tuple bound to the dedicated credential digest', () => {
    const { host, bindingPath, provenancePath, ownerPublicKeyPath, binding } = fixture();
    const capacity: CampaignFundingCapacity = {
      seat: { seatId: binding.subject.seatId, seatDigest: sha256Hex(key),
        surface: 'glm-coding-plan-seat' },
      identity: { provider: 'glm', model: GLM_CODING_PLAN_MODEL, effort: 'max' },
      funding: { mode: 'subscription-seat', quotaSurface: 'glm-coding-plan-seat',
        seatDigest: sha256Hex(key), resourceBudgetDigest: sha256Hex('budget'),
        quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 } },
      surface: 'glm-coding-plan-seat', endpointDigest: sha256Hex(GLM_CODING_PLAN_ENDPOINT),
      remaining: { providerCalls: 10, inputTokens: 1000, outputTokens: 1000, activeSeconds: 600 },
    };
    expect(() => assertGLMCodingPlanCapacity(capacity, host,
      { now, credentialResolver: () => key, bindingPath,
        provenancePath, ownerPublicKeyPath })).not.toThrow();
    expect(() => assertGLMCodingPlanCapacity({ ...capacity,
      seat: { ...capacity.seat, seatDigest: sha256Hex('generic-env-key') } }, host,
    { now, credentialResolver: () => key, bindingPath,
      provenancePath, ownerPublicKeyPath })).toThrow('CAPACITY_BINDING_MISMATCH');
    expect(() => assertGLMCodingPlanCapacity({ ...capacity, surface: 'glm-direct',
      seat: { ...capacity.seat, surface: 'glm-direct' } }, host)).toThrow('MUST_BE_METERED');
  });

  it('rejects tamper, expiry, and credential mismatch before adapter execution', async () => {
    const { host, bindingPath, provenancePath, ownerPublicKeyPath } = fixture();
    const executor = vi.fn(async () => ({ stdout: '{}' }));
    const request: GLMCodingPlanInvocationRequest = { bindingId: 'glm-coding-plan:specialist-review',
      seatId: 'specialist-review', provider: 'glm', model: GLM_CODING_PLAN_MODEL, executionEffort: 'max',
      systemPrompt: 'system', userPrompt: 'user', maxTokens: 100 };
    const tampered = JSON.parse(readFileSync(bindingPath, 'utf8'));
    tampered.subject.model = 'glm-forged';
    writeFileSync(bindingPath, JSON.stringify(tampered), { mode: 0o600 });
    const adapter = createGLMCodingPlanHostAdapter({ registry: host, bindingPath,
      provenancePath, ownerPublicKeyPath,
      credentialResolver: () => key, executor, now: () => now });
    await expect(adapter.invoke(request)).rejects.toThrow('SIGNATURE_INVALID');
    expect(executor).not.toHaveBeenCalled();
    const fresh = fixture();
    expect(() => loadGLMCodingPlanSeat({ registry: fresh.host, bindingPath: fresh.bindingPath,
      provenancePath: fresh.provenancePath, ownerPublicKeyPath: fresh.ownerPublicKeyPath,
      credentialResolver: () => key, now: new Date('2026-08-05T00:00:00.000Z') }))
      .toThrow('SUBJECT_INVALID');
    expect(() => loadGLMCodingPlanSeat({ registry: fresh.host, bindingPath: fresh.bindingPath,
      provenancePath: fresh.provenancePath, ownerPublicKeyPath: fresh.ownerPublicKeyPath,
      credentialResolver: () => 'generic-env-key', now })).toThrow('CREDENTIAL_MISMATCH');
    expect(() => provisionGLMCodingPlanSeat({ registry: host, seatId: 'bad-expiry',
      expiresAt: 'not-a-date', now, credentialResolver: () => key,
      outputPath: join(fresh.root, 'bad.json') })).toThrow('EXPIRY_INVALID');
  });

  it('uses the dedicated credential in a bare tool-free CLI call and verifies its receipt', async () => {
    const { root, host, bindingPath, provenancePath, ownerPublicKeyPath } = fixture();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'must-not-leak');
    const executor = vi.fn(async () => ({ stdout: JSON.stringify({ result: '{"verdict":"pass"}',
      usage: { input_tokens: 12, output_tokens: 7 } }) }));
    const adapter = createGLMCodingPlanHostAdapter({ registry: host, bindingPath,
      provenancePath, ownerPublicKeyPath,
      credentialResolver: () => key, executor, now: () => now,
      configDir: join(root, 'claude-config') });
    const request: GLMCodingPlanInvocationRequest = { bindingId: 'glm-coding-plan:specialist-review',
      seatId: 'specialist-review', provider: 'glm', model: GLM_CODING_PLAN_MODEL, executionEffort: 'max',
      systemPrompt: 'system', userPrompt: 'user', maxTokens: 100 };
    const result = await adapter.invoke(request) as Awaited<ReturnType<typeof adapter.invoke>>;
    expect(() => verifyGLMCodingPlanInvocation({ result: result as never, request, registry: host })).not.toThrow();
    const call = executor.mock.calls[0]![0];
    expect(call.args).toContain('--bare');
    expect(call.args).toContain('--tools');
    expect(call.env.ANTHROPIC_AUTH_TOKEN).toBe(key);
    expect(call.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('100');
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude-config'));
    expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(call.env.GLM_API_KEY).toBeUndefined();
  });

  it('rejects missing usage and output over the authorized cap', async () => {
    const { root, host, bindingPath, provenancePath, ownerPublicKeyPath } = fixture();
    const request: GLMCodingPlanInvocationRequest = { bindingId: 'glm-coding-plan:specialist-review',
      seatId: 'specialist-review', provider: 'glm', model: GLM_CODING_PLAN_MODEL, executionEffort: 'max',
      systemPrompt: 'system', userPrompt: 'user', maxTokens: 5 };
    const adapterFor = (stdout: string) => createGLMCodingPlanHostAdapter({ registry: host,
      bindingPath, provenancePath, ownerPublicKeyPath,
      credentialResolver: () => key, executor: vi.fn(async () => ({ stdout })),
      now: () => now, configDir: join(root, 'claude-config') });
    await expect(adapterFor(JSON.stringify({ result: 'ok' })).invoke(request))
      .rejects.toThrow('CLI_RESULT_INVALID');
    await expect(adapterFor(JSON.stringify({ result: 'ok',
      usage: { input_tokens: 1, output_tokens: 6 } })).invoke(request))
      .rejects.toThrow('OUTPUT_CAP_EXCEEDED');
  });

  it('rejects missing or tampered owner subscription provenance before execution', async () => {
    const { root, host, bindingPath, provenancePath, ownerPublicKeyPath } = fixture();
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    provenance.subject.product = 'metered-api';
    writeFileSync(provenancePath, JSON.stringify(provenance), { mode: 0o600 });
    const executor = vi.fn(async () => ({ stdout: '{}' }));
    const adapter = createGLMCodingPlanHostAdapter({ registry: host, bindingPath,
      provenancePath, ownerPublicKeyPath, credentialResolver: () => key, executor,
      now: () => now, configDir: join(root, 'claude-config') });
    await expect(adapter.invoke({ bindingId: 'glm-coding-plan:specialist-review',
      seatId: 'specialist-review', provider: 'glm', model: GLM_CODING_PLAN_MODEL, executionEffort: 'max',
      systemPrompt: 'system', userPrompt: 'user', maxTokens: 5 }))
      .rejects.toThrow('OWNER_PROVENANCE_INVALID');
    expect(executor).not.toHaveBeenCalled();
  });

  it('rejects a live config binding that differs from the owner-proven seat', () => {
    const { root, host, bindingPath, provenancePath, ownerPublicKeyPath } = fixture();
    const configPath = join(root, 'execution-config.json');
    writeFileSync(configPath, JSON.stringify({
      credentialBindingRefs: { review: 'binding-specialist-review' },
      preSpendPolicy: { declaredSlots: [{ id: 'review', provider: 'glm',
        subscriptionTransport: 'host-adapter' }] },
    }), { mode: 0o600 });
    expect(() => createGLMCodingPlanAdapterRegistry(configPath, { registry: host, bindingPath,
      provenancePath, ownerPublicKeyPath, credentialResolver: () => key, now: () => now }))
      .toThrow('CONFIG_BINDING_MISMATCH');
    writeFileSync(configPath, JSON.stringify({
      credentialBindingRefs: { review: 'glm-coding-plan:specialist-review' },
      preSpendPolicy: { declaredSlots: [{ id: 'review', provider: 'glm',
        subscriptionTransport: 'host-adapter' }] },
    }), { mode: 0o600 });
    expect(createGLMCodingPlanAdapterRegistry(configPath, { registry: host, bindingPath,
      provenancePath, ownerPublicKeyPath, credentialResolver: () => key, now: () => now })?.has(
      'glm-coding-plan:specialist-review')).toBe(true);
  });

  it('rejects a non-max review allocation before transport', () => {
    const { host, bindingPath, provenancePath, ownerPublicKeyPath, binding } = fixture();
    const allocation = {
      stageId: 'specialist-review-brief-candidate', surface: 'glm-coding-plan-seat',
      identity: { provider: 'glm', model: GLM_CODING_PLAN_MODEL, effort: 'high' },
      seat: { seatId: binding.subject.seatId, seatDigest: binding.subject.credentialDigest,
        surface: 'glm-coding-plan-seat' },
      funding: { mode: 'subscription-seat', quotaSurface: 'glm-coding-plan-seat',
        seatDigest: binding.subject.credentialDigest },
    } as unknown as CampaignFundingAllocation;
    expect(() => new GLMCodingPlanReviewClient(allocation, host, { bindingPath,
      provenancePath, ownerPublicKeyPath, credentialResolver: () => key, now: () => now }))
      .toThrow('BINDING_MISMATCH');
  });
});
