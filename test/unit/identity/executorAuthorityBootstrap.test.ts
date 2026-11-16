import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapCampaignExecutorAuthority, bootstrapExecutorAuthority,
  classifyProviderSurface, ExecutorAuthorityUnavailableError,
  pinnedProductionHostAuthorityRoot } from '../../../src/identity/executorAuthorityBootstrap.js';
import { formatHarnessExecutorProjection, toExecutorAttestationRef } from '../../../src/identity/harnessTransportGuard.js';
import { NonceLedger, type ExecutorAttestationSubjectV1 } from '../../../src/identity/executorAttestation.js';
import { HostAdapterRegistry } from '../../../src/identity/hostAdapterRegistry.js';
import { subscriptionFunding } from '../../../src/identity/fundingTruth.js';
import { LLMClient, LLMRateLimitError } from '../../../src/llm/LLMClient.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';
import { LUNA_MODEL_ID } from '../../../src/identity/canonicalAlias.js';
import { readExecutorTruthProjection, runExecutorTruthCli } from '../../../src/cli/ExecutorTruthCli.js';

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), 'executor-authority-'));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('production executor authority bootstrap', () => {
  it('trusts only exact loopback hosts and ports', () => {
    expect(classifyProviderSurface('unknown', 'http://localhost:8317/v1')).toBe('cliproxy-seat');
    expect(classifyProviderSurface('unknown', 'http://[::1]:1234/v1')).toBe('lmstudio-local');
    expect(classifyProviderSurface('unknown', 'https://untrusted.example/localhost:1234')).toBe('unknown');
    expect(classifyProviderSurface('unknown', 'http://localhost:1234.evil.example/v1')).toBe('unknown');
    expect(classifyProviderSurface('unknown', 'not a url localhost:8317')).toBe('unknown');
    expect(classifyProviderSurface('openai', 'grok-cli://local')).toBe('grok-cli-seat');
    expect(classifyProviderSurface('xai', 'https://api.x.ai/v1')).toBe('unknown');
    expect(classifyProviderSurface('openai', 'https://api.x.ai/v1')).toBe('unknown');
    expect(classifyProviderSurface('xai', 'https://api.x.ai/v1', { grokSubscriptionSeat: true }))
      .toBe('grok-cli-seat');
    expect(classifyProviderSurface('xai', 'http://api.x.ai/v1', { grokSubscriptionSeat: true }))
      .toBe('unknown');
    expect(classifyProviderSurface('xai', 'https://chat.x.ai/v1', { grokSubscriptionSeat: true }))
      .toBe('unknown');
    expect(classifyProviderSurface('unknown', 'https://api.x.ai.evil/v1')).toBe('unknown');
  });

  it('creates protected trust material and durable ledgers', () => {
    const directory = root();
    const authority = bootstrapExecutorAuthority({ rootDir: directory });
    expect(authority.guard.isDurable).toBe(true);
    expect(statSync(join(directory, 'trust-key.json')).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory).sort()).toEqual(['attempts', 'nonces', 'reservations', 'trust-key.json']);
  });

  it('does not let process environment redirect the production trust root', () => {
    const previous = process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
    process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = root();
    try {
      expect(pinnedProductionHostAuthorityRoot()).not.toBe(process.env.SINTER_EXECUTOR_AUTHORITY_ROOT);
    } finally {
      if (previous === undefined) delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
      else process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = previous;
    }
  });

  it('does not mint an environment-selected campaign root even in test mode', () => {
    const forgedRoot = root();
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRoot = process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
    process.env.NODE_ENV = 'test';
    process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = forgedRoot;
    try {
      try {
        bootstrapCampaignExecutorAuthority({
          seat: { seatId: 'forged', seatDigest: 'a'.repeat(64), surface: 'cliproxy-seat' },
          funding: subscriptionFunding({ seatDigest: 'a'.repeat(64), quotaCounters: {
            calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0,
          }, quotaSurface: 'cliproxy-seat' }),
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ExecutorAuthorityUnavailableError);
      }
      expect(existsSync(join(forgedRoot, 'trust-key.json'))).toBe(false);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousRoot === undefined) delete process.env.SINTER_EXECUTOR_AUTHORITY_ROOT;
      else process.env.SINTER_EXECUTOR_AUTHORITY_ROOT = previousRoot;
    }
  });

  it('loads a signed pre-upgrade v1 receipt without inventing an exact delta', () => {
    const directory = root();
    bootstrapExecutorAuthority({ rootDir: directory });
    const stored = JSON.parse(readFileSync(join(directory, 'trust-key.json'), 'utf8')) as {
      keyId: string; secretBase64: string;
    };
    const registry = new HostAdapterRegistry({
      keyId: stored.keyId,
      secret: Buffer.from(stored.secretBase64, 'base64'),
    }, [{
      adapterId: 'host-cliproxy-seat', surface: 'cliproxy-seat',
      provider: 'unknown', canEnforceNoSubstitution: true,
    }]);
    const identity = { provider: 'anthropic' as const, model: 'claude-opus-4-1', effort: 'high' as const };
    const seat = { seatId: 'legacy-seat', seatDigest: 'a'.repeat(64), surface: 'cliproxy-seat' as const };
    const issuedAt = '2026-08-01T00:00:00.000Z';
    const subject: ExecutorAttestationSubjectV1 = {
      schemaVersion: 'executor-attestation.v1',
      attestationId: 'legacy-v1-attestation', runDigest: 'legacy-run',
      requestDigest: 'legacy-request', attemptDigest: 'legacy-attempt', routeDigest: 'legacy-route',
      attemptOrdinal: 0, fallbackOrdinal: 0, retryOrdinal: 0,
      priorTraceDigest: null, policyTraceDigest: 'legacy-policy',
      requestedIdentity: identity, resolvedIdentity: identity, effort: identity.effort,
      fallbackChain: [{ ordinal: 0, identity }], seat,
      funding: subscriptionFunding({
        seatDigest: seat.seatDigest,
        quotaCounters: { calls: 7, inputTokens: 70, outputTokens: 30, activeSeconds: 4 },
        quotaSurface: 'cliproxy-seat',
      }),
      quotaSurface: 'cliproxy-seat', issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + 300_000).toISOString(),
      nonce: 'legacy-v1-nonce', keyId: stored.keyId,
      adapterId: 'host-cliproxy-seat', surface: 'cliproxy-seat', durationMs: 25,
    };
    const legacy = { subject, signature: registry.issueAttestationSignature(subject) };
    writeFileSync(join(directory, 'attempts', 'legacy-v1-attestation.json'), JSON.stringify(legacy));
    expect(new NonceLedger(join(directory, 'nonces')).burn(
      subject.nonce, subject.attestationId, issuedAt,
    ).ok).toBe(true);

    const upgraded = bootstrapExecutorAuthority({ rootDir: directory });
    const history = upgraded.readAttemptHistory?.() ?? [];
    expect(history).toHaveLength(1);
    expect(history[0].attestation.subject.schemaVersion).toBe('executor-attestation.v1');
    expect(history[0].attestation.subject).not.toHaveProperty('success');
    expect(history[0].attestation.subject).not.toHaveProperty('quotaCounterDelta');
    expect(toExecutorAttestationRef(history[0])).toBeNull();
    expect(upgraded.readAttemptHistory?.()[0]).toBe(history[0]);

    const receiptPath = join(directory, 'attempts', 'legacy-v1-attestation.json');
    writeFileSync(receiptPath, JSON.stringify({ ...legacy,
      subject: { ...legacy.subject, routeDigest: 'tampered-route' } }));
    expect(() => upgraded.readAttemptHistory?.()).toThrow(ExecutorAuthorityUnavailableError);
    writeFileSync(receiptPath, JSON.stringify(legacy));
    expect(upgraded.readAttemptHistory?.()).toHaveLength(1);
    rmSync(join(directory, 'nonces', readdirSync(join(directory, 'nonces'))[0]!));
    expect(upgraded.readAttemptHistory?.()).toEqual([]);
  });

  it('refuses exposed trust material instead of silently repairing it', () => {
    const directory = root();
    bootstrapExecutorAuthority({ rootDir: directory });
    chmodSync(join(directory, 'trust-key.json'), 0o644);
    expect(() => bootstrapExecutorAuthority({ rootDir: directory }))
      .toThrow(ExecutorAuthorityUnavailableError);
  });

  it('refuses missing or hard-linked trust keys in verification-only mode', () => {
    const missing = root();
    expect(() => bootstrapExecutorAuthority({ rootDir: missing, requireExisting: true }))
      .toThrow('existing host trust key is required');
    const directory = root();
    bootstrapExecutorAuthority({ rootDir: directory });
    linkSync(join(directory, 'trust-key.json'), join(directory, 'trust-key-alias.json'));
    expect(() => bootstrapExecutorAuthority({ rootDir: directory, requireExisting: true }))
      .toThrow('trust key must not have hard links');
  });

  it('attests a failed transport before fallback and projects the complete raw history', async () => {
    const directory = root();
    const authority = bootstrapExecutorAuthority({ rootDir: directory });
    const client = new LLMClient({ role: 'generator', baseUrl: 'http://localhost:8317/v1',
      apiKey: 'seat-test', model: 'claude-opus-4-1', harnessTransportAuthority: authority });
    const req: ProviderRequest = { systemPrompt: 'system', userPrompt: 'same request' };
    const primary = {
      name: 'anthropic', getModel: () => 'claude-opus-4-1',
      getConfig: () => ({ baseUrl: 'http://localhost:8317/v1', apiKey: 'seat-test', model: 'claude-opus-4-1' }),
      generate: async () => err(new LLMRateLimitError('anthropic')),
    };
    const fallback = {
      name: 'openai', getModel: () => LUNA_MODEL_ID,
      getConfig: () => ({ baseUrl: 'http://localhost:8317/v1', apiKey: 'seat-test', model: LUNA_MODEL_ID }),
      generate: async () => ok({ content: 'fallback', model: LUNA_MODEL_ID, success: true }),
    };
    const execute = Reflect.get(client, 'executeProviderAttempt') as (
      provider: unknown, request: ProviderRequest, phase: string, fallbackOrdinal: number, retryOrdinal: number,
    ) => Promise<unknown>;

    await expect(execute.call(client, primary, req, 'pre-primary-transport', 0, 0))
      .rejects.toThrow('Rate limited');
    expect(client.getHarnessExecutorProjection()).toMatchObject({
      status: 'verified', attempts: [{ attemptOrdinal: 0, fallbackOrdinal: 0, retryOrdinal: 0,
        attestation: { subject: { terminalReason: 'Rate limited by anthropic API' } } }],
    });

    await expect(execute.call(client, fallback, req, 'pre-fallback-transport', 1, 0))
      .resolves.toMatchObject({ content: 'fallback', success: true });
    const projection = client.getHarnessExecutorProjection();
    expect(projection).toMatchObject({
      status: 'verified',
      attempts: [
        { attemptOrdinal: 0, fallbackOrdinal: 0, retryOrdinal: 0 },
        { attemptOrdinal: 1, fallbackOrdinal: 1, retryOrdinal: 0,
          attestation: { subject: { fallbackChain: [{ ordinal: 0 }, { ordinal: 1 }] } } },
      ],
    });
    expect(formatHarnessExecutorProjection(projection)).toBe(JSON.stringify(projection));
    expect(readdirSync(join(directory, 'attempts'))).toHaveLength(2);
    const cliProjection = readExecutorTruthProjection(directory);
    expect(cliProjection.attempts).toEqual(projection.attempts);
    const output: string[] = [];
    expect(runExecutorTruthCli({ rootDir: directory, write: line => output.push(line) }))
      .toEqual(cliProjection);
    expect(JSON.parse(output[0])).toEqual(projection);
  });

  it('accepts a real harness response only after reservation and terminal attestation', async () => {
    const directory = root();
    const authority = bootstrapExecutorAuthority({ rootDir: directory });
    const client = new LLMClient({ role: 'harness', baseUrl: 'http://localhost:8317/v1',
      apiKey: 'harness-seat', model: 'claude-opus-4-1', harnessTransportAuthority: authority });
    const provider = {
      name: 'anthropic', getModel: () => 'claude-opus-4-1',
      getConfig: () => ({ baseUrl: 'http://localhost:8317/v1', apiKey: 'harness-seat', model: 'claude-opus-4-1' }),
      generate: async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return ok({ content: 'accepted', model: 'claude-opus-4-1', success: true,
          usage: { inputTokens: 4, outputTokens: 2 } });
      },
    };
    const execute = Reflect.get(client, 'executeProviderAttempt') as (
      provider: unknown, request: ProviderRequest, phase: string, fallbackOrdinal: number, retryOrdinal: number,
    ) => Promise<unknown>;
    await expect(execute.call(client, provider, { systemPrompt: 'system', userPrompt: 'request' },
      'pre-primary-transport', 0, 0)).resolves.toMatchObject({ content: 'accepted' });
    expect(client.getHarnessExecutorProjection()).toMatchObject({ status: 'verified', attempts: [{
      durationMs: expect.any(Number),
      attestation: { subject: { durationMs: expect.any(Number),
        funding: { quotaCounters: { calls: 1, inputTokens: 4, outputTokens: 2,
          activeSeconds: expect.any(Number) } } } },
    }] });
    const restartedAuthority = bootstrapExecutorAuthority({ rootDir: directory });
    const restarted = new LLMClient({ role: 'harness', baseUrl: 'http://localhost:8317/v1',
      apiKey: 'harness-seat', model: 'claude-opus-4-1', harnessTransportAuthority: restartedAuthority });
    expect(restarted.getHarnessExecutorProjection()).toEqual(readExecutorTruthProjection(directory));
    const attempts = restartedAuthority.readAttemptHistory?.() ?? [];
    expect(attempts[0].durationMs).toBeGreaterThan(0);
    expect(attempts[0].attestation.subject.funding.quotaCounters.activeSeconds).toBeGreaterThan(0);
    const restartedExecute = Reflect.get(restarted, 'executeProviderAttempt') as typeof execute;
    await expect(restartedExecute.call(restarted, provider,
      { systemPrompt: 'system', userPrompt: 'request' }, 'pre-retry-transport', 0, 1))
      .resolves.toMatchObject({ content: 'accepted' });
    expect(restarted.getHarnessExecutorProjection()).toMatchObject({ attempts: [
      { attemptOrdinal: 0, priorTraceDigest: null },
      { attemptOrdinal: 1, retryOrdinal: 1, priorTraceDigest: expect.any(String) },
    ] });
    expect(restartedAuthority.readAttemptHistory?.()).toHaveLength(2);
  });

  it('does not advance counters when exact completion issuance rejects malformed telemetry', async () => {
    const authority = bootstrapExecutorAuthority({ rootDir: root() });
    const identity = { provider: 'anthropic' as const, model: 'claude-opus-4-1', effort: 'high' as const };
    const context = {
      role: 'harness' as const, requestDigest: 'atomic-request', routeDigest: 'atomic-route',
      requestedIdentity: identity, resolvedIdentity: identity, phase: 'pre-primary-transport' as const,
      fallbackOrdinal: 0, retryOrdinal: 0, attemptOrdinal: 0, priorTraceDigest: null,
      policyTraceDigest: 'atomic-policy', fallbackChain: [{ ordinal: 0, identity }],
      surface: 'cliproxy-seat' as const, seatDigest: 'b'.repeat(64),
    };
    const initial = await authority.reserveAttempt(context);
    expect(initial?.subject.funding.quotaCounters).toEqual({
      calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0,
    });

    const malformed = [
      { model: identity.model, success: false, durationMs: -1 },
      { model: identity.model, success: false, durationMs: 1, usage: { inputTokens: 0.5, outputTokens: 0 } },
      { model: identity.model, success: false, durationMs: Number.NaN },
    ];
    for (const response of malformed) {
      expect(() => authority.attestCompletion({ context, reservation: initial, response }))
        .toThrow('ATTESTATION_EXACT_OUTCOME_REQUIRED');
    }

    const afterRejections = await authority.reserveAttempt(context);
    expect(afterRejections?.subject.funding.quotaCounters).toEqual({
      calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0,
    });
    const valid = await authority.attestCompletion({
      context, reservation: afterRejections,
      response: { model: identity.model, success: true, durationMs: 12,
        usage: { inputTokens: 3, outputTokens: 2 } },
    });
    expect(valid.subject.quotaCounterDelta).toEqual({
      calls: 1, inputTokens: 3, outputTokens: 2, activeSeconds: 0.012,
    });
    expect(valid.subject.funding.quotaCounters).toEqual({
      calls: 1, inputTokens: 3, outputTokens: 2, activeSeconds: 0.012,
    });
    const following = await authority.reserveAttempt(context);
    expect(following?.subject.funding.quotaCounters).toEqual(valid.subject.funding.quotaCounters);
  });

  it('binds the coding-plan seat to subscription funding without metered receipts', async () => {
    const authority = bootstrapExecutorAuthority({ rootDir: root() });
    const identity = { provider: 'glm' as const, model: 'glm-5.3',
      effort: 'high' as const, alias: 'glm-5.3' };
    const context = {
      role: 'generator' as const, requestDigest: 'seat-request', routeDigest: 'seat-route',
      requestedIdentity: identity, resolvedIdentity: identity, phase: 'pre-primary-transport' as const,
      fallbackOrdinal: 0, retryOrdinal: 0, attemptOrdinal: 0, priorTraceDigest: null,
      policyTraceDigest: 'seat-policy', fallbackChain: [{ ordinal: 0, identity }],
      surface: 'glm-coding-plan-seat' as const, seatDigest: 'g'.repeat(64),
    };
    const reservation = await authority.reserveAttempt(context);
    expect(reservation?.subject.funding).toMatchObject({
      mode: 'subscription-seat', quotaSurface: 'glm-coding-plan-seat',
    });
  });

  it('classifies a declared MiniMax Token Plan seat as subscription only on the exact endpoint', () => {
    const plan = 'https://api.minimax.io/anthropic';
    expect(classifyProviderSurface('minimax', plan, { minimaxTokenPlanSeat: true })).toBe('minimax-token-plan-seat');
    expect(classifyProviderSurface('minimax', plan + '/', { minimaxTokenPlanSeat: true })).toBe('minimax-token-plan-seat');
    // Undeclared key on the same host stays metered.
    expect(classifyProviderSurface('minimax', plan)).toBe('minimax-direct');
    // Declaration never transfers to another path, host, scheme or provider.
    expect(classifyProviderSurface('minimax', 'https://api.minimax.io/v1', { minimaxTokenPlanSeat: true })).toBe('minimax-direct');
    expect(classifyProviderSurface('minimax', 'http://api.minimax.io/anthropic', { minimaxTokenPlanSeat: true })).toBe('minimax-direct');
    expect(classifyProviderSurface('minimax', 'https://evil.example/anthropic', { minimaxTokenPlanSeat: true })).toBe('unknown');
    expect(classifyProviderSurface('glm', plan, { minimaxTokenPlanSeat: true })).toBe('unknown');
    for (const url of ['https://api.minimax.io:8443/anthropic', 'https://api.minimax.io/anthropic/v1',
      'https://evil.api.minimax.io/anthropic', 'https://api.minimax.io.evil/anthropic']) {
      expect(classifyProviderSurface('minimax', url, { minimaxTokenPlanSeat: true })).not.toBe('minimax-token-plan-seat');
    }
  });

  it('binds the MiniMax Token Plan seat to subscription funding without metered receipts', async () => {
    const authority = bootstrapExecutorAuthority({ rootDir: root() });
    const identity = { provider: 'minimax' as const, model: 'minimax-m3',
      effort: 'high' as const, alias: 'minimax-m3' };
    const context = {
      role: 'harness' as const, requestDigest: 'mm-request', routeDigest: 'mm-route',
      requestedIdentity: identity, resolvedIdentity: identity, phase: 'pre-primary-transport' as const,
      fallbackOrdinal: 0, retryOrdinal: 0, attemptOrdinal: 0, priorTraceDigest: null,
      policyTraceDigest: 'mm-policy', fallbackChain: [{ ordinal: 0, identity }],
      surface: 'minimax-token-plan-seat' as const, seatDigest: 'm'.repeat(64),
    };
    const reservation = await authority.reserveAttempt(context);
    expect(reservation?.subject.funding).toMatchObject({
      mode: 'subscription-seat', quotaSurface: 'minimax-token-plan-seat',
    });
    expect(() => authority.reserveAttempt({ ...context, surface: 'minimax-direct' as const }))
      .toThrow(/metered funding evidence missing for minimax-direct/);
  });

  it('does not expose a staged receipt until its completion nonce is durably accepted', async () => {
    const directory = root();
    const authority = bootstrapExecutorAuthority({ rootDir: directory });
    const identity = { provider: 'anthropic' as const, model: 'claude-opus-4-1',
      effort: 'high' as const, alias: 'claude-opus-4-1' };
    await authority.attestCompletion({
      context: { role: 'generator', requestDigest: 'request', routeDigest: 'route',
        requestedIdentity: identity, resolvedIdentity: identity, phase: 'pre-primary-transport',
        fallbackOrdinal: 0, retryOrdinal: 0, attemptOrdinal: 0, priorTraceDigest: null,
        policyTraceDigest: 'policy', fallbackChain: [{ ordinal: 0, identity }],
        surface: 'cliproxy-seat', seatDigest: 'seat-digest' },
      response: { model: identity.model, success: true, durationMs: 12 },
    });
    expect(readdirSync(join(directory, 'attempts'))).toHaveLength(1);
    expect(authority.readAttemptHistory?.()).toEqual([]);
    expect(readExecutorTruthProjection(directory)).toEqual({ status: 'idle', attempts: [] });
  });
});
