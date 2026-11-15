#!/usr/bin/env node
/**
 * Wave-gate style proof: compound loop exports exist and unit contract file is present.
 * Fail if SelfImproveCompoundLoop or guidance inject symbols are missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const compound = join(root, 'src/harness/SelfImproveCompoundLoop.ts');
const envelope = join(root, 'src/harness/CompoundRunEnvelope.ts');
const publisher = join(root, 'src/harness/PlanPublisher.ts');
const allowlist = join(root, 'src/harness/DiagnosePathAllowlist.ts');
const llmClient = join(root, 'src/llm/LLMClient.ts');
const sir = join(root, 'src/runtime-core/SelfImprovementRuntime.ts');
const skills = [
  join(root, '.skills/comorbidity-check/SKILL.md'),
  join(root, '.skills/systematic-debugging/SKILL.md'),
];
const testFile = join(root, 'test/unit/harness/SelfImproveCompoundLoop.test.ts');
const envTest = join(root, 'test/unit/harness/CompoundRunEnvelope.test.ts');
const harvestTest = join(root, 'test/unit/harness/compound-harvest-e2e.test.ts');

const errors = [];
if (!existsSync(compound)) errors.push('missing src/harness/SelfImproveCompoundLoop.ts');
else {
  const body = readFileSync(compound, 'utf8');
  for (const sym of [
    'withLearnedGuidance',
    'recordSelfImproveOutcome',
    'writeDiagnosePlanFile',
    'LEARNED_SECTION_HEADER',
    'verifyPatternBeforeLearn',
  ]) {
    if (!body.includes(sym)) errors.push(`SelfImproveCompoundLoop missing ${sym}`);
  }
}
if (!existsSync(envelope)) errors.push('missing CompoundRunEnvelope.ts');
else {
  const body = readFileSync(envelope, 'utf8');
  for (const sym of ['createEnvelope', 'evaluateWaveGate', 'isFailureRetryable', 'proofChain']) {
    if (!body.includes(sym)) errors.push(`CompoundRunEnvelope missing ${sym}`);
  }
}
if (!existsSync(publisher)) errors.push('missing PlanPublisher.ts');
else if (!readFileSync(publisher, 'utf8').includes('publishDiagnosePlan')) {
  errors.push('PlanPublisher missing publishDiagnosePlan');
}
if (!existsSync(allowlist)) errors.push('missing DiagnosePathAllowlist.ts');
if (!existsSync(llmClient)) errors.push('missing LLMClient.ts');
else {
  const body = readFileSync(llmClient, 'utf8');
  if (!body.includes('timeout?: number')) errors.push('LLMClient missing timeout config field');
  if (!body.includes('const timeoutMs = this.config.timeout ?? TIMEOUT_DEFAULT_MS')) {
    errors.push('LLMClient getProvider must use config.timeout ?? TIMEOUT_DEFAULT_MS');
  }
}
if (!existsSync(sir)) errors.push('missing SelfImprovementRuntime.ts');
else {
  const body = readFileSync(sir, 'utf8');
  if (!body.includes('withLearnedGuidance')) errors.push('SIR missing withLearnedGuidance inject');
  if (!body.includes('recordSelfImproveOutcome')) errors.push('SIR missing recordSelfImproveOutcome');
}
for (const s of skills) {
  if (!existsSync(s)) errors.push(`missing skill ${s}`);
}
if (!existsSync(testFile)) errors.push('missing SelfImproveCompoundLoop unit tests');
else if (!readFileSync(testFile, 'utf8').includes('withLearnedGuidance creates a measurable prompt delta')) {
  errors.push('missing guidance-delta contract test');
}
if (!existsSync(envTest)) errors.push('missing CompoundRunEnvelope unit tests');
if (!existsSync(harvestTest)) errors.push('missing compound-harvest-e2e tests');

// W9-L2-01: forbid dual plan writers outside PlanPublisher
const batteriesPath = join(root, 'scripts/rotation/batteries.mjs');
if (existsSync(batteriesPath)) {
  const bat = readFileSync(batteriesPath, 'utf8');
  if (bat.includes('writeDiagnosePlanFile')) {
    errors.push('batteries.mjs must not call writeDiagnosePlanFile (PlanPublisher only)');
  }
  if (/writeFile\([\s\S]{0,120}-plan\.md/.test(bat) || /receipts[\s\S]{0,80}-plan\.md[\s\S]{0,80}writeFile/.test(bat)) {
    errors.push('batteries.mjs must not raw-write *-plan.md outside PlanPublisher');
  }
}

if (errors.length) {
  console.error('compound-loop-contract FAIL:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('compound-loop-contract OK');
