import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalCliSeatUrl, parseHermesSeat } from './cliSeatUrl.js';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { issueExecutorAttestation, verifyExecutorAttestation, type ExecutorAttestation } from './executorAttestation.js';
import { NonceLedger } from './executorAttestation.js';
import { issueExecutorReservation, ReservationTracker } from './executorReservation.js';
import { meteredFunding, offlineFunding, subscriptionFunding } from './fundingTruth.js';
import { HostAdapterRegistry, mintNonce, sha256Hex, type HostAdapterDescriptor, type HostTrustKey } from './hostAdapterRegistry.js';
import { HarnessTransportGuard, toExecutorAttemptRecord, type ExecutorAttemptRecord, type HarnessAttemptContext, type HarnessTransportAuthority } from './harnessTransportGuard.js';
import type { ExhaustionClass, FundingTruth, ProviderSurface, QuotaCounters, SeatBinding } from './types.js';

const KEY_FILE = 'trust-key.json';
const PRIVATE_MASK = 0o077;

export class ExecutorAuthorityUnavailableError extends Error {
  constructor(message: string) {
    super(`EXECUTOR_AUTHORITY_UNAVAILABLE: ${message}`);
    this.name = 'ExecutorAuthorityUnavailableError';
  }
}

/** Owner-authorized generator routes on openai-compatible gateways (L8:
 * the Qwen 3.8 27B champion on the LAN gateway + the kilo fleet seats — CEO-ruled
 * rotation 2026-08-29: deepseek-v4-flash, the probed hy3 free seat, and
 * stepfun/step-3.7-flash:free; kilo NEVER serves qwen. CEO 2026-08-30:
 * DeepInfra earmark route (deepseek-ai/DeepSeek-V4-Flash-0731, $40 cap —
 * see ProviderBudgetLedger) + the Xiaomi Token Plan (mimo-v2.5-pro direct,
 * token-plan-sgp; NEVER kilo for xiaomi per CEO token-plan ruling). */
const LAN_GATEWAY_FREE_ROUTES: ReadonlySet<string> = new Set([
  'qwen3.6-27b-mtp', 'qwen3.8-27b', 'deepseek-v4-flash', 'deepseek-v4-flash:cloud',
  'hy3', 'stepfun/step-3.7-flash:free', 'xiaomi/mimo-v2.5',
  'deepseek-ai/DeepSeek-V4-Flash-0731', 'mimo-v2.5-pro',
]);

function glmCodingPlanPathVerified(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const trimmed = parsed.pathname.replace(/\/+$/, '');
    return trimmed === '/api/anthropic';
  } catch {
    return false;
  }
}

/**
 * The owner's self-hosted LiteLLM gateway, named by `SINTER_LAN_GATEWAY`
 * (`host:port`). It used to be a hard-coded private address, which shipped
 * the owner's machine identity in every package. Unset means no gateway.
 */
export function isOwnerLanGatewayUrl(baseUrl: string): boolean {
  const declared = process.env.SINTER_LAN_GATEWAY?.trim();
  if (!declared) return false;
  try {
    const url = new URL(baseUrl);
    return `${url.hostname}:${url.port}` === declared;
  } catch { return false; }
}

export function classifyProviderSurface(
  provider: string,
  baseUrl: string,
  options?: { readonly grokSubscriptionSeat?: boolean; readonly glmCodingPlanSeat?: boolean;
    readonly model?: string },
): ProviderSurface {
  let hostname = '';
  let port = '';
  let protocol = '';
  try {
    const parsed = new URL(baseUrl);
    const cliSeatUrl = canonicalCliSeatUrl(baseUrl);
    if (parsed.protocol === 'grok-cli:') return 'grok-cli-seat';
    if (provider === 'cli' && cliSeatUrl === 'cli://codex'
      && ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'].includes(options?.model ?? '')) {
      return 'codex-cli-seat';
    }
    // Hermes runs with its fallback chain off (--ignore-user-config), so the
    // named model is the one that answers. Funding stays metered: the seat
    // fronts API keys, so it needs the same receipt + ceiling as any API call.
    if (provider === 'cli' && parseHermesSeat(baseUrl)) return 'hermes-cli-seat';
    if (provider === 'cli' && cliSeatUrl === 'cli://agy'
      && options?.model === 'gemini-3.7-flash-medium') return 'agy-cli-seat';
    if (provider === 'cli' && cliSeatUrl === 'cli://command-code'
      && options?.model === 'deepseek/deepseek-v4-pro') return 'command-code-cli-seat';
    hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    port = parsed.port;
    protocol = parsed.protocol;
  } catch {
    return 'unknown';
  }
  // A GLM coding-plan subscription seat is caller-declared on the EXACT z.ai
  // coding-plan endpoint (scheme+host+path — A005/Sol); a pay-per-token GLM key,
  // any other api.z.ai path, or any other provider stays glm-direct.
  if (options?.glmCodingPlanSeat === true && protocol === 'https:' && hostname === 'api.z.ai'
    && provider === 'glm' && (port === '' || port === '443')
    && glmCodingPlanPathVerified(baseUrl)) {
    return 'glm-coding-plan-seat';
  }
  // Exact HTTPS api.x.ai is subscription only when the caller marked the grok
  // seat. A pay-per-token xAI key on the same host stays metered/unknown.
  if (protocol === 'https:' && hostname === 'api.x.ai' && options?.grokSubscriptionSeat === true) {
    return 'grok-cli-seat';
  }
  // LAN LiteLLM (owner's OpenAI-compatible gateway; L8 generator seat) is a
  // self-hosted endpoint — but offline (free) funding applies ONLY to the
  // owner-authorized free/local model routes (A006/Sol). Unknown or paid
  // models proxied through the same gateway must not inherit free funding;
  // they classify 'unknown' (metered evidence required, fail-closed).
  if (isOwnerLanGatewayUrl(baseUrl)) {
    const route = (options?.model ?? '').toLowerCase();
    return LAN_GATEWAY_FREE_ROUTES.has(route) ? 'lan-gateway-litellm' : 'unknown';
  }
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (loopback && provider === 'kimi' && port !== '1234' && port !== '11434') return 'kimi-cliproxy';
  if (loopback && (port === '8317' || port === '8318')) return 'cliproxy-seat';
  if (provider === 'kilo' || hostname === 'kilo.ai' || hostname.endsWith('.kilo.ai')) return 'kilo-gateway-entitlement';
  if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')) return 'openrouter';
  if (loopback && port === '1234') return 'lmstudio-local';
  if (loopback && port === '11434') return 'ollama-cloud';
  // Provider-direct classification must verify the hostname, not just the
  // provider string. An arbitrary endpoint claiming provider='google' must
  // not receive a trusted 'google-direct' surface classification.
  const directHosts: Partial<Record<string, string[]>> = {
    anthropic: ['api.anthropic.com'],
    google: ['generativelanguage.googleapis.com'],
    glm: ['api.z.ai', 'open.bigmodel.cn'],
    openai: ['api.openai.com'],
    minimax: ['api.minimax.io'],
    moonshot: ['api.moonshot.cn'],
    kimi: ['api.moonshot.cn'],
  };
  const knownDirect = directHosts[provider];
  if (knownDirect && knownDirect.includes(hostname)) {
    return `${provider}-direct` as ProviderSurface;
  }
  return 'unknown';
}

const ADAPTERS: readonly HostAdapterDescriptor[] = [
  ['cliproxy-seat', true], ['kimi-cliproxy', true], ['codex-cli-seat', true], ['agy-cli-seat', true], ['command-code-cli-seat', true], ['grok-cli-seat', true], ['hermes-cli-seat', true], ['kilo-gateway-entitlement', true],
  ['openai-direct', true], ['anthropic-direct', true], ['google-direct', true],
  ['glm-direct', true], ['glm-coding-plan-seat', true], ['minimax-direct', true],
  ['moonshot-direct', true],
  ['lmstudio-local', true], ['lan-gateway-litellm', true], ['ollama-cloud', true],
  ['openrouter', false], ['unknown', false],
].map(([surface, strict]) => ({
  adapterId: `host-${surface}`,
  surface: surface as ProviderSurface,
  provider: 'unknown' as const,
  canEnforceNoSubstitution: strict as boolean,
}));

export interface BootstrapOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Verification-only callers must fail instead of minting a new host key. */
  requireExisting?: boolean;
  /** Host-admitted campaign seat; prevents a production client minting a new seat alias. */
  binding?: { readonly seat: SeatBinding; readonly funding: FundingTruth };
}

export interface HostAuthorityBootstrap {
  readonly rootDir: string;
  readonly registry: HostAdapterRegistry;
}

export function pinnedProductionHostAuthorityRoot(): string {
  return join(homedir(), '.sinter', 'executor-authority');
}

/** Verification root cannot be redirected by campaign input or process environment. */
export function loadPinnedProductionHostAuthority(): HostAuthorityBootstrap {
  return bootstrapHostAuthority({
    rootDir: pinnedProductionHostAuthorityRoot(),
    requireExisting: true,
  });
}

/** The shared protected trust root used by executor and campaign authorities. */
export function bootstrapHostAuthority(options: BootstrapOptions = {}): HostAuthorityBootstrap {
  const rootDir = options.rootDir
    ?? options.env?.SINTER_EXECUTOR_AUTHORITY_ROOT
    ?? process.env.SINTER_EXECUTOR_AUTHORITY_ROOT
    ?? join(homedir(), '.sinter', 'executor-authority');
  const registry = new HostAdapterRegistry(
    loadOrCreateKey(rootDir, options.requireExisting ?? false), ADAPTERS);
  if (new Set(registry.listAdapters().map(adapter => adapter.surface)).size !== ADAPTERS.length) {
    throw new ExecutorAuthorityUnavailableError('adapter capability registry is ambiguous');
  }
  return Object.freeze({ rootDir, registry });
}

interface StoredKey { schemaVersion: 'executor-trust-key.v1'; keyId: string; secretBase64: string }

function loadOrCreateKey(rootDir: string, requireExisting: boolean): HostTrustKey {
  if (requireExisting && !existsSync(join(rootDir, KEY_FILE))) {
    throw new ExecutorAuthorityUnavailableError('existing host trust key is required');
  }
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  chmodSync(rootDir, 0o700);
  const keyPath = join(rootDir, KEY_FILE);
  if (!existsSync(keyPath)) {
    const stored: StoredKey = {
      schemaVersion: 'executor-trust-key.v1',
      keyId: `host-${randomUUID()}`,
      secretBase64: randomBytes(32).toString('base64'),
    };
    try {
      writeFileSync(keyPath, JSON.stringify(stored), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const keyStat = lstatSync(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink()) {
    throw new ExecutorAuthorityUnavailableError('trust key must be a regular file');
  }
  const stat = statSync(keyPath);
  if (stat.nlink !== 1) {
    throw new ExecutorAuthorityUnavailableError('trust key must not have hard links');
  }
  const mode = stat.mode & 0o777;
  if ((mode & PRIVATE_MASK) !== 0) {
    throw new ExecutorAuthorityUnavailableError(`trust key permissions ${mode.toString(8)} must be 600`);
  }
  const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as Partial<StoredKey>;
  const secret = typeof parsed.secretBase64 === 'string' ? Buffer.from(parsed.secretBase64, 'base64') : Buffer.alloc(0);
  if (parsed.schemaVersion !== 'executor-trust-key.v1' || !parsed.keyId || secret.byteLength < 32) {
    throw new ExecutorAuthorityUnavailableError('trust key is malformed');
  }
  return { keyId: parsed.keyId, secret };
}

function exhaustionFor(reason?: string): ExhaustionClass | undefined {
  if (!reason) return undefined;
  if (/quota|billing cycle|usage limit/i.test(reason)) return 'subscription-quota-exhausted';
  if (/rate.?limit|429/i.test(reason)) return 'rate-limited';
  if (/auth|credential|401|403/i.test(reason)) return 'seat-unavailable';
  if (/spend|budget|ceiling/i.test(reason)) return 'metered-spend-exhausted';
  return 'capacity-unknown';
}

/** Load the protected host key and durable replay/attempt ledgers. */
export function bootstrapExecutorAuthority(options: BootstrapOptions = {}): HarnessTransportAuthority {
  const { rootDir, registry } = bootstrapHostAuthority(options);
  const runtimeEnv = options.env ?? process.env;
  const guard = new HarnessTransportGuard(registry, {
    reservations: new ReservationTracker(join(rootDir, 'reservations')),
    nonces: new NonceLedger(join(rootDir, 'nonces')),
  });
  const attemptsDir = join(rootDir, 'attempts');
  mkdirSync(attemptsDir, { recursive: true, mode: 0o700 });
  const runDigest = sha256Hex(`${registry.keyId}:${randomUUID()}`);
  // Keep verified immutable receipts across role clients, but rehash every
  // on-disk file and recheck its nonce on each read. A changed or torn file
  // never inherits a prior verification result.
  const verifiedHistory = new Map<string, { digest: string; record: ExecutorAttemptRecord }>();
  const readHistory = (): ExecutorAttemptRecord[] => readdirSync(attemptsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      // ADVERSARY CATCH (committee 2026-09-02): concurrent children write
      // attestation files non-atomically; an unguarded JSON.parse of a torn
      // file crashes the CONSTRUCTOR of every role'd client in a new child —
      // killing it before generation, before any capture (the zero-capture
      // death signature). A torn file is skipped loudly, never fatal; a
      // fully-written but unverifiable record still fails closed.
      let content: string;
      let attestation: ExecutorAttestation;
      try {
        content = readFileSync(join(attemptsDir, name), 'utf8');
        const cached = verifiedHistory.get(name);
        if (cached?.digest === sha256Hex(content)) return cached.record;
        attestation = JSON.parse(content) as ExecutorAttestation;
      } catch {
        // eslint-disable-next-line no-console -- intentional operator diagnostic for a skipped torn file
        console.warn(`[executor-authority] skipping torn attempt file (concurrent write): ${name}`);
        return null;
      }
      const verified = verifyExecutorAttestation(registry, attestation, attestation.subject.issuedAt);
      if (!verified.ok) throw new ExecutorAuthorityUnavailableError(`attempt ledger verification failed: ${verified.reason}`);
      const record = toExecutorAttemptRecord(attestation);
      verifiedHistory.set(name, { digest: sha256Hex(content), record });
      return record;
    })
    .filter((record): record is ExecutorAttemptRecord => record !== null
      && guard.isNonceBurned(record.attestation.subject.nonce))
    .sort((left, right) => left.attestation.subject.issuedAt.localeCompare(right.attestation.subject.issuedAt));
  const persistedCounters = readHistory().at(-1)?.attestation.subject.funding.quotaCounters;
  let counters: QuotaCounters = persistedCounters
    ? { ...persistedCounters }
    : { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 };

  const binding = (
    context: HarnessAttemptContext,
    quotaCounters: QuotaCounters = counters,
  ): { seat: SeatBinding; funding: FundingTruth } => {
    if (options.binding) {
      const { seat, funding } = options.binding;
      if (seat.surface !== context.surface || seat.seatDigest !== context.seatDigest
        || (funding.seatDigest && funding.seatDigest !== seat.seatDigest)) {
        throw new ExecutorAuthorityUnavailableError('campaign seat binding does not match resolved transport');
      }
      const rebound = funding.mode === 'subscription-seat'
        ? subscriptionFunding({ seatDigest: seat.seatDigest, quotaCounters,
          quotaSurface: funding.quotaSurface })
        : funding.mode === 'metered-api'
          ? meteredFunding({ meteredReceiptDigest: funding.meteredReceiptDigest!,
            approvedUsdCeiling: funding.approvedUsdCeiling!, quotaCounters })
          : offlineFunding({ quotaCounters });
      return { seat, funding: rebound };
    }
    const seatDigest = context.seatDigest;
    const seat: SeatBinding = { seatId: `${context.surface}:${seatDigest.slice(0, 12)}`, seatDigest, surface: context.surface };
    if (context.surface === 'lmstudio-local' || context.surface === 'ollama-cloud'
      || context.surface === 'lan-gateway-litellm') {
      return { seat, funding: offlineFunding({ quotaCounters }) };
    }
    if (context.surface === 'cliproxy-seat' || context.surface === 'kimi-cliproxy'
      || context.surface === 'codex-cli-seat' || context.surface === 'agy-cli-seat' || context.surface === 'command-code-cli-seat' || context.surface === 'grok-cli-seat'
      || context.surface === 'glm-coding-plan-seat'
      || context.surface.startsWith('kilo-')) {
      return { seat, funding: subscriptionFunding({ seatDigest, quotaCounters,
        quotaSurface: context.surface === 'codex-cli-seat' ? 'codex-cli-seat'
          : context.surface === 'agy-cli-seat' ? 'agy-cli-seat'
          : context.surface === 'command-code-cli-seat' ? 'command-code-cli-seat'
          : context.surface === 'grok-cli-seat' ? 'grok-cli-seat'
          : context.surface === 'glm-coding-plan-seat' ? 'glm-coding-plan-seat'
          : context.surface === 'cliproxy-seat' || context.surface === 'kimi-cliproxy'
            ? 'cliproxy-seat' : 'kilo-gateway-entitlement' }) };
    }
    const ceiling = Number(runtimeEnv.SINTER_METERED_APPROVED_USD_CEILING
      ?? runtimeEnv.LIMINAL_METERED_APPROVED_USD_CEILING);
    const receipt = runtimeEnv.SINTER_METERED_PRICE_RECEIPT_DIGEST
      ?? runtimeEnv.LIMINAL_METERED_PRICE_RECEIPT_DIGEST;
    if (!receipt || !Number.isFinite(ceiling) || ceiling <= 0) {
      throw new ExecutorAuthorityUnavailableError(`metered funding evidence missing for ${context.surface}`);
    }
    return { seat, funding: meteredFunding({ meteredReceiptDigest: receipt, approvedUsdCeiling: ceiling, quotaCounters }) };
  };

  const authority: HarnessTransportAuthority = {
    guard,
    readAttemptHistory: readHistory,
    reserveAttempt(context) {
      const { seat, funding } = binding(context);
      return issueExecutorReservation(registry, {
        reservationId: `reservation-${randomUUID()}`,
        runDigest, requestDigest: context.requestDigest, routeDigest: context.routeDigest,
        identity: context.resolvedIdentity, seat, funding, surface: context.surface,
        issuedAt: (options.now?.() ?? new Date()).toISOString(), nonce: mintNonce(),
      });
    },
    attestCompletion({ context, reservation, response }) {
      const usage = response.usage;
      const delta = {
        calls: 1,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        activeSeconds: response.durationMs / 1_000,
      };
      const nextCounters = {
        calls: counters.calls + 1,
        inputTokens: counters.inputTokens + delta.inputTokens,
        outputTokens: counters.outputTokens + delta.outputTokens,
        activeSeconds: counters.activeSeconds + delta.activeSeconds,
      };
      const { seat, funding } = binding(context, nextCounters);
      const issuedAt = (options.now?.() ?? new Date()).toISOString();
      const attestation = issueExecutorAttestation(registry, {
        attestationId: `attestation-${randomUUID()}`,
        runDigest: reservation?.subject.runDigest ?? runDigest,
        requestDigest: context.requestDigest,
        routeDigest: context.routeDigest,
        attemptDigest: sha256Hex(`${context.routeDigest}:${context.attemptOrdinal}:${issuedAt}`),
        attemptOrdinal: context.attemptOrdinal,
        fallbackOrdinal: context.fallbackOrdinal,
        retryOrdinal: context.retryOrdinal,
        priorTraceDigest: context.priorTraceDigest,
        policyTraceDigest: context.policyTraceDigest,
        requestedIdentity: context.requestedIdentity,
        resolvedIdentity: context.resolvedIdentity,
        effort: context.resolvedIdentity.effort,
        fallbackChain: context.fallbackChain,
        seat, funding, quotaSurface: funding.quotaSurface,
        issuedAt, nonce: mintNonce(), surface: context.surface,
        terminalReason: response.terminalReason,
        durationMs: response.durationMs,
        success: response.success,
        responseDigest: sha256Hex(response.content ?? ''),
        quotaCounterDelta: delta,
        exhaustionClass: exhaustionFor(response.terminalReason),
      });
      const receiptPath = join(attemptsDir, `${attestation.subject.attestationId}.json`);
      writeFileSync(receiptPath, JSON.stringify(attestation), { flag: 'wx', mode: 0o600 });
      counters = nextCounters;
      return attestation;
    },
  };
  return Object.freeze(authority);
}

let productionAuthority: HarnessTransportAuthority | undefined;
const bootstrappedAuthorities = new WeakSet<object>();

/** Mint a host-rooted authority pinned to one admitted campaign seat. */
export function bootstrapCampaignExecutorAuthority(
  binding: NonNullable<BootstrapOptions['binding']>,
): HarnessTransportAuthority {
  const authority = bootstrapExecutorAuthority({ rootDir: pinnedProductionHostAuthorityRoot(),
    requireExisting: true, binding });
  bootstrappedAuthorities.add(authority);
  return authority;
}

/** Explicit construction-only seam for isolated tests; product composition never calls it. */
export function bootstrapTestCampaignExecutorAuthority(
  binding: NonNullable<BootstrapOptions['binding']>, rootDir: string,
): HarnessTransportAuthority {
  if (process.env.NODE_ENV !== 'test') {
    throw new ExecutorAuthorityUnavailableError('test campaign authority is unavailable');
  }
  const authority = bootstrapExecutorAuthority({ rootDir, binding });
  bootstrappedAuthorities.add(authority);
  return authority;
}

/** One trust root shared by CLI, Studio, coordinator, and harness clients. */
export function getProductionExecutorAuthority(): HarnessTransportAuthority {
  if (!productionAuthority) {
    productionAuthority = bootstrapExecutorAuthority({ rootDir: pinnedProductionHostAuthorityRoot(),
      requireExisting: true });
    bootstrappedAuthorities.add(productionAuthority);
  }
  return productionAuthority;
}

export function isBootstrappedExecutorAuthority(authority: HarnessTransportAuthority): boolean {
  return bootstrappedAuthorities.has(authority);
}

/** Avoid writing operator trust material from unit tests while defaulting every real entrypoint. */
export function resolveRuntimeExecutorAuthority(
  explicit?: HarnessTransportAuthority,
): HarnessTransportAuthority | undefined {
  if (process.env.NODE_ENV === 'test' && !process.env.SINTER_EXECUTOR_AUTHORITY_ROOT) return explicit;
  if (explicit && !isBootstrappedExecutorAuthority(explicit)) {
    throw new ExecutorAuthorityUnavailableError('caller-constructed authority is not bound to the host trust root');
  }
  return explicit ?? getProductionExecutorAuthority();
}
