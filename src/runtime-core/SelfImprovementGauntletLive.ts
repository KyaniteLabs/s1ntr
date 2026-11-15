import type { LLMClient } from '../llm/LLMClient.js';
import { Status } from '../types/status.js';
import {
  LLMModeSelfImprovementRuntime,
  type SelfImprovementRuntime,
  type SelfImprovementRuntimeResult,
} from './SelfImprovementRuntime.js';

/**
 * Live self-improvement gauntlet.
 *
 * The static gauntlet (`runSelfImprovementGauntlet`) only checks routing/regex
 * contracts. This live gauntlet actually exercises ONE bounded self-improvement
 * pass through the real runtime (`LLMModeSelfImprovementRuntime` ->
 * `createLLMModeAgent` -> writeFile/applyEdit) and verifies a real edit landed.
 *
 * The CLI handler is responsible for spinning up a throwaway git worktree
 * sandbox and chdir-ing into it before calling this, then removing it after,
 * so the main repo working tree is never mutated. This module owns the
 * orchestration + verification of a single pass and stays pure enough to unit
 * test with the LLM and edit-detection boundaries mocked.
 */

/**
 * Bounded, safe, deterministic self-improvement target. This description
 * localizes (via RepoIndexLite) to a tight runtime-core packet, so the live
 * pass stays small and reviewable rather than wandering the whole repo.
 */
export const LIVE_GAUNTLET_DESCRIPTION =
  'Tighten the bounded runtime-core self-improvement task packet shaping and expansion budget determinism';

export interface LiveGauntletEditDetection {
  /** True when at least one tracked file shows an uncommitted change in the sandbox. */
  hasUncommittedChange: boolean;
  /** Paths the sandbox reports as changed (e.g. from `git status --porcelain`). */
  changedFiles: string[];
}

export interface LiveSelfImprovementGauntletOptions {
  /** Real LLM client wired to the live provider (GLM/MiniMax/etc). */
  llm: LLMClient;
  /**
   * Self-improvement runtime. Defaults to the real LLM-mode runtime so the live
   * gauntlet exercises the same path as `improve run`. Injectable for tests.
   */
  runtime?: SelfImprovementRuntime;
  /** Bounded self-improvement description. Defaults to the safe runtime-core target. */
  description?: string;
  /**
   * Require the agent to make at least one real edit (mutation gate). The live
   * gauntlet exists to exercise a real edit, so this defaults to true.
   * Inspection-only outcomes then fail honestly instead of passing as "no
   * change needed".
   */
  requiresMutation?: boolean;
  /**
   * Inspect the sandbox for a real edit (e.g. `git status --porcelain`). The
   * runtime tracks mutated files in-process, but this independent filesystem
   * check confirms the edit actually landed on disk in the sandbox.
   */
  detectSandboxEdits: () => Promise<LiveGauntletEditDetection> | LiveGauntletEditDetection;
}

export interface LiveSelfImprovementGauntletResult {
  /** Whether the live pass produced a verified, real edit. */
  verified: boolean;
  /** The bounded description the pass ran against. */
  description: string;
  /** Model that performed the pass. */
  modelName: string;
  /** Runtime session status (success/failed/...). */
  status: Status | string;
  /** Steps the agent took. */
  stepCount: number;
  /** Files the in-process runtime reported mutating. */
  mutatedFiles: string[];
  /** Files the runtime reported successfully mutating (mutation + verification). */
  successfulMutatedFiles: string[];
  /** Files the independent sandbox filesystem check found changed. */
  sandboxChangedFiles: string[];
  /** Why the pass was (not) considered a verified self-improvement. */
  reason: string;
  /** The raw runtime result, for callers that want the full session. */
  runtimeResult: SelfImprovementRuntimeResult;
}

/**
 * Run ONE bounded self-improvement pass through the real runtime and verify a
 * real edit was produced. Caller must have already chdir-ed into an isolated
 * sandbox worktree; this function does not create or remove it.
 */
export async function runLiveSelfImprovementGauntlet(
  options: LiveSelfImprovementGauntletOptions,
): Promise<LiveSelfImprovementGauntletResult> {
  const runtime = options.runtime ?? new LLMModeSelfImprovementRuntime();
  const description = options.description ?? LIVE_GAUNTLET_DESCRIPTION;
  const requiresMutation = options.requiresMutation ?? true;

  const runtimeResult = await runtime.run({ llm: options.llm, description, requiresMutation });
  const session = runtimeResult.session;
  const mutatedFiles = Array.from(session.mutatedFiles ?? []);
  const successfulMutatedFiles = Array.from(session.successfulMutatedFiles ?? []);

  const detection = await options.detectSandboxEdits();
  const sandboxChangedFiles = detection.changedFiles;

  // A real self-improvement requires BOTH: the runtime reports an in-process
  // mutation AND the sandbox filesystem confirms an uncommitted change landed.
  // Either alone is insufficient — in-process tracking can lie if a write
  // silently failed, and a stray sandbox change might predate the pass.
  const runtimeMutated = mutatedFiles.length > 0;
  const sandboxMutated = detection.hasUncommittedChange && sandboxChangedFiles.length > 0;
  const verified = runtimeMutated && sandboxMutated;

  let reason: string;
  if (verified) {
    reason = `Bounded self-improvement edited ${sandboxChangedFiles.join(', ')} in the sandbox and the runtime tracked ${mutatedFiles.length} mutation(s).`;
  } else if (!runtimeMutated && !sandboxMutated) {
    reason = `No edit produced: runtime tracked no mutation and the sandbox has no uncommitted change (status=${session.status}).`;
  } else if (!runtimeMutated) {
    reason = `Sandbox changed (${sandboxChangedFiles.join(', ')}) but the runtime reported no in-process mutation (status=${session.status}).`;
  } else {
    reason = `Runtime tracked mutation(s) (${mutatedFiles.join(', ')}) but the sandbox shows no matching uncommitted change (status=${session.status}).`;
  }

  return {
    verified,
    description,
    modelName: runtimeResult.modelName,
    status: session.status,
    stepCount: session.stepCount,
    mutatedFiles,
    successfulMutatedFiles,
    sandboxChangedFiles,
    reason,
    runtimeResult,
  };
}
