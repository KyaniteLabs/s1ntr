import { lstatSync, readFileSync, statSync } from 'node:fs';
import { sign, verify } from 'node:crypto';
import type { HostAdapterRegistry } from '../identity/hostAdapterRegistry.js';
import {
  pinnedGLMCodingPlanOwnerProvenancePath,
  pinnedGLMCodingPlanOwnerPublicKeyPath,
  pinnedGLMCodingPlanSeatPath,
  provisionGLMCodingPlanOwnerProvenance,
  provisionGLMCodingPlanSeat,
  type GLMCodingPlanCredentialResolver,
} from '../identity/GLMCodingPlanSeat.js';
import { loadPinnedProductionHostAuthority } from '../identity/executorAuthorityBootstrap.js';

export interface GLMCodingPlanProvisionResult {
  readonly bindingId: string;
  readonly credentialDigest: string;
  readonly ownerKeyId: string;
  readonly ownerProvenancePath: string;
  readonly ownerPublicKeyPath: string;
  readonly seatBindingPath: string;
}

function readPrivateRegularFile(filePath: string): Buffer {
  const link = lstatSync(filePath);
  const info = statSync(filePath);
  if (!link.isFile() || link.isSymbolicLink() || info.nlink !== 1
    || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('GLM_CODING_PLAN_OWNER_KEY_FILE_UNTRUSTED');
  }
  return readFileSync(filePath);
}

/** Explicit operator path for binding an owner-authorized Z.ai coding-plan seat. */
export function runGLMCodingPlanProvision(input: {
  readonly confirmedOwnerAuthorizedSubscription: boolean;
  readonly seatId: string;
  readonly expiresAt: string;
  readonly ownerPrivateKeyPath: string;
  readonly ownerPublicKeyPath: string;
  readonly registry?: HostAdapterRegistry;
  readonly credentialResolver?: GLMCodingPlanCredentialResolver;
  readonly now?: Date;
  readonly outputPaths?: {
    readonly provenance: string;
    readonly publicKey: string;
    readonly binding: string;
  };
}): GLMCodingPlanProvisionResult {
  if (!input.confirmedOwnerAuthorizedSubscription) {
    throw new Error('GLM_CODING_PLAN_OWNER_SUBSCRIPTION_CONFIRMATION_REQUIRED');
  }
  if (!input.seatId.trim()) throw new Error('GLM_CODING_PLAN_SEAT_ID_REQUIRED');
  const ownerPrivateKeyPem = readPrivateRegularFile(input.ownerPrivateKeyPath);
  const ownerPublicKeyPem = readPrivateRegularFile(input.ownerPublicKeyPath).toString('utf8');
  try {
    const probe = Buffer.from('sinter.glm-coding-plan.owner-key-pair.v1');
    if (!verify(null, probe, ownerPublicKeyPem, sign(null, probe, ownerPrivateKeyPem))) {
      throw new Error('mismatch');
    }
  } catch {
    throw new Error('GLM_CODING_PLAN_OWNER_KEY_PAIR_INVALID');
  }
  const registry = input.registry ?? loadPinnedProductionHostAuthority().registry;
  const paths = input.outputPaths ?? {
    provenance: pinnedGLMCodingPlanOwnerProvenancePath(),
    publicKey: pinnedGLMCodingPlanOwnerPublicKeyPath(),
    binding: pinnedGLMCodingPlanSeatPath(),
  };
  const provenance = provisionGLMCodingPlanOwnerProvenance({
    seatId: input.seatId, expiresAt: input.expiresAt, ownerPrivateKeyPem,
    ownerPublicKeyPem, credentialResolver: input.credentialResolver, now: input.now,
    provenancePath: paths.provenance, ownerPublicKeyPath: paths.publicKey,
  });
  const binding = provisionGLMCodingPlanSeat({ registry, seatId: input.seatId,
    expiresAt: input.expiresAt, credentialResolver: input.credentialResolver, now: input.now,
    outputPath: paths.binding, provenancePath: paths.provenance,
    ownerPublicKeyPath: paths.publicKey });
  return Object.freeze({ bindingId: binding.subject.bindingId,
    credentialDigest: binding.subject.credentialDigest,
    ownerKeyId: provenance.subject.ownerKeyId,
    ownerProvenancePath: paths.provenance, ownerPublicKeyPath: paths.publicKey,
    seatBindingPath: paths.binding });
}
