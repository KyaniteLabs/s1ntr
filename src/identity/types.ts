/**
 * Identity authority types for W8C-03 (#716).
 *
 * These types establish actual-executor, funding, quota, and role truth for
 * every provider transport. The harness must obtain a host-signed
 * {@link ExecutorReservationV1} before network access and verify a
 * host-signed {@link ExecutorAttestationV1} against it before consuming any
 * response. Luna (`gpt-5.6-luna`) is permanently ineligible for the harness
 * role, including inheritance, fallback, retry, migration, and restart paths.
 *
 * Spec: `.omx/plans/prd-wave8-closure-wave9-admission.md` (W8C-03).
 */

/**
 * Runtime model role. `studio` is the chat role. The harness role is the only
 * one that may mutate MetaHarness state; it is never Luna-eligible.
 */
export type ModelRole = 'generator' | 'evaluator' | 'harness' | 'studio';

/**
 * Logical provider surfaces a single physical endpoint can expose. Kilo, in
 * particular, exposes four distinct surfaces (web balance, gateway entitlement,
 * CLI entitlement, cliproxy seat) that must be probed independently — denial
 * on one cannot demote the others.
 */
export type ProviderSurface =
  | 'openai-direct'
  | 'anthropic-direct'
  | 'google-direct'
  | 'glm-direct'
  | 'glm-coding-plan-seat'
  | 'minimax-token-plan-seat'
  | 'minimax-direct'
  | 'moonshot-direct'
  | 'kimi-cliproxy'
  | 'codex-cli-seat'
  | 'claude-cli-seat'
  | 'agy-cli-seat'
  | 'command-code-cli-seat'
  | 'grok-cli-seat'
  | 'hermes-cli-seat'
  | 'kilo-web-balance'
  | 'kilo-gateway-entitlement'
  | 'kilo-cli-entitlement'
  | 'cliproxy-seat'
  | 'ollama-cloud'
  | 'lmstudio-local'
  | 'lan-gateway-litellm'
  | 'openrouter'
  | 'unknown';

/**
 * Authentication/identity provider family. Decoupled from {@link ProviderSurface}
 * because a single provider (e.g. OpenAI) can be reached through multiple
 * surfaces (direct API, cliproxy seat, Kilo gateway passthrough).
 */
export type ProviderFamily =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'glm'
  | 'minimax'
  | 'moonshot'
  | 'kimi'
  | 'kilo'
  | 'ollama'
  | 'lmstudio'
  | 'openrouter'
  | 'unknown';

/**
 * Normalized model effort. Hides vendor-specific vocabulary (`reasoning_effort`,
 * `thinking.budget_tokens`, etc.) behind one canonical scale.
 */
export type ModelEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Funding mode for a transport. Subscription evidence must bind the seat /
 * resource-budget digest and quota counters; metered evidence must bind its
 * current-price receipt and an approved USD ceiling. `spendUsd: 0` is not
 * accepted as deterministic no-spend proof for either mode.
 */
export type FundingMode = 'subscription-seat' | 'metered-api' | 'offline-local';

/**
 * Quota surface a denial or exhaustion event is attributed to. Mirrors
 * {@link ProviderSurface} but is narrowed to surfaces that actually meter
 * usage.
 */
export type QuotaSurface =
  | 'cliproxy-seat'
  | 'codex-cli-seat'
  | 'claude-cli-seat'
  | 'agy-cli-seat'
  | 'command-code-cli-seat'
  | 'grok-cli-seat'
  | 'kilo-gateway-entitlement'
  | 'kilo-cli-entitlement'
  | 'kilo-web-balance'
  | 'metered-api'
  | 'glm-coding-plan-seat'
  | 'minimax-token-plan-seat'
  | 'subscription-seat'
  | 'local';

/**
 * Exhaustion class. Subscription quota exhaustion and metered spend exhaustion
 * are distinct terminal reasons and must not be conflated.
 */
export type ExhaustionClass =
  | 'subscription-quota-exhausted'
  | 'metered-spend-exhausted'
  | 'rate-limited'
  | 'seat-unavailable'
  | 'capacity-unknown';

/**
 * Seat/credential binding for an executor. The {@link seatDigest} binds the
 * resolved credential material without persisting raw secrets.
 */
export interface SeatBinding {
  readonly seatId: string;
  readonly seatDigest: string;
  readonly surface: ProviderSurface;
}

/**
 * Canonical executor identity after alias resolution. The {@link alias} is the
 * input form; {@link canonicalModel} is the normalized form the host trusts.
 */
export interface ExecutorIdentity {
  readonly provider: ProviderFamily;
  readonly model: string;
  readonly effort: ModelEffort;
  readonly alias?: string;
}

/**
 * Funding/quota truth attached to every transport.
 */
export interface FundingTruth {
  readonly mode: FundingMode;
  readonly quotaSurface: QuotaSurface;
  readonly seatDigest?: string;
  readonly resourceBudgetDigest?: string;
  readonly quotaCounters: Readonly<QuotaCounters>;
  readonly meteredReceiptDigest?: string;
  readonly approvedUsdCeiling?: number;
}

/**
 * Resource counters reported atomically with each transport. Subscription
 * evidence binds these; metered evidence records incremental spend.
 */
export interface QuotaCounters {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly activeSeconds: number;
}

/**
 * Source layer that produced a role configuration. The eligibility policy must
 * govern each layer uniformly.
 */
export type ConfigSourceLayer =
  | 'project-config'
  | 'user-config'
  | 'role-specific-env-override'
  | 'generic-env-override'
  | 'default-inheritance'
  | 'generator-to-harness-inheritance'
  | 'fallbacks-harness'
  | 'internal-retry'
  | 'persisted-restart-hydration'
  | 'explicit-harness-client'
  | 'legacy-config-conversion';

/**
 * Lifecycle phase at which the eligibility policy is invoked. Skipping any
 * phase fails closed.
 */
export type EligibilityPhase =
  | 'config-mutation'
  | 'provider-construction'
  | 'post-merged-resolution'
  | 'pre-primary-transport'
  | 'pre-fallback-transport'
  | 'pre-retry-transport'
  | 'pre-harness-client-construction'
  | 'pre-restart-hydration';

/**
 * Typed postcondition failure reasons. Each is quarantine-worthy. The full
 * (attestation-intrinsic + transport-specific) set lives here so callers can
 * exhaustively switch over them. The transport guard's
 * `TransportPostconditionResult` re-uses this set, which is why both
 * attestation-intrinsic strings (`signature-invalid`, `expired`, ...) and
 * transport-only strings (`reservation-not-consumed`, ...) appear here.
 */
export type PostconditionFailureReason =
  // Intrinsic attestation failures surfaced through the postcondition gate.
  | 'signature-invalid'
  | 'schema-version-mismatch'
  | 'wrong-trust-key'
  | 'expired'
  | 'wrong-adapter'
  | 'wrong-surface'
  | 'effort-mismatch'
  | 'seat-mismatch'
  | 'identity-mismatch'
  | 'fallback-chain-incomplete'
  | 'hidden-fallback'
  // Transport-specific postcondition failures.
  | 'attestation-unsigned'
  | 'attestation-replayed'
  | 'attestation-nonce-burned'
  | 'attestation-effort-downgraded'
  | 'attestation-policy-rejection'
  | 'reservation-not-consumed'
  | 'reservation-self-asserted';
