#!/usr/bin/env node
// Harvest real scored SINTER attempts into evaluator score-band labels.
// Safe default: --dry-run plans quotas only. Live mode requires --budget N.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDomainPrompt, parseScoreLine } from './self-improve-domains.mjs';

const DEFAULT_TARGETS = { marginal: 75, good: 75, excellent: 75 };
const DEFAULT_DOMAIN_TARGETS = { hydra: 20 };
const DEFAULT_DATASET = path.join(os.homedir(), '.omx/generated/sinter-evaluator-dataset/cleaned-20260707T0026Z-final-confirm');
const THEMES = [
  'a restrained study of one imperfect motion system',
  'a simple composition with one clear visual idea',
  'a rough but readable draft of procedural texture',
  'a sparse interaction that almost works but needs refinement',
  'a coherent miniature with moderate polish',
  'an intentionally underdeveloped study of rhythm and form',
];
const BAND_PROMPTS = {
  marginal: 'Keep this valid but intentionally minimal: one promising idea, sparse detail, low ambition, no broken or incomplete code.',
  good: 'Make this competent and coherent but restrained: one strong idea, moderate polish, no ornate overachievement.',
  excellent: 'Make this polished, legible, and art-directed: strong composition, tasteful detail, robust execution.',
};

function valueAfter(argv, flag) {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function has(argv, flag) {
  return argv.includes(flag);
}

export function scoreBucket(score) {
  if (!Number.isFinite(score)) return 'unscored';
  if (score >= 0.85) return 'excellent';
  if (score >= 0.65) return 'good';
  if (score >= 0.45) return 'marginal';
  return 'poor';
}

export function parseAssignments(text, fallback = {}) {
  const out = { ...fallback };
  if (!text) return out;
  for (const part of String(text).split(',')) {
    const [key, raw] = part.split('=').map((s) => s?.trim());
    if (!key || raw === undefined) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

function parseList(text, fallback) {
  const values = String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function readJsonl(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function summarizePrimaryDataset(datasetDir) {
  const rows = ['primary-train', 'primary-val', 'primary-test'].flatMap((name) => readJsonl(path.join(datasetDir, `${name}.jsonl`)));
  const buckets = {};
  const domains = {};
  for (const row of rows) {
    const bucket = row?.target?.scoreBucket ?? 'unknown';
    const domain = row?.input?.domain ?? 'unknown';
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    domains[domain] = (domains[domain] ?? 0) + 1;
  }
  return { rows: rows.length, buckets, domains };
}

export function calculateGaps(summary, bucketTargets = DEFAULT_TARGETS, domainTargets = DEFAULT_DOMAIN_TARGETS) {
  const bucketGaps = {};
  const domainGaps = {};
  for (const [bucket, target] of Object.entries(bucketTargets)) {
    const current = summary.buckets[bucket] ?? 0;
    bucketGaps[bucket] = { current, target, need: Math.max(0, target - current) };
  }
  for (const [domain, target] of Object.entries(domainTargets)) {
    const current = summary.domains[domain] ?? 0;
    domainGaps[domain] = { current, target, need: Math.max(0, target - current) };
  }
  return { bucketGaps, domainGaps };
}

export function planAttempts(gaps, budget, domains = ['hydra', 'p5', 'kinetic', 'glsl', 'textgen', 'tone', 'strudel']) {
  const buckets = Object.entries(gaps.bucketGaps)
    .filter(([, gap]) => gap.need > 0)
    .sort((a, b) => b[1].need - a[1].need)
    .map(([bucket]) => bucket);
  const domainNeeds = Object.entries(gaps.domainGaps).filter(([, gap]) => gap.need > 0).map(([domain]) => domain);
  const plan = [];
  const n = Math.max(0, Number(budget) || 0);
  for (let i = 0; i < n; i++) {
    const targetBucket = buckets[i % Math.max(1, buckets.length)] ?? 'good';
    const domain = i < domainNeeds.length ? domainNeeds[i] : domains[i % domains.length];
    const theme = THEMES[i % THEMES.length];
    const prompt = `${buildDomainPrompt(domain, theme)}. ${BAND_PROMPTS[targetBucket] ?? BAND_PROMPTS.good} Harvest target band: ${targetBucket}.`;
    plan.push({ index: i + 1, domain, targetBucket, prompt });
  }
  return plan;
}

function harvestId({ domain, prompt, score, index }) {
  const hash = crypto.createHash('sha256').update(`${domain}\n${prompt}\n${score}\n${index}`).digest('hex').slice(0, 8);
  return `har_${domain.slice(0, 3)}_${hash}`;
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '');
}

function writeReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function display(file) {
  const home = os.homedir();
  if (file.startsWith(`${home}${path.sep}`)) return `~${file.slice(home.length)}`;
  return file;
}

function sanitizeMessage(text, repoRoot) {
  return String(text ?? '').replaceAll(repoRoot, 'repo:.').replaceAll(os.homedir(), '~');
}

function runAttempt(item, options) {
  const outputDir = path.join(options.outputRoot, `attempt-${String(item.index).padStart(4, '0')}-${item.domain}-${item.targetBucket}`);
  const args = ['bin/sinter', '--prompt', item.prompt, '--domain', item.domain, '--intuition', '--aesthetic', options.aesthetic, '-o', outputDir];
  if (options.learn) args.push('--learn');
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);
  const stdout = execFileSync('node', args, {
    cwd: options.repoRoot,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    env: { ...process.env, LIMINAL_LOG_LEVEL: process.env.LIMINAL_LOG_LEVEL || 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = parseScoreLine(stdout);
  return { outputDir, stdout, parsed };
}

export async function main(argv = process.argv.slice(2)) {
  if (has(argv, '--help')) {
    console.log('Usage: node scripts/quality/harvest-evaluator-score-bands.mjs [--dry-run] --budget N [--dataset-dir DIR] [--targets marginal=75,good=75,excellent=75] [--domain-targets hydra=20] [--domains p5,glsl,textgen,tone] [--out FILE] [--report DIR] [--provider NAME] [--model NAME]');
    return 0;
  }

  const repoRoot = process.cwd();
  const dryRun = has(argv, '--dry-run');
  const budget = Number(valueAfter(argv, '--budget') ?? (dryRun ? '24' : '0'));
  if (!dryRun && (!Number.isFinite(budget) || budget <= 0)) {
    console.error('--budget N is required for live harvesting');
    return 2;
  }

  const datasetDir = valueAfter(argv, '--dataset-dir') ?? DEFAULT_DATASET;
  const bucketTargets = parseAssignments(valueAfter(argv, '--targets'), DEFAULT_TARGETS);
  const domainTargets = parseAssignments(valueAfter(argv, '--domain-targets'), DEFAULT_DOMAIN_TARGETS);
  const harvestDomains = parseList(valueAfter(argv, '--domains'), ['hydra', 'p5', 'kinetic', 'glsl', 'textgen', 'tone', 'strudel']);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const reportDir = valueAfter(argv, '--report') ?? path.join(os.homedir(), `.omx/generated/sinter-evaluator-harvest/${stamp}`);
  const outFile = valueAfter(argv, '--out') ?? path.join(repoRoot, `docs/validation/rescore/evaluator-harvest-${stamp}.jsonl`);
  const outputRoot = valueAfter(argv, '--output-root') ?? path.join(repoRoot, '.quality/evaluator-harvest', stamp, 'attempts');
  const options = {
    repoRoot,
    provider: valueAfter(argv, '--provider'),
    model: valueAfter(argv, '--model'),
    aesthetic: valueAfter(argv, '--aesthetic') ?? 'free',
    timeoutMs: Number(valueAfter(argv, '--timeout-ms') ?? '480000'),
    learn: has(argv, '--learn'),
    outputRoot,
  };

  const summary = summarizePrimaryDataset(datasetDir);
  const gaps = calculateGaps(summary, bucketTargets, domainTargets);
  const plan = planAttempts(gaps, budget, harvestDomains);
  const rows = [];
  const attempts = [];

  if (!dryRun) fs.mkdirSync(outputRoot, { recursive: true });
  const baseReport = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    dryRun,
    datasetDir: display(datasetDir),
    outputJsonl: dryRun ? null : display(outFile),
    reportDir: display(reportDir),
    budget,
    harvestDomains,
    summary,
    gaps,
    plannedAttempts: plan.length,
  };
  writeReport(reportDir, dryRun
    ? { ...baseReport, capturedRows: 0, plan }
    : { ...baseReport, capturedRows: 0, attempts });
  for (const item of plan) {
    if (dryRun) continue;
    console.error(`[harvest] ${item.index}/${plan.length} domain=${item.domain} target=${item.targetBucket}`);
    try {
      const result = runAttempt(item, options);
      const score = result.parsed.score;
      const bucket = scoreBucket(score);
      const useful = bucket in gaps.bucketGaps && gaps.bucketGaps[bucket].need > 0;
      attempts.push({ ...item, score, bucket, degraded: result.parsed.degraded, useful, outputDir: display(result.outputDir) });
      if (score != null && !result.parsed.degraded && useful) {
        rows.push({
          id: harvestId({ ...item, score }),
          domain: item.domain,
          stored: null,
          fresh: score,
          delta: null,
          labelKind: 'score_band_harvest',
          provenance: 'sinter_score_band_harvest',
          prompt: item.prompt,
          scoreBand: bucket,
          targetBand: item.targetBucket,
          outputPath: display(result.outputDir),
          reason: `Harvested ${bucket} score-band attempt for evaluator data gap`,
        });
      }
    } catch (error) {
      attempts.push({ ...item, error: sanitizeMessage(error instanceof Error ? error.message : String(error), options.repoRoot) });
    }
    writeJsonl(outFile, rows);
    writeReport(reportDir, { ...baseReport, capturedRows: rows.length, attempts });
  }

  if (!dryRun) writeJsonl(outFile, rows);
  const report = {
    ...baseReport,
    capturedRows: rows.length,
    plan: dryRun ? plan : undefined,
    attempts: dryRun ? undefined : attempts,
  };
  writeReport(reportDir, report);
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  process.exit(code);
}
