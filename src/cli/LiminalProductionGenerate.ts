import { classifyJudgeScore } from '../learning/JudgeFloor.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { resolveSinterProjectRoot } from '../fs/projectRoot.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionLiminalRuntime, defaultSharedRuntimeRoot,
  type ProductionLiminalRuntime } from '../runtime-core/ProductionLiminalRuntime.js';
import type { LiminalCommandResult, LiminalCommandService } from '../runtime-core/LiminalCommandService.js';
import { enforceProductionAuthorityEntrypoints }
  from '../runtime-core/ProductionAuthorityRegistry.js';
import { scanProductionEntrypointAuthorityLocators }
  from '../runtime-core/ProductionAuthorityScanner.js';
import type { PriorRun } from '../generators/revision/RevisionBrief.js';
import { buildHostProofPage, validateSVGFragment, type SVGFragmentSpec } from '../generators/svg/SVGFragment.js';
import { assertBlenderReady } from '../render/BlenderReadiness.js';
import { FileLiminalProductCommandStore, LiminalProductStoreReadError } from '../runtime-core/LiminalProductCommandPort.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { describeMedium, MEDIUM_FILENAME, type MediumDecision } from '../core/MediumLine.js';
import { assertNextDomainEnabled, isNextDomainId } from '../config/nextDomains.js';
import { renderDatamosh } from '../render/DatamoshRenderer.js';
import { setSinterMemoryStage } from '../telemetry/SinterMemoryProfile.js';
import { withBoundLoopJournal, LoopOutcomeUnknown, LoopReplayIntegrityError, type LoopReplayOptions } from './LiminalProductionLoops.js';

export interface GovernedCliCompatibility {
  readonly explicitMaxIterations?: number;
  readonly stages?: string;
  readonly useSwarm?: boolean;
  readonly learn?: boolean;
  readonly intuition?: boolean;
  readonly aesthetic?: boolean;
  readonly voice?: boolean;
  readonly providerOverride?: boolean;
}

export function assertGovernedCliCompatibility(input: GovernedCliCompatibility): void {
  const incompatible = [
    input.explicitMaxIterations !== undefined && input.explicitMaxIterations !== 1
      ? '--max-iterations other than 1' : undefined,
    input.stages ? '--stages' : undefined,
    input.useSwarm ? '--use-swarm' : undefined,
    input.learn ? '--learn' : undefined,
    input.intuition ? '--intuition' : undefined,
    input.aesthetic ? '--aesthetic/--aesthetic-config' : undefined,
    input.voice ? '--voice/--voice-file' : undefined,
    input.providerOverride ? '--provider/--model/--base-url/--api-key' : undefined,
  ].filter(Boolean);
  if (incompatible.length) {
    throw new Error(`GOVERNED_GENERATE_FLAGS_UNSUPPORTED:${incompatible.join(',')}`);
  }
}

export interface ProductionCliGenerateInput extends LoopReplayOptions {
  readonly prompt: string;
  readonly domain: string;
  readonly outputRoot: string;
  /** Explicit runtime STATE root; beats SINTER_LIMINAL_RUNTIME_ROOT. The batch lane's request-capture pass uses a throwaway one. */
  readonly stateRoot?: string;
  readonly maxTransportAttempts?: number;
  /** Operator accepts possible double billing after an UNKNOWN outcome (#1323). */
  readonly retryUnknownOutcome?: boolean;
  /** One sampling attempt of a best-of-N batch (seat:prompt:rep); distinct attempts never collapse into one Create (audit F03). */
  readonly attemptId?: string;
  /** Teach this run with the latest active activated-knowledge snapshot covering the scope. */
  readonly teachScope?: string;
  /** SVG fragment mode (#1162): also write the accepted source as fragment.svg. */
  readonly fragmentSpec?: SVGFragmentSpec | null;
  /** Host readiness check for the blender domain; tests inject one. Defaults to the real host probe. */
  readonly blenderReadiness?: () => void;
  /**
   * Loop runs only: when the shared runtime already holds this Create (a crash after the journal write but before this
   * -o was mirrored), copy the first run's artifacts into this -o and complete the mirror instead of reporting a replay
   * with nothing saved. Without the original bytes it still reports the replay.
   */
  readonly adoptReplayedArtifacts?: boolean;
  /** Why this medium was used (forced, prompt cue, or an honest default); recorded in medium.json. */
  readonly mediumDecision?: MediumDecision;
}

export const TEACH_SCOPES = ['visual', 'motion'] as const;
export function parseTeachScope(value: string | undefined): string {
  if (!value || !(TEACH_SCOPES as readonly string[]).includes(value)) {
    throw new Error(`--teach requires one of: ${TEACH_SCOPES.join(', ')} (got ${value ? `"${value}"` : 'nothing'})`);
  }
  return value;
}

export interface ProductionCliGenerateResult {
  readonly result: LiminalCommandResult;
  readonly sourcePath: string;
  readonly playablePath: string;
  /** Paste-ready fragment, only set in SVG fragment mode. */
  readonly fragmentPath?: string;
  /** Host-page proof (fragment + token scaffold), only set in SVG fragment mode. */
  readonly hostProofPath?: string;
  /** Rendered-output page for domains whose playable is not browser code (blender): the frame, then the script. */
  readonly previewPath?: string;
  /** Plain line saying what S1NTR built and why (also `medium_line` in medium.json). */
  readonly mediumLine?: string;
  readonly mediumPath?: string;
  /**
   * False when sourcePath does not exist: the shared runtime already held this Create (a replay), so the bytes live in
   * the run that produced them, not in this -o. The paths are where they WOULD be; callers must not report them as saved.
   */
  readonly artifactsPresent: boolean;
  readonly prior?: PriorRun;
  /** Directory of the first run's artifacts when this was a replay and that run recorded its location and still has the bytes. */
  readonly originalArtifactDirectory?: string;
}

/** Exit code for a Create whose artifacts are not at the reported location (a replay): distinct from accepted (0), not accepted (3), error (1). */
export const NO_ARTIFACT_EXIT_CODE = 4;

/** Lines to print instead of the Saved/HTML lines when nothing exists at the reported paths; null when the artifacts are there. */
export function replayNoticeLines(governed: Pick<ProductionCliGenerateResult, 'artifactsPresent' | 'originalArtifactDirectory'>,
  outputRoot: string): string[] | null {
  if (governed.artifactsPresent) return null;
  return [
    `REPLAYED: this Create was already accepted earlier; no new generation ran and nothing was saved to ${outputRoot}.`,
    `   The scores above describe that earlier run. ${governed.originalArtifactDirectory
      ? `Its files: ${governed.originalArtifactDirectory}`
      : 'Its files are in the run that produced them (location not recorded).'}`,
    '   For a fresh take, change the prompt or the shared runtime root.',
  ];
}

const locationFile = (stateRoot: string, operationDirectory: string): string =>
  path.join(stateRoot, 'artifact-locations', `${operationDirectory}.txt`);

type RuntimeFactory = (options: { root: string; artifactRoot: string; knowledgeRoot?: string }) => Promise<ProductionLiminalRuntime>;

async function assertProductionEntrypointAuthority(): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  enforceProductionAuthorityEntrypoints(await scanProductionEntrypointAuthorityLocators(
    packageRoot, ['src/cli/LiminalProductionGenerate.ts']));
}

export async function runProductionCliGenerate(input: ProductionCliGenerateInput,
  runtimeFactory: RuntimeFactory = createProductionLiminalRuntime):
  Promise<ProductionCliGenerateResult> {
  if (!path.isAbsolute(input.outputRoot)) {
    throw new Error('GOVERNED_GENERATE_OUTPUT_ROOT_NOT_ABSOLUTE');
  }
  // Blender needs a host binary and an OS sandbox the model cannot supply: refuse before any
  // runtime bootstrap or provider call, so a lane without Blender cannot masquerade as a model failure.
  if (input.domain === 'blender') (input.blenderReadiness ?? (() => assertBlenderReady()))();
  // A next-release domain is refused with a message naming its flag before any runtime or provider call.
  if (isNextDomainId(input.domain)) assertNextDomainEnabled(input.domain);
  setSinterMemoryStage('cli:authority-scan');
  await assertProductionEntrypointAuthority();
  setSinterMemoryStage('cli:runtime-bootstrap');
  // SINTER_LIMINAL_RUNTIME_ROOT, when set to a non-empty absolute path, is the shared
  // runtime STATE root for every Create regardless of -o. Artifacts still land in -o
  // (artifactRoot). An unset/empty/relative env var falls back to -o exactly as before.
  const envRuntimeRoot = process.env.SINTER_LIMINAL_RUNTIME_ROOT;
  const stateRoot = input.stateRoot ?? (envRuntimeRoot && envRuntimeRoot.length > 0 && path.isAbsolute(envRuntimeRoot)
    ? envRuntimeRoot
    : input.outputRoot);
  // `--teach` reads activated-knowledge.json from the knowledge root, and `sinter dream activate`
  // writes it under the shared runtime root. Without this, a run whose state root falls back to
  // -o looks in its own output dir and is UNTAUGHT forever, even after activation.
  const envKnowledgeRoot = process.env.SINTER_LIMINAL_KNOWLEDGE_ROOT;
  const knowledgeRoot = input.teachScope && !envKnowledgeRoot
    ? (stateRoot === input.outputRoot ? defaultSharedRuntimeRoot() : stateRoot) : undefined;
  const runtime = await runtimeFactory({
    root: stateRoot,
    artifactRoot: input.outputRoot,
    ...(knowledgeRoot ? { knowledgeRoot } : {}),
  });
  try {
    setSinterMemoryStage('cli:create-command');
    const snapshot = input.teachScope
      ? runtime.activatedKnowledge.latestActive(input.teachScope) : undefined;
    if (input.teachScope) {
      if (!snapshot && process.env.SINTER_TEACH_STRICT === '1') {
        throw new Error(`TEACHING_SNAPSHOT_MISSING:${input.teachScope}`);
      }
      console.log(snapshot
        ? `Teaching: activated knowledge ${snapshot.snapshotDigest.slice(0, 12)} (${input.teachScope})`
        : `UNTAUGHT: no active knowledge for scope "${input.teachScope}" in ${runtime.activatedKnowledge.path ?? 'the knowledge root'}; run \`sinter dream activate\`; generating without it`);
    }
    const commandFor = (ownerRetry?: string) => runtime.createCommand({ prompt: input.prompt, domain: input.domain,
      maxTransportAttempts: input.maxTransportAttempts,
      ...(snapshot ? { teaching: { targetScope: input.teachScope!,
        snapshotDigest: snapshot.snapshotDigest } } : {}),
      ...(ownerRetry ? { retryUnknownOutcome: ownerRetry } : input.retryUnknownOutcome ? { retryUnknownOutcome: randomUUID() } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}) });
    const original = commandFor();
    const submit = async (ownerRetry: string | undefined, replayOnly: boolean) => {
      const command = ownerRetry ? commandFor(ownerRetry) : original;
      setSinterMemoryStage('cli:submit-create');
      try {
        const projection = replayOnly ? await runtime.port.replayCreate(command)
          : await runtime.port.submitCreate('cli', command);
        if (projection.kind !== 'create' || typeof projection.result?.operationId !== 'string'
          || !projection.result.operationId.trim()) throw new Error('LIMINAL_CREATE_PROJECTION_INVALID');
        return { command, projection };
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        if (replayOnly && reason === 'LOOP_REPLAY_PROJECTION_MISSING') throw new LoopOutcomeUnknown(error);
        if (input.adoptReplayedArtifacts && (replayOnly || error instanceof LiminalProductStoreReadError
          || ['IDEMPOTENCY_KEY_REBOUND', 'LIMINAL_CREATE_PROJECTION_INVALID'].includes(reason))) {
          throw new LoopReplayIntegrityError(error);
        }
        throw error;
      }
    };
    const submitted = input.adoptReplayedArtifacts && input.attemptId
      ? await withBoundLoopJournal(input.outputRoot, input.attemptId, original.idempotencyKey, stateRoot, input, submit)
      : await submit(undefined, input.replayOnly === true);
    const { command } = submitted;
    let { projection } = submitted;
    const operationDirectory = createHash('sha256')
      .update(projection.result.operationId).digest('hex');
    const artifactDirectory = path.join(input.outputRoot, 'artifacts', operationDirectory);
    const sourcePath = path.join(artifactDirectory, 'source.txt');
    // A shared state root (SINTER_LIMINAL_RUNTIME_ROOT) keeps projections out of -o, but art batches
    // score and replay a run from its own folder. Mirror this run's projection there. A replayed
    // Create (same key already in the shared store) has its artifacts in the original run dir,
    // so it is not mirrored: the new folder stays empty instead of posing as a duplicate result.
    let artifactsPresent = existsSync(sourcePath);
    let originalArtifactDirectory: string | undefined;
    const sharedState = stateRoot !== input.outputRoot;
    let prior: PriorRun | undefined;
    if (!artifactsPresent && sharedState) {
      try {
        const recorded = (await readFile(locationFile(stateRoot, operationDirectory), 'utf8')).trim();
        if (recorded && existsSync(path.join(recorded, 'source.txt'))) originalArtifactDirectory = recorded;
      } catch { /* no pointer: first run predates it or lives elsewhere */ }
    }
    if (input.adoptReplayedArtifacts) {
      try {
        const sourceDirectory = artifactsPresent ? artifactDirectory : originalArtifactDirectory;
        if (!sourceDirectory) throw new Error('LOOP_REPLAY_NO_ARTIFACT');
        const verified = await runtime.port.readVerifiedCreateResult(command, projection);
        prior = await verifyLoopArtifacts(runtime.createAuthority, verified, sourceDirectory,
          artifactsPresent ? undefined : artifactDirectory);
        projection = { ...projection, result: verified };
        artifactsPresent = true;
        originalArtifactDirectory = undefined;
      } catch (error) {
        throw new LoopReplayIntegrityError(error);
      }
    }
    if (artifactsPresent && sharedState) {
      try {
        await mkdir(path.join(stateRoot, 'artifact-locations'), { recursive: true });
        await writeFileAtomic(locationFile(stateRoot, operationDirectory), artifactDirectory);
      } catch { /* the pointer is a convenience; the artifact itself is already durable */ }
    }
    if (stateRoot !== input.outputRoot) {
      if (artifactsPresent) {
        await new FileLiminalProductCommandStore(path.join(input.outputRoot, 'product-projections.json'))
          .write(command.idempotencyKey, projection);
      } else {
        console.warn(`REPLAYED Create ${command.idempotencyKey}: artifacts are not in ${input.outputRoot}; `
          + 'the shared runtime root already holds this key (same prompt and source head)');
      }
    }
    let fragmentPath: string | undefined;
    let hostProofPath: string | undefined;
    if (input.fragmentSpec && artifactsPresent) {
      // Read the accepted artifact back, never the raw first attempt.
      const accepted = await readFile(sourcePath, 'utf8');
      const check = validateSVGFragment(accepted, input.fragmentSpec);
      if (!check.valid) throw new Error(`SVG_FRAGMENT_INVALID:${check.error}`);
      fragmentPath = path.join(artifactDirectory, 'fragment.svg');
      await writeFileAtomic(fragmentPath, accepted);
      hostProofPath = path.join(artifactDirectory, 'fragment.host.html');
      await writeFileAtomic(hostProofPath, buildHostProofPage(accepted, input.fragmentSpec));
    }
    // A blender playable is Python: the card/wall media is the rendered frame, so write a
    // page that shows it (and the script below). Skipped when no frame was rendered.
    let previewPath: string | undefined;
    if (input.domain === 'blender' && artifactsPresent) {
      previewPath = await writeBlenderPreview(artifactDirectory, sourcePath);
    }
    if (input.domain === 'datamosh' && artifactsPresent && projection.result.evidence.status === 'rendered') {
      const outputDir = await mkdtemp(path.join(path.dirname(artifactDirectory), '.datamosh-card-'));
      try {
        const rendered = await renderDatamosh(await readFile(sourcePath, 'utf8'), { outputDir, isolated: true });
        if (!rendered.success || !rendered.evidence) {
          throw new Error(`DATAMOSH_CARD_RENDER_FAILED:${rendered.failureKind}:${rendered.error}`);
        }
        const judgedDigests = projection.result.evidence.containment?.assetDigests;
        if (!judgedDigests?.includes(rendered.evidence.videoSha256)) {
          throw new Error('DATAMOSH_CARD_JUDGED_VIDEO_MISMATCH');
        }
        for (const file of ['mosh.mp4', 'contact.png', 'card.json', 'preview.html']) {
          await writeFileAtomic(path.join(artifactDirectory, file), await readFile(path.join(outputDir, file)));
        }
        previewPath = path.join(artifactDirectory, 'preview.html');
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    }
    if (artifactsPresent) {
      try {
        const result = await runtime.port.readVerifiedCreateResult(command, projection);
        const artifact = await runtime.createAuthority.readVerifiedArtifact(result);
        const { isGovernedAccepted, recordGovernedOutcome } = await import('./GovernedProjectRecord.js');
        const tasteAdmission = isGovernedAccepted(result.evaluation)
          && classifyJudgeScore(result.evaluation.score) === 'accepted'
          ? await runtime.port.readBoundTasteAdmission(command.idempotencyKey).catch(error => {
            console.warn(`Taste admission unavailable: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          }) : undefined;
        const recorded = await recordGovernedOutcome({ projectRoot: resolveSinterProjectRoot(), prompt: input.prompt,
          promptId: process.env.SINTER_PROMPT_ID, domain: input.domain, artifactDirectory, result,
          verifiedSource: artifact.source, tasteAdmission });
        for (const failure of recorded.failed) console.warn(`Project record skipped: ${failure}`);
      } catch (error) {
        console.warn(`Project record skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Say what the system ended up doing. Best-effort: the artifact is the deliverable.
    let mediumLine: string | undefined;
    let mediumPath: string | undefined;
    try {
      const record = describeMedium({
        domain: input.domain,
        source: await readFile(sourcePath, 'utf8'),
        decision: input.mediumDecision ?? { source: 'forced',
          reason: `the caller requested ${input.domain}` },
      });
      mediumPath = path.join(artifactDirectory, MEDIUM_FILENAME);
      await writeFileAtomic(mediumPath, `${JSON.stringify(record, null, 2)}\n`);
      mediumLine = record.made_with ?? record.medium_line;
    } catch (error) {
      console.warn(`MEDIUM_LINE_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
    }
    return Object.freeze({ result: projection.result, sourcePath,
      playablePath: path.join(artifactDirectory, 'playable.html'),
      ...(mediumLine ? { mediumLine, mediumPath } : {}),
      artifactsPresent,
      ...(prior ? { prior } : {}),
      ...(originalArtifactDirectory ? { originalArtifactDirectory } : {}),
      ...(fragmentPath ? { fragmentPath } : {}),
      ...(hostProofPath ? { hostProofPath } : {}),
      ...(previewPath ? { previewPath } : {}) });
  } finally {
    setSinterMemoryStage('cli:close');
    await runtime.close();
  }
}

async function readLoopFile(directory: string, name: string): Promise<Buffer> {
  const file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`LOOP_RECOVERY_NOT_A_FILE:${name}`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function verifyLoopArtifacts(authority: LiminalCommandService, result: LiminalCommandResult,
  directory: string, destination?: string): Promise<PriorRun> {
  const artifact = await authority.readVerifiedArtifact(result, { read: async () => ({
    source: (await readLoopFile(directory, 'source.txt')).toString('utf8'),
    playable: (await readLoopFile(directory, 'playable.html')).toString('utf8'),
    provenance: (await readLoopFile(directory, 'provenance.txt')).toString('utf8'),
  }) });
  const { earlyFrameDigest, lateFrameDigest } = result.evidence;
  const frameDigests = { 'early-frame.png': earlyFrameDigest, 'late-frame.png': lateFrameDigest };
  const frames = await Promise.all(Object.entries(frameDigests).flatMap(([file, digest]) =>
    digest ? [(async () => {
      const bytes = await readLoopFile(directory, file);
      if (createHash('sha256').update(bytes).digest('hex') !== digest) {
        throw new Error(`LOOP_RECOVERY_FRAME_DIGEST_MISMATCH:${file}`);
      }
      return { file, bytes };
    })()] : []));
  if (destination) {
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true });
    const staged = await mkdtemp(path.join(parent, '.loop-recovery-'));
    try {
      await writeFileAtomic(path.join(staged, 'source.txt'), artifact.source);
      await writeFileAtomic(path.join(staged, 'playable.html'), artifact.playable);
      await writeFileAtomic(path.join(staged, 'provenance.txt'), artifact.provenance);
      await writeFileAtomic(path.join(staged, 'artifact-manifest.json'), JSON.stringify(result.artifacts) + '\n');
      for (const frame of frames) await writeFileAtomic(path.join(staged, frame.file), frame.bytes);
      await writeFileAtomic(path.join(staged, 'rendered-evidence-manifest.json'),
        JSON.stringify({ earlyFrameDigest, lateFrameDigest }) + '\n');
      await rename(staged, destination);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  const evaluation = result.evaluation;
  return { source: artifact.source, score: evaluation.admissionEligible ? evaluation.score : null,
    critique: evaluation.reasoning ?? '', rejectionReasons: [...evaluation.rejectionReasons],
    frames: frames.map(frame => path.join(destination ?? directory, frame.file)),
    artifactDirectory: destination ?? directory, artifactDigest: result.receipt.artifactDigest };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Page showing the rendered Blender still (inline data URI, no external files) above the script. */
export function buildBlenderPreviewHtml(frame: Buffer, script: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>S1NTR</title>
<style>html,body{margin:0;background:#000;color:#9c9;font:13px ui-monospace,monospace}img{display:block;max-width:100%;max-height:100vh;margin:0 auto}details{padding:8px 10px}pre{white-space:pre-wrap}</style></head>
<body><img alt="Blender render" src="data:image/png;base64,${frame.toString('base64')}">
<details><summary>bpy script</summary><pre>${escapeHtml(script)}</pre></details></body></html>`;
}

async function writeBlenderPreview(artifactDirectory: string, sourcePath: string): Promise<string | undefined> {
  let frame: Buffer;
  try {
    frame = await readFile(path.join(artifactDirectory, 'early-frame.png'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const previewPath = path.join(artifactDirectory, 'preview.html');
  await writeFileAtomic(previewPath, buildBlenderPreviewHtml(frame, await readFile(sourcePath, 'utf8')));
  return previewPath;
}
