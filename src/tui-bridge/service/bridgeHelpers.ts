/**
 * Extracted from TuiBridgeService.ts: small shared helpers.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import type { CreativeRunHandle } from '../../creative-run/CreativeRunCoordinator.js';
import { Logger } from '../../utils/Logger.js';

export function creativeIdentityFields(run: CreativeRunHandle): {
  creativeThesisId?: string;
  creativePrincipleId?: string;
  creativeContractVersion?: number;
  creativeProjectionDigest?: string;
} {
  const principle = run.creativeThesis?.principles[0]?.contractIdentity;
  return principle ? {
    creativeThesisId: run.creativeThesis?.thesisId,
    creativePrincipleId: principle.principleId,
    creativeContractVersion: principle.contractVersion,
    creativeProjectionDigest: principle.projectionDigest,
  } : {};
}

export function logBridge(event: string, fields: Record<string, unknown>): void {
  Logger.info('TuiBridgeService', `${event} ${JSON.stringify(fields)}`);
}
