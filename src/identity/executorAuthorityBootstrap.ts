import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalCliSeatUrl, isAgyGeminiModel, parseHermesSeat } from './cliSeatUrl.js';
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

/** Subscription models a cli://codex seat may name (exact ids, owner's Codex plan). */
const CODEX_SEAT_MODELS: ReadonlySet<string> = new Set([
  'gpt-6-luna', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol',
  'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol',
]);

/** Subscription models a cli://claude seat may name (exact ids, owner's Claude plan). */
const CLAUDE_SEAT_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
]);

function exactPath(baseUrl: string, path: string): boolean {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, '') === path;
  } catch {
    return false;
  }
}

function glmCodingPlanPathVerified(baseUrl: string): boolean {
  return exactPath(baseUrl, '/api/anthropic');
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
    readonly minimaxTokenPlanSeat?: boolean;
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
      && CODEX_SEAT_MODELS.has(options?.model ?? '')) {
      return 'codex-cli-seat';
    }
    if (provider === 'cli' && cliSeatUrl === 'cli://claude'
      && CLAUDE_SEAT_MODELS.has(options?.model ?? '')) {
      return 'claude-cli-seat';
    }
    // Hermes runs with its fallback chain off (--ignore-user-config), so the
    // named model is the one that answers. The openai-codex provider is the
    // flat-rate ChatGPT/Codex subscription login, so it is a subscription seat.
    // Every other Hermes provider (openai-api included) fronts API keys: funding
    // stays metered and needs the same receipt + ceiling as any API call.
    if (provider === 'cli') {
      const hermes = parseHermesSeat(baseUrl);
      if (hermes) return hermes.provider === 'openai-codex' ? 'hermes-codex-seat' : 'hermes-cli-seat';
    }
    if (provider === 'cli' && cliSeatUrl === 'cli://agy'
      && isAgyGeminiModel(options?.model)) return 'agy-cli-seat';
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
  // A MiniMax Token Plan seat (flat subscription, the plan gjc uses) is
  // caller-declared on the exact api.minimax.io Anthropic-compatible endpoint.
  // An undeclared key on the same host stays minimax-direct (metered).
  if (options?.minimaxTokenPlanSeat === true && protocol === 'https:' && hostname === 'api.minimax.io'
    && provider === 'minimax' && (port === '' || port === '443')
    && exactPath(baseUrl, '/anthropic')) {
    return 'minimax-token-plan-seat';
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
  ['cliproxy-seat', true], ['kimi-cliproxy', true], ['codex-cli-seat', true], ['claude-cli-seat', true], ['agy-cli-seat', true], ['command-code-cli-seat', true], ['grok-cli-seat', true], ['hermes-cli-seat', true], ['hermes-codex-seat', true], ['kilo-gateway-entitlement', true],
  ['openai-direct', true], ['anthropic-direct', true], ['google-direct', true],
  ['glm-direct', true], ['glm-coding-plan-seat', true], ['minimax-token-plan-seat', true], ['minimax-direct', true],
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

/**
 * A Hermes openai-codex seat is subscription funded only while the Hermes login
 * is a live ChatGPT subscription login. The URL alone proves nothing: an
 * API-key login or a lapsed subscription behind the same URL would spend
 * metered credit. Read Hermes's own auth store each attempt; fail closed.
 */
function assertHermesCodexSubscription(env: NodeJS.ProcessEnv, now: Date): void {
  const home = env.HERMES_HOME?.trim() || join(homedir(), '.hermes');
  let entry: { auth_mode?: unknown; last_refresh?: unknown; tokens?: Record<string, unknown> } | undefined;
  try {
    const store = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')) as
      { providers?: Record<string, typeof entry> };
    entry = store.providers?.['openai-codex'];
  } catch {
    throw new ExecutorAuthorityUnavailableError('hermes-codex-seat needs a readable Hermes login (auth.json)');
  }
  const tokens = entry?.tokens;
  if (entry?.auth_mode !== 'chatgpt' || typeof tokens?.refresh_token !== 'string' || !tokens.refresh_token
    || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new ExecutorAuthorityUnavailableError(
      'hermes-codex-seat is not a ChatGPT subscription login (refusing API-key or incomplete login)');
  }
  // Only the access token is kept fresh; the id_token is stale by design.
  let claims: { exp?: unknown; 'https://api.openai.com/auth'?: { chatgpt_plan_type?: unknown } } = {};
  try {
    claims = JSON.parse(Buffer.from(String(tokens.access_token).split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch { /* unreadable token carries no plan claim */ }
  const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
  if (typeof plan !== 'string' || !plan) {
    throw new ExecutorAuthorityUnavailableError('hermes-codex-seat token has no ChatGPT plan claim');
  }
  // An expired access token is normal between refreshes; a long-stale refresh is a dead login.
  const lastRefresh = Date.parse(String(entry.last_refresh ?? ''));
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : NaN;
  if (!(exp > now.getTime()) && !(now.getTime() - lastRefresh < 30 * 86_400_000)) {
    throw new ExecutorAuthorityUnavailableError('hermes-codex-seat login has lapsed (refresh it with hermes login)');
  }
}

function exhaustionFor(reason?: string): ExhaustionClass | undefined {
  if (!reason) return undefined;
  if (/quota|billing cycle|usage limit/i.test(reason)) return 'subscription-quota-exhausted';
  if (/rate.?limit|429/i.test(reason)) return 'rate-limited';
  if (/auth|credential|401|403/i.test(reason)) return 'seat-unavailable';
  if (/spend|budget|ceiling/i.test(reason)) return 'metered-spend-exhausted';
  return 'capacity-unknown';
}

/**
 * An unknown-surface ledger record must show up in the event ledger, not only on stderr,
 * so a surface this build no longer knows cannot hide. Best effort and bounded:
 * the surface is hashed (the raw name is host-controlled text) and telemetry
 * never breaks bootstrap (#1783).
 */
function recordUnknownSurface(file: string, attestation: ExecutorAttestation): void {
  void import('../telemetry/EventLedger.js')
    .then(({ recordEvent }) => recordEvent({
      event: 'identity.ledgerRecordUnknownSurface',
      model: null, provider: null, role: null, runId: null, episodeId: null, domain: null,
      inputHash: null, verdict: 'warning', latencyMs: null, costUsd: null, evidenceRefs: [],
      payload: {
        reason: 'unknown-surface',
        file,
        attestationId: attestation.subject.attestationId,
        surfaceSha256: sha256Hex(String(attestation.subject.surface)),
        issuedAt: attestation.subject.issuedAt,
      },
    }))
    .catch(() => { /* telemetry must never break bootstrap */ });
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
  const reportedSkips = new Set<string>();
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
      const verified = verifyExecutorAttestation(registry, attestation, attestation.subject.issuedAt,
        { historical: true });
      const unknownSurface = !verified.ok && verified.reason === 'wrong-surface';
      if (unknownSurface) {
        // Reached only after the signature, key and expiry checks passed, so the
        // record is authentic: a surface this build no longer knows. Only adapter
        // resolution is skipped. The record stays in history so its quota counters,
        // terminal reason and exhaustion class keep counting; a forged or foreign
        // record still fails closed below (#1783).
        // eslint-disable-next-line no-console -- intentional operator diagnostic for a stale record
        console.warn(`[executor-authority] authentic attempt record of an unknown surface kept as history: ${name} (${verified.detail})`);
        if (!reportedSkips.has(name)) {
          reportedSkips.add(name);
          recordUnknownSurface(name, attestation);
        }
      }
      if (!verified.ok && !unknownSurface) throw new ExecutorAuthorityUnavailableError(`attempt ledger verification failed: ${verified.reason}`);
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
    if (context.surface === 'hermes-codex-seat') {
      assertHermesCodexSubscription(runtimeEnv, options.now?.() ?? new Date());
    }
    const seat: SeatBinding = { seatId: `${context.surface}:${seatDigest.slice(0, 12)}`, seatDigest, surface: context.surface };
    if (context.surface === 'lmstudio-local' || context.surface === 'ollama-cloud'
      || context.surface === 'lan-gateway-litellm') {
      return { seat, funding: offlineFunding({ quotaCounters }) };
    }
    if (context.surface === 'cliproxy-seat' || context.surface === 'kimi-cliproxy'
      || context.surface === 'codex-cli-seat' || context.surface === 'claude-cli-seat' || context.surface === 'agy-cli-seat' || context.surface === 'command-code-cli-seat' || context.surface === 'grok-cli-seat'
      || context.surface === 'hermes-codex-seat' || context.surface === 'glm-coding-plan-seat' || context.surface === 'minimax-token-plan-seat'
      || context.surface.startsWith('kilo-')) {
      return { seat, funding: subscriptionFunding({ seatDigest, quotaCounters,
        quotaSurface: context.surface === 'codex-cli-seat' ? 'codex-cli-seat'
          : context.surface === 'claude-cli-seat' ? 'claude-cli-seat'
          : context.surface === 'agy-cli-seat' ? 'agy-cli-seat'
          : context.surface === 'command-code-cli-seat' ? 'command-code-cli-seat'
          : context.surface === 'grok-cli-seat' ? 'grok-cli-seat'
          : context.surface === 'hermes-codex-seat' ? 'hermes-codex-seat'
          : context.surface === 'glm-coding-plan-seat' ? 'glm-coding-plan-seat'
          : context.surface === 'minimax-token-plan-seat' ? 'minimax-token-plan-seat'
          : context.surface === 'cliproxy-seat' || context.surface === 'kimi-cliproxy'
            ? 'cliproxy-seat' : 'kilo-gateway-entitlement' }) };
    }
    const ceiling = Number(runtimeEnv.SINTER_METERED_APPROVED_USD_CEILING
      ?? runtimeEnv.LIMINAL_METERED_APPROVED_USD_CEILING);
    const receipt = runtimeEnv.SINTER_METERED_PRICE_RECEIPT_DIGEST
      ?? runtimeEnv.LIMINAL_METERED_PRICE_RECEIPT_DIGEST;
    if (!receipt || !Number.isFinite(ceiling) || ceiling <= 0) {
      throw new ExecutorAuthorityUnavailableError(`metered funding evidence missing for ${context.surface}: supply SINTER_METERED_APPROVED_USD_CEILING (a positive USD amount) and SINTER_METERED_PRICE_RECEIPT_DIGEST (the price receipt digest) to approve metered spend`);
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

/**
 * One trust root shared by CLI, Studio, coordinator, and harness clients.
 * The signing side mints the host key on first run (0700 dir, 0600 file);
 * verification and campaign paths keep requireExisting, so a fresh key can
 * never vouch for receipts or seats it did not sign.
 */
export function getProductionExecutorAuthority(): HarnessTransportAuthority {
  if (!productionAuthority) {
    productionAuthority = bootstrapExecutorAuthority({ rootDir: pinnedProductionHostAuthorityRoot() });
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
