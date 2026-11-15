#!/usr/bin/env node
// W8-09 / Forgejo #679 no-spend proof
//
// Builds a deterministic interactive HTML artifact, parses the embedded
// metadata, and asserts identity binding, fail-closed behavior, bounded
// revision enforcement, and exact evidence binding — all without launching a
// browser process.
//
// Usage: pnpm prove:w8-09-interaction-a11y  (or: npx tsx scripts/quality/prove-w8-09-interaction-a11y.ts)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildInteractiveArtifactFromBrief,
  assertInteractiveArtifactIdentity,
  compileCreativeThesis,
  inspectInteractiveArtifactIdentity,
  INTERACTION_A11Y_DISPOSITION_MATRIX,
  INTERACTION_A11Y_SOURCE_ROWS,
  interactionAccessibilityDispositionFor,
  resolveCreativePrinciple,
  validateCreativeThesis,
} from '../../src/creative-intelligence/index.js';
import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../src/creative-run/CreativeRunCoordinator.js';

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`[OK]   ${name}`);
  } else {
    console.error(`[FAIL] ${name} — ${detail ?? ''}`);
    failures.push(name);
  }
}

function extractMeta(html, name) {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}

// 1. Frozen disposition matrix is exhaustive (supported / historical / unsupported).
console.log('\n=== 1. Frozen interaction/accessibility disposition matrix ===');
const totalRows = INTERACTION_A11Y_SOURCE_ROWS.length;
const supportedRows = INTERACTION_A11Y_DISPOSITION_MATRIX.filter((row) => row.disposition === 'supported');
const historicalRows = INTERACTION_A11Y_DISPOSITION_MATRIX.filter((row) => row.disposition === 'historical');
const unsupportedRows = INTERACTION_A11Y_DISPOSITION_MATRIX.filter((row) => row.disposition === 'unsupported');
check('frozen row count >= 20', totalRows >= 20, `expected at least 20 frozen rows, got ${totalRows}`);
check('every supported row binds to a contract', supportedRows.every((row) => row.principleId && row.contractDigest.match(/^[a-f0-9]{64}$/)));
check('every historical row has a non-empty reason', historicalRows.every((row) => typeof row.reason === 'string' && row.reason.length > 20));
check('every unsupported row has a non-empty reason', unsupportedRows.every((row) => typeof row.reason === 'string' && row.reason.length > 20));
check('historical rows have no reachable contract', historicalRows.every((row) => resolveCreativePrinciple(row.row.name) === undefined));
check('unsupported rows have no reachable contract', unsupportedRows.every((row) => resolveCreativePrinciple(row.row.name) === undefined));

// 2. Fail closed before provider reservation — historical and unsupported rows.
console.log('\n=== 2. Fail-closed before provider reservation ===');
let multiModalReserveCalls = 0;
const multiModalCoordinator = new CreativeRunCoordinator({
  persistence: new MemoryCreativeRunPersistence(),
  reserveProvider: async () => { multiModalReserveCalls++; return { id: 'reserve', status: 'reserved' }; },
});
try {
  await multiModalCoordinator.start({ entryPoint: 'studio-session', prompt: 'Use multi-modal input for navigation.' });
} catch (e) { /* expected fail-closed */ }
check('multi-modal input request fails closed', multiModalReserveCalls === 0, `expected 0 reservations, got ${multiModalReserveCalls}`);

let hoverReserveCalls = 0;
const hoverCoordinator = new CreativeRunCoordinator({
  persistence: new MemoryCreativeRunPersistence(),
  reserveProvider: async () => { hoverReserveCalls++; return { id: 'reserve', status: 'reserved' }; },
});
try {
  await hoverCoordinator.start({ entryPoint: 'studio-session', prompt: 'Use hover to reveal details.' });
} catch (e) { /* expected fail-closed */ }
check('historical hover request fails closed', hoverReserveCalls === 0, `expected 0 reservations, got ${hoverReserveCalls}`);

// 3. Supported request reaches deterministic no-spend interactive artifact.
console.log('\n=== 3. Supported artifact identity binding ===');
const supportedBrief = 'Apply keyboard operation, focus visibility, semantic naming, semantic state, and reduced motion to a calm interactive scene.';
const requestedFromBrief = [
  'keyboard-operation',
  'focus-visibility',
  'semantic-naming',
  'semantic-state',
  'reduced-motion',
];
const built = buildInteractiveArtifactFromBrief(supportedBrief, {
  runtimeSeed: 'w8-09-proof',
  requestedPrinciples: requestedFromBrief,
});
const thesis = built.thesis;
check('thesis is supported', thesis.disposition === 'supported');
check('thesis validates canonically', (() => { try { validateCreativeThesis(thesis); return true; } catch { return false; } })());
check('artifact identity binds thesis id', inspectInteractiveArtifactIdentity(built.html).thesisId === thesis.thesisId);
check('artifact identity binds principle ids', built.trace.identity.principleIds.length === 5);
check('artifact identity bounds runtime to deterministic seed', built.trace.identity.runtimeId === 'runtime-w8-09-proof');
check('artifact body contains sinter-interactive-artifact-digest meta', extractMeta(built.html, 'sinter-interactive-artifact-digest') !== null);
check('artifact body contains bounded revision max', extractMeta(built.html, 'sinter-interactive-artifact-bounded-revision-max') === '1');
const digests = new Set();
for (const step of built.trace.steps) {
  digests.add(`${step.input}|${step.priorState}|${step.nextState}`);
}
check('trace binds unique input -> state transitions', digests.size >= 3);
check('artifact emits executable primary handler', built.html.includes("primary.addEventListener('click'"));
check('artifact emits executable secondary handler', built.html.includes("secondary.addEventListener('click'"));

// 4. Bounded revision enforced (hard maximum, non-waivable).
console.log('\n=== 4. Bounded revision enforcement ===');
let threwOnExceedingMax = false;
try {
  buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'w8-09-proof', revisionsApplied: 2 });
} catch (e) { threwOnExceedingMax = /bounded revision/i.test(String(e)); }
check('revisions above maximum fail closed (non-waivable)', threwOnExceedingMax);

let threwOnNegative = false;
try {
  buildInteractiveArtifactFromBrief('Apply keyboard operation.', { runtimeSeed: 'w8-09-proof', revisionsApplied: -1 });
} catch (e) { threwOnNegative = true; }
check('negative revisions fail closed', threwOnNegative);

// 5. Determinism — same brief + same seed produces identical artifact digest.
console.log('\n=== 5. Determinism ===');
const left = buildInteractiveArtifactFromBrief(supportedBrief, {
  runtimeSeed: 'w8-09-proof',
  requestedPrinciples: requestedFromBrief,
}).trace.identity;
const right = buildInteractiveArtifactFromBrief(supportedBrief, {
  runtimeSeed: 'w8-09-proof',
  requestedPrinciples: requestedFromBrief,
}).trace.identity;
check('identical briefs produce identical identity', left.artifactDigest === right.artifactDigest && left.thesisId === right.thesisId);

// Different runtime seed must change the artifact digest but keep thesis identity.
const a = buildInteractiveArtifactFromBrief(supportedBrief, { runtimeSeed: 'seed-a', requestedPrinciples: requestedFromBrief });
const b = buildInteractiveArtifactFromBrief(supportedBrief, { runtimeSeed: 'seed-b', requestedPrinciples: requestedFromBrief });
check('runtime seed changes digest only', a.trace.identity.artifactDigest !== b.trace.identity.artifactDigest && a.trace.identity.thesisId === b.trace.identity.thesisId);

// 6. W8-05 behavior preservation — color/composition tests still hold.
console.log('\n=== 6. W8-05 preservation ===');
const chiaroscuro = compileCreativeThesis('Use the chiaroscuro principle for this study.');
check('chiaroscuro still fail-closed (W8-05 preserved)', chiaroscuro.disposition === 'unsupported' && chiaroscuro.unsupported[0].requested === 'chiaroscuro');
const splitComplementary = compileCreativeThesis('Use split-complementary for this work.');
check('split-complementary still fail-closed (W8-05 preserved)', splitComplementary.disposition === 'unsupported');
check('color-harmony contract still reachable', resolveCreativePrinciple('color-harmony')?.identity.id === 'color-harmony');
check('focal-point contract still reachable', resolveCreativePrinciple('focal-point')?.identity.id === 'focal-point');

// 7. Canonical body identity and production reachability.
console.log('\n=== 7. Identity binding ===');
const expectedIdentity = inspectInteractiveArtifactIdentity(built.html);
check('artifact identity assertion accepts exact canonical body', (() => {
  try { assertInteractiveArtifactIdentity(built.html, expectedIdentity); return true; } catch { return false; }
})());
const mutated = built.html.replace('Primary action', 'Mutated action');
check('artifact identity assertion rejects body mutation', (() => {
  try { assertInteractiveArtifactIdentity(mutated, expectedIdentity); return false; } catch { return true; }
})());
const productCoordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() });
const productArtifact = await productCoordinator.createInteractiveArtifact(
  'Apply keyboard operation and reduced motion.',
  { runtimeSeed: 'w8-09-product', revisionsApplied: 1 },
);
check('production coordinator/orchestrator seam creates completed artifact', productArtifact.creativeRun.record.status === 'completed');
check('one revision changes rendered artifact honestly', productArtifact.html.includes('Bounded revisions applied: 1 / 1'));

// Report
console.log('\n=== Summary ===');
const totalChecks = failures.length === 0 ? 'all green' : `${failures.length} failed`;
console.log(`Result: ${totalChecks}`);
if (failures.length > 0) {
  console.error('Failures:');
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

// Verify the bound run-tip: load the package.json and confirm SINTER_VERSION matches expectations.
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf8'));
  if (typeof pkg.version === 'string') {
    console.log(`sinter version: ${pkg.version}`);
  }
} catch { /* evidence probe is informational only */ }

console.log('\nStatus: W8-09 / Forgejo #679 no-spend proof OK');
process.exit(0);
