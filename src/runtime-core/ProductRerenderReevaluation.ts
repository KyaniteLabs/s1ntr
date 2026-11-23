import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JUDGE_REASONING_LEVELS, JUDGE_STRICTNESS_LEVELS } from '../core/TwoStageJudge.js';
import {
  LiminalCommandService,
  type LiminalCommandEffects,
  type LiminalCommandResult,
  type LiminalCreativeCommand,
  type LiminalReceiptAuthority,
} from './LiminalCommandService.js';
import {
  FileLiminalArtifactStore,
  FileLiminalOperationJournal,
} from './LiminalCommandFilePersistence.js';
import { commandFactory, type ProductionSourceRefs } from './ProductionLiminalRuntime.js';

/** Digest-pinned grant for one re-render + re-judge of one persisted product run (#1649). */
export interface RerenderReevaluationGrant {
  readonly schema: 'sinter.rerender-reevaluation-authority';
  readonly schemaVersion: 1;
  readonly sourceHeadSha: string;
  readonly parentReceiptSignature: string;
  readonly parentEvidenceDigest: string;
  readonly maxTransportAttempts: 1;
  readonly candidateCount: 0;
  readonly evaluatorTimeoutMs: number;
  /** Needed only when the run root holds more than one create projection. */
  readonly parentCreateIdempotencyKey?: string;
}

export interface RerenderReevaluateDeps {
  readonly effects: LiminalCommandEffects;
  readonly authority: LiminalReceiptAuthority;
  /** The exact parent command when the caller has it; otherwise it is rebuilt and proven. */
  readonly command?: LiminalCreativeCommand;
  /** Prompt text, needed to rebuild the command: run roots store only its digest. */
  readonly promptText?: string;
  /** The active checkout, action event, or package binding used by a current run. */
  readonly currentSourceRefs?: ProductionSourceRefs;
  /** origin/main SHAs the run may have been created against (see gitMainCandidates). */
  readonly canonicalMainCandidates?: readonly string[];
}

export interface RerenderReevaluateOutcome {
  readonly grantDigest: string;
  readonly parentKey: string;
  readonly command: LiminalCreativeCommand;
  readonly parent: LiminalCommandResult;
  readonly result: LiminalCommandResult;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;

export function parseRerenderGrant(bytes: string): RerenderReevaluationGrant {
  let grant: Partial<RerenderReevaluationGrant>;
  try { grant = JSON.parse(bytes) as Partial<RerenderReevaluationGrant>; } catch {
    throw new Error('REEVALUATION_GRANT_INVALID');
  }
  if (grant.schema !== 'sinter.rerender-reevaluation-authority' || grant.schemaVersion !== 1
    || !SHA1.test(grant.sourceHeadSha ?? '')
    || !SHA256.test(grant.parentReceiptSignature ?? '')
    || !SHA256.test(grant.parentEvidenceDigest ?? '')
    || grant.maxTransportAttempts !== 1 || grant.candidateCount !== 0
    || !Number.isSafeInteger(grant.evaluatorTimeoutMs) || grant.evaluatorTimeoutMs! < 1) {
    throw new Error('REEVALUATION_GRANT_INVALID');
  }
  return Object.freeze(grant as RerenderReevaluationGrant);
}

/** Accepts exactly this grant's digest, parent, evidence and attempt count, for a re-render only. */
export function createRerenderGrantVerifier(grant: RerenderReevaluationGrant, grantDigest: string) {
  return (input: Readonly<{ action: 'reevaluate' | 'rerender-reevaluate'; digest: string;
    parent: { readonly signature: string }; evidenceDigest: string;
    maxTransportAttempts: 1 }>): boolean =>
    input.action === 'rerender-reevaluate'
    && input.digest === grantDigest
    && input.parent.signature === grant.parentReceiptSignature
    && input.evidenceDigest === grant.parentEvidenceDigest
    && input.maxTransportAttempts === grant.maxTransportAttempts;
}

/** Every SHA origin/main has pointed at in this clone, newest first. Empty when git cannot say. */
export function gitMainCandidates(repoRoot: string): string[] {
  try {
    return execFileSync('git', ['-C', repoRoot, 'reflog', 'show', '--format=%H',
      'refs/remotes/origin/main'], { encoding: 'utf8' }).split('\n')
      .map(line => line.trim().toLowerCase()).filter(line => SHA1.test(line));
  } catch { return []; }
}

/**
 * Rebuild the parent command from evidence. The idempotency key embeds
 * sha256(sourceRefs, identities, settings), so a candidate is accepted only when it
 * reproduces the stored key exactly; anything else is unrecoverable, never guessed.
 */
function reconstructCommand(parentKey: string, parent: LiminalCommandResult,
  deps: RerenderReevaluateDeps): LiminalCreativeCommand {
  const [, head] = parentKey.split(':');
  if (deps.promptText && SHA1.test(head ?? '')) {
    const identities = Object.freeze({ ...parent.roles,
      renderer: parent.evidence.rendererIdentity });
    const historical: ProductionSourceRefs[] = [...new Set(deps.canonicalMainCandidates ?? [])].map(main => ({
      sourceHeadSha: head!, canonicalMainSha: main, sourceKind: 'git-origin-main',
      sourceHeadSource: 'git-head', canonicalMainSource: 'git-origin-main',
    }));
    const current = deps.currentSourceRefs;
    const candidates = current?.sourceHeadSha === head ? [current, ...historical] : historical;
    // There may be no judge receipt when rendering failed. Each supported profile
    // and the legacy command can be tried safely because the stored key binds the exact settings.
    const profiles = [undefined, ...JUDGE_REASONING_LEVELS.flatMap(reasoning =>
      JUDGE_STRICTNESS_LEVELS.map(strictness => ({ reasoning, strictness })))];
    for (const sourceRefs of candidates) {
      for (const profile of profiles) {
        try {
          const command = commandFactory(sourceRefs, identities, profile)({ prompt: deps.promptText,
            domain: parent.domain, maxTransportAttempts: parent.attempts.maximum });
          if (command.idempotencyKey === parentKey) return command;
        } catch { /* try the next candidate */ }
      }
    }
  }
  throw new Error('REEVALUATION_COMMAND_UNRECOVERABLE');
}

async function readCreateProjections(runRoot: string):
  Promise<Record<string, { kind: string; result: LiminalCommandResult }>> {
  try {
    return JSON.parse(await readFile(path.join(runRoot, 'product-projections.json'), 'utf8'));
  } catch { throw new Error('REEVALUATION_RUN_ROOT_INVALID'); }
}

/**
 * Re-render the persisted artifact of one product run on the current renderer and judge the
 * fresh evidence once. Absolute paths only; refuses before any render unless the grant names
 * this run's parent receipt, evidence and source head.
 */
export async function rerenderReevaluateProductRun(runRoot: string, grantPath: string,
  deps: RerenderReevaluateDeps): Promise<RerenderReevaluateOutcome> {
  if (!path.isAbsolute(runRoot) || !path.isAbsolute(grantPath)) {
    throw new Error('REEVALUATION_PATH_NOT_ABSOLUTE');
  }
  const grantBytes = await readFile(grantPath, 'utf8');
  const grant = parseRerenderGrant(grantBytes);
  const grantDigest = createHash('sha256').update(grantBytes).digest('hex');
  const projections = await readCreateProjections(runRoot);
  const creates = Object.entries(projections).filter(([, value]) => value.kind === 'create');
  const [parentKey, projection] = grant.parentCreateIdempotencyKey
    ? [grant.parentCreateIdempotencyKey, projections[grant.parentCreateIdempotencyKey]] as const
    : creates.length === 1 ? creates[0]! : [undefined, undefined] as const;
  if (!parentKey || projection?.kind !== 'create') throw new Error('REEVALUATION_PARENT_NOT_FOUND');
  const parent = projection.result;
  if (parentKey.split(':')[1] !== grant.sourceHeadSha
    || parent.receipt.signature !== grant.parentReceiptSignature
    || parent.receipt.evidenceDigest !== grant.parentEvidenceDigest) {
    throw new Error('REEVALUATION_GRANT_PARENT_MISMATCH');
  }
  const command = deps.command ?? reconstructCommand(parentKey, parent, deps);
  const service = new LiminalCommandService({
    effects: deps.effects,
    artifacts: new FileLiminalArtifactStore(path.join(runRoot, 'artifacts')),
    journal: new FileLiminalOperationJournal(path.join(runRoot, 'operation-journal.json')),
    authority: deps.authority,
    verifyActionAuthority: createRerenderGrantVerifier(grant, grantDigest),
  });
  const result = await service.rerenderAndReevaluate(command, parent, {
    idempotencyKey: `${parentKey}:rerender-evaluation:${grantDigest}`,
    maxTransportAttempts: 1, actionAuthorityDigest: grantDigest });
  return Object.freeze({ grantDigest, parentKey, command, parent, result });
}
