import type { LLMClient } from '../llm/LLMClient.js';
import {
  createLLMModeAgent,
  type LLMSession,
  type LLMTask,
} from '../harness/agent/index.js';
import { createExperimentAuthorityPolicy } from '../harness/authority/ExperimentAuthority.js';
import {
  extractAdaptationId,
  identityOracleContainsAdaptationId,
  recordSelfImproveOutcome,
  withLearnedGuidance,
} from '../harness/SelfImproveCompoundLoop.js';
import { resolveHarnessSeatModel } from '../telemetry/harnessLane.js';
import { localizeBoundedSelfImprovement, type VerificationTarget } from './RepoIndexLite.js';
import { describeStatusLifecycle, type StatusLifecycleDescriptor } from '../types/status.js';
import {
  DEFAULT_SHADOW_BUDGETS,
  parseRecursiveExperimentContract,
  RECURSIVE_CONTRACT_VERSION,
  type RecursiveExperimentContract,
} from './RecursiveImprovementContract.js';

export interface SelfImprovementRuntimeInput {
  llm: LLMClient;
  description: string;
  /**
   * When true, the bounded task is not complete until the agent makes at least
   * one successful writeFile/applyEdit mutation and runs verification.
   * Inspection-only/no-change outcomes become failures. Used by the live
   * self-improve gauntlet and the `--confirm auto` execute path, which exist
   * specifically to exercise a real edit.
   */
  requiresMutation?: boolean;
  /**
   * When true, mutations are hard-blocked; agent must diagnose and deliver
   * complete(params.plan) only (architect / Kimi K3 plan-only seats).
   */
  forbidMutations?: boolean;
  kind?: string;
  /**
   * Optional external contract payload. Invalid or unsafe payloads fail before
   * an agent task is created. The runtime supplies a shadow contract when the
   * caller omits one so existing self-improvement entry points cannot bypass
   * W5-01.
   */
  recursiveContract?: unknown;
  /** Override agent step budget (battery task.maxSteps). Env LIMINAL_TUI_AGENT_MAX_STEPS still wins when set. */
  maxSteps?: number;
}

interface TaskPacket {
  fileHint: string;
  workingSet: string[];
  primaryFiles: string[];
  secondaryFiles: string[];
  deferredSecondaryFiles: string[];
  expansionBudget: number;
  expansionStatus: 'allowed' | 'exhausted';
  localizationConfidence: 'high' | 'medium' | 'low';
  verificationTargets: VerificationTarget[];
  domain: string;
  description: string;
}

export interface PreparedSelfImprovementRun {
  task: LLMTask;
  taskId: string;
  modelName: string;
  maxSteps: number;
  /** Description after withLearnedGuidance (identity oracle surface for pass B). */
  composedDescription: string;
  /** Adaptation ids present in composed guidance (byte-stable tags). */
  injectedAdaptationIds: string[];
  recursiveContract: RecursiveExperimentContract;
  execute: () => Promise<LLMSession>;
}

/**
 * Identity oracle: prepared run retains pass-A adaptation id in composed packet.
 * Not sufficient alone for compound floor — pair with a predeclared behavior check.
 */
export function assertIdentityOracle(
  prepared: Pick<PreparedSelfImprovementRun, 'composedDescription' | 'task'>,
  adaptationId: string,
): boolean {
  const haystack = `${prepared.composedDescription}\n${prepared.task.description}`;
  return identityOracleContainsAdaptationId(haystack, adaptationId);
}

/**
 * Behavior oracle: Verification-DRI MUST predeclare the behavior check
 * (`opts.custom`). Tag presence plus a non-trivial suffix is only a
 * precondition — it says nothing about task improvement, so there is no
 * default pass (#1325). Missing predicate throws rather than passing.
 */
export function assertBehaviorOracle(
  prepared: Pick<PreparedSelfImprovementRun, 'composedDescription' | 'task' | 'injectedAdaptationIds'>,
  adaptationId: string,
  opts: { requireBody?: boolean; custom: (text: string) => boolean },
): boolean {
  if (typeof opts?.custom !== 'function') {
    throw new Error('assertBehaviorOracle: a predeclared behavior check (opts.custom) is required');
  }
  if (!assertIdentityOracle(prepared, adaptationId)) return false;
  if (!prepared.injectedAdaptationIds.includes(adaptationId)) return false;
  const text = prepared.task.description;
  if (opts.requireBody !== false) {
    // Tag alone is not enough — line must have content after the bracket.
    const line = text.split('\n').find((l) => l.includes(`[adaptation:${adaptationId}`));
    if (!line) return false;
    const after = line.replace(/.*\[adaptation:[^\]]+\]\s*/, '').trim();
    if (after.length < 8) return false;
  }
  return opts.custom(text);
}

export interface SelfImprovementRuntimeResult {
  taskId: string;
  modelName: string;
  maxSteps: number;
  session: LLMSession;
  lifecycle: StatusLifecycleDescriptor;
}

export interface SelfImprovementRuntime {
  prepare(input: SelfImprovementRuntimeInput): PreparedSelfImprovementRun;
  run(input: SelfImprovementRuntimeInput): Promise<SelfImprovementRuntimeResult>;
}

function buildTaskPacket(description: string): TaskPacket {
  const context = localizeBoundedSelfImprovement(description);

  return {
    fileHint: context.fileHint,
    workingSet: context.workingSet,
    primaryFiles: context.primaryFiles,
    secondaryFiles: context.secondaryFiles,
    deferredSecondaryFiles: context.deferredSecondaryFiles,
    expansionBudget: context.expansionBudget,
    expansionStatus: context.expansionStatus,
    localizationConfidence: context.localizationConfidence,
    verificationTargets: context.verificationTargets,
    domain: context.domain,
    description: `${description}\n\n## Deterministic Task Packet\n${context.intro}\nPrimary files:\n- ${context.primaryFiles.join('\n- ')}\nSecondary files:\n- ${context.secondaryFiles.join('\n- ')}${context.deferredSecondaryFiles.length > 0 ? `\nDeferred secondary files:\n- ${context.deferredSecondaryFiles.join('\n- ')}` : ''}\nVerification targets:\n- ${context.verificationTargets.map((target) => `${target.tool}${target.pattern ? ` (${target.pattern})` : ''}: ${target.reason}`).join('\n- ')}\nExpansion budget: ${context.expansionBudget} additional files before broadening beyond this packet\nExpansion status: ${context.expansionStatus}\nLocalization confidence: ${context.localizationConfidence}\nDomain: ${context.domain}${context.fileHint ? `\nHint: ${context.fileHint}` : ''}\n\n## Self-Improvement Loop Contract\nThis task must tighten the concrete loop: PROMPT → Sinter acts → Sinter improves itself.\nThe agent receives a bounded task packet (fileHint, primaryFiles, secondaryFiles, verificationTargets). It reads, plans, edits, and verifies within that bounded set. This self-improvement loop routes broad self-improvement requests into bounded repo work. Do not widen beyond this packet unless the task explicitly requires expansion beyond the current bounded set.\n\nCurrent active focus file: ${context.fileHint}\n${context.primaryFiles.length > 1 ? `Do not jump to ${context.primaryFiles[1]} until you finish the current focus or explicitly reject it.\n` : ''}You are in LLM-driven mode. Plan your own steps. Your first explicit tool call should stay on the current active focus file unless you are editing or verifying.\nIf readFile returns truncated=true with startLine/endLine, continue that file with offset=endLine rather than rereading from the top.\nIf you need a specific method, symbol, or error location inside a large file, use search with the current file path before reading more pages.\n\nPreferred verification targets after a mutation:\n- ${context.verificationTargets.map((target) => `${target.tool}${target.pattern ? ` (${target.pattern})` : ''}: ${target.reason}`).join('\n- ')}\nPrefer the first applicable verification target before broader verification discovery.`,
  };
}

export class LLMModeSelfImprovementRuntime implements SelfImprovementRuntime {
  prepare(input: SelfImprovementRuntimeInput): PreparedSelfImprovementRun {
    const { llm, requiresMutation, forbidMutations, kind } = input;
    // Feed-forward: prepend short learned guidance from HarnessMemory when present.
    // Pass-B consumer seam (#583/#584): adaptation ids must survive into task.description.
    const description = withLearnedGuidance(input.description);
    const injectedAdaptationIds = description
      .split('\n')
      .map((line) => extractAdaptationId(line))
      .filter((id): id is string => Boolean(id));
    const diagnose = Boolean(forbidMutations) || kind === 'diagnose';
    // Diagnose: do NOT inject the mutation task packet — it trains the model to
    // "edit focus files" and burned K3 recon without ever delivering params.plan.
    const taskPacket = diagnose ? null : buildTaskPacket(description);
    // Best-effort sync name; run()/CLI resolveEffectiveModel for seat truth (F1).
    const modelName = llm.getConfig().model || 'unknown';
    const _maxStepsEnv = parseInt(process.env.LIMINAL_TUI_AGENT_MAX_STEPS ?? '', 10);
    const _maxStepsIn = typeof input.maxSteps === 'number' ? input.maxSteps : NaN;
    const maxSteps = Number.isFinite(_maxStepsEnv) && _maxStepsEnv > 0
      ? _maxStepsEnv
      : Number.isFinite(_maxStepsIn) && _maxStepsIn > 0
        ? _maxStepsIn
        : (diagnose ? 28 : 20);
    // Diagnose must NOT use tui-self-* ids — that prefix triggers mutation-oriented
    // bounded-inspection auto-exit (SUCCESS with no plan) and kills architect seats.
    const taskId = diagnose ? `tui-diagnose-${Date.now()}` : `tui-self-${Date.now()}`;
    const recursiveContract = parseRecursiveExperimentContract(
      input.recursiveContract ?? {
        version: RECURSIVE_CONTRACT_VERSION,
        loop: diagnose ? 'consolidate' : 'autoresearch',
        experimentId: taskId,
        lineageId: taskId,
        state: 'observe',
        stage: 'shadow',
        sourceMutationRequested: !diagnose,
        budgets: DEFAULT_SHADOW_BUDGETS,
      },
    );
    const diagnoseDescription =
      `${description}\n\n## Architect Diagnose Contract\n` +
      `You inspect only (read/search/git/typecheck/tests + executeSkill). Mutations are forbidden.\n` +
      `SKILLS: Early in the run, executeSkill {"name":"comorbidity-check"} and executeSkill {"name":"systematic-debugging"} ` +
      `(repo .skills/). Follow their methods with harness tools only; skills may chain other executeSkill loads.\n` +
      `Finish with tool complete and params.plan = full markdown implementer spec (≥200 chars).\n` +
      `Dirty working-tree diffs are orchestrator WIP — ignore them; do not adopt them as a task.\n` +
      `Prefer depth on the recursive compound loop over breadth.`;
    const candidateFiles = diagnose ? [] : taskPacket!.workingSet;
    const experimentAuthority = createExperimentAuthorityPolicy({
      contract: recursiveContract,
      candidateFiles,
      sealedEvaluatorFiles: candidateFiles.filter((file) =>
        /(?:evaluator|evaluation|scoringengine|protected-judge)/i.test(file)
      ),
      allowedSkills: ['comorbidity-check', 'systematic-debugging'],
    });
    const task: LLMTask = {
      id: taskId,
      title: diagnose
        ? 'Architect diagnose — plan only (no product mutations)'
        : 'Bubble Tea TUI self-improvement request',
      description: diagnose ? diagnoseDescription : taskPacket!.description,
      kind: kind || (diagnose ? 'diagnose' : undefined),
      fileHint: diagnose ? undefined : taskPacket!.fileHint,
      // Diagnose: free exploration of the self-improve loop (no bounded mutation packet).
      workingSet: diagnose ? undefined : taskPacket!.workingSet,
      primaryFiles: diagnose ? undefined : taskPacket!.primaryFiles,
      secondaryFiles: diagnose ? undefined : taskPacket!.secondaryFiles,
      deferredSecondaryFiles: diagnose ? undefined : taskPacket!.deferredSecondaryFiles,
      expansionBudget: diagnose ? undefined : taskPacket!.expansionBudget,
      expansionStatus: diagnose ? undefined : taskPacket!.expansionStatus,
      localizationConfidence: diagnose ? undefined : taskPacket!.localizationConfidence,
      // Diagnose seats should not be forced onto mutation verification targets.
      verificationTargets: diagnose ? [] : taskPacket!.verificationTargets,
      domain: diagnose ? 'harness-diagnose' : taskPacket!.domain,
      maxSteps,
      approved: true,
      completionPolicy: diagnose ? 'manual' : 'stop_after_verification',
      experimentAuthority,
      // Only set the mutation gate when requested so inspection-style runs keep
      // their existing task shape (and existing snapshot-style tests).
      ...(requiresMutation && !diagnose ? { requiresMutation: true } : {}),
      ...(diagnose ? { forbidMutations: true, kind: 'diagnose' } : {}),
    };

    return {
      task,
      taskId,
      modelName,
      maxSteps,
      composedDescription: description,
      injectedAdaptationIds,
      recursiveContract,
      execute: async () => {
        // F1: resolve seat before the agent loop so receipts never say Model: auto.
        await resolveHarnessSeatModel(llm);
        const agent = createLLMModeAgent(llm);
        return agent.executeTask(task);
      },
    };
  }

  async run(input: SelfImprovementRuntimeInput): Promise<SelfImprovementRuntimeResult> {
    const prepared = this.prepare(input);
    // Prefer resolved seat model for gauntlet/summary lines (F1).
    const modelName = await resolveHarnessSeatModel(input.llm);
    const session = await prepared.execute();
    // Re-read after execute — resolveEffectiveModel may have updated config.
    const resolvedAfter = input.llm.getConfig().model || modelName;
    // Compound joint: persist outcome into FailureLogger / PatternDetector / HarnessMemory.
    // Await so short-lived CLI/rotation processes flush HarnessMemory before exit.
    await recordSelfImproveOutcome(session, {
      taskId: prepared.taskId,
      model: resolvedAfter,
      description: input.description,
      kind: prepared.task.kind,
    });
    return {
      taskId: prepared.taskId,
      modelName: resolvedAfter,
      maxSteps: prepared.maxSteps,
      session,
      lifecycle: describeStatusLifecycle(session.status, session.lastPlanError, {
        lastVerification: session.lastVerification,
        mutatedFiles: session.mutatedFiles ? Array.from(session.mutatedFiles) : [],
      }),
    };
  }
}
