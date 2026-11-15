/**
 * Fail-closed Wave 8 bind guards. Bind may not relabel compose evidence
 * onto the current tip, and may not mint owner-decision packets.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WAVE8_REQUIRED_OWNER_DECISIONS } from '../src/runtime-core/Wave8ReleaseRoot.js';

export const BIND_OWNER_DECISION_KINDS = WAVE8_REQUIRED_OWNER_DECISIONS;

export function normalizeSourceFingerprint(value: string): string {
  return value.replace(/^sha256:/, '');
}

export function stableBindJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableBindJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableBindJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function assertComposeBoundToCurrentSource(input: {
  readonly currentHead: string;
  readonly currentFingerprint: string;
  readonly composeHead: string;
  readonly composeFingerprint: string;
}): void {
  const currentHead = input.currentHead.trim();
  const composeHead = input.composeHead.trim();
  const currentFp = normalizeSourceFingerprint(input.currentFingerprint.trim());
  const composeFp = normalizeSourceFingerprint(input.composeFingerprint.trim());
  if (!currentHead || !composeHead || !currentFp || !composeFp) {
    throw new Error('compose-source-binding-missing');
  }
  if (currentHead !== composeHead || currentFp !== composeFp) {
    throw new Error(
      `compose-source-mismatch: current head=${currentHead} fp=${currentFp.slice(0, 16)} `
      + `compose head=${composeHead} fp=${composeFp.slice(0, 16)}. Rerun sinter compose; do not rebind.`,
    );
  }
}

export function readComposeSourceBinding(liveDir: string): {
  readonly head: string;
  readonly fingerprint: string;
} {
  const bootstrapPath = path.join(liveDir, 'bootstrap-release-root.json');
  const executionPath = path.join(liveDir, 'execution-config.json');
  if (!existsSync(bootstrapPath)) {
    throw new Error('compose-source-binding-missing: bootstrap-release-root.json');
  }
  const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as {
    releaseHead?: unknown;
    sourceFingerprint?: unknown;
  };
  const head = typeof bootstrap.releaseHead === 'string' ? bootstrap.releaseHead : '';
  const fingerprint = typeof bootstrap.sourceFingerprint === 'string' ? bootstrap.sourceFingerprint : '';
  if (!head || !fingerprint) {
    throw new Error('compose-source-binding-missing: bootstrap releaseHead/sourceFingerprint');
  }
  if (existsSync(executionPath)) {
    const execution = JSON.parse(readFileSync(executionPath, 'utf8')) as {
      preSpendPolicy?: { expectedSourceFingerprint?: unknown };
    };
    const expected = execution.preSpendPolicy?.expectedSourceFingerprint;
    if (typeof expected === 'string' && expected
      && normalizeSourceFingerprint(expected) !== normalizeSourceFingerprint(fingerprint)) {
      throw new Error('compose-execution-fingerprint-mismatch');
    }
  }
  return { head, fingerprint };
}

export interface VerifiedOwnerDecisionPackets {
  readonly kinds: readonly string[];
  readonly digests: readonly string[];
}

export function loadVerifiedOwnerDecisionPackets(input: {
  readonly packetsDir: string;
  readonly publicKeyPem: string;
  readonly currentHead: string;
  readonly currentFingerprint: string;
  readonly campaignSubjectDigest: string;
}): VerifiedOwnerDecisionPackets {
  if (!existsSync(input.packetsDir)) {
    throw new Error('owner-packets-missing');
  }
  const publicKey = createPublicKey(input.publicKeyPem);
  const currentFp = normalizeSourceFingerprint(input.currentFingerprint);
  const kinds: string[] = [];
  const digests: string[] = [];
  for (const kind of BIND_OWNER_DECISION_KINDS) {
    const packetPath = path.join(input.packetsDir, `${kind}.json`);
    if (!existsSync(packetPath)) {
      throw new Error(`owner-packets-incomplete: missing ${kind}`);
    }
    const packet = JSON.parse(readFileSync(packetPath, 'utf8')) as Record<string, unknown>;
    if (packet.schema !== 'sinter.owner-decision-packet' || packet.decisionKind !== kind) {
      throw new Error(`owner-packet-invalid: ${kind}`);
    }
    if (packet.subjectDigest !== input.campaignSubjectDigest) {
      throw new Error(`owner-packet-subject-mismatch: ${kind}`);
    }
    const packetHead = typeof packet.releaseHead === 'string' ? packet.releaseHead : '';
    const packetFp = typeof packet.sourceFingerprint === 'string'
      ? normalizeSourceFingerprint(packet.sourceFingerprint) : '';
    if (packetHead !== input.currentHead || packetFp !== currentFp) {
      throw new Error(`owner-packet-source-mismatch: ${kind}`);
    }
    const signatureBase64 = typeof packet.signatureBase64 === 'string' ? packet.signatureBase64 : '';
    const { signatureBase64: _sig, decisionDigest: claimedDigest, ...unsigned } = packet;
    if (!verify(null, Buffer.from(stableBindJson(unsigned)), publicKey, Buffer.from(signatureBase64, 'base64'))) {
      throw new Error(`owner-packet-signature-invalid: ${kind}`);
    }
    const decisionDigest = createHash('sha256').update(stableBindJson(unsigned)).digest('hex');
    if (claimedDigest !== decisionDigest) {
      throw new Error(`owner-packet-digest-mismatch: ${kind}`);
    }
    kinds.push(kind);
    digests.push(decisionDigest);
  }
  return { kinds, digests };
}
