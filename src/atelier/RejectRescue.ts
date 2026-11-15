/**
 * RejectRescue — the rescue organ for rejected generations.
 *
 * The CEO audit question: "is good art falling through the cracks?" This
 * organ answers it per reject pool with evidence:
 *  - FALSE KILL: the piece validates clean under the CURRENT validators,
 *    exactly as the pipeline first sees it — the old stack killed valid art.
 *  - RECOVERED: the piece passes after the pipeline's own mechanical recovery
 *    chain (fence/prose/HTML-embedded-script/tail strips) — the spine saves
 *    it today.
 *  - LLM SALVAGE: still dead mechanically; ONE bounded repair attempt with
 *    the validator defect list fixed it (repair-the-code, never regenerate —
 *    no-duplicator law).
 *  - GENUINELY DEAD / NO CODE: honest losses.
 *
 * falseKillRate = (false-kill + recovered + llm-salvage) / total — the share
 * of the reject pool that was thrown away but holds salvageable art. Recurring
 * repair patterns are counted and emitted as CANDIDATE system lessons;
 * promotion goes through the existing staging/evolution gate, never here.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { CodeValidator } from '../core/CodeValidator.js';
import { Logger } from '../utils/Logger.js';
import { GenericWrapper } from '../core/wrappers/GenericWrapper.js';
import { GLSLValidator } from '../core/validators/GLSLValidator.js';
import {
  extractEmbeddedScript,
  extractFinalCodeBlock,
  normalizeStrudelSource,
  stripFence,
  stripProsePreamble,
  stripStrudelInventedTail,
} from '../core/recovery/SourceRecovery.js';

export type RescueClassification =
  | 'false-kill'
  | 'recovered'
  | 'llm-salvage'
  | 'genuinely-dead'
  | 'no-code';

export interface RescueOutcome {
  file: string;
  domain: string;
  classification: RescueClassification;
  /** Which mechanical stage saved it ('raw' = as the pipeline first sees it). */
  stage?: string;
  salvagedCode?: string;
  /** Final defect list when the piece is dead. */
  errors?: string[];
}

export interface RescueReport {
  pool: string;
  total: number;
  counts: Record<RescueClassification, number>;
  /** (false-kill + recovered + llm-salvage) / total. */
  falseKillRate: number;
  outcomes: RescueOutcome[];
  /** Defect buckets seen >= minPatternCount times across the pool — candidate system lessons. */
  repairPatterns: { pattern: string; count: number }[];
}

/** Detect the domain of a raw generation the way the loop's surfaces do. */
export function detectRescueDomain(code: string): string {
  const generic = GenericWrapper.detectDomain(code);
  if (generic) return generic;
  if (/THREE\.|three\.module/.test(code)) return 'three';
  if (/void\s+main\s*\(/.test(code) && /gl_FragColor|fragColor/.test(code)) return 'glsl';
  if (/createCanvas|function\s+setup\s*\(|function\s+draw\s*\(/.test(code)) return 'p5';
  return 'p5';
}

/** One bounded LLM repair — repair-the-code, not regenerate. */
async function llmRepair(
  domain: string,
  code: string,
  defects: string[],
  client: { generate: (system: string, user: string) => Promise<{ success: boolean; code?: string }> },
): Promise<string | null> {
  const system = `You are Sinter's repair bench for ${domain} generative art. You repair broken code with minimal edits. You never regenerate or redesign: the piece's structure, names, parameters and artistic idea stay. Output ONLY the repaired raw code — no prose, no markdown fences.`;
  const user = `This ${domain} piece failed validation with these defects:\n${defects.map(d => `- ${d}`).join('\n')}\n\nRepair the defects with minimal edits and return the full corrected code only.\n\nCODE:\n${code}`;
  try {
    const response = await client.generate(system, user);
    if (!response.success || !response.code) return null;
    return response.code;
  } catch {
    return null;
  }
}

export interface RescueOptions {
  /** Skip the bounded LLM repair stage (mechanical-only audit). */
  noLlm?: boolean;
  /** Build the LLM repair client from ~/.sinter/config.json roles.harness. */
  buildRepairClient?: () => { generate: (system: string, user: string) => Promise<{ success: boolean; code?: string }> } | null;
  /** Recurring-pattern threshold for the candidate-lesson list. */
  minPatternCount?: number;
}

/**
 * Mechanical recovery pipeline mirroring the spine exactly: fence strip →
 * (HTML? embedded-script) → validate → prose-preamble slice → embedded-script
 * → domain extras (strudel invented-tail, glsl preprocessor balance).
 * Returns the first stage at which the piece validates, or the final errors.
 */
export function mechanicalRecovery(raw: string, domain: string): {
  stage: string | null;
  code: string;
  errors: string[];
} {
  // Stage 0: what the spine first validates (fence-stripped source; strudel
  // is normalized at spine intake, so mirror that here).
  const source = domain === 'strudel'
    ? normalizeStrudelSource(stripFence(raw))
    : stripFence(raw);
  const stage0 = CodeValidator.validate(source, domain);
  if (stage0.valid) {
    return { stage: domain === 'strudel' ? 'strudel-normalize' : 'raw', code: stage0.cleanedCode || source, errors: [] };
  }

  if (domain === 'strudel') {
    // The full formatter guardrail (typography + prose isolation + dangling
    // chains) already ran above; a still-invalid piece has real defects.
    const tailStripped = stripStrudelInventedTail(source);
    const tailValidation = CodeValidator.validate(tailStripped, domain);
    if (tailValidation.valid) {
      return { stage: 'strudel-tail-strip', code: tailValidation.cleanedCode || tailStripped, errors: [] };
    }
  }

  if (/<!DOCTYPE|<html[\s>]/i.test(source)) {
    const embedded = extractEmbeddedScript(source);
    if (embedded !== null && CodeValidator.validate(embedded, domain).valid) {
      return { stage: 'html-embedded-script', code: embedded, errors: [] };
    }
  }

  const sliced = stripProsePreamble(source, domain);
  if (sliced !== null) {
    const slicedValidation = CodeValidator.validate(sliced, domain);
    if (slicedValidation.valid) {
      return { stage: 'prose-preamble-slice', code: slicedValidation.cleanedCode || sliced, errors: [] };
    }
  }

  // Design-prose recovery: chat seats emit their whole design process as prose
  // (often containing ;{} so the preamble slice refuses) with the artwork as
  // the final contiguous code block.
  const finalBlock = extractFinalCodeBlock(source);
  if (finalBlock !== null) {
    const blockValidation = CodeValidator.validate(finalBlock, domain);
    if (blockValidation.valid) {
      return { stage: 'final-code-block', code: blockValidation.cleanedCode || finalBlock, errors: [] };
    }
  }

  const embeddedLate = extractEmbeddedScript(source);
  if (embeddedLate !== null && CodeValidator.validate(embeddedLate, domain).valid) {
    return { stage: 'embedded-script', code: embeddedLate, errors: [] };
  }

  if (domain === 'glsl' || domain === 'shader') {
    const balanced = GLSLValidator.balancePreprocessor(source);
    const balancedValidation = CodeValidator.validate(balanced, domain);
    if (balancedValidation.valid) {
      return { stage: 'glsl-preprocessor-balance', code: balanced, errors: [] };
    }
  }

  // Dead mechanically: report the most actionable defect list (prefer the
  // prose-sliced variant's errors when prose slicing applied).
  const finalSource = sliced ?? source;
  const finalErrors = CodeValidator.validate(finalSource, domain).errors;
  return { stage: null, code: finalSource, errors: finalErrors };
}

/** Coarse defect bucket for pattern counting: the error clause with any
 *  quoted variable names generalized away ("Undefined function 'palette()'"
 *  and "'palettes()'" must count as ONE pattern). */
function defectBucket(error: string): string {
  const head = error.split(' - ')[0];
  return head
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .slice(0, 110)
    .trim();
}

export async function rescuePool(poolDir: string, options: RescueOptions = {}): Promise<RescueReport> {
  const target = resolve(poolDir);
  // A single reject file is a pool of one; artifacts still land beside it.
  const dir = statSync(target).isFile() ? dirname(target) : target;
  const wanted = statSync(target).isFile() ? [basename(target)] : null;
  const files = readdirSync(dir)
    .filter(name => (name.endsWith('.js') || name.endsWith('.txt'))
      && !name.includes('.salvaged.') && !name.includes('.view.'))
    .filter(name => wanted === null || wanted.includes(name))
    .sort();
  const outcomes: RescueOutcome[] = [];
  const defectCounts = new Map<string, number>();

  for (const name of files) {
    const raw = readFileSync(join(dir, name), 'utf8');
    const domain = detectRescueDomain(raw);
    const outcome: RescueOutcome = { file: name, domain, classification: 'genuinely-dead' };

    if (!raw.trim()) {
      outcome.classification = 'no-code';
      outcome.errors = ['reject is empty'];
      outcomes.push(outcome);
      continue;
    }

    const mechanical = mechanicalRecovery(raw, domain);
    if (mechanical.stage === 'raw') {
      outcome.classification = 'false-kill';
      outcome.stage = mechanical.stage;
      outcome.salvagedCode = mechanical.code;
    } else if (mechanical.stage !== null) {
      outcome.classification = 'recovered';
      outcome.stage = mechanical.stage;
      outcome.salvagedCode = mechanical.code;
    } else {
      for (const error of mechanical.errors) {
        const bucket = defectBucket(error);
        defectCounts.set(bucket, (defectCounts.get(bucket) ?? 0) + 1);
      }
      outcome.errors = mechanical.errors;

      const repairClient = options.buildRepairClient?.() ?? null;
      if (!options.noLlm && repairClient && mechanical.code.trim()) {
        const repaired = await llmRepair(domain, mechanical.code, mechanical.errors, repairClient);
        if (repaired) {
          const repairedCheck = mechanicalRecovery(repaired, domain);
          if (repairedCheck.stage !== null) {
            outcome.classification = 'llm-salvage';
            outcome.stage = 'llm-repair';
            outcome.salvagedCode = repairedCheck.code;
          }
        }
      }
    }
    outcomes.push(outcome);
  }

  const counts: Record<RescueClassification, number> = {
    'false-kill': 0, 'recovered': 0, 'llm-salvage': 0, 'genuinely-dead': 0, 'no-code': 0,
  };
  for (const outcome of outcomes) counts[outcome.classification] += 1;

  const salvageable = counts['false-kill'] + counts['recovered'] + counts['llm-salvage'];
  const total = outcomes.length;
  const minCount = options.minPatternCount ?? 2;
  const repairPatterns = [...defectCounts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);

  return {
    pool: dir,
    total,
    counts,
    falseKillRate: total === 0 ? 0 : salvageable / total,
    outcomes,
    repairPatterns,
  };
}

/** Persist salvaged code + the full report under <poolDir>/rescue/. */
export function writeRescueArtifacts(report: RescueReport): string {
  const outDir = join(report.pool, 'rescue');
  mkdirSync(outDir, { recursive: true });
  for (const outcome of report.outcomes) {
    if (!outcome.salvagedCode) continue;
    const base = basename(outcome.file).replace(/\.(js|txt)$/, '');
    writeFileSync(join(outDir, `${base}.${outcome.classification}.js`), outcome.salvagedCode);
  }
  const reportPath = join(outDir, 'rescue-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

/**
 * PROACTIVE SWEEP — rescue as a standing organ. Each wave (every machine)
 * scans the fresh generation-failure records (~/.sinter/failures — each
 * carries the rejected code), runs the mechanical recovery chain, attempts
 * bounded LLM repair on the still-dead, and keeps a running false-kill rate.
 * Recurring defect classes graduate into staged lessons through a FIXED
 * deterministic map — raw error strings never become teaching prompts.
 */

interface RepairClientShape {
  generate: (system: string, user: string) => Promise<{ success: boolean; code?: string }>;
}

export interface SweepOptions {
  failuresDir?: string;
  watermarkPath?: string;
  poolDir?: string;
  stagingPath?: string;
  patternsPath?: string;
  llm?: boolean;
  buildRepairClient?: () => RepairClientShape | null;
  maxPerSweep?: number;
  maxLlmRepairs?: number;
  patternThreshold?: number;
}

export interface SweepResult {
  scanned: number;
  salvaged: Array<{ id: string; domain: string; classification: RescueClassification | 'recovered'; stage: string }>;
  deadCount: number;
  falseKillRate: number;
  stagedLessonIds: string[];
  skipped: number;
}

/** Deterministic defect-class → lesson map. ONLY these classes auto-stage;
 *  unknown classes are counted but never turned into prompts. */
const REPAIR_LESSON_MAP: Record<string, { id: string; text: string; domains: string[] }> = {
  'is used but never declared as a uniform': { id: 'glsl_declare_uniforms', text: 'Declare every uniform you use (uniform float u_time;) — the WebGL compiler fails the whole shader on an undeclared identifier.', domains: ['glsl', 'shader'] },
  'is called before declaration': { id: 'glsl_declaration_order', text: 'Define every helper function BEFORE its first call and never initialize a variable from itself. Order: precision, uniforms, helpers, main last.', domains: ['glsl', 'shader'] },
  'used in its own initializer': { id: 'glsl_declaration_order', text: 'Define every helper function BEFORE its first call and never initialize a variable from itself. Order: precision, uniforms, helpers, main last.', domains: ['glsl', 'shader'] },
  'Hydra code calls': { id: 'hydra_expression_only', text: 'Hydra patches are one EXPRESSION: no JS statements, no helper functions. Build only from osc()/noise()/shape()/gradient()/voronoi()/solid() chained with methods, ending .out(o0).', domains: ['hydra'] },
  'non-ASCII': { id: 'ascii_only_strudel', text: 'Strudel code is ASCII only — no em-dashes, curly quotes, or arrows anywhere, including comments; the transpiler rejects them and the piece plays silence.', domains: ['strudel'] },
};

function lessonForError(error: string): { id: string; text: string; domains: string[] } | null {
  for (const [prefix, lesson] of Object.entries(REPAIR_LESSON_MAP)) {
    if (error.includes(prefix)) return lesson;
  }
  return null;
}

export async function sweepRejects(cwd: string, options: SweepOptions = {}): Promise<SweepResult> {
  const home = process.env.HOME || '.';
  const failuresDir = options.failuresDir ?? join(home, '.sinter', 'failures');
  const watermarkPath = options.watermarkPath ?? join(cwd, '.omx', 'atelier', 'lessons', 'rescue-watermark.txt');
  const poolDir = options.poolDir ?? join(cwd, '.omx', 'atelier', 'rescue-pool');
  const stagingPath = options.stagingPath ?? join(cwd, '.omx', 'atelier', 'lessons', 'hints-staging.json');
  const patternsPath = options.patternsPath ?? join(cwd, '.omx', 'atelier', 'lessons', 'rescue-patterns.json');
  const maxPerSweep = options.maxPerSweep ?? 6;
  const maxLlmRepairs = options.maxLlmRepairs ?? 2;
  const patternThreshold = options.patternThreshold ?? 3;

  const prevWatermark = existsSync(watermarkPath) ? readFileSync(watermarkPath, 'utf8').trim() : '';
  const files = readdirSync(failuresDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try {
        const record = JSON.parse(readFileSync(join(failuresDir, name), 'utf8')) as {
          id?: string; timestamp?: string; domain?: string; code?: string; error?: string;
        };
        return { name, record };
      } catch { return null; }
    })
    .filter((x): x is { name: string; record: NonNullable<typeof x>['record'] } => x !== null)
    .filter(({ record }) => (record.timestamp ?? '') > prevWatermark && (record.code ?? '').trim().length > 0)
    .sort((a, b) => (a.record.timestamp ?? '').localeCompare(b.record.timestamp ?? ''));

  const batch = files.slice(0, maxPerSweep);
  const skipped = files.length - batch.length;
  const patterns: Record<string, number> = existsSync(patternsPath)
    ? JSON.parse(readFileSync(patternsPath, 'utf8')) as Record<string, number>
    : {};
  const stagedLessonIds: string[] = [];
  const result: SweepResult = { scanned: batch.length, salvaged: [], deadCount: 0, falseKillRate: 0, stagedLessonIds, skipped };
  if (batch.length === 0) return result;

  mkdirSync(poolDir, { recursive: true });
  let llmBudget = maxLlmRepairs;
  let newest = prevWatermark;

  for (const { record } of batch) {
    newest = record.timestamp ?? newest;
    const raw = record.code ?? '';
    const domain = record.domain && record.domain !== 'unknown' ? record.domain : detectRescueDomain(raw);
    const id = (record.id ?? record.timestamp ?? 'unknown').slice(0, 18);
    const mechanical = mechanicalRecovery(raw, domain);
    let classification: SweepResult['salvaged'][number]['classification'] | null = null;
    let code = '';
    let stage = '';

    if (mechanical.stage === 'raw' || mechanical.stage === 'strudel-normalize' || mechanical.stage === null) {
      // raw = false kill; null = dead mechanically
    }
    if (mechanical.stage !== null) {
      classification = mechanical.stage === 'raw' ? 'false-kill'
        : mechanical.stage === 'strudel-normalize' ? 'false-kill'
        : 'recovered';
      code = mechanical.code;
      stage = mechanical.stage;
    } else if (options.llm !== false && options.buildRepairClient && llmBudget > 0) {
      const client = options.buildRepairClient();
      if (client) {
        llmBudget -= 1;
        const repaired = await llmRepair(domain, mechanical.code, mechanical.errors, client);
        if (repaired) {
          const check = mechanicalRecovery(repaired, domain);
          if (check.stage !== null) {
            classification = 'llm-salvage';
            code = check.code;
            stage = 'llm-repair';
          }
        }
      }
    }

    if (classification) {
      result.salvaged.push({ id, domain, classification, stage });
      const fileBase = `${(record.timestamp ?? id).replace(/[:.]/g, '-')}-${id}`;
      // Retain the original evidence before the rolling failure log prunes it.
      // Repair attribution is explicitly unknown; the original model is not
      // necessarily the model that produced an LLM-repaired piece.
      writeFileSync(join(poolDir, `${fileBase}.${classification}.lineage.json`),
        JSON.stringify({ schema: 'sinter.rescue-lineage/1', originalFailure: record,
          recovery: { classification, stage, repairModel: null } }, null, 2));
      writeFileSync(join(poolDir, `${fileBase}.${classification}.js`), code);
    } else {
      result.deadCount += 1;
      const error = (mechanical.errors ?? []).join(' | ');
      if (error) {
        const bucket = defectBucket(error);
        patterns[bucket] = (patterns[bucket] ?? 0) + 1;
        const lesson = lessonForError(error);
        if (lesson && patterns[bucket] >= patternThreshold) {
          try {
            const staging = existsSync(stagingPath)
              ? JSON.parse(readFileSync(stagingPath, 'utf8')) as Array<{ id: string; text: string; domains: string[] }>
              : [];
            if (!staging.some(l => l.id === lesson.id)) {
              staging.push(lesson);
              writeFileSync(stagingPath, JSON.stringify(staging, null, 2));
              stagedLessonIds.push(lesson.id);
            }
          } catch (err) { Logger.warn('RejectRescue', `lesson staging failed (sweep continues): ${stagingPath}:`, err); }
        }
      }
    }
  }

  writeFileSync(patternsPath, JSON.stringify(patterns, null, 2));
  mkdirSync(dirname(watermarkPath), { recursive: true });
  writeFileSync(watermarkPath, newest);
  const handled = result.salvaged.length + result.deadCount;
  result.falseKillRate = handled === 0 ? 0 : result.salvaged.length / handled;
  return result;
}
