/**
 * GovernedProjectRecord — the ONE place a governed `generate` finishes a piece and records it into the
 * project stores the organs read.
 *
 * Why: the governed runtime keeps its own state root (and writes artifacts to -o). The organs `fs artifacts`,
 * `compost status`, `gbg`, `name`, `taxonomy`, `rescue` and `report fitness` read the PROJECT stores
 * (`<cwd>/.sinter`, `<cwd>/.omx/atelier`, `~/.sinter`). Teaching those seven readers a second, governed-only layout
 * would give two sources of truth; recording once, here, keeps the stores they already read as the single source.
 * Best-effort: a store failure is reported, never fatal to a generate that already produced its artifact.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync } from '../utils/atomicWrite.js';
import { appendFitnessObservation, resolveFitnessObservationPath } from '../quality/FitnessObservationStore.js';
import { withFileLock } from '../utils/fileLock.js';
import type { ArchiveEntry } from '../emergence/types.js';
import { isCreativeLabelAdmitted, type CreativeLabelAdmission } from '../learning/CreativeLabelAdmission.js';
import type { LiminalCommandResult } from '../runtime-core/LiminalCommandService.js';

export interface GovernedRecordInput {
  readonly projectRoot: string;
  readonly home?: string;
  readonly prompt: string;
  readonly promptId?: string;
  readonly domain: string;
  readonly artifactDirectory: string;
  readonly result: LiminalCommandResult;
  /** An already verified snapshot for replay, so no later file mutation can change the write. */
  readonly verifiedSource: string;
  readonly tasteAdmission?: CreativeLabelAdmission;
  /** When the piece was finished (ISO). A live generate omits it (now); a replay of an old piece passes its own date so the stores keep the timeline. */
  readonly at?: string;
  /** Steps already recorded for this piece (replay receipts): skipped, so a second pass never appends twice. */
  readonly skip?: ReadonlySet<string>;
}

export interface GovernedRecordOutcome { readonly accepted: boolean; readonly recorded: string[]; readonly alreadyRecorded: string[]; readonly failed: string[] }

// The classes FitnessObservationStore accepts. A piece with no typed class (older or hand-made results) is recorded as 'legacy'.
interface RecordProgress {
  readonly at: string;
  readonly completed: string[];
}

export function isGovernedAccepted(e: LiminalCommandResult['evaluation']): boolean {
  return e.admissionEligible && !e.degraded && e.identityValid !== false;
}

export async function recordGovernedOutcome(input: GovernedRecordInput): Promise<GovernedRecordOutcome> {
  const { projectRoot, result } = input;
  const home = input.home ?? process.env.HOME ?? os.homedir();
  const id = createHash('sha256').update(result.operationId).digest('hex');
  const directory = path.join(projectRoot, '.sinter', 'governed-records');
  mkdirSync(directory, { recursive: true });
  return withFileLock(path.join(directory, '.lock'), () => recordProjectStores(input, id, directory, home));
}

async function recordProjectStores(
  input: GovernedRecordInput, id: string, directory: string, home: string,
): Promise<GovernedRecordOutcome> {
  const { projectRoot, result, artifactDirectory, verifiedSource: source } = input;
  const e = result.evaluation;
  const accepted = isGovernedAccepted(e);
  const progressFile = path.join(directory, id + '.json');
  let progress: RecordProgress;
  try {
    progress = JSON.parse(readFileSync(progressFile, 'utf8')) as RecordProgress;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    progress = { at: input.at || new Date().toISOString(), completed: [] };
    writeFileAtomicSync(progressFile, JSON.stringify(progress));
  }
  const recorded: string[] = [];
  const alreadyRecorded: string[] = [];
  const failed: string[] = [];
  const step = async (
    name: string, fn: () => void | Promise<void>, destination?: string,
  ): Promise<void> => {
    const completion = destination ? name + ':' + createHash('sha256').update(destination).digest('hex') : name;
    if (progress.completed.includes(completion) || input.skip?.has(name)) {
      alreadyRecorded.push(name);
      return;
    }
    try {
      await fn();
      progress.completed.push(completion);
      writeFileAtomicSync(progressFile, JSON.stringify(progress));
      recorded.push(name);
    } catch (error) {
      failed.push(name + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  };
  const atelier = path.join(projectRoot, '.omx', 'atelier');
  const scored = Number.isFinite(e.score) && e.scoreState !== 'unscored' && !e.degraded && e.identityValid === true;
  const ts = progress.at;

  await step('fitness', async () => {
    const failureClass = e.failureClass;
    const mapped = !scored ? 'infra'
      : failureClass === 'render' || failureClass === 'validator' || failureClass === 'parse'
        || failureClass === 'scorer' || failureClass === 'infra' ? failureClass
      : accepted || failureClass === 'aesthetic' ? 'none' : 'legacy';
    await appendFitnessObservation({ runId: id, domain: input.domain, model: result.roles.generator,
      sourceCode: source, score: scored ? e.score : 0, confidence: scored ? e.confidence ?? 0 : 0,
      failureClass: mapped, timestamp: ts }, { home, uniqueRunId: true });
  }, resolveFitnessObservationPath({ home }));

  if (accepted) {
    const lineageDir = path.join(home, '.sinter', 'lineage');
    const { LineageTracker } = await import('../emergence/LineageTracker.js');
    const tracker = new LineageTracker({ lineageDir });
    await step('lineage', async () => {
      if (!(await tracker.get(id))) {
        await tracker.record({ artifactId: id, runId: id, provenance: 'fresh-generation', createdAt: ts });
      }
    }, lineageDir);
    await step('archive', async () => {
      const { SinterFS } = await import('../fs/SinterFS.js');
      const { EmergenceHooks } = await import('../emergence/EmergenceHooks.js');
      const sinterFs = SinterFS.open(projectRoot);
      try {
        if (!sinterFs.readRef('archive/sinter://artifact/' + id)) {
          const lineage = await tracker.get(id);
          if (!lineage || lineage.provenance !== 'fresh-generation' || lineage.parentIds.length !== 0) {
            throw new Error('governed generation lineage missing or invalid');
          }
          const hooks = new EmergenceHooks(sinterFs, { minQuality: 0 });
          await hooks.onCreativeRun({ output: source, qualityScore: e.score, provenance: 'fresh-generation',
            runId: id, artifactId: id, lineage, metadata: { domain: input.domain, model: result.roles.generator,
              source: 'governed-generate', judgeScored: true } });
        }
        // fs artifacts: one named ref per accepted piece.
        const ref = sinterFs.writeArtifact({ kind: 'generated-code', content: source, filename: `${id}.source.txt`,
          metadata: { domain: input.domain, score: e.score, prompt: input.prompt.slice(0, 200) } });
        sinterFs.writeRef(`generate/${id}`, ref);
      } finally { sinterFs.close(); }
    });
    const tasteAdmission = input.tasteAdmission;
    if (tasteAdmission) await step('taste-training', async () => {
      const { SinterFS } = await import('../fs/SinterFS.js');
      const { ArchiveEntriesFSAdapter } = await import('../fs/adapters/ArchiveEntries.js');
      const sinterFs = SinterFS.open(projectRoot);
      try {
        const entryId = 'sinter://artifact/' + id;
        const archiveRef = sinterFs.readRef('archive/' + entryId);
        const sourceRef = sinterFs.readRef('generate/' + id);
        const entryBytes = archiveRef && sinterFs.readArtifact(archiveRef);
        const sourceBytes = sourceRef && sinterFs.readArtifact(sourceRef);
        if (!entryBytes || !sourceRef || !sourceBytes || sourceRef.hash !== tasteAdmission.artifactDigest
          || createHash('sha256').update(sourceBytes).digest('hex') !== tasteAdmission.artifactDigest
          || !isCreativeLabelAdmitted(tasteAdmission, 'evaluator-training')
          || tasteAdmission.trainingEvidence?.operationDigest !== id
          || tasteAdmission.trainingEvidence.quality !== e.score) {
          throw new Error('verified source and taste admission must match the archived piece');
        }
        const entry = JSON.parse(entryBytes.toString('utf8')) as ArchiveEntry;
        if (entry.id !== entryId || entry.lineage.artifactId !== id || entry.qualityScore !== e.score) {
          throw new Error('archive identity or score mismatch');
        }
        new ArchiveEntriesFSAdapter(sinterFs).writeArchiveEntry({ ...entry,
          artifactRef: { ...sourceRef, uri: entry.artifactRef.uri }, creativeLabel: tasteAdmission });
      } finally { sinterFs.close(); }
    });
    const name = `${input.domain}-${id.slice(0, 8)}`;
    await step('gallery', async () => {
      const { Gallery } = await import('../gallery/Gallery.js');
      await new Gallery(path.join(projectRoot, 'gallery')).saveIteration(name, 1, source, new Date(ts));
    });
    await step('piece-exemplar', async () => {
      const { recordAcceptedPiece } = await import('../learning/PieceExemplars.js');
      await recordAcceptedPiece(projectRoot, { name, domain: input.domain, score: e.score, prompt: input.prompt,
        promptId: input.promptId, source, playableSha256: result.artifacts?.playableDigest,
        artifactDigest: result.receipt.artifactDigest, ...(e.reasoning ? { judgeReasoning: e.reasoning } : {}), at: ts });
    });
    await step('trend', () => {
      const trend = path.join(atelier, 'lessons', 'trend.jsonl');
      mkdirSync(path.dirname(trend), { recursive: true });
      const previous = readFileSyncIfPresent(trend);
      if (previous.split('\n').some(line => {
        try {
          const row = JSON.parse(line) as { operation_id?: string; artifact?: string };
          return row.operation_id === id || row.artifact === artifactDirectory;
        } catch { return false; }
      })) return;
      appendFileSync(trend, JSON.stringify({ operation_id: id, event_type: 'governed_scored', schema_version: 'sinter.trend/1.2', ts,
        domain: input.domain, score: e.score, level: 'governed', artifact: artifactDirectory,
        model: result.roles.generator }) + '\n');
    });
    await step('champion', () => {
      const file = path.join(atelier, 'governed-best.json');
      let best: Record<string, { id: string; dir: string; mean: number }> = {};
      try { best = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first champion */ }
      if (best[input.domain] && best[input.domain].mean >= e.score * 5) return;
      best[input.domain] = { id, dir: artifactDirectory, mean: e.score * 5 };
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomicSync(file, JSON.stringify(best, null, 2));
    });
  } else {
    await step('rejects', () => {
      const dir = path.join(atelier, 'rejects', 'code');
      mkdirSync(dir, { recursive: true });
      writeFileAtomicSync(path.join(dir, `${id}.txt`), source);
      const failures = path.join(home, '.sinter', 'failures');
      mkdirSync(failures, { recursive: true });
      writeFileAtomicSync(path.join(failures, `governed-${id}.json`), JSON.stringify({ id, timestamp: ts, sessionId: `governed-${id}`, model: result.roles.generator, domain: input.domain,
        prompt: input.prompt, code: source, codeLength: source.length, duration: 0, errorType: 'degraded',
        error: (e.rejectionReasons ?? []).join('; ') || e.failureClass || 'not accepted' }));
    }, path.resolve(home));

  }
  return { accepted, recorded, alreadyRecorded, failed };
}

function readFileSyncIfPresent(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  }
}
