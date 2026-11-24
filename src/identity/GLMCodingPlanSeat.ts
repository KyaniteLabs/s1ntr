import { execFileSync } from 'node:child_process';
import { sign, verify } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CampaignFundingCapacity } from '../creative-run/CampaignExecutionAuthority.js';
import type { HostAdapterRegistry } from './hostAdapterRegistry.js';
import { mintNonce, sha256Hex } from './hostAdapterRegistry.js';

export const GLM_CODING_PLAN_ENDPOINT = 'https://api.z.ai/api/anthropic';
export const GLM_CODING_PLAN_MODEL = 'glm-5.3';
/** Models the Z.ai coding plan serves on the same flat subscription. Each one
 *  still needs its own host-signed seat binding: a binding names exactly one
 *  model, and a client rides the plan only on the model its binding names.
 *  The owner's provenance attests the plan credential and keeps naming
 *  GLM_CODING_PLAN_MODEL as the plan's reference model. */
export const GLM_CODING_PLAN_MODELS = [GLM_CODING_PLAN_MODEL, 'glm-5.3-flash', 'glm-5.4'] as const;
export type GLMCodingPlanModel = typeof GLM_CODING_PLAN_MODELS[number];
export function isGLMCodingPlanModel(model: unknown): model is GLMCodingPlanModel {
  return (GLM_CODING_PLAN_MODELS as readonly unknown[]).includes(model);
}
export const GLM_CODING_PLAN_KEYCHAIN_SERVICE = 'pushing-dispatch';
export const GLM_CODING_PLAN_KEYCHAIN_ACCOUNT = 'zai_coding_plan_subscription';

export interface GLMCodingPlanOwnerProvenanceSubject {
  readonly schemaVersion: 'glm-coding-plan-owner-provenance.v1';
  readonly product: 'zai-coding-plan';
  readonly keychainService: typeof GLM_CODING_PLAN_KEYCHAIN_SERVICE;
  readonly keychainAccount: typeof GLM_CODING_PLAN_KEYCHAIN_ACCOUNT;
  readonly seatId: string;
  readonly provider: 'glm';
  readonly model: typeof GLM_CODING_PLAN_MODEL;
  readonly endpointDigest: string;
  readonly credentialDigest: string;
  readonly ownerKeyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface GLMCodingPlanOwnerProvenance {
  readonly subject: GLMCodingPlanOwnerProvenanceSubject;
  readonly signatureBase64: string;
}

export interface GLMCodingPlanSeatSubject {
  readonly schemaVersion: 'glm-coding-plan-seat.v1';
  readonly bindingId: string;
  readonly seatId: string;
  readonly provider: 'glm';
  readonly model: GLMCodingPlanModel;
  readonly surface: 'glm-coding-plan-seat';
  readonly endpointDigest: string;
  readonly credentialDigest: string;
  readonly ownerProvenanceDigest: string;
  readonly quotaSurface: 'glm-coding-plan-seat';
  readonly fundingMode: 'subscription-seat';
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export interface GLMCodingPlanSeatBinding {
  readonly subject: GLMCodingPlanSeatSubject;
  readonly signature: string;
}

export type GLMCodingPlanCredentialResolver = () => string;

export interface GLMCodingPlanTransportTrust {
  readonly registry: HostAdapterRegistry;
  readonly bindingPath?: string;
  readonly provenancePath?: string;
  readonly ownerPublicKeyPath?: string;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
}

let testTransportTrust: GLMCodingPlanTransportTrust | undefined;

export function installGLMCodingPlanTransportTrustForTests(
  trust: GLMCodingPlanTransportTrust,
): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('GLM_CODING_PLAN_TEST_TRUST_FORBIDDEN');
  if (testTransportTrust) throw new Error('GLM_CODING_PLAN_TEST_TRUST_ALREADY_INSTALLED');
  testTransportTrust = trust;
  return () => { if (testTransportTrust === trust) testTransportTrust = undefined; };
}

export function currentGLMCodingPlanTransportTestTrust(): GLMCodingPlanTransportTrust | undefined {
  return testTransportTrust;
}

export function pinnedGLMCodingPlanSeatPath(model: GLMCodingPlanModel = GLM_CODING_PLAN_MODEL): string {
  return join(homedir(), '.sinter', 'glm-coding-plan',
    model === GLM_CODING_PLAN_MODEL ? 'seat-binding.json' : `seat-binding.${model}.json`);
}

export function pinnedGLMCodingPlanOwnerProvenancePath(): string {
  return join(homedir(), '.sinter', 'glm-coding-plan', 'owner-provenance.json');
}

export function pinnedGLMCodingPlanOwnerPublicKeyPath(): string {
  return join(homedir(), '.sinter', 'glm-coding-plan', 'owner-public.pem');
}

export function resolveDedicatedGLMCodingPlanCredential(): string {
  // macOS: the credential lives in Keychain. Linux hosts: the dedicated credential
  // file (0600, owner-only) carries the same secret — no keychain exists there.
  if (process.platform === 'darwin') {
    const value = execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', GLM_CODING_PLAN_KEYCHAIN_SERVICE,
      '-a', GLM_CODING_PLAN_KEYCHAIN_ACCOUNT, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!value) throw new Error('GLM_CODING_PLAN_DEDICATED_CREDENTIAL_MISSING');
    return value;
  }
  const credPath = join(homedir(), '.sinter', 'glm-coding-plan', 'credential');
  const value = readFileSync(credPath, 'utf8').trim();
  assertPrivateRegularFile(credPath);
  if (!value) throw new Error('GLM_CODING_PLAN_DEDICATED_CREDENTIAL_MISSING');
  return value;
}

function assertPrivateRegularFile(filePath: string): void {
  const link = lstatSync(filePath);
  const info = statSync(filePath);
  if (!link.isFile() || link.isSymbolicLink() || info.nlink !== 1
    || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('GLM_CODING_PLAN_BINDING_FILE_UNTRUSTED');
  }
}

function endpointDigest(): string {
  return sha256Hex(GLM_CODING_PLAN_ENDPOINT);
}

function writePrivateAtomic(outputPath: string, content: string): void {
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(outputPath), 0o700);
  const temporary = `${outputPath}.${process.pid}.${mintNonce()}.tmp`;
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o600);
}

export function provisionGLMCodingPlanOwnerProvenance(input: {
  readonly seatId: string;
  readonly expiresAt: string;
  readonly ownerPrivateKeyPem: string | Buffer;
  readonly ownerPublicKeyPem: string;
  readonly now?: Date;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
  readonly provenancePath?: string;
  readonly ownerPublicKeyPath?: string;
}): GLMCodingPlanOwnerProvenance {
  const now = input.now ?? new Date();
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error('GLM_CODING_PLAN_OWNER_PROVENANCE_EXPIRY_INVALID');
  }
  const credential = (input.credentialResolver ?? resolveDedicatedGLMCodingPlanCredential)();
  const subject: GLMCodingPlanOwnerProvenanceSubject = Object.freeze({
    schemaVersion: 'glm-coding-plan-owner-provenance.v1', product: 'zai-coding-plan',
    keychainService: GLM_CODING_PLAN_KEYCHAIN_SERVICE,
    keychainAccount: GLM_CODING_PLAN_KEYCHAIN_ACCOUNT, seatId: input.seatId,
    provider: 'glm', model: GLM_CODING_PLAN_MODEL, endpointDigest: endpointDigest(),
    credentialDigest: sha256Hex(credential), ownerKeyId: sha256Hex(input.ownerPublicKeyPem),
    issuedAt: now.toISOString(), expiresAt: input.expiresAt, nonce: mintNonce(),
  });
  const provenance = Object.freeze({ subject,
    signatureBase64: sign(null, Buffer.from(JSON.stringify(subject)), input.ownerPrivateKeyPem).toString('base64') });
  const publicKeyPath = input.ownerPublicKeyPath ?? pinnedGLMCodingPlanOwnerPublicKeyPath();
  if (existsSync(publicKeyPath)) {
    assertPrivateRegularFile(publicKeyPath);
    if (readFileSync(publicKeyPath, 'utf8') !== input.ownerPublicKeyPem) {
      throw new Error('GLM_CODING_PLAN_OWNER_TRUST_REPLACEMENT_FORBIDDEN');
    }
  } else {
    writePrivateAtomic(publicKeyPath, input.ownerPublicKeyPem);
  }
  writePrivateAtomic(input.provenancePath ?? pinnedGLMCodingPlanOwnerProvenancePath(),
    JSON.stringify(provenance));
  return provenance;
}

export function loadGLMCodingPlanOwnerProvenance(input: {
  readonly seatId: string;
  readonly now?: Date;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
  readonly provenancePath?: string;
  readonly ownerPublicKeyPath?: string;
}): GLMCodingPlanOwnerProvenance {
  const provenancePath = input.provenancePath ?? pinnedGLMCodingPlanOwnerProvenancePath();
  const publicKeyPath = input.ownerPublicKeyPath ?? pinnedGLMCodingPlanOwnerPublicKeyPath();
  assertPrivateRegularFile(provenancePath);
  assertPrivateRegularFile(publicKeyPath);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as GLMCodingPlanOwnerProvenance;
  const publicKey = readFileSync(publicKeyPath, 'utf8');
  const subject = provenance?.subject;
  const now = input.now ?? new Date();
  const issuedAt = Date.parse(subject?.issuedAt ?? '');
  const expiresAt = Date.parse(subject?.expiresAt ?? '');
  const credential = (input.credentialResolver ?? resolveDedicatedGLMCodingPlanCredential)();
  if (!subject || subject.schemaVersion !== 'glm-coding-plan-owner-provenance.v1'
    || subject.product !== 'zai-coding-plan'
    || subject.keychainService !== GLM_CODING_PLAN_KEYCHAIN_SERVICE
    || subject.keychainAccount !== GLM_CODING_PLAN_KEYCHAIN_ACCOUNT
    || subject.seatId !== input.seatId || subject.provider !== 'glm'
    || subject.model !== GLM_CODING_PLAN_MODEL || subject.endpointDigest !== endpointDigest()
    || subject.credentialDigest !== sha256Hex(credential) || subject.ownerKeyId !== sha256Hex(publicKey)
    || !Number.isFinite(now.getTime()) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now.getTime() || expiresAt <= now.getTime()
    || typeof provenance.signatureBase64 !== 'string'
    || !verify(null, Buffer.from(JSON.stringify(subject)), publicKey,
      Buffer.from(provenance.signatureBase64, 'base64'))) {
    throw new Error('GLM_CODING_PLAN_OWNER_PROVENANCE_INVALID');
  }
  return provenance;
}

function assertCurrent(subject: GLMCodingPlanSeatSubject, now: Date): void {
  const issuedAt = Date.parse(subject.issuedAt);
  const expiresAt = Date.parse(subject.expiresAt);
  if (subject.provider !== 'glm' || !isGLMCodingPlanModel(subject.model)
    || subject.surface !== 'glm-coding-plan-seat'
    || subject.endpointDigest !== endpointDigest()
    || subject.quotaSurface !== 'glm-coding-plan-seat'
    || subject.fundingMode !== 'subscription-seat'
    || !Number.isFinite(now.getTime()) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now.getTime() || expiresAt <= now.getTime()) {
    throw new Error('GLM_CODING_PLAN_BINDING_SUBJECT_INVALID');
  }
}

export function provisionGLMCodingPlanSeat(input: {
  readonly registry: HostAdapterRegistry;
  readonly seatId: string;
  readonly expiresAt: string;
  readonly now?: Date;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
  readonly outputPath?: string;
  readonly provenancePath?: string;
  readonly ownerPublicKeyPath?: string;
  readonly model?: GLMCodingPlanModel;
}): GLMCodingPlanSeatBinding {
  const model = input.model ?? GLM_CODING_PLAN_MODEL;
  if (!isGLMCodingPlanModel(model)) throw new Error('GLM_CODING_PLAN_MODEL_NOT_ON_PLAN');
  const now = input.now ?? new Date();
  const credential = (input.credentialResolver ?? resolveDedicatedGLMCodingPlanCredential)();
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error('GLM_CODING_PLAN_BINDING_EXPIRY_INVALID');
  }
  const provenance = loadGLMCodingPlanOwnerProvenance({ seatId: input.seatId, now,
    credentialResolver: () => credential, provenancePath: input.provenancePath,
    ownerPublicKeyPath: input.ownerPublicKeyPath });
  const subject: GLMCodingPlanSeatSubject = Object.freeze({
    schemaVersion: 'glm-coding-plan-seat.v1',
    bindingId: model === GLM_CODING_PLAN_MODEL ? `glm-coding-plan:${input.seatId}`
      : `glm-coding-plan:${input.seatId}:${model}`,
    seatId: input.seatId, provider: 'glm', model,
    surface: 'glm-coding-plan-seat', endpointDigest: endpointDigest(),
    credentialDigest: sha256Hex(credential),
    ownerProvenanceDigest: sha256Hex(JSON.stringify(provenance)),
    quotaSurface: 'glm-coding-plan-seat',
    fundingMode: 'subscription-seat', issuer: input.registry.keyId,
    issuedAt: now.toISOString(), expiresAt: input.expiresAt, nonce: mintNonce(),
  });
  const binding = Object.freeze({ subject,
    signature: input.registry.issueGLMCodingPlanSeatSignature(subject) });
  const outputPath = input.outputPath ?? pinnedGLMCodingPlanSeatPath(model);
  writePrivateAtomic(outputPath, JSON.stringify(binding));
  return binding;
}

export function loadGLMCodingPlanSeat(input: {
  readonly registry: HostAdapterRegistry;
  readonly now?: Date;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
  readonly bindingPath?: string;
  readonly provenancePath?: string;
  readonly ownerPublicKeyPath?: string;
  /** The model the caller will ride; its binding must name exactly it. */
  readonly model?: GLMCodingPlanModel;
}): { readonly binding: GLMCodingPlanSeatBinding; readonly credential: string } {
  const bindingPath = input.bindingPath ?? pinnedGLMCodingPlanSeatPath(input.model);
  assertPrivateRegularFile(bindingPath);
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as GLMCodingPlanSeatBinding;
  if (!binding?.subject || binding.subject.schemaVersion !== 'glm-coding-plan-seat.v1'
    || typeof binding.signature !== 'string'
    || !input.registry.verify(binding.subject, binding.signature)) {
    throw new Error('GLM_CODING_PLAN_BINDING_SIGNATURE_INVALID');
  }
  assertCurrent(binding.subject, input.now ?? new Date());
  if (input.model !== undefined && binding.subject.model !== input.model) {
    throw new Error('GLM_CODING_PLAN_BINDING_MODEL_MISMATCH');
  }
  const credential = (input.credentialResolver ?? resolveDedicatedGLMCodingPlanCredential)();
  if (sha256Hex(credential) !== binding.subject.credentialDigest) {
    throw new Error('GLM_CODING_PLAN_BINDING_CREDENTIAL_MISMATCH');
  }
  const provenance = loadGLMCodingPlanOwnerProvenance({ seatId: binding.subject.seatId,
    now: input.now, credentialResolver: () => credential, provenancePath: input.provenancePath,
    ownerPublicKeyPath: input.ownerPublicKeyPath });
  if (binding.subject.ownerProvenanceDigest !== sha256Hex(JSON.stringify(provenance))) {
    throw new Error('GLM_CODING_PLAN_BINDING_OWNER_PROVENANCE_MISMATCH');
  }
  return Object.freeze({ binding, credential });
}

export function assertGLMCodingPlanCapacity(
  capacity: CampaignFundingCapacity,
  registry: HostAdapterRegistry,
  options?: { readonly now?: Date; readonly credentialResolver?: GLMCodingPlanCredentialResolver;
    readonly bindingPath?: string; readonly provenancePath?: string;
    readonly ownerPublicKeyPath?: string },
): void {
  if (capacity.surface === 'glm-direct') {
    if (capacity.funding.mode !== 'metered-api' || capacity.funding.quotaSurface !== 'metered-api') {
      throw new Error('GLM_DIRECT_CAPACITY_MUST_BE_METERED');
    }
    return;
  }
  if (capacity.surface !== 'glm-coding-plan-seat') return;
  if (!isGLMCodingPlanModel(capacity.identity.model)) {
    throw new Error('GLM_CODING_PLAN_CAPACITY_BINDING_MISMATCH');
  }
  const { binding } = loadGLMCodingPlanSeat({ registry, ...options, model: capacity.identity.model });
  const subject = binding.subject;
  if (capacity.identity.provider !== 'glm' || capacity.identity.model !== subject.model
    || capacity.seat.seatId !== subject.seatId
    || capacity.seat.seatDigest !== subject.credentialDigest
    || capacity.seat.surface !== subject.surface
    || capacity.endpointDigest !== subject.endpointDigest
    || capacity.funding.mode !== 'subscription-seat'
    || capacity.funding.seatDigest !== subject.credentialDigest
    || capacity.funding.quotaSurface !== subject.quotaSurface) {
    throw new Error('GLM_CODING_PLAN_CAPACITY_BINDING_MISMATCH');
  }
}

export function assertGLMCodingPlanTransport(input: {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly seatId: string;
  readonly seatDigest: string;
  readonly registry: HostAdapterRegistry;
  readonly bindingPath?: string;
  readonly provenancePath?: string;
  readonly ownerPublicKeyPath?: string;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
}): 'glm-coding-plan-seat' {
  if (!isGLMCodingPlanModel(input.model)) throw new Error('GLM_CODING_PLAN_TRANSPORT_BINDING_MISMATCH');
  const { binding } = loadGLMCodingPlanSeat({ ...input, model: input.model });
  const subject = binding.subject;
  if (input.provider !== subject.provider || input.model !== subject.model
    || input.baseUrl.replace(/\/+$/, '') !== GLM_CODING_PLAN_ENDPOINT
    || sha256Hex(input.baseUrl.replace(/\/+$/, '')) !== subject.endpointDigest
    || input.seatId !== subject.seatId || input.seatDigest !== subject.credentialDigest) {
    throw new Error('GLM_CODING_PLAN_TRANSPORT_BINDING_MISMATCH');
  }
  return 'glm-coding-plan-seat';
}
