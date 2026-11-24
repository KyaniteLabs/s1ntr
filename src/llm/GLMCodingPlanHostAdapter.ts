import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { HostAdapterRegistry } from '../identity/hostAdapterRegistry.js';
import { mintNonce, sha256Hex } from '../identity/hostAdapterRegistry.js';
import {
  GLM_CODING_PLAN_ENDPOINT,
  GLM_CODING_PLAN_MODEL,
  loadGLMCodingPlanSeat,
  type GLMCodingPlanCredentialResolver,
} from '../identity/GLMCodingPlanSeat.js';
import { SubscriptionHostAdapterRegistry, type SubscriptionHostAdapter } from './PreSpendInterlock.js';
import {
  claimCurrentCampaignTransportProof,
  debitCurrentCampaignFunding,
  settleCurrentCampaignFunding,
  type CampaignFundingAllocation,
} from '../creative-run/CampaignExecutionAuthority.js';
import { bootstrapCampaignExecutorAuthority,
  loadPinnedProductionHostAuthority } from '../identity/executorAuthorityBootstrap.js';
import { decideRoleEligibility } from '../identity/roleEligibilityPolicy.js';
import type { ExecutorAttestationV2, ExecutorAttestationV3 } from '../identity/executorAttestation.js';
import { projectExecutorAttemptHistory, toExecutorAttestationRef,
  toExecutorAttemptRecord, type ExecutorAttemptRecord,
  type HarnessTransportAuthority } from '../identity/harnessTransportGuard.js';
import type { LLMResponse } from './LLMClient.js';
import { TIMEOUT_DEFAULT_MS } from '../constants/limits.js';
import { providerRequestDigest } from './ProviderRequestDigest.js';
import type { ProviderRequest } from './ProviderTypes.js';
import {
  authorizeSubscriptionHostAdapterInvocation,
  completeSubscriptionHostAdapterInvocation,
  failSubscriptionHostAdapterInvocation,
  invokeSubscriptionHostAdapterProvider,
  type CanonicalPreSpendCapability,
} from './PreSpendInterlock.js';

const executeFile = promisify(execFile);

export interface GLMCodingPlanInvocationRequest {
  readonly bindingId: string;
  readonly seatId: string;
  readonly provider: 'glm';
  readonly model: typeof GLM_CODING_PLAN_MODEL;
  readonly executionEffort: 'max';
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTokens: number;
}

export interface GLMCodingPlanInvocationSubject {
  readonly schemaVersion: 'glm-coding-plan-invocation.v1';
  readonly bindingId: string;
  readonly seatId: string;
  readonly provider: 'glm';
  readonly model: typeof GLM_CODING_PLAN_MODEL;
  readonly surface: 'glm-coding-plan-seat';
  readonly endpointDigest: string;
  readonly credentialDigest: string;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly issuedAt: string;
  readonly nonce: string;
}

export interface GLMCodingPlanInvocationResult {
  readonly content: string;
  readonly subject: GLMCodingPlanInvocationSubject;
  readonly signature: string;
}

export type GLMCodingPlanCommandExecutor = (input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}) => Promise<{ readonly stdout: string }>;

const productionExecutor: GLMCodingPlanCommandExecutor = async ({ file, args, env }) => {
  const result = await executeFile(file, [...args], {
    env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: TIMEOUT_DEFAULT_MS,
  });
  return { stdout: result.stdout };
};

function parseCLIResult(stdout: string): {
  readonly content: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
} {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const content = typeof parsed.result === 'string' ? parsed.result
    : typeof parsed.content === 'string' ? parsed.content : '';
  const usage = parsed.usage as Record<string, unknown> | undefined;
  const inputTokens = Number(usage?.input_tokens ?? usage?.inputTokens);
  const outputTokens = Number(usage?.output_tokens ?? usage?.outputTokens);
  if (!content || !Number.isInteger(inputTokens) || inputTokens < 0
    || !Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new Error('GLM_CODING_PLAN_CLI_RESULT_INVALID');
  }
  return { content, usage: { inputTokens, outputTokens } };
}

function assertRequest(request: unknown): asserts request is GLMCodingPlanInvocationRequest {
  const item = request as Partial<GLMCodingPlanInvocationRequest>;
  if (item.provider !== 'glm' || item.model !== GLM_CODING_PLAN_MODEL
    || item.executionEffort !== 'max'
    || typeof item.bindingId !== 'string' || typeof item.seatId !== 'string'
    || typeof item.systemPrompt !== 'string' || typeof item.userPrompt !== 'string'
    || !Number.isInteger(item.maxTokens) || item.maxTokens! < 1) {
    throw new Error('GLM_CODING_PLAN_INVOCATION_REQUEST_INVALID');
  }
}

export function createGLMCodingPlanHostAdapter(input: {
  readonly registry: HostAdapterRegistry;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
  readonly bindingPath?: string;
  readonly provenancePath?: string;
  readonly ownerPublicKeyPath?: string;
  readonly executor?: GLMCodingPlanCommandExecutor;
  readonly now?: () => Date;
  readonly configDir?: string;
}): SubscriptionHostAdapter {
  return Object.freeze({
    async invoke(raw: unknown): Promise<GLMCodingPlanInvocationResult> {
      assertRequest(raw);
      const { binding, credential } = loadGLMCodingPlanSeat({ registry: input.registry,
        credentialResolver: input.credentialResolver, bindingPath: input.bindingPath,
        provenancePath: input.provenancePath, ownerPublicKeyPath: input.ownerPublicKeyPath,
        now: input.now?.() });
      const subject = binding.subject;
      if (raw.bindingId !== subject.bindingId || raw.seatId !== subject.seatId) {
        throw new Error('GLM_CODING_PLAN_INVOCATION_BINDING_MISMATCH');
      }
      const configDir = input.configDir ?? `${homedir()}/.sinter/glm-coding-plan/claude-config`;
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      chmodSync(configDir, 0o700);
      const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: GLM_CODING_PLAN_ENDPOINT,
        ANTHROPIC_AUTH_TOKEN: credential, ANTHROPIC_API_KEY: credential,
        ANTHROPIC_MODEL: GLM_CODING_PLAN_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: GLM_CODING_PLAN_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: GLM_CODING_PLAN_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: GLM_CODING_PLAN_MODEL,
        CLAUDE_CODE_SUBAGENT_MODEL: GLM_CODING_PLAN_MODEL,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(raw.maxTokens), CLAUDE_CONFIG_DIR: configDir };
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'GLM_API_KEY', 'Z_AI_API_KEY']) delete env[key];
      const args = ['--bare', '--print', '--output-format', 'json', '--no-session-persistence',
        '--disable-slash-commands', '--tools', '', '--max-turns', '1', '--model', GLM_CODING_PLAN_MODEL,
        '--effort', raw.executionEffort, '--system-prompt', raw.systemPrompt, raw.userPrompt];
      const response = parseCLIResult((await (input.executor ?? productionExecutor)({
        file: `${homedir()}/.local/bin/claude-real`, args, env,
      })).stdout);
      if (response.usage.outputTokens > raw.maxTokens) {
        throw new Error('GLM_CODING_PLAN_OUTPUT_CAP_EXCEEDED');
      }
      const invocation: GLMCodingPlanInvocationSubject = Object.freeze({
        schemaVersion: 'glm-coding-plan-invocation.v1', bindingId: subject.bindingId,
        seatId: subject.seatId, provider: 'glm', model: GLM_CODING_PLAN_MODEL,
        surface: 'glm-coding-plan-seat', endpointDigest: subject.endpointDigest,
        credentialDigest: subject.credentialDigest,
        requestDigest: sha256Hex(JSON.stringify(raw)), responseDigest: sha256Hex(response.content),
        usage: response.usage, issuedAt: (input.now?.() ?? new Date()).toISOString(), nonce: mintNonce(),
      });
      return Object.freeze({ content: response.content, subject: invocation,
        signature: input.registry.issueGLMCodingPlanSeatSignature(invocation) });
    },
  });
}

export function verifyGLMCodingPlanInvocation(input: {
  readonly result: GLMCodingPlanInvocationResult;
  readonly request: GLMCodingPlanInvocationRequest;
  readonly registry: HostAdapterRegistry;
}): void {
  const { result, request, registry } = input;
  const subject = result.subject;
  if (!registry.verify(subject, result.signature)
    || subject.schemaVersion !== 'glm-coding-plan-invocation.v1'
    || subject.bindingId !== request.bindingId || subject.seatId !== request.seatId
    || subject.provider !== request.provider || subject.model !== request.model
    || subject.surface !== 'glm-coding-plan-seat'
    || subject.endpointDigest !== sha256Hex(GLM_CODING_PLAN_ENDPOINT)
    || subject.requestDigest !== sha256Hex(JSON.stringify(request))
    || subject.responseDigest !== sha256Hex(result.content)) {
    throw new Error('GLM_CODING_PLAN_INVOCATION_RECEIPT_INVALID');
  }
}

/** Narrow owner-review client; the credential remains inside the host adapter. */
export class GLMCodingPlanReviewClient {
  readonly #attempts: ExecutorAttemptRecord[] = [];
  readonly #authority;
  readonly #binding;

  constructor(
    readonly allocation: CampaignFundingAllocation,
    readonly registry: HostAdapterRegistry,
    testOptions?: {
      readonly bindingPath: string;
      readonly provenancePath: string;
      readonly ownerPublicKeyPath: string;
      readonly credentialResolver: GLMCodingPlanCredentialResolver;
      readonly executorAuthority?: HarnessTransportAuthority;
      readonly now?: () => Date;
    },
  ) {
    if (testOptions && process.env.NODE_ENV !== 'test') {
      throw new Error('OWNER_REVIEW_GLM_TEST_OPTIONS_FORBIDDEN');
    }
    const loaded = loadGLMCodingPlanSeat({ registry, ...(testOptions ?? {}), now: testOptions?.now?.() });
    this.#binding = loaded.binding;
    if (allocation.surface !== 'glm-coding-plan-seat'
      || allocation.identity.provider !== 'glm'
      || allocation.identity.model !== GLM_CODING_PLAN_MODEL
      || allocation.identity.effort !== 'max'
      || allocation.seat.seatId !== loaded.binding.subject.seatId
      || allocation.seat.seatDigest !== loaded.binding.subject.credentialDigest) {
      throw new Error(`OWNER_REVIEW_GLM_CODING_PLAN_BINDING_MISMATCH:${allocation.stageId}`);
    }
    this.#authority = testOptions?.executorAuthority ?? bootstrapCampaignExecutorAuthority({
      seat: allocation.seat, funding: allocation.funding,
    });
  }

  getHarnessExecutorProjection() {
    return projectExecutorAttemptHistory(this.#attempts);
  }

  verifyPersistedExecutorCompletion(attestation: ExecutorAttestationV2 | ExecutorAttestationV3) {
    return this.#authority.guard.verifyPersistedCompletion(attestation);
  }

  async generate(systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
    const request: ProviderRequest = {
      systemPrompt, userPrompt, maxTokens: this.allocation.outputTokens,
    };
    const adapterRequest: GLMCodingPlanInvocationRequest = {
      bindingId: this.#binding.subject.bindingId, seatId: this.allocation.seat.seatId,
      provider: 'glm', model: GLM_CODING_PLAN_MODEL, executionEffort: 'max', systemPrompt, userPrompt,
      maxTokens: this.allocation.outputTokens,
    };
    const identity = this.allocation.identity;
    if (identity.effort !== 'max') throw new Error('OWNER_REVIEW_GLM_EFFORT_MISMATCH');
    const decision = decideRoleEligibility({ role: 'evaluator', sourceLayer: 'explicit-harness-client',
      phase: 'pre-primary-transport', requestedIdentity: identity, resolvedIdentity: identity,
      fallbackOrdinal: 0, retryOrdinal: 0, priorDigest: null,
      policyInvokedAt: ['pre-primary-transport'] });
    if (!decision.ok) throw new Error(`OWNER_REVIEW_GLM_ROLE_REJECTED:${decision.reason}`);
    const context = {
      role: 'evaluator' as const, requestDigest: providerRequestDigest(request),
      routeDigest: this.allocation.routeDigest, requestedIdentity: identity, resolvedIdentity: identity,
      phase: 'pre-primary-transport' as const, fallbackOrdinal: 0, retryOrdinal: 0,
      attemptOrdinal: this.#attempts.length, priorTraceDigest: null,
      policyTraceDigest: decision.trace.digest, fallbackChain: [{ ordinal: 0, identity }],
      surface: 'glm-coding-plan-seat' as const, seatDigest: this.allocation.seat.seatDigest,
    };
    const campaignProfile = {
      executorRouteDigest: context.routeDigest, requestDigest: context.requestDigest,
      role: context.role, identity, phase: context.phase, mode: 'generate' as const,
      attemptOrdinal: context.attemptOrdinal, fallbackOrdinal: 0, retryOrdinal: 0,
      maxInputTokens: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
      maxOutputTokens: this.allocation.outputTokens, baseUrl: GLM_CODING_PLAN_ENDPOINT,
      credentialDigest: this.#binding.subject.credentialDigest,
      transportProvider: 'glm', transportModel: GLM_CODING_PLAN_MODEL,
    };
    const campaignProof = claimCurrentCampaignTransportProof(campaignProfile);
    if (!campaignProof) throw new Error('OWNER_REVIEW_GLM_CAMPAIGN_FUNDING_CONTEXT_MISSING');
    const campaignDebit = await debitCurrentCampaignFunding({ ...campaignProfile, ...campaignProof });
    if (!campaignDebit) throw new Error('OWNER_REVIEW_GLM_CAMPAIGN_FUNDING_DEBIT_MISSING');
    const startedAt = Date.now();
    const finish = async (response: {
      readonly content?: string; readonly success: boolean;
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
      readonly terminalReason?: string;
    }) => {
      const attestation = await this.#authority.attestCompletion({ context, response: {
        model: GLM_CODING_PLAN_MODEL, ...response, durationMs: Date.now() - startedAt,
      } });
      const verified = this.#authority.guard.verifyCompletion({ attestation,
        role: 'evaluator', sourceLayer: 'explicit-harness-client', phase: 'pre-primary-transport',
        policyInvokedAt: ['pre-primary-transport'], now: new Date().toISOString() });
      if (!verified.ok || verified.attestation.subject.schemaVersion === 'executor-attestation.v1') {
        throw new Error('OWNER_REVIEW_GLM_COMPLETION_ATTESTATION_INVALID');
      }
      const exact = verified.attestation as ExecutorAttestationV2 | ExecutorAttestationV3;
      const record = toExecutorAttemptRecord(exact);
      await settleCurrentCampaignFunding(campaignDebit, exact);
      this.#attempts.push(record);
      return record;
    };
    let capability: CanonicalPreSpendCapability | undefined;
    let result: GLMCodingPlanInvocationResult;
    try {
      capability = authorizeSubscriptionHostAdapterInvocation(request);
      result = await invokeSubscriptionHostAdapterProvider(
        capability, adapterRequest,
        () => Promise.reject(new Error('GLM_CODING_PLAN_DIRECT_TRANSPORT_FORBIDDEN')));
      verifyGLMCodingPlanInvocation({ result, request: adapterRequest, registry: this.registry });
      completeSubscriptionHostAdapterInvocation(capability, {
        provider: 'glm', model: GLM_CODING_PLAN_MODEL,
        usage: { tokens: result.subject.usage.inputTokens + result.subject.usage.outputTokens,
          ...result.subject.usage },
      }, 'success');
    } catch (error) {
      if (capability) {
        try { failSubscriptionHostAdapterInvocation(capability); } catch { /* already terminal */ }
      }
      await finish({ success: false,
        terminalReason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const record = await finish({ content: result.content, success: true, usage: result.subject.usage });
    const ref = toExecutorAttestationRef(record);
    if (!ref) throw new Error('OWNER_REVIEW_GLM_COMPLETION_REF_MISSING');
    return Object.freeze({ code: result.content, success: true,
      usage: result.subject.usage, executorAttestations: [ref] });
  }
}

export function createGLMCodingPlanAdapterRegistry(
  configPath: string,
  testOptions?: {
    readonly registry: HostAdapterRegistry;
    readonly bindingPath: string;
    readonly provenancePath: string;
    readonly ownerPublicKeyPath: string;
    readonly credentialResolver: GLMCodingPlanCredentialResolver;
    readonly now?: () => Date;
  },
): SubscriptionHostAdapterRegistry | undefined {
  if (testOptions && process.env.NODE_ENV !== 'test') {
    throw new Error('GLM_CODING_PLAN_ADAPTER_TEST_OPTIONS_FORBIDDEN');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    readonly credentialBindingRefs?: Readonly<Record<string, string>>;
    readonly preSpendPolicy?: { readonly declaredSlots?: readonly {
      readonly id: string; readonly provider: string; readonly subscriptionTransport?: string }[] };
  };
  const refs = config.credentialBindingRefs ?? {};
  const bindingIds = (config.preSpendPolicy?.declaredSlots ?? [])
    .filter(slot => slot.provider === 'glm' && slot.subscriptionTransport === 'host-adapter')
    .map(slot => refs[slot.id])
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (bindingIds.length === 0) return undefined;
  const authority = testOptions
    ? { registry: testOptions.registry }
    : loadPinnedProductionHostAuthority();
  const seatOptions = testOptions ?? {};
  const seat = loadGLMCodingPlanSeat({
    registry: authority.registry,
    ...seatOptions,
    now: testOptions?.now?.(),
  });
  if (bindingIds.some(bindingId => bindingId !== seat.binding.subject.bindingId)) {
    throw new Error('GLM_CODING_PLAN_CONFIG_BINDING_MISMATCH');
  }
  const adapter = createGLMCodingPlanHostAdapter({ ...authority, ...seatOptions });
  return new SubscriptionHostAdapterRegistry(
    new Map([[seat.binding.subject.bindingId, adapter]]),
  );
}
