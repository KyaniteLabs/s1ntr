/**
 * A/B test results and domain routing data for smart model selection.
 *
 * Based on A/B test results from March 2026:
 *
 * | Domain | Local (Qwen 3.5-4B) | Cloud (Minimax) | Winner |
 * |--------|---------------------|-----------------|--------|
 * | Music  | 0.523               | 0.236           | Local +121% |
 * | Code   | 0.503               | 0.460           | Local +9% |
 * | ASCII  | 0.363               | 0.531           | Cloud +46% |
 *
 * @module routing/RoutingData
 */

import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Logger } from '../utils/Logger.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { generatorBanditRouter } from './GeneratorBanditRouter.js';
import type { RoutingOutcomeAdmission } from './RoutingOutcomeAdmission.js';

/**
 * Record of a generation outcome for dynamic routing.
 */
export interface RoutingRecord {
  domain: DomainType;
  model: ModelChoice;
  qualityScore: number;
  timestamp: string;
  admission: RoutingOutcomeAdmission;
}

/**
 * Rolling performance data per domain and model.
 */
export interface RollingPerformance {
  local: { total: number; count: number };
  cloud: { total: number; count: number };
}

const PERFORMANCE_WINDOW = 50; // Keep last 50 records per domain
const perfDir = (): string => process.env.SINTER_ROUTING_DIR || path.join(homedir(), '.sinter', 'routing');

const hydrated = new Set<string>();

/**
 * Replay persisted, still-verifiable outcomes into the in-memory bandit (once per domain per process), so learning
 * survives a restart. Records whose signed admission no longer verifies are skipped, never trusted.
 */
export function hydrateRoutingBandit(domain: DomainType): number {
  if (hydrated.has(domain)) return 0;
  hydrated.add(domain);
  let n = 0;
  try {
    const records = JSON.parse(readFileSync(path.join(perfDir(), `${domain}.json`), 'utf-8')) as RoutingRecord[];
    for (const r of records) {
      try { generatorBanditRouter.recordOutcome(r.admission); n++; } catch { /* unverifiable: skip */ }
    }
  } catch { /* no history yet */ }
  return n;
}

/** Test hook: forget which domains were hydrated. */
export function resetRoutingHydration(): void { hydrated.clear(); }

/**
 * Record an owner-admitted generation outcome: persisted to ~/.sinter/routing/<domain>.json and fed to the
 * Thompson bandit. Production writer: LiminalProductCommandPort owner review. Reader: GeneratorRegistry.route()
 * behind LIMINAL_ROUTING_BANDIT.
 */
export async function recordRoutingOutcome(record: RoutingRecord): Promise<void> {
  if (record.admission.domain !== record.domain || record.admission.model !== record.model
    || record.admission.criterionScore !== record.qualityScore) {
    throw new Error('ROUTING_RECORD_ADMISSION_MISMATCH');
  }
  hydrateRoutingBandit(record.domain);
  const records = await loadRoutingRecords(record.domain);
  records.push(record);
  // Keep only the last PERFORMANCE_WINDOW records
  if (records.length > PERFORMANCE_WINDOW) {
    records.splice(0, records.length - PERFORMANCE_WINDOW);
  }
  const filePath = path.join(perfDir(), `${record.domain}.json`);
  await fs.mkdir(perfDir(), { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(records));

  // Feed the online bandit
  generatorBanditRouter.recordOutcome(record.admission);
}

/**
 * Load routing records for a domain.
 */
async function loadRoutingRecords(domain: DomainType): Promise<RoutingRecord[]> {
  try {
    const filePath = path.join(perfDir(), `${domain}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    Logger.warn('RoutingData', 'Failed to load routing records:', err);
    return [];
  }
}

/**
 * Get rolling performance averages for a domain based on actual generation outcomes.
 * Falls back to static AB_TEST_RESULTS if no dynamic data exists.
 */
export async function getRollingPerformance(domain: DomainType): Promise<RollingPerformance | null> {
  const records = await loadRoutingRecords(domain);
  if (records.length < 5) return null; // Not enough data

  const local: { total: number; count: number } = { total: 0, count: 0 };
  const cloud: { total: number; count: number } = { total: 0, count: 0 };

  for (const record of records) {
    if (record.model === 'local' || record.model === 'hybrid') {
      local.total += record.qualityScore;
      local.count++;
    }
    if (record.model === 'cloud' || record.model === 'hybrid') {
      cloud.total += record.qualityScore;
      cloud.count++;
    }
  }

  return { local, cloud };
}

/**
 * Get the optimal model for a domain using Thompson Sampling bandit.
 * Returns null if the bandit hasn't collected enough data yet
 * (caller should fall back to static DOMAIN_ROUTING_DATA).
 */
export function getOptimalModelBandit(domain: DomainType): ModelChoice | null {
  hydrateRoutingBandit(domain);
  if (!generatorBanditRouter.isReady(domain)) {
    return null;
  }
  return generatorBanditRouter.selectModel(domain);
}

/**
 * Get bandit statistics for monitoring/debugging.
 */
export function getBanditStats(domain: DomainType) {
  return generatorBanditRouter.getDomainStats(domain);
}

/**
 * Domain types supported by the smart router.
 */
export type DomainType = 'ascii' | 'music' | 'code' | 'visual' | 'revideo' | 'html' | 'webdev';

/**
 * Map a creative {@link Domain} (p5/hydra/strudel/…) to the coarse routing
 * bucket the smart router/bandit keys on. Replaces the old lying cast
 * (`collabDomain as 'ascii'|'music'|'code'|'visual'`) which excluded
 * revideo/html/webdev and force-bucketed every visual domain. Unknown/empty
 * domains fall back to 'visual' (the most common creative output).
 */
const DOMAIN_TO_ROUTING_TYPE: Record<string, DomainType> = {
  // visual / graphics
  p5: 'visual', glsl: 'visual', shader: 'visual', webgl: 'visual', three: 'visual',
  hydra: 'visual', kinetic: 'visual', svg: 'visual', hyperframes: 'visual', generic: 'visual',
  // music / audio
  tone: 'music', strudel: 'music', music: 'music',
  // text art
  ascii: 'ascii', textgen: 'ascii',
  // code / web / video
  code: 'code', html: 'html', webdev: 'webdev', revideo: 'revideo',
};

export function domainToRoutingType(domain: string | null | undefined): DomainType {
  if (!domain) return 'visual';
  return DOMAIN_TO_ROUTING_TYPE[domain.toLowerCase()] ?? 'visual';
}

/**
 * Model choice for routing.
 */
export type ModelChoice = 'local' | 'cloud' | 'hybrid';

/**
 * Fitness scores for a specific domain and model combination.
 */
export interface DomainFitness {
  local: number;
  cloud: number;
  hybrid: number;
}

/**
 * A/B test results mapping domain to fitness scores.
 */
export const AB_TEST_RESULTS: Record<DomainType, DomainFitness> = {
  ascii: { local: 0.363, cloud: 0.531, hybrid: 0.470 },
  music: { local: 0.523, cloud: 0.236, hybrid: 0.481 },
  code: { local: 0.503, cloud: 0.460, hybrid: 0.413 },
  visual: { local: 0.400, cloud: 0.550, hybrid: 0.475 },
  html: { local: 0.450, cloud: 0.520, hybrid: 0.485 },
  webdev: { local: 0.450, cloud: 0.520, hybrid: 0.485 },
  revideo: { local: 0.400, cloud: 0.550, hybrid: 0.475 },
};

/**
 * Domain routing configuration with optimal model and metadata.
 */
export interface DomainRoutingConfig {
  /** Optimal model choice for this domain */
  optimalModel: ModelChoice;
  /** Confidence in this choice (0-1) */
  confidence: number;
  /** Advantage percentage (e.g., "+121%") */
  advantage: string;
  /** Local fitness score */
  localFitness: number;
  /** Cloud fitness score */
  cloudFitness: number;
}

/**
 * Domain routing data mapping domain to routing configuration.
 */
export const DOMAIN_ROUTING_DATA: Record<DomainType, DomainRoutingConfig> = {
  html: {
    optimalModel: 'cloud',
    confidence: 0.80,
    advantage: '+16%',
    localFitness: 0.450,
    cloudFitness: 0.520,
  },
  webdev: {
    optimalModel: 'cloud',
    confidence: 0.80,
    advantage: '+16%',
    localFitness: 0.450,
    cloudFitness: 0.520,
  },
  music: {
    optimalModel: 'local',
    confidence: 0.95,
    advantage: '+121%',
    localFitness: 0.523,
    cloudFitness: 0.236,
  },
  code: {
    optimalModel: 'local',
    confidence: 0.75,
    advantage: '+9%',
    localFitness: 0.503,
    cloudFitness: 0.460,
  },
  ascii: {
    optimalModel: 'cloud',
    confidence: 0.85,
    advantage: '+46%',
    localFitness: 0.363,
    cloudFitness: 0.531,
  },
  visual: {
    optimalModel: 'cloud',
    confidence: 0.80,
    advantage: '+38%',
    localFitness: 0.400,
    cloudFitness: 0.550,
  },
  revideo: {
    optimalModel: 'cloud',
    confidence: 0.80,
    advantage: '+38%',
    localFitness: 0.400,
    cloudFitness: 0.550,
  },
};

/**
 * Overall fitness averages across all domains.
 */
export const OVERALL_FITNESS = {
  local: 0.463,
  cloud: 0.409,
  hybrid: 0.447,
} as const;

/**
 * Keyword detection patterns for domain classification.
 */
export const DOMAIN_KEYWORDS: Record<DomainType, string[]> = {
  // Music domain includes Strudel (pattern-based) and Hydra (visual synthesis)
  // Note: Local models show +121% advantage for music but contamination risk with <think> tags
  music: ['music', 'song', 'melody', 'rhythm', 'chord', 'piano', 'guitar', 'beat', 'harmony', 'tempo', 'audio', 'strudel', 'hydra', 'synth', 'pattern', 'drone', 'techno'],
  ascii: ['ascii', 'art', 'draw', 'picture', 'cat face', 'spaceship', 'text art', 'character'],
  code: ['code', 'function', 'class', 'algorithm', 'generate', 'fractal', 'animation', 'script', 'program'],
  visual: ['visual', 'image', 'graphic', 'design', 'color', 'shape', 'pattern', 'render', 'shader', '3d', 'scene'],
  html: ['html', 'web page', 'landing page', 'website', 'css', 'responsive', 'web design'],
  webdev: ['web app', 'dashboard', 'portfolio', 'spa', 'single page', 'ui component', 'form', 'web dev'],
  revideo: ['revideo', 'video export', 'motion graphics', 'composition', 'mp4', 'render video'],
};
