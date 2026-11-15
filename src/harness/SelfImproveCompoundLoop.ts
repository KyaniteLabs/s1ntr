/**
 * Self-improve compound feed-forward (Wave 3).
 *
 * Closes: self-improve outcome → FailureLogger → PatternDetector → HarnessMemory
 * and injects short learned guidance into the next self-improve/diagnose description.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { failureLogger } from './FailureLogger.js';
import { patternDetector } from './PatternDetector.js';
import { harnessMemory } from './HarnessMemory.js';
import type { LLMSession } from './agent/LLMModeAgent.js';
import { Status } from '../types/status.js';
import { Logger } from '../utils/Logger.js';

export const LEARNED_SECTION_HEADER = '## Learned from prior runs';
/**
 * Prefix for identity-preserving feed-forward (Wave 3 #583).
 * Captures id only; optional ` provenance:…` may appear before the closing `]`.
 * Examples: `[adaptation:adapt_1]` or `[adaptation:adapt_1 provenance:harness-memory]`.
 */
export const ADAPTATION_TAG_RE = /\[adaptation:([^\s\]]+)/;
const MAX_LEARNED_LINES = 3;
const MAX_LINE_CHARS = 240;
/** A tag longer than this is not a bounded identity; the line is dropped rather than cut. */
const MAX_TAG_CHARS = 160;
/** Leading `[adaptation:<id>( provenance:<p>)?]` tag, captured whole. */
const LEADING_TAG_RE = /^\[adaptation:[^\s\]]+(?: provenance:[^\s\]]+)?\]/;

/**
 * Bound a guidance line to MAX_LINE_CHARS without cutting its identity tag.
 * Only the body after the tag is truncated. Returns null when a line starts
 * with an adaptation tag that is malformed or longer than MAX_TAG_CHARS.
 */
function boundGuidanceLine(line: string): string | null {
  if (line.startsWith('[adaptation:')) {
    const tag = LEADING_TAG_RE.exec(line)?.[0];
    if (!tag || tag.length > MAX_TAG_CHARS) return null;
    if (line.length <= MAX_LINE_CHARS) return line;
    const bodyBudget = MAX_LINE_CHARS - tag.length - 2; // space + ellipsis
    return `${tag} ${line.slice(tag.length).trim().slice(0, Math.max(0, bodyBudget))}…`;
  }
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

export interface SelfImproveOutcomeContext {
  taskId: string;
  model: string;
  description: string;
  kind?: string;
}

export interface AdaptationGuidanceSource {
  id?: string;
  description?: string;
}

/**
 * Pure: format one guidance line with stable adaptation identity.
 * Pass-B consumer (`LLMModeSelfImprovementRuntime.prepare`) must see the exact id tag.
 */
export function formatAdaptationGuidanceLine(
  adaptation: AdaptationGuidanceSource,
  opts?: { provenance?: string },
): string {
  const desc = typeof adaptation.description === 'string' ? adaptation.description.trim() : '';
  const id = typeof adaptation.id === 'string' ? adaptation.id.trim() : '';
  if (!desc && !id) return '';
  const provenance = opts?.provenance ? ` provenance:${opts.provenance}` : '';
  if (id) {
    const body = desc || '(no description)';
    return `[adaptation:${id}${provenance}] ${body}`;
  }
  return desc;
}

/** Extract adaptation id from a guidance line (null if absent). */
export function extractAdaptationId(line: string): string | null {
  const m = ADAPTATION_TAG_RE.exec(line);
  return m ? m[1] : null;
}

/** Normalize for learned-line dedupe (first 80 chars, lowercased). Prefer id when present. */
export function normalizeLearnedLineKey(line: string): string {
  const id = extractAdaptationId(line);
  if (id) return `id:${id}`;
  return line.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

/** Pure: format adaptation descriptions into a markdown section (or empty). Dedupes near-identical tips. */
export function formatLearnedGuidanceSection(lines: string[]): string {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const bounded = boundGuidanceLine(line);
    if (bounded === null) continue;
    const key = normalizeLearnedLineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(bounded);
    if (cleaned.length >= MAX_LEARNED_LINES) break;
  }
  if (cleaned.length === 0) return '';
  return `${LEARNED_SECTION_HEADER}\n${cleaned.map((l) => `- ${l}`).join('\n')}\n`;
}

/** Pure: prepend learned section once (idempotent if already present). */
export function prependLearnedToDescription(description: string, learnedSection: string): string {
  if (!learnedSection.trim()) return description;
  if (description.includes(LEARNED_SECTION_HEADER)) return description;
  return `${learnedSection.trim()}\n\n${description}`;
}

/** Load up to N recent adaptation guidance lines (with `[adaptation:<id>]` when id known). */
export function loadLearnedGuidanceLines(limit: number = MAX_LEARNED_LINES): string[] {
  try {
    let adaptations = harnessMemory.getAdaptations();
    // Short-lived rotation/CLI may never call initialize(); fall back to on-disk memory.
    // Skip disk in unit tests so mocks are not polluted by the developer's ~/.sinter store.
    const allowDisk = process.env.NODE_ENV !== 'test' || process.env.LIMINAL_HARNESS_MEMORY_DISK === '1';
    if (!adaptations.length && allowDisk) {
      const memoryFile = join(homedir(), '.sinter', 'memory', 'harness-memory.json');
      if (existsSync(memoryFile)) {
        const raw = JSON.parse(readFileSync(memoryFile, 'utf8')) as {
          adaptations?: Array<{ id?: string; description?: string }>;
        };
        adaptations = Array.isArray(raw.adaptations) ? raw.adaptations as typeof adaptations : [];
      }
    }
    // Prefer recent first (array is append-ordered); over-fetch then dedupe in format step.
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const a of adaptations.slice(-Math.max(limit * 6, 12)).reverse()) {
      const line = formatAdaptationGuidanceLine(
        { id: a.id, description: a.description },
        { provenance: 'harness-memory' },
      );
      if (!line) continue;
      const key = normalizeLearnedLineKey(line);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
      if (lines.length >= limit) break;
    }
    return lines;
  } catch (err) {
    Logger.warn('SelfImproveCompoundLoop', `loadLearnedGuidanceLines failed: ${String(err)}`);
    return [];
  }
}

/**
 * Identity oracle helper: does composed text contain the exact adaptation id tag?
 * Behavior oracle is separate (Verification-DRI) — id citation alone is not sufficient.
 */
export function identityOracleContainsAdaptationId(
  composedText: string,
  adaptationId: string,
): boolean {
  if (!adaptationId || !composedText) return false;
  // Exact id: the tag must close or continue with provenance right after the id,
  // so `adapt_1` does not match `[adaptation:adapt_10]`.
  const needle = `[adaptation:${adaptationId}`;
  let from = 0;
  for (let at = composedText.indexOf(needle, from); at !== -1; at = composedText.indexOf(needle, from)) {
    const next = composedText[at + needle.length];
    if (next === ']' || next === ' ') return true;
    from = at + 1;
  }
  return false;
}

/** Apply learned guidance to a task description for the next self-improve/diagnose pass. */
export function withLearnedGuidance(description: string): string {
  return prependLearnedToDescription(description, formatLearnedGuidanceSection(loadLearnedGuidanceLines()));
}

/**
 * Verify-before-learn gate (IW-S04 / IW-005).
 * Reject patterns that look like active sabotage fixtures or empty names.
 * Returns reason string when rejected, null when ok to persist.
 */
export function verifyPatternBeforeLearn(pattern: {
  name?: string;
  description?: string;
}): string | null {
  const name = (pattern.name || '').trim();
  const desc = (pattern.description || '').trim();
  if (!name) return 'empty_pattern_name';
  if (/^harmful[-_]/i.test(name) || /__REJECT__/i.test(name)) {
    return 'harmful-pattern-rejected';
  }
  if (/\beval\s*\(|\bnew\s+Function\b|rm\s+-rf\s+\//i.test(desc)) {
    return 'harmful-pattern-rejected';
  }
  return null;
}

/**
 * Low-level plan bytes writer. Prefer `publishDiagnosePlan` (PlanPublisher) as the
 * only public diagnose plan SoT. Direct callers outside PlanPublisher are a dual-writer
 * defect (Wave8 L2 residual).
 */
export function writeDiagnosePlanFile(runDir: string, taskId: string, planText: string): string {
  const receiptsDir = join(runDir, 'receipts');
  mkdirSync(receiptsDir, { recursive: true });
  const planPath = join(receiptsDir, `${taskId}-plan.md`);
  writeFileSync(planPath, planText, 'utf8');
  return planPath;
}

const NON_SUCCESS_STATUSES = new Set<string>([
  Status.FAILED, Status.ROLLED_BACK, Status.SUSPENDED, Status.CANCELLED,
  'failed', 'rolled_back', 'suspended', 'cancelled',
]);

/**
 * A suspended (checkpointed) or cancelled run did not succeed. Treating it as
 * success scored 0-work episodes 1 and hid the suspension from the harness.
 */
export function isFailureStatus(status: string | undefined): boolean {
  return status !== undefined && NON_SUCCESS_STATUSES.has(status);
}

/**
 * Record self-improve session outcome into FailureLogger + PatternDetector + HarnessMemory.
 * On failure: full failure log + pattern analysis + adaptation record.
 * On success: light episode so the pass is still observable.
 * Flushes HarnessMemory so short-lived rotation/CLI processes do not drop adaptations
 * (30s auto-save alone is not enough when the process exits).
 * Never throws (dogfood must not die on memory I/O).
 */
export async function recordSelfImproveOutcome(
  session: Pick<LLMSession, 'status' | 'stepCount' | 'lastPlanError' | 'toolsUsed' | 'diagnosePlan'>,
  ctx: SelfImproveOutcomeContext,
): Promise<{ loggedFailure: boolean; patterns: number; adaptationIds: string[] }> {
  // loggedFailure is true only when the FailureLogger write succeeded.
  const result = { loggedFailure: false, patterns: 0, adaptationIds: [] as string[] };
  try {
    // Ensure disk state is loaded before append+save (singleton starts empty until init).
    if (typeof harnessMemory.initialize === 'function') {
      await harnessMemory.initialize();
    }

    const tools = Array.isArray(session.toolsUsed) ? session.toolsUsed.join(',') : '';
    const duration = typeof session.stepCount === 'number' ? session.stepCount * 1000 : 0;
    const domain = ctx.kind === 'diagnose' || ctx.description.includes('Diagnose')
      ? 'harness-diagnose'
      : 'harness-self-improve';
    const failed = isFailureStatus(String(session.status));

    if (failed) {
      const error = session.lastPlanError
        || `Self-improve failed (status=${session.status}, steps=${session.stepCount ?? '?'})`;
      const write = failureLogger.log({
        model: ctx.model || 'unknown',
        domain,
        prompt: `[${ctx.taskId}] ${ctx.description.slice(0, 500)}`,
        error,
        errorType: 'other',
        duration,
        thinking: tools ? `toolsUsed=${tools}` : undefined,
      });
      // Only claim the failure was logged when the record actually reached disk.
      result.loggedFailure = write.written;

      const failureRecord = {
        model: ctx.model || 'unknown',
        domain,
        prompt: ctx.description.slice(0, 500),
        error,
        errorType: 'other' as const,
        duration,
        timestamp: new Date().toISOString(),
        sessionId: failureLogger.getSessionId?.() ?? ctx.taskId,
      };
      const patterns = patternDetector.analyze(failureRecord);
      result.patterns = patterns.length;
      for (const pattern of patterns) {
        const reject = verifyPatternBeforeLearn({
          name: pattern.name,
          description: `${pattern.name} ${error}`,
        });
        if (reject) {
          failureLogger.log({
            model: ctx.model || 'unknown',
            domain,
            prompt: `[${ctx.taskId}] pattern-reject`,
            error: reject,
            errorType: 'other',
            duration: 0,
            thinking: `failureClass=harmful-pattern-rejected pattern=${pattern.name}`,
          });
          continue;
        }
        harnessMemory.recordPatternOccurrence(pattern.name, domain);
        const id = harnessMemory.recordAdaptation({
          patternName: pattern.name,
          patternSeverity: pattern.severity ?? 'medium',
          fixType: 'manual',
          description: `Self-improve ${ctx.taskId}: ${pattern.name} — ${error.slice(0, 160)}`,
          success: false,
        });
        result.adaptationIds.push(id);
      }
      if (patterns.length === 0) {
        const id = harnessMemory.recordAdaptation({
          patternName: 'self-improve-failure',
          patternSeverity: 'medium',
          fixType: 'manual',
          description: `Self-improve ${ctx.taskId} failed: ${error.slice(0, 200)}`,
          success: false,
        });
        result.adaptationIds.push(id);
      }
    } else {
      // Success / diagnose success: episode for observability (no FailureLogger spam).
      harnessMemory.recordEpisode({
        type: 'command',
        domain,
        prompt: `[${ctx.taskId}] ${ctx.description.slice(0, 300)}`,
        comment: `status=${session.status}; steps=${session.stepCount ?? 0}; tools=${tools}`,
        tags: ['self-improve', ctx.kind || 'self-improve', String(session.status)],
        score: failed ? 0 : 1,
      });
      if (typeof session.diagnosePlan === 'string' && session.diagnosePlan.length >= 200) {
        const id = harnessMemory.recordAdaptation({
          patternName: 'diagnose-plan-delivered',
          patternSeverity: 'low',
          fixType: 'manual',
          description: `Diagnose plan delivered (${session.diagnosePlan.length} chars) for ${ctx.taskId}`,
          success: true,
        });
        result.adaptationIds.push(id);
      }
    }

    // Flush before process exit — rotation dogfood is short-lived.
    if (typeof harnessMemory.save === 'function') {
      const saveResult = await harnessMemory.save();
      if (saveResult && typeof saveResult === 'object' && 'isErr' in saveResult && saveResult.isErr()) {
        Logger.warn('SelfImproveCompoundLoop', `HarnessMemory save failed after outcome: ${saveResult.error?.message ?? 'unknown'}`);
      }
    }
  } catch (err) {
    Logger.warn('SelfImproveCompoundLoop', `recordSelfImproveOutcome failed: ${String(err)}`);
  }
  return result;
}
