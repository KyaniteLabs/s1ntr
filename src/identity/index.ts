/**
 * Identity authority surface for W8C-03 (#716).
 *
 * Public entry points:
 *   - Canonical alias resolution: `resolveExecutorAlias`, `buildExecutorIdentity`, `LUNA_MODEL_ID`
 *   - Role eligibility boundary: `decideRoleEligibility`, `ROLE_ELIGIBILITY_POLICY_VERSION`
 *   - Immutable role-resolution trace: `freezeTrace`, `chainTrace`, `verifyTraceDigest`
 *   - Host-owned adapter registry + signing: `HostAdapterRegistry`, `mintTrustKey`
 *   - Reservation v1: `issueExecutorReservation`, `verifyExecutorReservation`, `ReservationTracker`
 *   - Attestation v1: `issueExecutorAttestation`, `verifyExecutorAttestation`, `verifyAttestationAgainstReservation`, `NonceLedger`
 *   - Transport guard: `HarnessTransportGuard`
 *   - Capability probes: `buildCapabilitySnapshot`, `kiloGatewayDenied`
 *   - Funding truth: `subscriptionFunding`, `meteredFunding`, `offlineFunding`, `terminalReasonForExhaustion`
 */

export * from './types.js';
export * from './canonicalAlias.js';
export * from './roleResolutionTrace.js';
export * from './roleEligibilityPolicy.js';
export * from './hostAdapterRegistry.js';
export * from './executorReservation.js';
export * from './executorAttestation.js';
export * from './harnessTransportGuard.js';
export * from './executorAuthorityBootstrap.js';
export * from './capabilityProbe.js';
export * from './fundingTruth.js';
