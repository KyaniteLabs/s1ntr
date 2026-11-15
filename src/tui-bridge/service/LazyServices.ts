/**
 * Extracted from TuiBridgeService.ts: lazy store accessors, taste learning and session hydration.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { GoalStore } from '../../cortex/GoalStore.js';
import { BehaviorDescriptorExtractor } from '../../emergence/BehaviorDescriptorExtractor.js';
import { EmergenceHooks } from '../../emergence/EmergenceHooks.js';
import type { DescriptorAxis } from '../../emergence/types.js';
import { SinterFS } from '../../fs/SinterFS.js';
import { resolveSinterProjectRoot } from '../../fs/projectRoot.js';
import { TasteLearningService } from '../../learning/TasteLearningService.js';
import { OwnerReactionError, type OwnerReactionSource } from '../../runtime-core/OwnerReactionCausality.js';
import { computeProofSourceFingerprint } from '../../runtime-core/ProofReceiptValidator.js';
import { Logger } from '../../utils/Logger.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';

/**
 * Lazy-initialize the GoalStore with SinterFS.
 * Returns null if SinterFS cannot be opened (e.g. not in a project directory).
 */
export function getGoalStore(host: TuiBridgeService): GoalStore | null {
    if (!host.goalStore) {
      try {
        const fs = SinterFS.open(resolveSinterProjectRoot());
        host.goalStore = new GoalStore(fs);
      } catch (err) {
        Logger.debug('TuiBridgeService', 'GoalStore unavailable — SinterFS could not be opened:', err);
        return null;
      }
    }
    return host.goalStore;
  }

/**
 * Lazy-initialize EmergenceHooks with SinterFS so the gardener can hydrate the
 * archive from persisted emergence experience each cycle.
 * Returns null if SinterFS cannot be opened (e.g. not in a project directory).
 */
export function getEmergenceHooks(host: TuiBridgeService): EmergenceHooks | null {
    if (!host.emergenceHooks) {
      try {
        const fs = SinterFS.open(resolveSinterProjectRoot());
        host.emergenceHooks = new EmergenceHooks(fs, undefined, host.dreamSourceAdmission);
      } catch (err) {
        Logger.debug('TuiBridgeService', 'EmergenceHooks unavailable — SinterFS could not be opened:', err);
        return null;
      }
    }
    return host.emergenceHooks;
  }

/**
 * The descriptor axes the background gardener searches over. Sources the real
 * 6 behavior axes from the same canonical place the rest of the system uses
 * (BehaviorDescriptorExtractor's defaults, derived from the DescriptorAxis
 * union) — matching the CLI `garden` path, which passes the identical 6 axes.
 * Without this the GUI gardener would run dream/novelty over a null (empty)
 * descriptor space.
 */
export function gardenerAxes(_host: TuiBridgeService): DescriptorAxis[] {
    return new BehaviorDescriptorExtractor().getAvailableAxes();
  }

/**
 * Lazily open a shared SinterFS handle (session persistence + hydration).
 * Returns null if SinterFS cannot be opened (e.g. not in a project directory),
 * in which case sessions degrade to memory-only.
 */
export function getSinterFS(host: TuiBridgeService): SinterFS | null {
    if (!host.sinterFs) {
      try {
        host.sinterFs = SinterFS.open(resolveSinterProjectRoot());
      } catch (err) {
        Logger.debug('TuiBridgeService', 'SinterFS unavailable — sessions are memory-only:', err);
        return null;
      }
    }
    return host.sinterFs;
  }

/**
 * Lazily initialize taste learning against the same project-local SinterFS
 * handle used by session and archive persistence.
 */
export function getTasteLearningService(host: TuiBridgeService): TasteLearningService | null {
    if (!host.tasteLearningService) {
      const fs = host.getSinterFS();
      if (!fs) return null;
      host.tasteLearningService = new TasteLearningService(fs);
    }
    return host.tasteLearningService;
  }

export function hydrateLatestTasteModel(host: TuiBridgeService): boolean {
    const service = host.getTasteLearningService();
    if (!service || !host.gardener) return false;
    try {
      const weights = service.loadLatestModel();
      if (!weights) return false;
      host.gardener.loadTasteModel(weights);
      return true;
    } catch (err) {
      Logger.debug('TuiBridgeService', 'Taste model hydration unavailable:', err);
      return false;
    }
  }

export async function recordReviewPreference(host: TuiBridgeService, sessionId: string, action: 'pin' | 'reject', artifactId: string, auth?: { nonce: string; eventId: string; source: OwnerReactionSource; occurredAt: string }): Promise<{ saved: boolean; causal: boolean; reactionDigest?: string; reason?: string }> {
    const service = host.getTasteLearningService();
    let saved = false;
    try {
      if (!service) throw new Error('taste learning service unavailable');
      await service.recordPreference({ action, artifactId, sessionId });
      const summary = await service.trainFromProject();
      if (summary.weights && host.gardener) {
        host.gardener.loadTasteModel(summary.weights);
      }
      saved = true;
    } catch (err) {
      Logger.warn('TuiBridgeService', `Preference ${action} persistence failed for ${artifactId}:`, err);
    }
    if (saved && auth) {
      try {
        const receipt = host.ownerReactions.record({
          ownerSessionId: sessionId, artifactId, action, ...auth,
        });
        const nextCreateContext = host.ownerReactions.resolveNextCreateContext(sessionId, receipt.reactionDigest);
        await host.cognitiveWriter.recordReaction({
          receipt, nextCreateContext, saved,
        });
        return { saved, causal: true, reactionDigest: receipt.reactionDigest };
      } catch (err) {
        Logger.warn('TuiBridgeService', `Preference lineage failed for ${artifactId}:`, err);
        const reason = err instanceof OwnerReactionError ? err.code : 'LINEAGE_FAILED';
        return { saved, causal: false, reason };
      }
    }
    return { saved, causal: false, reason: saved ? 'OWNER_AUTH_NOT_SUPPLIED' : 'PERSISTENCE_FAILED' };
  }

export function registerOwnerArtifact(host: TuiBridgeService, sessionId: string, lineageId: string, artifact: {
    artifactPath: string;
    artifactDigest: string;
  }): void {
    const ownerSession = host.sessions.get(sessionId)?.ownerSession;
    const sourceFingerprint = computeProofSourceFingerprint(process.cwd())?.replace(/^sha256:/, '');
    if (!ownerSession || !sourceFingerprint) return;
    const revision = (host.ownerReactions.currentArtifact(sessionId)?.revision ?? 0) + 1;
    const binding = host.ownerReactions.bindArtifact({
      ownerSessionId: sessionId,
      nonce: ownerSession.nonce,
      artifactId: artifact.artifactPath,
      artifactDigest: artifact.artifactDigest,
      lineageId,
      revision,
      sourceFingerprint,
    });
    host.emit(sessionId, {
      type: 'review.owner_artifact_ready', sessionId,
      artifactId: binding.artifactId, artifactDigest: binding.artifactDigest,
      lineageId: binding.lineageId, revision: binding.revision,
      sourceFingerprint: binding.sourceFingerprint,
    });
  }

/**
 * Hydrate sessions persisted by prior processes into the resumer, once, so
 * `/sessions` accumulates across restarts. Safe no-op if SinterFS is
 * unavailable or already hydrated.
 */
export function ensureSessionsHydrated(host: TuiBridgeService): void {
    if (host.sessionsHydrated) return;
    host.sessionsHydrated = true;
    const fs = host.getSinterFS();
    if (!fs) return;
    try {
      const loaded = host.sessionResumer.hydrate(fs);
      if (loaded > 0) {
        Logger.debug('TuiBridgeService', `Hydrated ${loaded} persisted session(s) from SinterFS.`);
      }
    } catch (err) {
      Logger.debug('TuiBridgeService', 'Session hydration failed:', err);
    }
  }
