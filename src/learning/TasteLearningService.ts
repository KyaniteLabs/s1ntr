import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ArchiveEntriesFSAdapter } from '../fs/adapters/ArchiveEntries.js';
import { PreferenceEventsFSAdapter } from '../fs/adapters/PreferenceEvents.js';
import type { SinterFS } from '../fs/SinterFS.js';
import type { ArchiveEntry, PreferenceAction, PreferenceRecord } from '../emergence/types.js';
import type { SinterObjectRef } from '../fs/types.js';
import { PreferenceDatasetBuilder } from './PreferenceDatasetBuilder.js';
import { PreferenceEventLogger } from './PreferenceEventLogger.js';
import { TasteModelTrainer, type TasteModelWeights } from './TasteModelTrainer.js';
import { TasteModelEvaluator, splitEntriesByRoot } from './TasteModelEvaluator.js';
import { NimaService, isValidNimaScore, type NimaResult } from './NimaService.js';
import { Logger } from '../utils/Logger.js';
import type { RenderDomain } from '../render/HeadlessRenderer.js';
import { bootstrapProductionCreativeAdmissionSigner } from '../runtime-core/CreativeAdmissionAuthority.js';
import { isCreativeLabelAdmitted } from './CreativeLabelAdmission.js';

export interface TasteLearningRecordResult {
  record: PreferenceRecord;
  persisted: boolean;
  ref: SinterObjectRef;
}

export interface TasteTrainingSummary {
  archiveEntryCount: number;
  preferenceEventCount: number;
  pairCount: number;
  persisted: boolean;
  reason?: string;
  weights?: TasteModelWeights;
  ref?: SinterObjectRef;
  /**
   * Whether the persisted model carries a root-held-out score. Training
   * agreement is in-sample and is never a substitute for this.
   */
  heldOutStatus?: 'evaluated' | 'insufficient-roots' | 'no-held-out-pairs';
  /** Which quality construct the training entries carry, and why. */
  nimaEnrichment?: NimaEnrichmentReport;
}

/**
 * Outcome of NIMA enrichment. Enrichment is all-or-nothing: entries either
 * all carry NIMA quality ('applied') or all keep their prior quality, so a
 * NIMA failure never silently mixes pixel scores with LLM-derived scores.
 */
export interface NimaEnrichmentReport {
  status: 'applied' | 'unavailable' | 'incomplete' | 'empty';
  scored: number;
  missingPreview: number;
  failedScore: number;
}

/** Below this many lineage roots, every root is needed for training. */
const MIN_ROOTS_FOR_HOLDOUT = 5;

/**
 * Structural seam over {@link NimaService} so tests can inject a stub scorer
 * without touching the network. {@link NimaService} satisfies this by shape.
 */
export interface NimaScorer {
  isAvailable(): Promise<boolean>;
  score(image: Buffer | Uint8Array): Promise<NimaResult | null>;
}

/**
 * Renders a preview image (PNG/JPEG bytes) for an archive entry so NIMA can
 * score it pixel-accurately. Return null when no preview is available — the
 * entry keeps its existing qualityScore (graceful fallback).
 */
export type PreviewProvider = (entry: ArchiveEntry) => Buffer | null | Promise<Buffer | null>;

export interface TasteLearningServiceConfig {
  prefDir?: string;
  /**
   * NIMA aesthetic scorer. Defaults to the {@link NimaService} singleton
   * (localhost:8765). When unavailable, training falls back to the existing
   * LLM-derived qualityScore.
   */
  nima?: NimaScorer;
  /**
   * Produces a rendered preview image (PNG/JPEG bytes) for an archive entry so
   * NIMA can score it pixel-accurately. Return null when no preview is
   * available — the entry keeps its existing qualityScore (graceful fallback).
   * Default: {@link createRenderedPreviewProvider} renders the entry's stored
   * artifact with {@link HeadlessRenderer} (only when NIMA is available).
   */
  previewProvider?: PreviewProvider;
}

const MODEL_REF_NAME = 'taste/model/latest';

/**
 * Domains whose rendered output is an image NIMA can meaningfully score.
 * Mirrors the canonical `VISUAL_DOMAINS` set used by `scripts/quality/rescore-tops`.
 * Audio generators (strudel, tone) and unrecognized code are excluded — there
 * is no screenshot to score, so the entry silently keeps its qualityScore.
 */
const NIMA_VISUAL_DOMAINS: ReadonlySet<RenderDomain> = new Set<RenderDomain>([
  'p5', 'glsl', 'three', 'hydra', 'svg', 'ascii', 'textgen', 'kinetic', 'nbe',
]);

/**
 * Default {@link PreviewProvider}: renders an archive entry's stored artifact
 * with {@link HeadlessRenderer} and returns the PNG screenshot buffer for NIMA.
 *
 * The render module is imported lazily on first use (matching RalphLoop's
 * discipline) so the playwright-backed headless browser stays out of the import
 * graph of callers that never enrich with NIMA.
 *
 * Null-return contract (consumed by {@link TasteLearningService.enrichArchiveWithNima}):
 * - Non-visual / audio domain → null, silently (no screenshot exists by design).
 * - Missing artifact, render failure, or render throw → null, with a `Logger.warn`
 *   so operators can see why a visual entry was not pixel-scored.
 *
 * NIMA availability is NOT re-checked here — the caller gates the whole
 * enrichment on `nima.isAvailable()` up front, so this only runs when scoring
 * is live (keeping the expensive render path off the fallback branch).
 */
export function createRenderedPreviewProvider(sinterFs: SinterFS): PreviewProvider {
  let rendererModule: Promise<typeof import('../render/HeadlessRenderer.js')> | null = null;
  const loadRenderer = (): Promise<typeof import('../render/HeadlessRenderer.js')> =>
    (rendererModule ??= import('../render/HeadlessRenderer.js'));

  return async (entry): Promise<Buffer | null> => {
    const artifact = sinterFs.readArtifact(entry.artifactRef);
    if (!artifact) {
      Logger.warn('TasteLearningService', `No artifact content for archive entry ${entry.id}; skipping NIMA preview`);
      return null;
    }
    const code = artifact.toString('utf-8');

    const { HeadlessRenderer } = await loadRenderer();
    const domain = HeadlessRenderer.detectDomain(code);
    if (!NIMA_VISUAL_DOMAINS.has(domain)) {
      // Audio (strudel/tone) and other non-visual domains have no screenshot.
      return null;
    }

    try {
      const result = await HeadlessRenderer.getInstance().render(code, { domain });
      const screenshot = result.screenshot;
      if (!result.success || !screenshot || !screenshot.success || screenshot.buffer.length === 0) {
        Logger.warn(
          'TasteLearningService',
          `Preview render failed for archive entry ${entry.id}${result.error ? `: ${result.error}` : ''}; falling back to existing qualityScore`,
        );
        return null;
      }
      return screenshot.buffer;
    } catch (error) {
      Logger.warn(
        'TasteLearningService',
        `Preview render threw for archive entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}; falling back to existing qualityScore`,
      );
      return null;
    }
  };
}

export class TasteLearningService {
  private readonly sinterFs: SinterFS;
  private readonly logger: PreferenceEventLogger;
  private readonly preferenceAdapter: PreferenceEventsFSAdapter;
  private readonly archiveAdapter: ArchiveEntriesFSAdapter;
  private readonly nima: NimaScorer;
  private readonly previewProvider: PreviewProvider;
  private lastNimaEnrichment: NimaEnrichmentReport | null = null;

  constructor(sinterFs: SinterFS, config: TasteLearningServiceConfig = {}) {
    this.sinterFs = sinterFs;
    this.logger = new PreferenceEventLogger({
      prefDir: config.prefDir ?? TasteLearningService.preferenceDirForProject(sinterFs),
    });
    this.preferenceAdapter = new PreferenceEventsFSAdapter(sinterFs);
    this.archiveAdapter = new ArchiveEntriesFSAdapter(sinterFs);
    this.nima = config.nima ?? NimaService.getInstance();
    this.previewProvider = config.previewProvider ?? createRenderedPreviewProvider(sinterFs);
  }

  static preferenceDirForProject(sinterFs: SinterFS): string {
    return join(sinterFs.getProjectRoot(), '.sinter', 'preferences');
  }

  async recordPreference(params: {
    action: PreferenceAction;
    artifactId: string;
    comparedTo?: string;
    sessionId?: string;
  }): Promise<TasteLearningRecordResult> {
    const record = await this.logger.log(params);
    const ref = this.preferenceAdapter.writePreferenceEvent(record);
    return { record, ref, persisted: true };
  }

  async trainFromProject(): Promise<TasteTrainingSummary> {
    try {
      await bootstrapProductionCreativeAdmissionSigner(
        join(homedir(), '.sinter', 'authority', 'liminal-command-receipt.key'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const archiveEntries = this.archiveAdapter.readAllArchiveEntries();
    const preferenceEvents = await this.logger.getEvents();
    const admittedEntries = archiveEntries.filter(entry => this.isVerifiedTrainingEntry(entry));
    // Keep one score scale for all pairs. A source-bound label authorizes only its signed score.
    const includesBoundScore = admittedEntries.some(entry => entry.creativeLabel?.trainingEvidence !== undefined);
    if (includesBoundScore) this.lastNimaEnrichment = null;
    const enrichedEntries = includesBoundScore ? admittedEntries : await this.enrichArchiveWithNima(admittedEntries);
    const trainingEntries = this.attachPreferences(enrichedEntries, preferenceEvents);
    // Split by lineage root BEFORE pair construction so no root leaks across.
    const split = splitEntriesByRoot(trainingEntries, undefined, MIN_ROOTS_FOR_HOLDOUT);
    const builder = new PreferenceDatasetBuilder();
    const dataset = builder.build(split.train);

    if (archiveEntries.length === 0) {
      return {
        archiveEntryCount: 0,
        preferenceEventCount: preferenceEvents.length,
        pairCount: 0,
        persisted: false,
        reason: 'no archive entries',
        nimaEnrichment: this.lastNimaEnrichment ?? undefined,
      };
    }

    if (dataset.pairs.length === 0) {
      return {
        archiveEntryCount: archiveEntries.length,
        preferenceEventCount: preferenceEvents.length,
        pairCount: 0,
        persisted: false,
        reason: admittedEntries.length === 0
          ? 'no rendered admitted labels' : 'no usable preference pairs',
        nimaEnrichment: this.lastNimaEnrichment ?? undefined,
      };
    }

    const trained = new TasteModelTrainer().train(dataset.pairs);
    const heldOutPairs = split.test.length > 0 ? builder.build(split.test).pairs : [];
    let heldOutStatus: TasteTrainingSummary['heldOutStatus'] = 'insufficient-roots';
    let weights: TasteModelWeights = trained;
    if (split.test.length > 0) {
      heldOutStatus = heldOutPairs.length > 0 ? 'evaluated' : 'no-held-out-pairs';
    }
    if (heldOutStatus === 'evaluated') {
      const heldOut = new TasteModelEvaluator().evaluatePairs(heldOutPairs, trained);
      weights = {
        ...trained,
        heldOutAgreement: heldOut.agreement,
        heldOutTieRate: heldOut.tieRate,
        heldOutPairCount: heldOut.pairCount,
      };
    }
    const ref = this.persistModel(weights);
    return {
      archiveEntryCount: archiveEntries.length,
      preferenceEventCount: preferenceEvents.length,
      pairCount: dataset.pairs.length,
      persisted: true,
      weights,
      ref,
      nimaEnrichment: this.lastNimaEnrichment ?? undefined,
      heldOutStatus,
    };
  }

  private isVerifiedTrainingEntry(entry: ArchiveEntry): boolean {
    const label = entry.creativeLabel;
    if (!label || entry.artifactRef.hash !== label.artifactDigest
      || !isCreativeLabelAdmitted(label, 'evaluator-training')) return false;
    const evidence = label.trainingEvidence;
    if (!evidence) return true;
    if (entry.id !== `sinter://artifact/${evidence.operationDigest}`
      || entry.lineage.artifactId !== evidence.operationDigest
      || entry.lineage.provenance !== 'fresh-generation'
      || !Array.isArray(entry.lineage.parentIds) || entry.lineage.parentIds.length !== 0
      || entry.qualityScore !== evidence.quality) return false;
    try {
      const source = this.sinterFs.readArtifact(entry.artifactRef);
      return source !== null && createHash('sha256').update(source).digest('hex') === label.artifactDigest;
    } catch {
      return false;
    }
  }

  /**
   * Enrich archive entries with NIMA pixel-level aesthetic scores.
   *
   * For each entry, when NIMA is available AND a rendered preview can be
   * produced, the entry's `qualityScore` is overridden by `nimaScore / 10`
   * (NIMA scores 1.0–10.0 → 0.1–1.0) and `nimaScore` is set. This is the
   * quality signal the taste model formula consumes (qualityWeight blend).
   *
   * All-or-nothing: if NIMA is unavailable, or any entry lacks a preview or
   * gets a failed/invalid score, every entry keeps its prior qualityScore and
   * the outcome is reported (see NimaEnrichmentReport) — NIMA and prior
   * quality are never silently mixed, and no neutral score is substituted.
   * The persisted archive is never mutated; enrichment is an in-memory training
   * transform only.
   *
   * @returns a new array; original entries are not mutated.
   */
  async enrichArchiveWithNima(entries: ArchiveEntry[]): Promise<ArchiveEntry[]> {
    const empty = { scored: 0, missingPreview: 0, failedScore: 0 };
    if (entries.length === 0) {
      this.lastNimaEnrichment = { status: 'empty', ...empty };
      return entries;
    }
    // Gate on availability up front so we skip the (potentially expensive)
    // preview rendering entirely when NIMA is down.
    if (!(await this.nima.isAvailable())) {
      this.lastNimaEnrichment = { status: 'unavailable', ...empty };
      return entries;
    }

    const enriched: ArchiveEntry[] = [];
    let missingPreview = 0;
    let failedScore = 0;
    for (const entry of entries) {
      const preview = await this.previewProvider(entry);
      if (!preview) {
        missingPreview++;
        continue;
      }
      const result = await this.nima.score(preview);
      if (!result || !isValidNimaScore(result.score)) {
        failedScore++;
        continue;
      }
      const normalizedQuality = Math.max(0, Math.min(1, result.score / 10));
      enriched.push({ ...entry, qualityScore: normalizedQuality, nimaScore: result.score });
    }

    if (missingPreview > 0 || failedScore > 0) {
      // Never mix NIMA pixel scores with prior LLM-derived scores in one
      // training set: keep every entry on its prior quality and say so.
      this.lastNimaEnrichment = { status: 'incomplete', scored: enriched.length, missingPreview, failedScore };
      Logger.warn('TasteLearningService',
        `NIMA enrichment incomplete (${enriched.length} scored, ${missingPreview} without preview, ${failedScore} failed); training on prior quality for all entries`);
      return entries;
    }
    this.lastNimaEnrichment = { status: 'applied', scored: enriched.length, missingPreview: 0, failedScore: 0 };
    return enriched;
  }

  loadLatestModel(): TasteModelWeights | null {
    const ref = this.sinterFs.readRef(MODEL_REF_NAME);
    if (!ref) return null;

    try {
      const content = this.sinterFs.readArtifact(ref);
      if (!content) return null;
      const parsed = JSON.parse(content.toString('utf-8')) as TasteModelWeights;
      return this.isTasteModelWeights(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private attachPreferences(
    entries: ArchiveEntry[],
    preferences: PreferenceRecord[],
  ): ArchiveEntry[] {
    const latestByArtifact = new Map<string, PreferenceRecord>();
    for (const record of preferences) {
      const prior = latestByArtifact.get(record.artifactId);
      if (!prior || new Date(record.capturedAt).getTime() >= new Date(prior.capturedAt).getTime()) {
        latestByArtifact.set(record.artifactId, record);
      }
    }

    return entries.map(entry => {
      const preference = latestByArtifact.get(entry.id);
      return preference ? { ...entry, preference } : entry;
    });
  }

  private persistModel(weights: TasteModelWeights): SinterObjectRef {
    const ref = this.sinterFs.writeArtifact({
      kind: 'taste-model',
      content: JSON.stringify(weights, null, 2),
      filename: 'taste-model-latest.json',
      metadata: {
        pairCount: weights.pairCount,
        trainingAgreement: weights.trainingAgreement,
        ...(weights.heldOutAgreement !== undefined ? { heldOutAgreement: weights.heldOutAgreement } : {}),
        trainedAt: weights.trainedAt,
      },
    });
    this.sinterFs.writeRef(MODEL_REF_NAME, ref);
    return ref;
  }

  private isTasteModelWeights(value: unknown): value is TasteModelWeights {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<TasteModelWeights>;
    return Array.isArray(candidate.axisWeights)
      && typeof candidate.qualityWeight === 'number'
      && typeof candidate.trainedAt === 'string'
      && typeof candidate.pairCount === 'number'
      && typeof candidate.trainingAgreement === 'number';
  }
}
