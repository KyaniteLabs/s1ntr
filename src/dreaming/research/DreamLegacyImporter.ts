import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { DreamResearchService } from './DreamResearchService.js';
import type { DreamExperimentPlan } from './DreamResearchTypes.js';

const KNOWN = new Set(['queue-v1', 'checkpoint-v1', 'recommendation-v1']);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export interface DreamLegacyImportReceipt {
  aggregateId: string;
  sourceKind: string;
  originalDigest: string;
  classification: 'historical-non-admissible';
}

export class DreamLegacyImporter {
  constructor(private readonly service: DreamResearchService) {}

  importFile(filePath: string, sourceKind: string): DreamLegacyImportReceipt {
    if (!KNOWN.has(sourceKind)) throw new Error('DREAM_LEGACY_SCHEMA_UNKNOWN');
    const bytes = fs.readFileSync(filePath);
    try { JSON.parse(bytes.toString('utf8')); } catch {
      throw new Error('DREAM_LEGACY_BYTES_INVALID');
    }
    const originalDigest = digest(bytes);
    const aggregateId = `legacy-${originalDigest}`;
    const plan = legacyPlan(aggregateId, originalDigest);
    this.service.plan(plan, `${aggregateId}:plan`);
    this.service.importHistorical(aggregateId, 1, `${aggregateId}:import`, {
      sourceKind, originalDigest, originalBase64: bytes.toString('base64') });
    return { aggregateId, sourceKind, originalDigest,
      classification: 'historical-non-admissible' };
  }
}

function legacyPlan(aggregateId: string, sourceDigest: string): DreamExperimentPlan {
  return { aggregateId, schemaVersion: 1, campaignId: 'historical-import',
    hypothesis: { id: 'historical', statement: 'Historical evidence only',
      principle: 'none', expectedEffect: 'none' },
    context: { sourceDigests: [sourceDigest], knowledgeProfileDigest: digest('none'),
      parentSetDigest: digest('none'), operatorDigest: digest('none'),
      policyDigest: digest('non-admissible'), rendererEnvironmentDigest: digest('unrendered'),
      evaluatorManifestDigests: [], transferCommitmentDigest: digest('none') },
    budget: { maximumAttempts: 0 }, requiredModalities: [],
    lease: { token: 'historical', fencingSequence: 0 } };
}
