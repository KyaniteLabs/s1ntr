/**
 * Two-stage judge (#1731): a text-only code auditor and a vision seat that runs
 * two separate passes (B1 visual bugs, then B2 aesthetics), independent of each
 * other. No stage sees another stage's score before writing its own: the
 * auditor and B1 start together and neither is told about the other; B2 runs
 * only on frames B1 passed and is told B1's findings, never the auditor's.
 *
 * Fail closed: a missing auditor seat or an unparseable stage reply throws.
 * Nothing in here returns a silent 0.5.
 *
 * Status (Sol L3-10): wired into shipped Create behind SINTER_TWO_STAGE_JUDGE=1 (see twoStageJudgeFromEnv in
 * ProductionLiminalRuntime; SINTER_JUDGE_REASONING / SINTER_JUDGE_STRICTNESS set the seats). Off by default because it
 * triples judge requests per take and changes the receipt shape; the fake-provider e2e proves both paths.
 * Behaviour when it does run:
 *   - the seat `reasoning` dial configures every request it makes (audit, B1 and B2) via `thinkingForReasoning`;
 *   - `timeoutMs` is ONE action-wide budget: audit and B1 share it, B2 gets what is left, none may outlive it;
 *   - the final blend is bounded by what the eyes saw: min(0.6 aesthetics + 0.4 audit, aesthetics). The code audit
 *     can lower a piece, never lift it above its aesthetics score (so an overmix-capped B2 stays capped);
 *   - a crash finding is a defect of class `render`, not `none`;
 *   - GLITCH IS BEAUTY (owner rule): a rendered, moving, saturated frame (measured `glitchLiveness.alive`) is never
 *     capped or floored by a B1 look verdict ("corrupted", "static"); B1 stays advisory text for it. Only a crash
 *     finding from the code audit still caps it.
 */

import { scoreRenderedEvidence } from './ScoringEngine.js';
import { CapabilityRegistry } from '../llm/CapabilityRegistry.js';
import { boundedEvaluatorImages, firstJsonObject, parseJudgeJson } from './EvaluatorIO.js';
import { createCreativeJudgmentProfile } from '../learning/CreativeJudgmentCalibration.js';
import type { RenderEvidence, GenerationEvaluation } from './types/GenerationEvaluation.js';
import type { LLMClient } from '../llm/LLMClient.js';
import type { ThinkingConfig } from '../llm/ProviderTypes.js';
import { measureRenderEvidence } from '../perception/RenderEvidencePerception.js';
import { ALIVE_GLITCH_SCORE_FLOOR } from '../render/GlitchLiveness.js';

export type JudgeReasoning = 'medium' | 'high' | 'xhigh';
export type JudgeStrictness = 'lenient' | 'standard' | 'harsh';
export type FindingSeverity = 'crash' | 'wrong-per-brief' | 'perf' | 'dead-code';

export const JUDGE_REASONING_LEVELS: readonly JudgeReasoning[] = ['medium', 'high', 'xhigh'];
export const JUDGE_STRICTNESS_LEVELS: readonly JudgeStrictness[] = ['lenient', 'standard', 'harsh'];

/** The reasoning dial as a client thinking config (budgets match the audit's 16k default at high). */
export function thinkingForReasoning(level: JudgeReasoning): ThinkingConfig {
  const budgetTokens = { medium: 8_000, high: 16_000, xhigh: 32_000 }[level];
  return { enabled: true, budgetTokens, effort: level };
}

/** A score cap, not a tone: crash findings and B1 failures cannot score above this. */
export const DEFECT_SCORE_CAP = 0.25;
/** Final blend: aesthetics carries the piece, the audit keeps it honest, and the result never exceeds aesthetics. */
export const BLEND_WEIGHTS = Object.freeze({ aesthetics: 0.6, code: 0.4 });

export class JudgeSeatMissingError extends Error {
  constructor(seat: string) {
    super(`JUDGE_SEAT_MISSING: the two-stage judge needs a ${seat} seat; refusing to score without it`);
    this.name = 'JudgeSeatMissingError';
  }
}

export class JudgeStageReplyError extends Error {
  constructor(readonly stage: string, detail: string) {
    super(`JUDGE_STAGE_REPLY_INVALID:${stage}: ${detail}`);
    this.name = 'JudgeStageReplyError';
  }
}

export interface JudgeSeat {
  readonly client: LLMClient;
  readonly reasoning: JudgeReasoning;
  readonly strictness: JudgeStrictness;
}

export interface CodeFinding {
  readonly severity: FindingSeverity;
  readonly line?: number;
  readonly note: string;
}

export interface AuditStageResult {
  readonly findings: readonly CodeFinding[];
  readonly score: number;
  readonly raw: string;
}

export interface BugStageResult {
  readonly pass: boolean;
  readonly bugs: readonly string[];
  readonly raw: string;
}

export interface StageReceipt {
  readonly stage: 'audit' | 'visual-bugs' | 'aesthetics';
  readonly model: string;
  readonly reasoning: JudgeReasoning;
  readonly strictness: JudgeStrictness;
  readonly ran: boolean;
  readonly raw?: string;
}

export interface TwoStageReceipt {
  readonly schema: 'sinter.two-stage-judge-receipt';
  readonly schemaVersion: 1;
  readonly stages: readonly StageReceipt[];
  readonly rule: string;
  readonly audit: { readonly score: number; readonly findings: readonly CodeFinding[] };
  readonly visualBugs: { readonly pass: boolean; readonly bugs: readonly string[] };
  readonly aesthetics: { readonly score: number } | null;
  readonly capped: boolean;
  readonly finalScore: number;
}

export interface TwoStageInput {
  readonly evidence: RenderEvidence;
  readonly source: string;
  readonly brief: string;
  readonly domain: string;
  readonly runtimeErrors?: readonly string[];
  readonly timeoutMs?: number;
}

export interface TwoStageOptions {
  /** Text-only code-audit seat. Missing = fail closed. */
  readonly auditor: JudgeSeat | undefined;
  /** Vision seat; runs B1 then B2 on the same client. */
  readonly vision: JudgeSeat;
}

export interface TwoStageResult {
  readonly evaluation: GenerationEvaluation;
  readonly receipt: TwoStageReceipt;
}

const STRICTNESS_ANCHORS: Record<JudgeStrictness, string> = {
  lenient: 'Strictness LENIENT: report only defects a viewer would notice at once. Mark crash only for an uncaught exception or a blank result. A stylistic choice you dislike is not a finding.',
  standard: 'Strictness STANDARD: report every defect that changes what a viewer sees or hears, and every place the code contradicts the brief. A defect that only shows under unusual input is not a finding.',
  harsh: 'Strictness HARSH: report every contradiction of the brief, every hard-coded constant that ignores a number in the brief, every silently swallowed error, and every defect a careful reviewer would reject. Anchor: a zoom that shrinks when the brief says it moves inward is a wrong-per-brief finding even if the picture looks fine.',
};

function clamp01(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

export function buildAuditorSystemPrompt(strictness: JudgeStrictness): string {
  return `You are a senior code auditor for generative art. You read the full source and judge whether it does what the brief says. You cannot see the rendering; do not guess about looks.
${STRICTNESS_ANCHORS[strictness]}
Look for what a screenshot cannot show: direction errors (a zoom, pan or easing that goes the wrong way for the brief), hard-coded constants that ignore the brief's duration or counts, type errors a fallback path hides, work done every frame that should be done once, and dead code.
Severity per finding: "crash" (throws, fails to compile, or renders nothing), "wrong-per-brief" (runs but contradicts the brief), "perf" (cost that will stall a real viewer), "dead-code".
Return ONLY JSON: {"findings":[{"severity":"crash|wrong-per-brief|perf|dead-code","line":<1-based line or null>,"note":"<what is wrong and why>"}],"score":<0-1 code quality; 1 means no findings>}`;
}

export function buildBugsSystemPrompt(strictness: JudgeStrictness): string {
  return `You check rendered frames for visual defects only. You do not judge taste.
${STRICTNESS_ANCHORS[strictness]}
Defects to look for: blank or black frames, clipped layout, NaN speckle, banding, a frozen animation (the early and late frames are identical when the brief calls for motion), a palette that does not match the brief's colour count, washed-out output.
Return ONLY JSON: {"pass":<true when no defect above is present>,"bugs":["<one line per defect>"]}`;
}

function strictnessBrief(strictness: JudgeStrictness): string {
  return `Judge aesthetics at ${strictness} strictness: ${{
    lenient: 'give credit for clear intent; a competent piece may score in the upper-middle band.',
    standard: 'use the rubric bands as written.',
    harsh: 'score as a gallery curator would: competent is mid-band, only distinctive work scores high.',
  }[strictness]}`;
}

export function parseAuditorReply(raw: string): AuditStageResult {
  const json = firstJsonObject(raw);
  if (!json) throw new JudgeStageReplyError('audit', 'no JSON object in reply');
  let parsed: { findings?: unknown; score?: unknown };
  try { parsed = parseJudgeJson(json); } catch { throw new JudgeStageReplyError('audit', 'reply JSON did not parse'); }
  if (!Array.isArray(parsed.findings)) throw new JudgeStageReplyError('audit', 'findings must be an array');
  const findings: CodeFinding[] = parsed.findings.map((entry: unknown) => {
    const item = entry as { severity?: unknown; line?: unknown; note?: unknown };
    const severities: FindingSeverity[] = ['crash', 'wrong-per-brief', 'perf', 'dead-code'];
    if (!severities.includes(item.severity as FindingSeverity) || typeof item.note !== 'string') {
      throw new JudgeStageReplyError('audit', 'a finding needs a known severity and a note');
    }
    return { severity: item.severity as FindingSeverity, note: item.note,
      ...(typeof item.line === 'number' && Number.isInteger(item.line) && item.line > 0 ? { line: item.line } : {}) };
  });
  const score = clamp01(parsed.score);
  if (score === undefined) throw new JudgeStageReplyError('audit', 'score must be a number');
  return { findings, score, raw };
}

export function parseBugsReply(raw: string): BugStageResult {
  const json = firstJsonObject(raw);
  if (!json) throw new JudgeStageReplyError('visual-bugs', 'no JSON object in reply');
  let parsed: { pass?: unknown; bugs?: unknown };
  try { parsed = parseJudgeJson(json); } catch { throw new JudgeStageReplyError('visual-bugs', 'reply JSON did not parse'); }
  if (typeof parsed.pass !== 'boolean' || !Array.isArray(parsed.bugs)
    || parsed.bugs.some(bug => typeof bug !== 'string')) {
    throw new JudgeStageReplyError('visual-bugs', 'pass must be boolean and bugs a string array');
  }
  // A pass with listed bugs contradicts itself; the stricter reading wins.
  const bugs = parsed.bugs as string[];
  return { pass: parsed.pass && bugs.length === 0, bugs, raw };
}

/**
 * The stated rule: a crash finding or a B1 fail caps the score; otherwise a weighted blend that is bounded by the
 * aesthetics score (the audit may lower a piece, never lift it above what the vision seat saw).
 * `alive` (measured saturated + structured + moving) makes B1 advisory: a look verdict alone never caps it, and a
 * non-crash result is never scored below the alive-glitch line (or its own aesthetics score if that is lower).
 */
export function combineVerdict(input: {
  audit: AuditStageResult; bugs: BugStageResult; aesthetics: number | null; alive?: boolean;
}): { score: number; capped: boolean; rule: string } {
  const crash = input.audit.findings.some(finding => finding.severity === 'crash');
  const alive = input.alive === true;
  const rule = `crash finding${alive ? '' : ' or visual-bug fail'} caps the score at ${DEFECT_SCORE_CAP}; otherwise ${BLEND_WEIGHTS.aesthetics} aesthetics + ${BLEND_WEIGHTS.code} code audit, never above the aesthetics score${alive ? `; an alive glitch is not scored below ${ALIVE_GLITCH_SCORE_FLOOR} for its look` : ''}`;
  if (input.aesthetics === null || crash || (!input.bugs.pass && !alive)) {
    const base = input.aesthetics === null
      ? input.audit.score
      : Math.min(input.aesthetics, BLEND_WEIGHTS.aesthetics * input.aesthetics + BLEND_WEIGHTS.code * input.audit.score);
    return { score: Math.min(DEFECT_SCORE_CAP, base), capped: true, rule };
  }
  const blend = BLEND_WEIGHTS.aesthetics * input.aesthetics + BLEND_WEIGHTS.code * input.audit.score;
  let score = Math.min(input.aesthetics, blend);
  if (alive) score = Math.max(score, Math.min(input.aesthetics, ALIVE_GLITCH_SCORE_FLOOR));
  return { score, capped: false, rule };
}

/** The seat's reasoning dial applied to every request of a client (audit, B1 and, through the scorer, B2). */
export function withReasoning(client: LLMClient, level: JudgeReasoning): LLMClient {
  const thinking = thinkingForReasoning(level);
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'generate') {
        return (sys: string, user: string, signal?: AbortSignal, bypass?: boolean, images?: unknown, opts?: object) =>
          (target.generate as (...a: unknown[]) => unknown).call(target, sys, user, signal, bypass, images, { thinking, ...opts });
      }
      if (prop === 'generateWithImages') {
        return (sys: string, user: string, images: unknown, signal?: AbortSignal, bypass?: boolean, opts?: object) =>
          (target.generateWithImages as (...a: unknown[]) => unknown).call(target, sys, user, images, signal, bypass, { thinking, ...opts });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function seatModel(seat: JudgeSeat): string {
  const config = seat.client.getConfig();
  return `${config.provider ?? 'configured'}/${config.model}`;
}

async function frames(evidence: RenderEvidence) {
  const shots = [evidence.screenshot && { ...evidence.screenshot, label: 'rendered-artifact' },
    evidence.lateScreenshot && { ...evidence.lateScreenshot, label: 'rendered-artifact-late' }]
    .filter((shot): shot is NonNullable<typeof shot> => Boolean(shot));
  return boundedEvaluatorImages(shots);
}

async function runAudit(input: TwoStageInput, seat: JudgeSeat, signal?: AbortSignal): Promise<AuditStageResult> {
  const numbered = input.source.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n');
  const errors = (input.runtimeErrors ?? []).length > 0
    ? `\nRenderer runtime errors and console:\n${(input.runtimeErrors ?? []).join('\n')}` : '';
  const user = `Brief: ${input.brief}\nDomain: ${input.domain}\nSource (line-numbered):\n${numbered}${errors}`;
  const response = await seat.client.generate(buildAuditorSystemPrompt(seat.strictness), user,
    signal, true, undefined, { jsonMode: true });
  if (!response.success) throw new JudgeStageReplyError('audit', `transport failed: ${String(response.error ?? 'unknown')}`);
  return parseAuditorReply(response.code);
}

/** Same rule as the single-stage judge: a CLI seat other than Hermes passes text only. */
export function seatCanSee(seat: JudgeSeat): boolean {
  const config = seat.client.getConfig();
  const baseUrl = String(config.baseUrl ?? '');
  return CapabilityRegistry.supportsVision(String(config.model ?? ''))
    && (!baseUrl.startsWith('cli://') || baseUrl.startsWith('cli://hermes/'));
}

async function runBugs(input: TwoStageInput, seat: JudgeSeat, signal?: AbortSignal): Promise<BugStageResult> {
  const images = await frames(input.evidence);
  // No frames means nothing to inspect: that is itself the defect, and no model is asked to guess.
  if (images.length === 0) {
    return { pass: false, bugs: ['no rendered frame was captured'], raw: '' };
  }
  const user = `Brief: ${input.brief}\nDomain: ${input.domain}\nFrames attached: ${images.length} (early, then late).`;
  const response = await seat.client.generateWithImages(buildBugsSystemPrompt(seat.strictness), user,
    images, signal, true, { jsonMode: true, requireVision: true });
  if (!response.success) throw new JudgeStageReplyError('visual-bugs', `transport failed: ${String(response.error ?? 'unknown')}`);
  return parseBugsReply(response.code);
}

export async function judgeTwoStage(input: TwoStageInput, options: TwoStageOptions): Promise<TwoStageResult> {
  if (!options.auditor) throw new JudgeSeatMissingError('auditor');
  // One action-wide budget: every stage draws on the same absolute deadline.
  const deadline = input.timeoutMs && input.timeoutMs > 0 ? Date.now() + input.timeoutMs : undefined;
  const remaining = () => deadline === undefined ? undefined : deadline - Date.now();
  const stageSignal = () => {
    const left = remaining();
    if (left === undefined) return undefined;
    if (left <= 0) throw new JudgeStageReplyError('deadline', `action budget of ${input.timeoutMs}ms is spent`);
    return AbortSignal.timeout(left);
  };
  // The reasoning dial configures every request the seat makes.
  const auditor = { ...options.auditor, client: withReasoning(options.auditor.client, options.auditor.reasoning) };
  const vision = { ...options.vision, client: withReasoning(options.vision.client, options.vision.reasoning) };
  // A blind seat would return pass/fail verdicts on frames it never saw: refuse it.
  if (!seatCanSee(options.vision)) throw new JudgeSeatMissingError(`vision-capable (got ${seatModel(options.vision)})`);
  // Independent: neither promise reads the other's output.
  const [audit, bugsStage] = await Promise.all([runAudit(input, auditor, stageSignal()), runBugs(input, vision, stageSignal())]);

  // Measured, deterministic: a saturated, structured, moving frame is alive glitch, whatever B1 thinks of its look.
  const measure = await measureRenderEvidence(input.evidence).catch(() => undefined);
  const alive = measure?.glitchLiveness?.alive === true;
  let bugs = bugsStage;
  let aesthetics: GenerationEvaluation | null = null;
  let gate: GenerationEvaluation | null = null;
  if (bugs.pass || alive) {
    stageSignal(); // throws if the action budget is already spent
    const told = `${input.brief}\n${bugs.pass ? 'Visual-bug check found nothing blocking.' : 'Visual-bug check raised look findings; the frame is measured alive (saturated, structured, moving), so judge its impact, not its glitch.'} ${strictnessBrief(vision.strictness)}`;
    // Same as the single-stage judge: for music and ASCII the source is the artwork, so B2 reads it (Sol L3-10).
    const b2Source = input.domain === 'tone' || input.domain === 'strudel' || input.domain === 'ascii' ? input.source : '';
    aesthetics = await scoreRenderedEvidence(input.evidence, b2Source, told, vision.client, input.domain, {
      judgmentProfile: createCreativeJudgmentProfile(), deadlineAt: deadline
    });
    // The deterministic render gate inside the scorer can still reject the frames B1 passed.
    // That is a verdict (a capped visual defect with the gate's repair advice), not a transport failure.
    if (aesthetics.failureClass === 'render' || aesthetics.failureClass === 'infra') {
      gate = aesthetics;
      bugs = { ...bugs, pass: false, bugs: [...bugs.bugs, `render gate: ${aesthetics.reasoning ?? aesthetics.failureClass}`] };
      aesthetics = null;
    } else if (aesthetics.failureClass !== 'none' || aesthetics.confidence <= 0) {
      // A scorer that failed to score is not a verdict: surface it, never blend a placeholder.
      throw new JudgeStageReplyError('aesthetics', `scorer did not produce a verdict (${aesthetics.failureClass})`);
    }
  }
  const verdict = combineVerdict({ audit, bugs, aesthetics: aesthetics ? aesthetics.score : null, alive });
  const stage = (name: StageReceipt['stage'], seat: JudgeSeat, ran: boolean, raw?: string): StageReceipt =>
    ({ stage: name, model: seatModel(seat), reasoning: seat.reasoning, strictness: seat.strictness, ran,
      ...(raw !== undefined ? { raw } : {}) });
  const receipt: TwoStageReceipt = {
    schema: 'sinter.two-stage-judge-receipt', schemaVersion: 1,
    stages: [stage('audit', auditor, true, audit.raw), stage('visual-bugs', vision, true, bugs.raw),
      stage('aesthetics', vision, aesthetics !== null || gate !== null, (aesthetics ?? gate)?.reasoning)],
    rule: verdict.rule,
    audit: { score: audit.score, findings: audit.findings },
    visualBugs: { pass: bugs.pass, bugs: bugs.bugs },
    aesthetics: aesthetics ? { score: aesthetics.score } : null,
    capped: verdict.capped, finalScore: verdict.score,
  };
  const reasons = [
    ...audit.findings.map(f => `[${f.severity}${f.line ? ` L${f.line}` : ''}] ${f.note}`),
    ...bugs.bugs.map(b => `[visual] ${b}`),
  ];
  const evaluation: GenerationEvaluation = {
    score: verdict.score,
    confidence: aesthetics ? aesthetics.confidence : 1,
    failureClass: (bugs.pass || (alive && !gate)) && !audit.findings.some(f => f.severity === 'crash') ? 'none' : (gate?.failureClass ?? 'render'),
    ...(gate?.repairAdvice ? { repairAdvice: gate.repairAdvice } : {}),
    reasoning: `two-stage judge (${verdict.rule}). ${aesthetics?.reasoning ?? 'Aesthetics not scored: visual-bug check failed.'}${reasons.length ? ` Findings: ${reasons.join(' | ')}` : ''}`,
    ...(aesthetics?.dimensionScores ? { dimensionScores: aesthetics.dimensionScores } : {}),
    ...(aesthetics?.difficulty !== undefined ? { difficulty: aesthetics.difficulty } : {}),
  } as GenerationEvaluation;
  return { evaluation, receipt };
}
