/**
 * SinterRoleDatasetExporter
 *
 * Builds role-aware dataset manifests for future SINTER fine-tuning. The exporter
 * intentionally separates roles, label provenance, and leakage policy so that
 * evaluator, harness, router, evolution, generator, studio, and Simon-preference
 * data are not collapsed into one misleading corpus.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type Trainability = 'train_now_candidate' | 'analytics_first' | 'capture_first' | 'do_not_train_raw';
export type LabelStrength = 'high' | 'medium' | 'weak' | 'high_but_tiny' | 'not_available' | 'risky_raw';

export interface RoleDatasetExportOptions {
  repoRoot?: string;
  sinterHome?: string;
  selfImproveLedgerPath?: string;
  outputDir?: string;
  now?: string;
  /** Include full artifact/code/prompt payloads in emitted JSONL rows. Defaults to false. */
  includeArtifactText?: boolean;
  /** Avoid reading every huge diagnostic file when only a manifest is needed. Defaults to 2,000. */
  maxDiagnosticRows?: number;
}

export interface SourceSummary {
  id: string;
  displayPath: string;
  files: number;
  records: number;
  parsedRecords: number;
  domains: Record<string, number>;
  labels: Record<string, number>;
  trust: LabelStrength;
  notes: string[];
}

export interface RoleBundleSummary {
  id: string;
  role: string;
  taskContract: string;
  trainability: Trainability;
  labelStrength: LabelStrength;
  sources: string[];
  targets: string[];
  rowCountEstimate: number;
  outputJsonl?: string;
  leakagePolicy: string;
  risks: string[];
  nextAction: string;
}

export interface RoleDatasetManifest {
  schemaVersion: 1;
  createdAt: string;
  includeArtifactText: boolean;
  sourceSummaries: Record<string, SourceSummary>;
  bundles: RoleBundleSummary[];
  recommendation: {
    firstLoraCandidate: string;
    robustnessCandidate: string;
    doNotTrainFirst: string[];
    rationale: string;
  };
}

interface ArchiveEntryLike {
  id?: unknown;
  domain?: unknown;
  prompt?: unknown;
  output?: unknown;
  qualityScore?: unknown;
  createdAt?: unknown;
  metadata?: unknown;
  confidence?: unknown;
  failureClass?: unknown;
  creativeLabel?: unknown;
}

interface ManifestWork {
  archiveRows: unknown[];
  failureRows: unknown[];
  preferenceRows: unknown[];
}

const SOURCE_IDS = {
  qualityArchive: 'quality_archive',
  routing: 'routing',
  selfImproveLedger: 'self_improve_ledger',
  rescore: 'rescore',
  lineage: 'lineage',
  refs: 'sinter_refs',
  failures: 'failures',
  reasoning: 'reasoning',
  thinkingTraces: 'thinking_traces',
  preferences: 'preferences',
  taste: 'taste',
  galleryRefs: 'gallery_refs',
} as const;

export async function exportSinterRoleDatasets(options: RoleDatasetExportOptions = {}): Promise<RoleDatasetManifest> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const sinterHome = options.sinterHome ?? path.join(homedir(), '.sinter');
  const maxDiagnosticRows = options.maxDiagnosticRows ?? 2000;
  const includeArtifactText = options.includeArtifactText ?? false;
  const work: ManifestWork = { archiveRows: [], failureRows: [], preferenceRows: [] };
  const configuredLedger = options.selfImproveLedgerPath ?? process.env.SINTER_PROGRESS_LEDGER_PATH;
  const runtimeLedger = configuredLedger
    ? path.resolve(repoRoot, configuredLedger)
    : path.join(sinterHome, 'quality', 'self-improve-ledger.jsonl');
  const legacyLedger = path.join(repoRoot, 'docs', 'validation', 'self-improve-ledger.jsonl');
  let selfImproveLedger = runtimeLedger;
  if (!configuredLedger) {
    try {
      await fs.access(runtimeLedger);
    } catch {
      selfImproveLedger = legacyLedger;
    }
  }

  const sourceSummaries: Record<string, SourceSummary> = {};

  sourceSummaries[SOURCE_IDS.qualityArchive] = await summarizeQualityArchive(
    path.join(sinterHome, 'archive', 'quality_archive.json'),
    includeArtifactText,
    work,
  );
  sourceSummaries[SOURCE_IDS.routing] = await summarizeJsonArrayDir(
    path.join(sinterHome, 'routing'),
    '~/.sinter/routing/*.json',
    SOURCE_IDS.routing,
    'medium',
    ['Routing records are observational; counterfactual route quality is usually missing.'],
    maxDiagnosticRows,
  );
  sourceSummaries[SOURCE_IDS.selfImproveLedger] = await summarizeJsonlFiles(
    [selfImproveLedger],
    selfImproveLedger === legacyLedger
      ? 'docs/validation/self-improve-ledger.jsonl'
      : configuredLedger ?? '~/.sinter/quality/self-improve-ledger.jsonl',
    SOURCE_IDS.selfImproveLedger,
    'medium',
    ['Cycle-level outcomes are useful but causally confounded by changing code, models, and daemon state.'],
  );
  sourceSummaries[SOURCE_IDS.rescore] = await summarizeJsonlGlob(
    path.join(repoRoot, 'docs', 'validation', 'rescore'),
    'docs/validation/rescore/*.jsonl',
    SOURCE_IDS.rescore,
    'high',
    ['Rescore rows are high-value evaluator calibration labels.'],
  );
  sourceSummaries[SOURCE_IDS.lineage] = await summarizeJsonDir(
    path.join(sinterHome, 'lineage'),
    '~/.sinter/lineage/*.json',
    SOURCE_IDS.lineage,
    'medium',
    ['Lineage is provenance first; it becomes training data only after joins to archive/outcome labels.'],
    maxDiagnosticRows,
  );
  sourceSummaries[SOURCE_IDS.refs] = await summarizeRefs(path.join(repoRoot, '.sinter', 'refs'), work);
  sourceSummaries[SOURCE_IDS.failures] = await summarizeFailures(
    path.join(sinterHome, 'failures'),
    maxDiagnosticRows,
    includeArtifactText,
    work,
  );
  sourceSummaries[SOURCE_IDS.reasoning] = await summarizeJsonDir(
    path.join(sinterHome, 'reasoning'),
    '~/.sinter/reasoning/*.json',
    SOURCE_IDS.reasoning,
    'risky_raw',
    ['Raw reasoning is excluded from training bundles by default; extract structured labels/features only.'],
    maxDiagnosticRows,
  );
  sourceSummaries[SOURCE_IDS.thinkingTraces] = await summarizeJsonDir(
    path.join(sinterHome, 'thinking-traces'),
    '~/.sinter/thinking-traces/**/*.{json,jsonl}',
    SOURCE_IDS.thinkingTraces,
    'risky_raw',
    ['Thinking traces are diagnostic/process data, not direct SFT targets.'],
    maxDiagnosticRows,
  );
  sourceSummaries[SOURCE_IDS.preferences] = await summarizeJsonDir(
    path.join(sinterHome, 'preferences'),
    '~/.sinter/preferences/*.json',
    SOURCE_IDS.preferences,
    'high_but_tiny',
    ['Home preference directory may be absent; repo-local SinterFS preference refs are counted separately.'],
    maxDiagnosticRows,
  );
  sourceSummaries[SOURCE_IDS.taste] = await summarizeJsonDir(
    path.join(sinterHome, 'taste'),
    '~/.sinter/taste/*.json',
    SOURCE_IDS.taste,
    'weak',
    ['Taste weights are derived/legacy priors, not ground-truth labels.'],
    maxDiagnosticRows,
  );
  sourceSummaries[SOURCE_IDS.galleryRefs] = await summarizeJsonDir(
    path.join(repoRoot, '.liminal', 'refs', 'gallery'),
    '.liminal/refs/gallery/*.json',
    SOURCE_IDS.galleryRefs,
    'medium',
    ['Gallery refs are useful only after joining to curation context and rejected alternatives.'],
    maxDiagnosticRows,
  );

  await appendRoutingEvaluatorRows(path.join(sinterHome, 'routing'), work);
  await appendRescoreEvaluatorRows(path.join(repoRoot, 'docs', 'validation', 'rescore'), work);

  const bundles = buildBundles(sourceSummaries);
  const manifest: RoleDatasetManifest = {
    schemaVersion: 1,
    createdAt: options.now ?? new Date().toISOString(),
    includeArtifactText,
    sourceSummaries,
    bundles,
    recommendation: {
      firstLoraCandidate: 'evaluator_system_quality_v0',
      robustnessCandidate: 'failure_triage_v0',
      doNotTrainFirst: ['simon_preference_v0', 'generator_sft_seed_v0', 'studio_planner_v0', 'routing_quality_v0', 'evolution_trajectory_v0'],
      rationale: 'Evaluator/ranker has the clearest role contract and reusable labels. Harness/failure triage has the strongest high-volume labels. Generator, studio, Simon preference, router, and evolution need cleaner role-specific labels first.',
    },
  };

  if (options.outputDir) {
    await writeRoleDatasetArtifacts(options.outputDir, manifest, work);
  }

  return manifest;
}

async function writeRoleDatasetArtifacts(outputDir: string, manifest: RoleDatasetManifest, work: ManifestWork): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.mkdir(path.join(outputDir, 'bundles'), { recursive: true });
  await writeJsonl(path.join(outputDir, 'bundles', 'evaluator_system_quality_v0.jsonl'), work.archiveRows);
  await writeJsonl(path.join(outputDir, 'bundles', 'failure_triage_v0.jsonl'), work.failureRows);
  await writeJsonl(path.join(outputDir, 'bundles', 'simon_preference_v0.jsonl'), work.preferenceRows);
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(filePath, body.length > 0 ? `${body}\n` : '');
}

async function appendRoutingEvaluatorRows(dirPath: string, work: ManifestWork): Promise<void> {
  const files = await listFiles(dirPath, ['.json']);
  for (const file of files) {
    const data = await readJson(file);
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const record = asRecord(row);
      const score = numberValue(record.qualityScore);
      work.archiveRows.push({
        bundle_id: 'evaluator_system_quality_v0',
        source: SOURCE_IDS.routing,
        event_id: stableHash(row),
        input: {
          domain: stringValue(record.domain) ?? path.basename(file, '.json'),
          model: stringValue(record.model),
          timestamp: stringValue(record.timestamp),
        },
        label: {
          kind: 'routing_quality_score',
          score,
          bucket: scoreBucket(score),
          provenance: SOURCE_IDS.routing,
        },
      });
    }
  }
}

async function appendRescoreEvaluatorRows(dirPath: string, work: ManifestWork): Promise<void> {
  const files = await listFiles(dirPath, ['.jsonl']);
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = safeJsonParse(line);
      if (!row) continue;
      const record = asRecord(row);
      const fresh = numberValue(record.fresh);
      work.archiveRows.push({
        bundle_id: 'evaluator_system_quality_v0',
        source: SOURCE_IDS.rescore,
        artifact_id: stringValue(record.id),
        input: {
          domain: stringValue(record.domain),
          stored_score: numberValue(record.stored),
          prompt: stringValue(record.prompt),
          score_band: stringValue(record.scoreBand),
          target_band: stringValue(record.targetBand),
          output_path: stringValue(record.outputPath),
        },
        label: {
          kind: stringValue(record.labelKind) ?? stringValue(record.kind) ?? 'rescore_quality_score',
          score: fresh,
          bucket: scoreBucket(fresh),
          delta: numberValue(record.delta),
          provenance: stringValue(record.provenance) ?? SOURCE_IDS.rescore,
          reason: stringValue(record.reason),
        },
      });
    }
  }
}

async function summarizeQualityArchive(filePath: string, includeArtifactText: boolean, work: ManifestWork): Promise<SourceSummary> {
  const summary = emptySummary(SOURCE_IDS.qualityArchive, '~/.sinter/archive/quality_archive.json', 'medium', [
    'Archive scores are useful system-quality labels, but known bad admissions should be quarantined before training.',
  ]);
  const data = await readJson(filePath);
  if (!data) return markMissing(summary);

  const entries = extractArchiveEntries(data);
  const unique = new Set<string>();
  summary.files = 1;
  summary.records = entries.length;
  summary.parsedRecords = entries.length;

  for (const entry of entries) {
    const id = stringValue(entry.id) ?? stableHash(entry);
    unique.add(id);
    const domain = stringValue(entry.domain) ?? stringValue(asRecord(entry.metadata)?.domain) ?? 'unknown';
    summary.domains[domain] = (summary.domains[domain] ?? 0) + 1;
    const score = numberValue(entry.qualityScore);
    const bucket = scoreBucket(score);
    summary.labels[bucket] = (summary.labels[bucket] ?? 0) + 1;
    work.archiveRows.push({
      bundle_id: 'evaluator_system_quality_v0',
      source: SOURCE_IDS.qualityArchive,
      artifact_id: id,
      input: {
        domain,
        prompt: includeArtifactText ? stringValue(entry.prompt) : undefined,
        artifact_text: includeArtifactText ? stringValue(entry.output) : undefined,
        artifact_sha256: stringValue(entry.output) ? stableHash(stringValue(entry.output)) : undefined,
        render_measure: asRecord(entry.metadata)?.renderMeasure,
      },
      label: {
        kind: 'quality_score',
        score,
        bucket,
        confidence: numberValue(entry.confidence),
        failure_class: stringValue(entry.failureClass) ?? stringValue(asRecord(entry.metadata)?.evaluationFailureClass),
        provenance: SOURCE_IDS.qualityArchive,
        creative_label: asRecord(entry.creativeLabel),
      },
    });
  }
  summary.notes.push(`${unique.size} unique artifact ids observed.`);
  return summary;
}

async function summarizeFailures(
  dirPath: string,
  maxRows: number,
  includeArtifactText: boolean,
  work: ManifestWork,
): Promise<SourceSummary> {
  const summary = emptySummary(SOURCE_IDS.failures, '~/.sinter/failures/**/*.json', 'high', [
    'Failure telemetry is strong for failure/not-failure and failure-type labels, but weak for aesthetic taste.',
  ]);
  const files = await listFiles(dirPath, ['.json']);
  summary.files = files.length;
  summary.records = files.length;
  for (const file of files.slice(0, maxRows)) {
    const row = await readJson(file);
    if (!row) continue;
    const record = asRecord(row);
    summary.parsedRecords++;
    const domain = stringValue(record.domain) ?? 'unknown';
    const label = stringValue(record.errorType) ?? stringValue(record.failureClass) ?? 'unknown';
    summary.domains[domain] = (summary.domains[domain] ?? 0) + 1;
    summary.labels[label] = (summary.labels[label] ?? 0) + 1;
    work.failureRows.push({
      bundle_id: 'failure_triage_v0',
      source: SOURCE_IDS.failures,
      event_id: stringValue(record.id) ?? stableHash(row),
      input: {
        domain,
        model: stringValue(record.model),
        prompt: includeArtifactText ? stringValue(record.prompt) : undefined,
        code: includeArtifactText ? stringValue(record.code) : undefined,
        code_sha256: stringValue(record.code) ? stableHash(stringValue(record.code)) : undefined,
        error: stringValue(record.error),
      },
      label: {
        kind: 'failure_type',
        error_type: label,
        broken_not_broken: 'broken',
        provenance: SOURCE_IDS.failures,
      },
    });
  }
  if (files.length > maxRows) summary.notes.push(`Parsed first ${maxRows} diagnostic files; file count records full volume.`);
  return summary;
}

async function summarizeRefs(refRoot: string, work: ManifestWork): Promise<SourceSummary> {
  const summary = emptySummary(SOURCE_IDS.refs, 'repo:.sinter/refs/**/*.json', 'high', [
    'SinterFS refs are high-integrity object pointers; they need hydration before training.',
  ]);
  const files = await listFiles(refRoot, ['.json']);
  summary.files = files.length;
  summary.records = files.length;
  for (const file of files) {
    const rel = path.relative(refRoot, file).split(path.sep);
    const top = rel[0] ?? 'unknown';
    summary.labels[top] = (summary.labels[top] ?? 0) + 1;
    const row = await readJson(file);
    if (!row) continue;
    summary.parsedRecords++;
    if (top === 'preference') {
      const action = rel.at(-1)?.replace(/\.json$/, '') ?? stringValue(asRecord(row).action) ?? 'unknown';
      const artifactId = rel[1] ?? stringValue(asRecord(row).artifactId) ?? stringValue(asRecord(row).uri) ?? 'unknown';
      work.preferenceRows.push({
        bundle_id: 'simon_preference_v0',
        source: SOURCE_IDS.refs,
        artifact_id: artifactId,
        input: { ref_uri: stringValue(asRecord(row).uri), ref_hash: stringValue(asRecord(row).hash) },
        label: { kind: 'preference_action', action, provenance: 'repo_sinter_ref' },
      });
    }
  }
  return summary;
}

async function summarizeJsonArrayDir(
  dirPath: string,
  displayPath: string,
  id: string,
  trust: LabelStrength,
  notes: string[],
  maxRows: number,
): Promise<SourceSummary> {
  const summary = emptySummary(id, displayPath, trust, notes);
  const files = await listFiles(dirPath, ['.json']);
  summary.files = files.length;
  for (const file of files) {
    const data = await readJson(file);
    const rows = Array.isArray(data) ? data : [];
    summary.records += rows.length;
    for (const row of rows.slice(0, Math.max(0, maxRows - summary.parsedRecords))) {
      const record = asRecord(row);
      summary.parsedRecords++;
      const domain = stringValue(record.domain) ?? path.basename(file, '.json');
      const label = stringValue(record.model) ?? stringValue(record.kind) ?? 'unknown';
      summary.domains[domain] = (summary.domains[domain] ?? 0) + 1;
      summary.labels[label] = (summary.labels[label] ?? 0) + 1;
    }
  }
  return summary;
}

async function summarizeJsonlGlob(
  dirPath: string,
  displayPath: string,
  id: string,
  trust: LabelStrength,
  notes: string[],
): Promise<SourceSummary> {
  const files = await listFiles(dirPath, ['.jsonl']);
  return summarizeJsonlFiles(files, displayPath, id, trust, notes);
}

async function summarizeJsonlFiles(
  files: string[],
  displayPath: string,
  id: string,
  trust: LabelStrength,
  notes: string[],
): Promise<SourceSummary> {
  const summary = emptySummary(id, displayPath, trust, notes);
  for (const file of files) {
    if (!(await exists(file))) continue;
    summary.files++;
    const text = await fs.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      summary.records++;
      const row = safeJsonParse(line);
      if (!row) continue;
      summary.parsedRecords++;
      const record = asRecord(row);
      const domains = Array.isArray(record.targetedDomains) ? record.targetedDomains : [record.domain];
      for (const domainValue of domains) {
        const domain = stringValue(domainValue) ?? 'unknown';
        summary.domains[domain] = (summary.domains[domain] ?? 0) + 1;
      }
      const label = stringValue(record.failureClass) ?? (record.meanScore !== undefined ? scoreBucket(numberValue(record.meanScore)) : 'jsonl_record');
      summary.labels[label] = (summary.labels[label] ?? 0) + 1;
    }
  }
  return summary;
}

async function summarizeJsonDir(
  dirPath: string,
  displayPath: string,
  id: string,
  trust: LabelStrength,
  notes: string[],
  maxRows: number,
): Promise<SourceSummary> {
  const summary = emptySummary(id, displayPath, trust, notes);
  const files = await listFiles(dirPath, ['.json', '.jsonl']);
  summary.files = files.length;
  summary.records = files.length;
  for (const file of files.slice(0, maxRows)) {
    if (file.endsWith('.jsonl')) {
      const text = await fs.readFile(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        summary.records++;
        const row = safeJsonParse(line);
        if (row) summarizeGenericRecord(summary, row);
      }
    } else {
      const row = await readJson(file);
      if (row) summarizeGenericRecord(summary, row);
    }
  }
  if (files.length > maxRows) summary.notes.push(`Parsed first ${maxRows} files; file count records full volume.`);
  return summary;
}

function summarizeGenericRecord(summary: SourceSummary, row: unknown): void {
  summary.parsedRecords++;
  const record = asRecord(row);
  const domain = stringValue(record.domain) ?? stringValue(asRecord(record.params).domain) ?? stringValue(record.source) ?? 'unknown';
  const label = stringValue(record.outcome) ?? stringValue(record.provenance) ?? stringValue(record.kind) ?? 'record';
  summary.domains[domain] = (summary.domains[domain] ?? 0) + 1;
  summary.labels[label] = (summary.labels[label] ?? 0) + 1;
}

function buildBundles(sources: Record<string, SourceSummary>): RoleBundleSummary[] {
  const archive = sources[SOURCE_IDS.qualityArchive]?.records ?? 0;
  const rescore = sources[SOURCE_IDS.rescore]?.records ?? 0;
  const routing = sources[SOURCE_IDS.routing]?.records ?? 0;
  const failures = sources[SOURCE_IDS.failures]?.records ?? 0;
  const selfImprove = sources[SOURCE_IDS.selfImproveLedger]?.records ?? 0;
  const prefs = (sources[SOURCE_IDS.refs]?.labels.preference ?? 0) + (sources[SOURCE_IDS.preferences]?.records ?? 0);

  return [
    {
      id: 'evaluator_system_quality_v0',
      role: 'evaluator_ranker',
      taskContract: 'prompt + artifact + optional render/failure evidence -> score bucket, pass/fail, failure class, or pairwise rank',
      trainability: 'train_now_candidate',
      labelStrength: 'medium',
      sources: [SOURCE_IDS.qualityArchive, SOURCE_IDS.rescore, SOURCE_IDS.routing, SOURCE_IDS.failures],
      targets: ['score_bucket', 'pass_fail', 'failure_class', 'pairwise_score_gap'],
      rowCountEstimate: archive + rescore + routing + failures,
      outputJsonl: 'bundles/evaluator_system_quality_v0.jsonl',
      leakagePolicy: 'Artifact text is included only when includeArtifactText=true; raw reasoning/thinking is excluded.',
      risks: ['circular evaluator labels', 'known bad visual admissions', 'score/rubric drift'],
      nextAction: 'Quarantine known bad admissions, then create held-out rank/eval split.',
    },
    {
      id: 'failure_triage_v0',
      role: 'harness_diagnostic',
      taskContract: 'generation attempt metadata + error/code context -> failure type and next diagnostic action',
      trainability: 'train_now_candidate',
      labelStrength: 'high',
      sources: [SOURCE_IDS.failures, SOURCE_IDS.selfImproveLedger],
      targets: ['failure_type', 'next_action', 'broken_not_broken'],
      rowCountEstimate: failures,
      outputJsonl: 'bundles/failure_triage_v0.jsonl',
      leakagePolicy: 'Prompt/code payloads are opt-in; raw thinking traces are excluded.',
      risks: ['environment-specific failures', 'overfitting to common boring errors'],
      nextAction: 'Build classifier baseline before LoRA; use archive successes as not-broken negatives.',
    },
    {
      id: 'routing_quality_v0',
      role: 'router_policy',
      taskContract: 'domain/task/model context -> route quality or model choice',
      trainability: 'analytics_first',
      labelStrength: 'weak',
      sources: [SOURCE_IDS.routing, SOURCE_IDS.qualityArchive],
      targets: ['route_quality_regression'],
      rowCountEstimate: routing,
      outputJsonl: undefined,
      leakagePolicy: 'Do not train route labels without counterfactual trials.',
      risks: ['observational bias', 'mostly-default route labels', 'counterfactual blindness'],
      nextAction: 'Add A/B/counterfactual route capture before model training.',
    },
    {
      id: 'evolution_trajectory_v0',
      role: 'evolution_strategy',
      taskContract: 'cycle state + archive health + failures -> self-improvement target/policy delta',
      trainability: 'analytics_first',
      labelStrength: 'medium',
      sources: [SOURCE_IDS.selfImproveLedger, SOURCE_IDS.lineage, SOURCE_IDS.refs],
      targets: ['cycle_policy_delta', 'domain_target_selection'],
      rowCountEstimate: selfImprove,
      outputJsonl: undefined,
      leakagePolicy: 'Use measured deltas only; exclude self-written improvement claims as labels.',
      risks: ['causal confounding', 'reward hacking', 'optimizing stale metrics'],
      nextAction: 'Build trajectory dashboard and causal joins before training an LLM strategist.',
    },
    {
      id: 'simon_preference_v0',
      role: 'human_preference',
      taskContract: 'artifact/context pair -> explicit Simon keep/reject/pairwise preference',
      trainability: prefs >= 100 ? 'train_now_candidate' : 'capture_first',
      labelStrength: prefs >= 100 ? 'high' : 'high_but_tiny',
      sources: [SOURCE_IDS.refs, SOURCE_IDS.preferences, SOURCE_IDS.taste, SOURCE_IDS.galleryRefs],
      targets: ['explicit_keep_reject_pairwise'],
      rowCountEstimate: prefs,
      outputJsonl: 'bundles/simon_preference_v0.jsonl',
      leakagePolicy: 'Keep explicit human preference labels separate from automated quality labels.',
      risks: ['too few explicit preferences', 'conflating Simon taste with SINTER score'],
      nextAction: 'Capture many more explicit pairwise/keep/reject events before taste LoRA/DPO.',
    },
    {
      id: 'generator_sft_seed_v0',
      role: 'generator',
      taskContract: 'prompt/domain/constraints -> artifact code or text',
      trainability: 'capture_first',
      labelStrength: 'weak',
      sources: [SOURCE_IDS.qualityArchive, SOURCE_IDS.lineage, SOURCE_IDS.failures],
      targets: ['prompt_to_artifact'],
      rowCountEstimate: archive,
      outputJsonl: undefined,
      leakagePolicy: 'Do not include failures as target completions; use them only as anti-pattern metadata.',
      risks: ['small multi-domain positive set', 'memorization', 'automated scoring bugs'],
      nextAction: 'Train evaluator/harness first, then export cleaner prompt->accepted artifact examples.',
    },
    {
      id: 'studio_planner_v0',
      role: 'studio_planner',
      taskContract: 'free-form idea -> structured composition spec',
      trainability: 'capture_first',
      labelStrength: 'not_available',
      sources: [],
      targets: ['prompt_to_composition_spec'],
      rowCountEstimate: 0,
      outputJsonl: undefined,
      leakagePolicy: 'No dedicated planner corpus found; add explicit capture before training.',
      risks: ['aesthetic theater', 'no plan->outcome linkage'],
      nextAction: 'Persist prompt, plan JSON, layer outcomes, and final render score.',
    },
  ];
}

function extractArchiveEntries(data: unknown): ArchiveEntryLike[] {
  const record = asRecord(data);
  if (Array.isArray(data)) return data.map(asRecord) as ArchiveEntryLike[];
  if (Array.isArray(record.entries)) return record.entries.map(asRecord) as ArchiveEntryLike[];
  const archives = asRecord(record.archives);
  return Object.values(archives).flatMap((value) => (Array.isArray(value) ? value.map(asRecord) : [])) as ArchiveEntryLike[];
}

function emptySummary(id: string, displayPath: string, trust: LabelStrength, notes: string[]): SourceSummary {
  return { id, displayPath, files: 0, records: 0, parsedRecords: 0, domains: {}, labels: {}, trust, notes: [...notes] };
}

function markMissing(summary: SourceSummary): SourceSummary {
  summary.notes.push('Path missing or unreadable at export time.');
  return summary;
}

async function listFiles(root: string, extensions: string[]): Promise<string[]> {
  if (!(await exists(root))) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
    }
  }
  out.sort();
  return out;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return safeJsonParse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scoreBucket(score: number | undefined): string {
  if (score === undefined) return 'unscored';
  if (score >= 0.85) return 'excellent';
  if (score >= 0.7) return 'good';
  if (score >= 0.5) return 'marginal';
  return 'poor';
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
