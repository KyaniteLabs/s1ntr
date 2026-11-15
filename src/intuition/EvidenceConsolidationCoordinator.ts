import {
  EVIDENCE_TRUST_CLASSES,
  type EvidenceTaint,
  type EvidenceTrustClass,
} from '../runtime-core/RecursiveImprovementContract.js';

export const CONSOLIDATION_SOURCES = [
  'memory', 'archive', 'taste', 'compost', 'pattern', 'dream',
  'operational', 'composition',
] as const;
export type ConsolidationSource = typeof CONSOLIDATION_SOURCES[number];
export type EvidenceStance = 'support' | 'contradict';

export interface ConsolidationEvidence {
  id: string;
  hypothesisKey: string;
  claim: string;
  falsifier: string;
  source: ConsolidationSource;
  sourceRef: string;
  lineageId: string;
  stance: EvidenceStance;
  confidence: number;
  observedAt: string;
  trust: EvidenceTrustClass;
  taint: EvidenceTaint;
  retryOwner?: string;
  retryAttempt?: number;
}

export interface ConsolidatedHypothesis {
  key: string;
  claim: string;
  falsifier: string;
  status: 'ready' | 'insufficient' | 'contradicted' | 'retry';
  confidence: number;
  citations: ConsolidationEvidence[];
  supportingSources: ConsolidationSource[];
  corroboratingSources: ConsolidationSource[];
  /**
   * Distinct root lineages (lineageId) behind clean, trusted support. Two
   * source categories derived from one root count as ONE root here.
   */
  corroboratingRoots: string[];
  disagreements: ConsolidationEvidence[];
  trust: EvidenceTrustClass;
  taint: EvidenceTaint;
  retry?: { owner: string; attempt: number; nextRetryAt: string };
  expiresAt: string;
}

export interface EvidenceConsolidationConfig {
  minSources?: number;
  readyConfidence?: number;
  maxAgeDays?: number;
  maxHypotheses?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface EvidenceConsolidationResult {
  evidenceProcessed: number;
  duplicateEvidence: number;
  rejectedEvidence: number;
  hypotheses: ConsolidatedHypothesis[];
}

const DEFAULTS: Required<EvidenceConsolidationConfig> = {
  minSources: 2,
  readyConfidence: 0.55,
  maxAgeDays: 30,
  maxHypotheses: 20,
  maxRetries: 2,
  retryDelayMs: 86_400_000,
};

const TRUST_WEIGHT: Record<EvidenceTrustClass, number> = {
  owner: 1,
  'verified-system': 1,
  'model-inference': 0.65,
  'untrusted-external': 0.15,
};

function validEvidence(evidence: ConsolidationEvidence): boolean {
  return Boolean(
    evidence.id && evidence.hypothesisKey && evidence.claim
    && evidence.falsifier && evidence.sourceRef && evidence.lineageId
    && Number.isFinite(evidence.confidence)
    && evidence.confidence >= 0 && evidence.confidence <= 1
    && Number.isFinite(Date.parse(evidence.observedAt))
    && CONSOLIDATION_SOURCES.includes(evidence.source)
    && ['support', 'contradict'].includes(evidence.stance)
    && EVIDENCE_TRUST_CLASSES.includes(evidence.trust)
    && ['clean', 'tainted'].includes(evidence.taint)
  );
}

/**
 * Consolidates evidence into ranked hypotheses.
 *
 * `status: 'ready'` means ready for CS review only — it never authorizes
 * promotion or execution by itself. Readiness requires `minSources` distinct
 * source categories AND `minSources` distinct root lineages among clean,
 * trusted support; tainted support is excluded from support entirely.
 */
export class EvidenceConsolidationCoordinator {
  private readonly config: Required<EvidenceConsolidationConfig>;

  constructor(config: EvidenceConsolidationConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  consolidate(
    input: readonly ConsolidationEvidence[],
    now = new Date(),
  ): EvidenceConsolidationResult {
    const unique = new Map<string, ConsolidationEvidence>();
    let rejectedEvidence = 0;
    for (const item of input) {
      if (!validEvidence(item)) {
        rejectedEvidence += 1;
      } else if (!unique.has(item.id)) {
        unique.set(item.id, structuredClone(item));
      } else if (JSON.stringify(unique.get(item.id)) !== JSON.stringify(item)) {
        rejectedEvidence += 1;
      }
    }
    const groups = new Map<string, ConsolidationEvidence[]>();
    for (const evidence of unique.values()) {
      const group = groups.get(evidence.hypothesisKey) ?? [];
      group.push(evidence);
      groups.set(evidence.hypothesisKey, group);
    }
    const hypotheses = [...groups.entries()]
      .map(([key, evidence]) => this.buildHypothesis(key, evidence, now))
      .sort((left, right) => (
        Number(right.status === 'ready') - Number(left.status === 'ready')
        || right.confidence - left.confidence
        || left.key.localeCompare(right.key)
      ))
      .slice(0, this.config.maxHypotheses);
    return {
      evidenceProcessed: unique.size,
      duplicateEvidence: input.length - unique.size - rejectedEvidence,
      rejectedEvidence,
      hypotheses,
    };
  }

  private buildHypothesis(
    key: string,
    evidence: ConsolidationEvidence[],
    now: Date,
  ): ConsolidatedHypothesis {
    const weight = (item: ConsolidationEvidence): number => {
      const ageDays = Math.max(0, now.getTime() - Date.parse(item.observedAt)) / 86_400_000;
      const retention = Math.max(0, 1 - ageDays / this.config.maxAgeDays);
      const taint = item.taint === 'clean' ? 1 : 0.25;
      return item.confidence * TRUST_WEIGHT[item.trust] * taint * retention;
    };
    const anchor = evidence.find(item => item.stance === 'support') ?? evidence[0];
    const sameProposition = (item: ConsolidationEvidence): boolean =>
      item.claim === anchor.claim && item.falsifier === anchor.falsifier;
    const supporting = evidence.filter(item =>
      item.stance === 'support' && sameProposition(item));
    const disagreements = evidence.filter(item =>
      item.stance === 'contradict' || !sameProposition(item));
    // Tainted support is excluded outright, not discounted (#1254).
    const cleanSupporting = supporting.filter(item => item.taint === 'clean');
    const supportWeight = cleanSupporting.reduce((sum, item) => sum + weight(item), 0);
    const contradictionWeight = disagreements.reduce((sum, item) => sum + weight(item), 0);
    const sources = [...new Set(supporting.map(item => item.source))];
    const corroborating = cleanSupporting
      .filter(item => item.trust !== 'untrusted-external');
    const corroboratingSources = [...new Set(corroborating.map(item => item.source))];
    const corroboratingRoots = [...new Set(corroborating.map(item => item.lineageId))];
    const authoritative = supporting.some(item =>
      item.taint === 'clean' && ['owner', 'verified-system'].includes(item.trust));
    const averageSupport = cleanSupporting.length > 0
      ? supportWeight / cleanSupporting.length
      : 0;
    const averageContradiction = disagreements.length > 0
      ? contradictionWeight / disagreements.length
      : 0;
    const confidence = Math.max(0, averageSupport - averageContradiction);
    const contradicted = contradictionWeight >= supportWeight && contradictionWeight > 0;
    const ready = authoritative && corroboratingSources.length >= this.config.minSources
      && corroboratingRoots.length >= this.config.minSources
      && confidence >= this.config.readyConfidence && !contradicted;
    const retryEvidence = evidence.find(item =>
      item.retryOwner && (item.retryAttempt ?? 0) < this.config.maxRetries);
    const status = contradicted ? 'contradicted'
      : ready ? 'ready'
      : retryEvidence ? 'retry'
      : 'insufficient';
    return this.finishHypothesis(
      key, evidence, supporting, disagreements, sources,
      { sources: corroboratingSources, roots: corroboratingRoots }, confidence, status, retryEvidence, now,
    );
  }

  private finishHypothesis(
    key: string,
    evidence: ConsolidationEvidence[],
    supporting: ConsolidationEvidence[],
    disagreements: ConsolidationEvidence[],
    sources: ConsolidationSource[],
    corroborating: { sources: ConsolidationSource[]; roots: string[] },
    confidence: number,
    status: ConsolidatedHypothesis['status'],
    retryEvidence: ConsolidationEvidence | undefined,
    now: Date,
  ): ConsolidatedHypothesis {
    const lead = supporting[0] ?? evidence[0];
    const trusted = supporting.find(item => item.trust === 'owner')
      ?? supporting.find(item => item.trust === 'verified-system')
      ?? lead;
    const retry = status === 'retry' && retryEvidence?.retryOwner
      ? {
          owner: retryEvidence.retryOwner,
          attempt: (retryEvidence.retryAttempt ?? 0) + 1,
          nextRetryAt: new Date(now.getTime() + this.config.retryDelayMs).toISOString(),
        }
      : undefined;
    return {
      key,
      claim: lead.claim,
      falsifier: lead.falsifier,
      status,
      confidence: Number(confidence.toFixed(6)),
      citations: evidence.map(item => structuredClone(item)),
      supportingSources: sources,
      corroboratingSources: corroborating.sources,
      corroboratingRoots: corroborating.roots,
      disagreements: disagreements.map(item => structuredClone(item)),
      trust: trusted.trust,
      taint: evidence.some(item => item.taint === 'tainted') ? 'tainted' : 'clean',
      ...(retry ? { retry } : {}),
      expiresAt: new Date(now.getTime() + this.config.maxAgeDays * 86_400_000).toISOString(),
    };
  }
}
