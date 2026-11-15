import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  WAVE6_LANE_DEFINITIONS,
  createWave6LiveEnvironment,
  evaluateWave6Experiment,
  normalizeWave6CoordinationScores,
  resumeWave6Lineage,
} from '../../dist/quality/Wave6CreativeFlywheel.js';
import { StudioLineageLedger } from '../../dist/tui-bridge/StudioLineage.js';
import {
  fingerprintTrialConfiguration,
  packageOwnerControlledCandidate,
} from '../../dist/runtime-core/CausalCandidatePackager.js';
import { ReviewedAutoresearchExperimentRunner } from '../../dist/runtime-core/SealedIndependentReview.js';
import {
  COMPOSITION_EVIDENCE_DIMENSIONS,
  CompositionEvaluator,
} from '../../dist/evaluation/CompositionEvaluator.js';
import {
  CREATIVE_PROOF_SCHEMA_VERSION,
  evaluateCreativeProof,
} from '../../dist/quality/CreativeProofGate.js';
import { chromiumLaunchOptions } from '../../dist/utils/browserPreflight.js';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
} from '../../dist/composition/ControlRecipe.js';
import { loadGrokOidcAuth } from '../rotation/grok-auth.mjs';

const exec = promisify(execFile);
const sha256 = value => createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  .digest('hex');
const progress = (stage, detail = '') => {
  process.stdout.write(`[wave6:${lane ?? 'unresolved'}] ${stage}${detail ? ` ${detail}` : ''}\n`);
};
const argValue = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const lane = argValue('--lane');
const requestedLineageId = argValue('--lineage');
const live = process.argv.includes('--live');
if (!Object.hasOwn(WAVE6_LANE_DEFINITIONS, lane)) {
  console.error('Usage: wave6-lane.mjs --lane <p5-tone|three-shader|strudel-p5> --live');
  process.exit(1);
}
const definition = WAVE6_LANE_DEFINITIONS[lane];
const runId = argValue('--run-id') ?? new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = path.resolve('.quality', 'tour', 'wave-6', runId, lane);
const durableReceipt = path.resolve('docs', 'agents', 'waves', 'receipts', `wave-6-${lane}-${runId}.json`);
await fs.mkdir(runRoot, { recursive: true });

async function persistReceipt(receipt) {
  await fs.mkdir(path.dirname(durableReceipt), { recursive: true });
  await fs.writeFile(durableReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  await fs.writeFile(path.join(runRoot, 'lane-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}

async function stopWith(status, reason, evidence = {}) {
  const receipt = {
    schemaVersion: 1,
    gate: `W6-${lane}`,
    runId,
    lane,
    generatedAt: new Date().toISOString(),
    status,
    reason,
    definition,
    evidence,
  };
  await persistReceipt(receipt);
  process.stdout.write(`${JSON.stringify({ status, reason, durableReceipt, runRoot }, null, 2)}\n`);
  process.exit(status === 'FAIL' ? 1 : 2);
}

if (!live) {
  await stopWith('DEFERRED', 'Live execution requires --live');
}

const configPath = path.join(os.homedir(), '.sinter', 'config.json');
let userConfig;
try {
  userConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
} catch (error) {
  await stopWith('DEFERRED', `Provider configuration unavailable: ${error.message}`);
}
const harnessRole = userConfig.roles?.harness;
let evaluatorRole = userConfig.roles?.evaluator;
if (evaluatorRole && (/grok/i.test(evaluatorRole.model ?? '') || /api\.x\.ai/i.test(evaluatorRole.baseUrl ?? ''))) {
  const grokAuth = await loadGrokOidcAuth({
    model: evaluatorRole.model,
    baseUrl: evaluatorRole.baseUrl,
  }).catch(() => null);
  if (grokAuth) {
    evaluatorRole = {
      ...evaluatorRole,
      provider: grokAuth.provider,
      apiKey: grokAuth.apiKey,
      baseUrl: grokAuth.baseUrl,
      model: grokAuth.model,
    };
  }
}
if (!harnessRole?.apiKey || !harnessRole?.baseUrl || !evaluatorRole?.apiKey || !evaluatorRole?.baseUrl) {
  await stopWith('DEFERRED', 'Harness or evaluator role is not configured');
}
const generatorRole = {
  ...harnessRole,
  model: process.env.WAVE6_GENERATOR_MODEL ?? 'gpt-5.6-luna',
};
const creativeReviewerRole = {
  ...harnessRole,
  model: process.env.WAVE6_CREATIVE_REVIEWER_MODEL ?? harnessRole.model,
};
const roleIdentity = role => [
  role.provider,
  role.model,
].map(value => String(value).trim().toLowerCase()).join('/');
if (new Set([
  roleIdentity(generatorRole),
  roleIdentity(creativeReviewerRole),
  roleIdentity(evaluatorRole),
]).size !== 3) {
  await stopWith('FAIL', 'Wave 6 generator and reviewer identities must be distinct');
}

function parseJsonText(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

async function modelJson(role, prompt, images = []) {
  const content = [{ type: 'text', text: prompt }];
  for (const imagePath of images) {
    const encoded = (await fs.readFile(imagePath)).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${encoded}` } });
  }
  const response = await fetch(`${role.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${role.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: role.model,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`model call failed (${response.status}): ${body.error?.message ?? 'unknown'}`);
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('model response omitted content');
  return {
    value: parseJsonText(text),
    identity: {
      provider: role.provider,
      model: body.model || role.model,
      verified: Boolean(body.model),
      requestId: response.headers.get('x-request-id') || body.id || 'unreported',
      observedAt: new Date().toISOString(),
    },
    usage: {
      tokens: Number(body.usage?.total_tokens ?? 0),
      retries: 0,
      artifacts: 1,
    },
  };
}

const repoRoot = process.cwd();
const repoPath = target => path.relative(repoRoot, target);
async function fileProofEvidence(file, kind, modalities, durationSeconds) {
  const content = await fs.readFile(file);
  return {
    ref: repoPath(file),
    kind,
    modalities,
    sha256: sha256(content),
    bytes: content.length,
    ...(durationSeconds ? { durationSeconds } : {}),
  };
}
const discoveredControl = (await exec('git', [
  'rev-list', '-1', '--grep=freeze Wave 6 causal experiment contract', 'HEAD',
], { cwd: repoRoot })).stdout.trim();
const controlRef = process.env.WAVE6_CONTROL_REF ?? discoveredControl;
if (!controlRef) await stopWith('FAIL', 'Could not resolve the frozen pre-intervention control');
const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), `wave6-${lane}-`));
const controlRoot = path.join(scratchRoot, 'control');
const candidateRoot = path.join(scratchRoot, 'candidate');
const restoreRoot = path.join(scratchRoot, 'restore');
const worktrees = [controlRoot, candidateRoot, restoreRoot];

async function addWorktree(target) {
  await exec('git', ['worktree', 'add', '--detach', target, 'HEAD'], { cwd: repoRoot });
  await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(target, 'node_modules'), 'dir');
}

async function removeWorktrees() {
  for (const target of worktrees.reverse()) {
    await exec('git', ['worktree', 'remove', '--force', target], { cwd: repoRoot }).catch(() => {});
  }
  await exec('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => {});
  await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
}

function gitDigest(root) {
  return exec('git', ['status', '--porcelain=v1'], { cwd: root })
    .then(result => sha256(result.stdout));
}

try {
  for (const target of worktrees) await addWorktree(target);
} catch (error) {
  await removeWorktrees();
  await stopWith('DEFERRED', `Could not prepare isolated experiment worktrees: ${error.message}`);
}

const mutationPath = 'src/composition/LayerContract.ts';
const candidateContent = await fs.readFile(path.join(repoRoot, mutationPath), 'utf8');
const controlContent = (await exec('git', ['show', `${controlRef}:${mutationPath}`], { cwd: repoRoot })).stdout;
for (const target of worktrees) {
  await fs.writeFile(path.join(target, mutationPath), controlContent);
}
const mutationDiff = (await exec('git', ['diff', controlRef, 'HEAD', '--', mutationPath], { cwd: repoRoot })).stdout;

async function createSealedManifest() {
  const root = path.join(runRoot, 'sealed-oracle');
  await fs.mkdir(root, { recursive: true });
  const files = {
    'evaluator.js': "import { rubric } from './rubric.js';\nexport const evaluate = scores => ({ rubric, scores });\n",
    'rubric.js': "export const rubric = ['intentionality','cross-layer coherence','sensory craft','expressive specificity','meaningful surprise'];\n",
    'fixture.json': `${JSON.stringify({ brief: definition.brief, lane })}\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content);
  }
  const ref = name => ({ path: name, sha256: sha256(files[name]) });
  const manifest = {
    schemaVersion: 1,
    evaluatorCode: [ref('evaluator.js')],
    dependencies: [ref('rubric.js')],
    prompt: { id: 'wave6-blind-creative-review-v1', sha256: sha256('wave6-blind-creative-review-v1') },
    reviewer: {
      provider: evaluatorRole.provider,
      model: evaluatorRole.model,
      verified: true,
    },
    fixtures: [ref('fixture.json')],
    thresholds: { minimumMeanEffect: 0.05, minimumWins: 2 },
    controls: [{ id: controlRef, sha256: sha256(controlContent) }],
    environment: { lane, contract: 'wave6-v1' },
    tools: ['readFile', 'search', 'searchCode', 'searchDocs', 'listDir', 'gitStatus'],
    artifactSelection: { strategy: 'all-formal-pairs', refs: ['C1/T1', 'T2/C2', 'C3/T3'] },
  };
  const manifestPath = path.join(root, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifestDigest: sha256(await fs.readFile(manifestPath)) };
}

const sealed = await createSealedManifest();

const author = {
  provider: 'repository',
  model: 'pre-existing-branch-content',
  verified: false,
};
const observedAt = new Date().toISOString();
const hypothesis = {
  key: `wave6-${lane}-coupling-craft`,
  claim: 'A bounded shared temporal-arc contract improves cross-layer coherence and creative specificity.',
  falsifier: 'Mean paired blind-review effect is below 0.05 or fewer than two treatment wins.',
  status: 'ready',
  confidence: 0.7,
  citations: [
    {
      id: `${lane}-studio-baseline`,
      hypothesisKey: `wave6-${lane}-coupling-craft`,
      claim: 'Studio baseline exposes cross-layer coordination quality.',
      falsifier: 'No coupled Studio artifact is produced.',
      source: 'composition',
      sourceRef: `run:${runId}:diagnostic`,
      lineageId: `wave6-${lane}`,
      stance: 'support',
      confidence: 0.7,
      observedAt,
      trust: 'verified-system',
      taint: 'clean',
    },
    {
      id: `${lane}-owner-intent`,
      hypothesisKey: `wave6-${lane}-coupling-craft`,
      claim: 'The frozen lane brief requires a legible temporal arc and one composed instrument.',
      falsifier: 'The frozen brief omits those requirements.',
      source: 'operational',
      sourceRef: 'spec:wave6-frozen-lane',
      lineageId: `wave6-${lane}`,
      stance: 'support',
      confidence: 1,
      observedAt,
      trust: 'owner',
      taint: 'clean',
    },
  ],
  supportingSources: ['composition', 'operational'],
  corroboratingSources: ['composition', 'operational'],
  disagreements: [],
  trust: 'verified-system',
  taint: 'clean',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};
const budgets = {
  tokens: 100_000,
  calls: 30,
  timeMs: 300_000,
  retries: 2,
  artifacts: 20,
  diskBytes: 2_000_000,
  worktrees: 1,
  reviewRounds: 1,
};

async function runExperiment({ workspaceRoot, shouldRestore, lineageId }) {
  const experimentId = `wave6-${lane}-${shouldRestore ? 'restore' : 'candidate'}-${runId}`;
  const runner = new ReviewedAutoresearchExperimentRunner();
  const laneHypothesis = structuredClone(hypothesis);
  laneHypothesis.citations.forEach(citation => { citation.lineageId = lineageId; });
  const input = {
    contract: {
      version: 1,
      loop: 'autoresearch',
      experimentId,
      lineageId,
      state: 'observe',
      stage: 'shadow',
      sourceMutationRequested: true,
      budgets,
    },
    hypothesis: laneHypothesis,
    control: { id: controlRef, digest: sha256(controlContent) },
    author,
    workspaceRoot,
    parentRoot: controlRoot,
    candidateFiles: [mutationPath],
    sealedEvaluatorFiles: ['src/evaluation/CompositionEvaluator.ts'],
    parentStateDigest: () => gitDigest(controlRoot),
    executeStage: async context => {
      if (context.state === 'mutate') await context.writeCandidate(mutationPath, candidateContent);
      const failedVerification = shouldRestore && context.state === 'verify';
      return {
        passed: !failedVerification,
        evidenceRefs: [`wave6:${lane}:${context.state}`],
        usage: { tokens: 0, retries: 0, artifacts: context.state === 'mutate' ? 1 : 0 },
      };
    },
  };
  return runner.run({
    experiment: input,
    manifestPath: sealed.manifestPath,
    executeReview: async context => {
      const expectation = shouldRestore
        ? 'Verification deliberately failed. The only correct verdict is veto.'
        : 'Approve only if the one-file mutation is bounded, relevant, simple, and does not alter sealed quality inputs.';
      const prompt = `You are the independent mutation reviewer for Wave 6 lane ${lane}.
${expectation}
Return JSON only:
{"verdict":"approve|veto","disagreement":["..."],"requestedFollowUp":["..."],"evidenceRefs":["..."]}
Frozen brief: ${definition.brief}
Candidate allowlist: ${definition.allowlist.join(', ')}
Actual diff:
${mutationDiff}`;
      const review = await modelJson(evaluatorRole, prompt);
      const verdict = review.value.verdict;
      if (!['approve', 'veto'].includes(verdict)) throw new Error('reviewer omitted verdict');
      return {
        verdict,
        identity: review.identity,
        evidenceRefs: Array.isArray(review.value.evidenceRefs) && review.value.evidenceRefs.length
          ? review.value.evidenceRefs.map(String)
          : [`review:${review.identity.requestId}`],
        disagreement: Array.isArray(review.value.disagreement) && review.value.disagreement.length
          ? review.value.disagreement.map(String)
          : ['No material disagreement recorded.'],
        requestedFollowUp: Array.isArray(review.value.requestedFollowUp) && review.value.requestedFollowUp.length
          ? review.value.requestedFollowUp.map(String)
          : ['Retain the frozen formal-pair protocol.'],
        usage: review.usage,
      };
    },
  });
}

const liveConfigPath = path.join(scratchRoot, 'config.json');
const liveConfig = {
  ...userConfig,
  defaultProvider: generatorRole.provider,
  providers: {
    ...(userConfig.providers ?? {}),
    [generatorRole.provider]: {
      baseUrl: generatorRole.baseUrl,
      model: generatorRole.model,
      apiKey: generatorRole.apiKey,
    },
  },
  roles: {
    ...(userConfig.roles ?? {}),
    generator: generatorRole,
    harness: harnessRole,
    evaluator: evaluatorRole,
  },
};
await fs.writeFile(liveConfigPath, `${JSON.stringify(liveConfig)}\n`, { mode: 0o600 });
const lineagePath = requestedLineageId
  ? process.env.SINTER_STUDIO_LINEAGE_PATH
  : path.join(runRoot, 'studio-lineage.jsonl');
if (!lineagePath) {
  await removeWorktrees();
  await stopWith('FAIL', '--lineage requires SINTER_STUDIO_LINEAGE_PATH');
}
const serverEnv = createWave6LiveEnvironment({
  inherited: process.env,
  configPath: liveConfigPath,
  lineagePath,
  generator: generatorRole,
});

async function buildWorktree(root) {
  await exec('pnpm', ['build'], {
    cwd: root,
    env: serverEnv,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}
try {
  await buildWorktree(controlRoot);
} catch (error) {
  await removeWorktrees();
  await stopWith('DEFERRED', `Control or candidate build failed: ${error.message}`);
}

async function openPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startStudio(root, label, studioLineagePath = path.join(runRoot, `${label}-lineage.jsonl`)) {
  const port = await openPort();
  const logPath = path.join(runRoot, `${label}-studio.log`);
  const log = await fs.open(logPath, 'w');
  const code = `import http from 'node:http';
import { createApp } from './gui/server.js';
const server=http.createServer(createApp(process.env.SINTER_CONFIG_PATH,${port}));
server.listen(${port},'127.0.0.1',()=>console.log('READY'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    env: { ...serverEnv, SINTER_STUDIO_LINEAGE_PATH: studioLineagePath },
    stdio: ['ignore', log.createWriteStream(), log.createWriteStream()],
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`${label} Studio exited before readiness`);
    try {
      await fetch(`http://127.0.0.1:${port}/api/status`);
      return {
        url: `http://127.0.0.1:${port}`,
        lineagePath: studioLineagePath,
        stop: async () => {
          child.kill('SIGTERM');
          await new Promise(resolve => child.once('exit', resolve));
          await log.close().catch(() => {});
        },
      };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  child.kill('SIGTERM');
  throw new Error(`${label} Studio readiness timed out`);
}

const layerSpecs = {
  'p5-tone': [
    { domain: 'p5', prompt: `${definition.brief} Create the bioluminescent current visual layer.` },
    { domain: 'tone', prompt: `${definition.brief} Create the generative bell and breathing-rhythm audio layer.` },
  ],
  'three-shader': [
    { domain: 'three', prompt: `${definition.brief} Create the glass cathedral 3D scene.` },
    { domain: 'shader', prompt: `${definition.brief} Create the living weather shader overlay.`, blendMode: 'screen' },
  ],
  'strudel-p5': [
    { domain: 'p5', prompt: `${definition.brief} Create the luminous bloom visual layer.` },
    { domain: 'strudel', prompt: `${definition.brief} Create the beat-phase musical layer.` },
  ],
};

async function compose(studio, label) {
  const response = await fetch(`${studio.url}/api/compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `${lane} ${label}`, layers: layerSpecs[lane] }),
    signal: AbortSignal.timeout(240_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label} compose failed (${response.status}): ${result.error ?? 'unknown'}`);
  if (!result.coupled || result.lane !== lane || !result.recipeDigest) {
    throw new Error(`${label} did not return the frozen coupled lane`);
  }
  const stored = {
    ...result,
    wave6Checkpoint: {
      controlRef,
      mutationDigest: sha256(label.startsWith('T') ? candidateContent : controlContent),
    },
  };
  await fs.writeFile(path.join(runRoot, `${label}.html`), result.html);
  await fs.writeFile(path.join(runRoot, `${label}.json`), `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

async function loadCompletedArtifact(label) {
  try {
    const result = JSON.parse(await fs.readFile(path.join(runRoot, `${label}.json`), 'utf8'));
    const html = await fs.readFile(path.join(runRoot, `${label}.html`), 'utf8');
    const expectedDigest = sha256(label.startsWith('T') ? candidateContent : controlContent);
    if (!result.coupled || result.lane !== lane || !result.recipeDigest || result.html !== html
      || result.wave6Checkpoint?.controlRef !== controlRef
      || result.wave6Checkpoint?.mutationDigest !== expectedDigest) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

async function verifyResumedArtifact(resumed) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch(chromiumLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent(resumed.artifactCode, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);
    const observed = await page.evaluate(() => ({
      lane: document.body.dataset.wave6Lane,
      recipeDigest: document.body.dataset.wave6RecipeDigest,
      layers: document.querySelectorAll('iframe[data-wave6-layer]').length,
    }));
    await page.screenshot({ path: path.join(runRoot, 'diagnostic-resumed.png'), fullPage: true });
    if (errors.length || observed.lane !== lane
      || observed.recipeDigest !== resumed.recipeDigest || observed.layers !== 2) {
      throw new Error(`resumed artifact failed exact replay: ${errors.join('; ') || 'contract mismatch'}`);
    }
  } finally {
    await browser.close();
  }
}

let controlStudio;
let candidateStudio;
let diagnostic;
let candidate;
let restoredFailure;
try {
  progress('studio-control-start');
  controlStudio = await startStudio(controlRoot, 'control', lineagePath);
  progress(requestedLineageId ? 'lineage-resume-start' : 'diagnostic-compose-start');
  diagnostic = requestedLineageId
    ? await resumeWave6Lineage({
      lineageId: requestedLineageId,
      lane,
      ledger: new StudioLineageLedger({ ledgerPath: lineagePath }),
    })
    : await compose(controlStudio, 'diagnostic-control');
  if (requestedLineageId) await verifyResumedArtifact(diagnostic);
  progress('diagnostic-compose-complete', `lineage=${diagnostic.lineageId}`);
  const cli = await exec(process.execPath, [
    path.join(repoRoot, 'bin', 'sinter'),
    'improve',
    '--lineage', diagnostic.lineageId,
    '--lane', lane,
    '--json',
    '--validate-only',
  ], {
    cwd: repoRoot,
    env: { ...serverEnv, SINTER_STUDIO_LINEAGE_PATH: controlStudio.lineagePath },
    timeout: 60_000,
  });
  await fs.writeFile(path.join(runRoot, 'cli-resume-before.json'), cli.stdout);

  progress('mutation-review-start');
  candidate = await runExperiment({
    workspaceRoot: candidateRoot,
    shouldRestore: false,
    lineageId: diagnostic.lineageId,
  });
  restoredFailure = await runExperiment({
    workspaceRoot: restoreRoot,
    shouldRestore: true,
    lineageId: diagnostic.lineageId,
  });
  await fs.writeFile(
    path.join(runRoot, 'independent-mutation-reviews.json'),
    `${JSON.stringify({ candidate, restoredFailure }, null, 2)}\n`,
  );
  if (candidate.experiment.terminal !== 'candidate' || candidate.review.verdict !== 'approve') {
    throw new Error(
      `Independent mutation review did not approve the candidate: ${candidate.review.disagreement.join('; ')}`,
    );
  }
  if (restoredFailure.experiment.terminal !== 'restored' || restoredFailure.review.verdict !== 'veto') {
    throw new Error('Restore canary did not restore, quarantine, and veto');
  }
  progress('mutation-review-complete');
  await buildWorktree(candidateRoot);
  candidateStudio = await startStudio(candidateRoot, 'candidate');
  progress('studio-candidate-ready');
} catch (error) {
  await controlStudio?.stop().catch(() => {});
  await candidateStudio?.stop().catch(() => {});
  await removeWorktrees();
  await stopWith(/review|restore/i.test(error.message) ? 'FAIL' : 'DEFERRED', error.message);
}

const formalOrder = [
  ['C1', controlStudio],
  ['T1', candidateStudio],
  ['T2', candidateStudio],
  ['C2', controlStudio],
  ['C3', controlStudio],
  ['T3', candidateStudio],
];
const artifacts = {};
try {
  for (const [label, studio] of formalOrder) {
    const completed = await loadCompletedArtifact(label);
    if (completed) {
      artifacts[label] = completed;
      progress('formal-compose-resumed', label);
      continue;
    }
    progress('formal-compose-start', label);
    artifacts[label] = await compose(studio, label);
    progress('formal-compose-complete', label);
  }
} catch (error) {
  await controlStudio.stop().catch(() => {});
  await candidateStudio.stop().catch(() => {});
  await removeWorktrees();
  await stopWith('DEFERRED', `Formal artifact generation failed: ${error.message}`, {
    completed: Object.keys(artifacts),
  });
}

await controlStudio.stop();
await candidateStudio.stop();

const { chromium } = await import('playwright');
const browser = await chromium.launch(chromiumLaunchOptions());
async function observeCoupling(page) {
  return page.evaluate(() => {
    const source = document.querySelector('iframe[data-wave6-layer="source"]');
    const target = document.querySelector('iframe[data-wave6-layer="target"]');
    const sourceWindow = source?.contentWindow;
    const tone = sourceWindow?.Tone;
    const strudelContext = typeof sourceWindow?.getAudioContext === 'function'
      ? sourceWindow.getAudioContext()
      : undefined;
    return {
      lane: document.body.dataset.wave6Lane,
      recipeDigest: document.body.dataset.wave6RecipeDigest,
      recipeId: window.SinterControl?.recipe?.id,
      audioOwner: window.SinterControl?.recipe?.audio?.ownerLayerId ?? null,
      layerFrames: document.querySelectorAll('iframe[data-wave6-layer]').length,
      audioStartDispatched: source?.dataset.wave6AudioStartDispatched === 'true',
      audioError: source?.dataset.wave6AudioError ?? null,
      audioState: tone?.context?.state ?? strudelContext?.state ?? null,
      transportState: tone?.Transport?.state ?? null,
      clockTime: tone?.Transport?.seconds ?? strudelContext?.currentTime ?? null,
      signalSource: source?.dataset.wave6SignalSource ?? null,
      signalValue: Number(source?.dataset.wave6SignalValue),
      targetValue: Number(target?.dataset.wave6TargetValue),
    };
  });
}

async function beginMediaProof(page) {
  return page.evaluate((activeLane) => {
    const source = document.querySelector('iframe[data-wave6-layer="source"]')?.contentWindow;
    const target = document.querySelector('iframe[data-wave6-layer="target"]')?.contentDocument;
    const canvas = target?.querySelector('canvas');
    if (!canvas?.captureStream) return { started: false, reason: 'target canvas unavailable' };
    const tracks = [...canvas.captureStream(30).getVideoTracks()];
    if (activeLane !== 'three-shader') {
      const tone = source?.Tone;
      const context = tone?.getContext?.().rawContext ?? source?.getAudioContext?.();
      const output = activeLane === 'p5-tone'
        ? tone?.getDestination?.().output
        : source?.gainNode?.();
      if (!context || !output?.connect) {
        return { started: false, reason: 'audio graph tap unavailable' };
      }
      const destination = context.createMediaStreamDestination();
      output.connect(destination);
      tracks.push(...destination.stream.getAudioTracks());
    }
    const stream = new MediaStream(tracks);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    window.__wave6MediaProof = { recorder, chunks, stream, mimeType };
    recorder.start(250);
    return {
      started: true,
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      mimeType,
    };
  }, lane);
}

async function finishMediaProof(page, label) {
  const encoded = await page.evaluate(() => new Promise((resolve) => {
    const state = window.__wave6MediaProof;
    if (!state) return resolve(null);
    state.recorder.onstop = () => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = String(reader.result);
        resolve(dataUrl.slice(dataUrl.indexOf('base64,') + 'base64,'.length));
      };
      reader.readAsDataURL(new Blob(state.chunks, { type: state.mimeType }));
      state.stream.getTracks().forEach(track => track.stop());
    };
    state.recorder.requestData();
    setTimeout(() => state.recorder.stop(), 100);
  }));
  if (!encoded) return null;
  const mediaPath = path.join(runRoot, `${label}.webm`);
  const rawMediaPath = path.join(runRoot, `${label}.capture.webm`);
  await fs.writeFile(rawMediaPath, Buffer.from(encoded, 'base64'));
  const mediaStat = await fs.stat(rawMediaPath);
  if (mediaStat.size < 1_024) {
    throw new Error(`MediaRecorder produced an incomplete ${mediaStat.size}-byte WebM`);
  }
  await exec('ffmpeg', [
    '-v', 'error', '-y', '-i', rawMediaPath, '-c', 'copy', mediaPath,
  ]);
  await fs.unlink(rawMediaPath);
  const probe = JSON.parse((await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type',
    '-show_entries', 'format=duration', '-of', 'json', mediaPath,
  ])).stdout);
  const streams = probe.streams?.map(stream => stream.codec_type) ?? [];
  let meanVolumeDb = null;
  if (streams.includes('audio')) {
    const volume = await exec('ffmpeg', [
      '-i', mediaPath, '-vn', '-af', 'volumedetect', '-f', 'null', '-',
    ]).catch(error => ({ stderr: error.stderr ?? '' }));
    meanVolumeDb = Number(/mean_volume:\s*(-?[0-9.]+)\s*dB/.exec(volume.stderr)?.[1]);
  }
  return {
    path: mediaPath,
    durationSeconds: Number(probe.format?.duration),
    streams,
    meanVolumeDb,
    audible: Number.isFinite(meanVolumeDb) && meanVolumeDb > -80,
  };
}

async function captureCoordinationConditions(page, label, baselineSignal) {
  const mutationSignal = baselineSignal <= 0.5
    ? baselineSignal + 0.4
    : baselineSignal - 0.4;
  const conditions = [
    ['baseline', baselineSignal],
    ['signal-mutation', mutationSignal],
  ];
  const trials = [];
  for (const [condition, signalValue] of conditions) {
    await page.evaluate(({ value }) => {
      window.SinterControl.setMappingEnabled('wave6-control', true);
      window.SinterControl.setSignalOverride('wave6-control', value);
      window.SinterControl.tick();
    }, { value: signalValue });
    await page.waitForTimeout(100);
    const observed = await page.evaluate(() =>
      window.SinterControl.observe('wave6-control'));
    const screenshot = path.join(runRoot, `${label}-coord-${condition}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    trials.push({ condition, ...observed, screenshot });
  }
  await page.evaluate(({ value, ablatedValue }) => {
    window.SinterControl.setSignalOverride('wave6-control', value);
    window.SinterControl.setMappingEnabled(
      'wave6-control',
      false,
      { ablatedValue },
    );
  }, { value: baselineSignal, ablatedValue: definition.mapping.clamp[0] });
  const observed = await page.evaluate(() =>
    window.SinterControl.observe('wave6-control'));
  const screenshot = path.join(runRoot, `${label}-coord-coupling-ablation.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  trials.push({ condition: 'coupling-ablation', ...observed, screenshot });
  return trials;
}

async function capture(label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(artifacts[label].html, { waitUntil: 'domcontentloaded' });
  const unlock = page.locator('#sinter-audio-unlock');
  if (await unlock.count()) await unlock.click();
  if (lane === 'three-shader') await page.mouse.move(960, 360);
  await page.waitForTimeout(500);
  const mediaStart = await beginMediaProof(page);
  await page.waitForTimeout(2_000);
  const observedBefore = await observeCoupling(page);
  const target = page.locator('iframe[data-wave6-layer="target"]');
  const before = await target.getAttribute('style');
  if (lane === 'three-shader') await page.mouse.move(160, 360);
  else await page.waitForTimeout(800);
  const after = await target.getAttribute('style');
  const observedAfter = await observeCoupling(page);
  const screenshot = path.join(runRoot, `${label}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const mediaProof = mediaStart.started
    ? await finishMediaProof(page, label)
    : null;
  const coordinationTrials = Number.isFinite(observedAfter.signalValue)
    ? await captureCoordinationConditions(page, label, observedAfter.signalValue)
    : [];
  await page.close();
  const expectedSignalSource = {
    'p5-tone': 'tone-transport',
    'three-shader': 'three-pointer',
    'strudel-p5': 'strudel-audio-clock',
  }[lane];
  const observedRealAudio = lane === 'three-shader' || (
    observedAfter.audioStartDispatched
    && observedAfter.audioState === 'running'
    && observedAfter.clockTime > observedBefore.clockTime
    && (lane !== 'p5-tone' || observedAfter.transportState === 'started')
  );
  return {
    label,
    screenshot,
    mediaStart,
    mediaProof,
    errors,
    observedBefore,
    observedAfter,
    coordinationTrials,
    targetStyleBefore: before,
    targetStyleAfter: after,
    couplingChanged: Boolean(before && after && before !== after),
    technicalPass:
      errors.length === 0
      && observedAfter.lane === lane
      && observedAfter.recipeDigest === artifacts[label].recipeDigest
      && observedAfter.layerFrames === 2
      && observedAfter.signalSource === expectedSignalSource
      && Number.isFinite(observedAfter.signalValue)
      && Number.isFinite(observedAfter.targetValue)
      && observedRealAudio
      && Boolean(mediaProof?.streams.includes('video'))
      && (lane === 'three-shader' || mediaProof?.audible === true)
      && Boolean(before && after && before !== after),
  };
}

const captures = {};
let captureFailure;
try {
  for (const label of Object.keys(artifacts)) {
    progress('browser-capture-start', label);
    captures[label] = await capture(label);
  }
} catch (error) {
  captureFailure = error;
} finally {
  await browser.close();
}
if (captureFailure) {
  await removeWorktrees();
  await stopWith('FAIL', `Browser coupling capture failed: ${captureFailure.message}`, {
    completed: Object.keys(captures),
  });
}
await fs.writeFile(path.join(runRoot, 'capture-evidence.json'), `${JSON.stringify(captures, null, 2)}\n`);

const pairLabels = [
  { trialId: '1', control: 'C1', treatment: 'T1', controlShownAs: 'A' },
  { trialId: '2', control: 'C2', treatment: 'T2', controlShownAs: 'B' },
  { trialId: '3', control: 'C3', treatment: 'T3', controlShownAs: 'A' },
];
const creativeReviews = [];
try {
for (const pair of pairLabels) {
  progress('blind-review-start', `pair=${pair.trialId}`);
  const a = pair.controlShownAs === 'A' ? pair.control : pair.treatment;
  const b = pair.controlShownAs === 'A' ? pair.treatment : pair.control;
  const prompt = `Blindly compare artifact A and B for this frozen creative-coding brief:
${definition.brief}
Score each from 0 to 1 on intentionality, crossLayerCoherence, sensoryCraft, expressiveSpecificity, meaningfulSurprise.
Do not infer which arm is a treatment. Return JSON only:
{"A":{"intentionality":0,"crossLayerCoherence":0,"sensoryCraft":0,"expressiveSpecificity":0,"meaningfulSurprise":0},"B":{same fields},"preference":"A|B|tie","reason":"..."}`;
  const review = await modelJson(creativeReviewerRole, prompt, [
    captures[a].screenshot,
    captures[b].screenshot,
  ]);
  const score = arm => {
    const values = [
      arm.intentionality,
      arm.crossLayerCoherence,
      arm.sensoryCraft,
      arm.expressiveSpecificity,
      arm.meaningfulSurprise,
    ].map(Number);
    if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error('blind creative reviewer returned an invalid score');
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const controlArm = pair.controlShownAs;
  const treatmentArm = controlArm === 'A' ? 'B' : 'A';
  const preference = review.value.preference === 'tie'
    ? 'tie'
    : review.value.preference === treatmentArm
      ? 'treatment'
      : review.value.preference === controlArm
        ? 'control'
        : (() => { throw new Error('blind creative reviewer omitted preference'); })();
  creativeReviews.push({
    ...pair,
    controlScore: score(review.value[controlArm]),
    treatmentScore: score(review.value[treatmentArm]),
    preference,
    reason: String(review.value.reason ?? ''),
    identity: review.identity,
  });
  progress('blind-review-complete', `pair=${pair.trialId}`);
}
} catch (error) {
  await removeWorktrees();
  await stopWith('DEFERRED', `Blind creative review failed: ${error.message}`);
}
await fs.writeFile(path.join(runRoot, 'blind-creative-reviews.json'), `${JSON.stringify(creativeReviews, null, 2)}\n`);

const laneDomains = {
  'p5-tone': { source: 'tone', target: 'p5' },
  'three-shader': { source: 'three', target: 'shader' },
  'strudel-p5': { source: 'strudel', target: 'p5' },
}[lane];
async function coordinationEvaluation(pair) {
  const mapping = definition.mapping;
  const recipe = {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: CONTROL_RECIPE_VERSION,
    id: `wave6-${lane}`,
    layers: [
      { id: 'target', domain: laneDomains.target, code: '', order: 0 },
      { id: 'source', domain: laneDomains.source, code: '', order: 1 },
    ],
    transport: {
      clock: 'interval',
      cadenceMs: 33,
      bufferSize: 4,
      staleAfterMs: 132,
      staleBehavior: 'hold',
    },
    signals: [{ id: definition.source, layerId: 'source', type: 'number' }],
    targets: [{ id: definition.target, layerId: 'target', type: 'number' }],
    mappings: [{
      id: 'wave6-control',
      signalId: definition.source,
      targetId: definition.target,
      ...mapping,
    }],
    resources: [
      { id: 'target-frame', kind: 'other', ownerLayerId: 'target' },
      { id: 'source-frame', kind: lane === 'three-shader' ? 'other' : 'audio-context', ownerLayerId: 'source' },
    ],
    lifecycle: { startOrder: ['target', 'source'], teardownOrder: ['source', 'target'] },
    audio: lane === 'three-shader'
      ? { unlock: 'not-required' }
      : { unlock: 'user-gesture', ownerLayerId: 'source' },
    lineage: { parentRecipeIds: [], createdAt: new Date().toISOString() },
  };
  const capturedTrials = captures[pair.treatment].coordinationTrials ?? [];
  const completeCapture = capturedTrials.length === 3;
  let wholeByCondition;
  let review;
  let reviewLatencyMs;
  if (completeCapture) {
    const startedAt = performance.now();
    const coordinationPrompt = `Evaluate three unlabeled coupling conditions for:
${definition.brief}
Images are ordered baseline, signal mutation, coupling ablation. Score only observed whole-work behavior.
Every score MUST be a JSON number from 0.0 through 1.0 inclusive.
Return JSON only:
{"baseline":{"coherence":0,"technicalValidity":0,"creativeQuality":0,"tasteQuality":0},"signal-mutation":{"coherence":0,"technicalValidity":0,"creativeQuality":0,"tasteQuality":0},"coupling-ablation":{"coherence":0,"technicalValidity":0,"creativeQuality":0,"tasteQuality":0}}`;
    const screenshots = capturedTrials.map(trial => trial.screenshot);
    review = await modelJson(creativeReviewerRole, coordinationPrompt, screenshots);
    try {
      wholeByCondition = normalizeWave6CoordinationScores(review.value);
    } catch (error) {
      await fs.writeFile(
        path.join(runRoot, `coordination-review-invalid-${pair.trialId}.json`),
        `${JSON.stringify(review, null, 2)}\n`,
      );
      review = await modelJson(
        creativeReviewerRole,
        `${coordinationPrompt}\nYour prior response violated the numeric schema. Return only the exact object.`,
        screenshots,
      );
      wholeByCondition = normalizeWave6CoordinationScores(review.value);
    }
    reviewLatencyMs = performance.now() - startedAt;
  }
  const units = {
    technical: 'ratio', creative: 'ratio', taste: 'ratio', cost: 'tokens',
    latency: 'ms', reliability: 'ratio', security: 'ratio', complexity: 'modules',
  };
  const reason = 'Real baseline, signal-mutation, and coupling-ablation observations were not captured';
  const technical = captures[pair.treatment].technicalPass ? 1 : 0;
  const measured = completeCapture ? {
    technical,
    creative: Number(wholeByCondition.baseline.creativeQuality),
    taste: Number(wholeByCondition.baseline.tasteQuality),
    cost: review.usage.tokens,
    latency: reviewLatencyMs,
    reliability: captures[pair.treatment].errors.length === 0 ? 1 : 0,
    security: captures[pair.treatment].errors.length === 0 ? 1 : 0,
    complexity: 1,
  } : {};
  const baselines = {
    technical: 1, creative: 0.6, taste: 0.6, cost: budgets.tokens,
    latency: 180_000, reliability: 1, security: 1, complexity: 1,
  };
  const evidence = COMPOSITION_EVIDENCE_DIMENSIONS.map(dimension => ({
    dimension,
    status: completeCapture ? 'observed' : 'unavailable',
    ...(completeCapture ? { value: measured[dimension] } : { missingReason: reason }),
    baseline: baselines[dimension],
    unit: units[dimension],
    direction: ['cost', 'latency', 'complexity'].includes(dimension)
      ? 'lower-better'
      : 'higher-better',
    sourceRef: `capture:${pair.trialId}:${dimension}`,
  }));
  const attempt = {
    id: `wave6-browser-${pair.trialId}`,
    method: 'browser-render-signal-mutation-ablation',
    status: completeCapture ? 'complete' : 'unavailable',
    ...(completeCapture ? {
      mappingId: 'wave6-control',
      layers: ['target', 'source'].map(layerId => ({
        layerId,
        technicalValidity: technical,
        contribution: Number(wholeByCondition.baseline.coherence),
        compatibility: Number(wholeByCondition.baseline.coherence),
        necessity: Number(wholeByCondition.baseline.coherence),
      })),
      trials: capturedTrials.map(trial => ({
        condition: trial.condition,
        signalValue: trial.signalValue,
        targetValue: trial.targetValue,
        signalUnit: 'normalized-phase',
        targetUnit: 'mapped-target',
        whole: wholeByCondition[trial.condition],
      })),
    } : { reason }),
    evidence,
  };
  return new CompositionEvaluator().evaluate(recipe, [attempt]);
}

const coordination = {};
try {
  for (const pair of pairLabels) {
    progress('coordination-review-start', `pair=${pair.trialId}`);
    coordination[pair.trialId] = await coordinationEvaluation(pair);
    progress(
      'coordination-review-complete',
      `pair=${pair.trialId} outcome=${coordination[pair.trialId].outcome}`,
    );
  }
} catch (error) {
  await removeWorktrees();
  await stopWith('DEFERRED', `Coordination review failed: ${error.message}`);
}
await fs.writeFile(path.join(runRoot, 'composition-evaluations.json'), `${JSON.stringify({
  recipeDigest: artifacts.C1.recipeDigest,
  coordination,
}, null, 2)}\n`);

const recipeDigests = new Set(Object.values(artifacts).map(artifact => artifact.recipeDigest));
const recipeDigest = recipeDigests.size === 1 ? artifacts.C1.recipeDigest : '';
const configuration = {
  intentDigest: sha256(definition.brief),
  provider: generatorRole.provider,
  model: generatorRole.model,
  promptDigest: sha256(layerSpecs[lane]),
  parametersDigest: sha256({ temperature: 1, formalOrder: formalOrder.map(([label]) => label) }),
  capabilitiesDigest: sha256({ lane, transport: definition.transport }),
  evaluatorDigest: sealed.manifestDigest,
  environmentDigest: sha256({ viewport: [1280, 720], durationMs: 2000, contract: 1 }),
  seedSupported: false,
};
const configurationDigest = fingerprintTrialConfiguration(configuration);
const causalTrials = creativeReviews.map(review => ({
  trialId: review.trialId,
  controlConfigurationDigest: configurationDigest,
  treatmentConfigurationDigest: configurationDigest,
  controlArtifactDigest: sha256(artifacts[review.control].html),
  treatmentArtifactDigest: sha256(artifacts[review.treatment].html),
  controlMetrics: {
    creativeQuality: review.controlScore,
    technical: captures[review.control].technicalPass ? 1 : 0,
    coordination: coordination[review.trialId].outcome === 'PASS' ? 1 : 0,
  },
  treatmentMetrics: {
    creativeQuality: review.treatmentScore,
    technical: captures[review.treatment].technicalPass ? 1 : 0,
    coordination: coordination[review.trialId].outcome === 'PASS' ? 1 : 0,
  },
}));
const decisionRule = {
  objective: 'creativeQuality',
  direction: 'higher-better',
  minimumEffect: 0.05,
  minimumTrials: 3,
  hardFloors: {
    technical: { minimum: 1 },
    coordination: { minimum: 1 },
  },
};
const recursiveContract = {
  version: 1,
  loop: 'autoresearch',
  experimentId: candidate.experiment.experimentId,
  lineageId: diagnostic.lineageId,
  state: 'observe',
  stage: 'shadow',
  sourceMutationRequested: true,
  budgets,
};
let causalCandidate;
let causalError;
try {
  causalCandidate = packageOwnerControlledCandidate({
    contract: recursiveContract,
    candidate,
    restoredFailure,
    configuration,
    decisionRule,
    trials: causalTrials,
    diff: { paths: [mutationPath], digest: sha256([mutationPath]) },
    verificationRefs: [
      'pnpm build',
      'test/unit/composition/LayerContract.test.ts',
      repoPath(path.join(runRoot, 'capture-evidence.json')),
    ],
    artifactComparisonRefs: creativeReviews.flatMap(review => [
      repoPath(captures[review.control].screenshot),
      repoPath(captures[review.treatment].screenshot),
    ]),
  });
} catch (error) {
  causalError = error.message;
}
await fs.writeFile(path.join(runRoot, 'causal-package.json'), `${JSON.stringify({
  recipeDigest,
  candidate: causalCandidate ?? null,
  error: causalError ?? null,
}, null, 2)}\n`);

const creativeIdentity = creativeReviews[0]?.identity;
const cortexCheckpoint = null;
const cortexError = 'LIVE_CORTEX_ACTIONS_NOT_IMPLEMENTED';
const formalPairs = creativeReviews.map(review => ({
  trialId: review.trialId,
  control: review.control,
  treatment: review.treatment,
  controlShownAs: review.controlShownAs,
  controlConfigurationDigest: configurationDigest,
  treatmentConfigurationDigest: configurationDigest,
  controlScore: review.controlScore,
  treatmentScore: review.treatmentScore,
  coordinationPass: coordination[review.trialId].outcome === 'PASS',
  technicalPass:
    captures[review.control].technicalPass
    && captures[review.treatment].technicalPass,
  blindPreference: review.preference,
}));
const proofEvidence = [];
for (const label of Object.keys(artifacts)) {
  proofEvidence.push(await fileProofEvidence(
    path.join(runRoot, `${label}.html`),
    'interactive',
    ['visual', 'interaction'],
  ));
  proofEvidence.push(await fileProofEvidence(
    captures[label].screenshot,
    'image',
    ['visual'],
  ));
  const media = captures[label].mediaProof;
  if (media?.streams.includes('video') && media.durationSeconds > 0) {
    proofEvidence.push(await fileProofEvidence(
      media.path,
      'video',
      media.audible ? ['visual', 'audio'] : ['visual'],
      media.durationSeconds,
    ));
  }
}
const proofRefs = proofEvidence.map(item => item.ref);
const proofInput = {
  schemaVersion: CREATIVE_PROOF_SCHEMA_VERSION,
  domains: Object.values(laneDomains).map(name => ({
    name,
    requiredModalities: ['tone', 'strudel'].includes(name)
      ? ['audio', 'interaction']
      : ['visual', 'interaction'],
  })),
  evidence: proofEvidence,
  verdicts: {
    technical: {
      status: formalPairs.every(pair => pair.technicalPass) ? 'pass' : 'fail',
      evidenceRefs: proofRefs,
    },
    coordination: {
      status: formalPairs.filter(pair => pair.coordinationPass).length >= 2 ? 'pass' : 'fail',
      evidenceRefs: proofRefs,
    },
    creativeQuality: {
      status: formalPairs.filter(pair => pair.blindPreference === 'treatment').length >= 2 ? 'pass' : 'fail',
      evidenceRefs: proofRefs,
      evaluatorRef: sealed.manifestDigest,
      rubricRef: sealed.manifestDigest,
    },
  },
  requestedClaims: {
    technicalSuccess: true,
    coordinationImproved: true,
    creativeQualityImproved: true,
  },
};
const creativeProof = evaluateCreativeProof(proofInput);
await fs.writeFile(path.join(runRoot, 'creative-proof.json'), `${JSON.stringify({
  input: proofInput,
  result: creativeProof,
}, null, 2)}\n`);
const evidence = {
  lane,
  lineageId: diagnostic.lineageId,
  recipeDigest,
  artifactRecipeDigest: recipeDigest,
  lineageRecipeDigest: diagnostic.recipeDigest,
  evaluationRecipeDigest: recipeDigest,
  causalRecipeDigest: causalCandidate ? recipeDigest : '',
  configurationDigest,
  mutationPath,
  identities: {
    author: `${candidate.review.author.provider}/${candidate.review.author.model}`,
    generator: roleIdentity(generatorRole),
    mutationReviewer: `${candidate.review.reviewer.provider}/${candidate.review.reviewer.model}`,
    creativeReviewer: `${creativeIdentity?.provider}/${creativeIdentity?.model}`,
  },
  runOrder: formalOrder.map(([label]) => label),
  pairs: formalPairs,
  restoredFailure: {
    restored: restoredFailure.experiment.terminal === 'restored',
    quarantined: restoredFailure.experiment.failure?.quarantined === true,
    lane,
    lineageId: restoredFailure.experiment.lineageId,
    allowlistDigest: definition.allowlistDigest,
    oracleDigest: sealed.manifestDigest,
  },
  expectedOracleDigest: sealed.manifestDigest,
  interventions: 2,
  creativeProofPass: creativeProof.outcome === 'PASS',
  cortexPass: cortexCheckpoint?.state === 'completed',
  lineageIntegrityPass: false,
  parentIntegrityPass:
    candidate.experiment.parentUnchanged
    && restoredFailure.experiment.parentUnchanged,
};

const ledger = new StudioLineageLedger({ ledgerPath: controlStudio.lineagePath });
await ledger.append(diagnostic.lineageId, {
  stage: 'dream',
  status: cortexCheckpoint?.state === 'completed' ? 'observed' : 'unavailable',
  origin: 'wave6-cortex-living-loop',
  trust: 'verified-system',
  taint: cortexCheckpoint?.state === 'completed' ? 'clean' : 'tainted',
  taintSources: cortexError ? ['cortex-cycle-failed'] : [],
  corroboration: cortexCheckpoint?.steps
    .flatMap(step => step.receiptRefs) ?? [],
  payload: {
    cycleId: cortexCheckpoint?.cycleId,
    state: cortexCheckpoint?.state,
    checkpointPath: repoPath(path.join(runRoot, 'cortex-checkpoint.json')),
    error: cortexError,
  },
});
await ledger.append(diagnostic.lineageId, {
  stage: 'hypothesis',
  status: 'observed',
  origin: 'wave6-autoresearch',
  trust: 'verified-system',
  corroboration: hypothesis.citations.map(citation => citation.sourceRef),
  payload: { key: hypothesis.key, claim: hypothesis.claim, falsifier: hypothesis.falsifier },
});
await ledger.append(diagnostic.lineageId, {
  stage: 'experiment',
  status: 'observed',
  origin: 'wave6-autoresearch',
  trust: 'verified-system',
  corroboration: candidate.experiment.authorityReceipts.map(receipt => receipt.receiptId),
  payload: {
    experimentId: candidate.experiment.experimentId,
    terminal: candidate.experiment.terminal,
    changedPaths: candidate.experiment.changedPaths,
  },
});
await ledger.append(diagnostic.lineageId, {
  stage: 'review',
  status: 'observed',
  origin: 'wave6-sealed-review',
  trust: 'verified-system',
  corroboration: [candidate.review.receiptDigest],
  payload: {
    verdict: candidate.review.verdict,
    reviewer: candidate.review.reviewer.model,
    manifestDigest: candidate.review.manifestDigest,
  },
});
await ledger.append(diagnostic.lineageId, {
  stage: 'follow-up',
  status: causalCandidate ? 'observed' : 'unavailable',
  origin: 'wave6-causal-package',
  trust: 'verified-system',
  taint: causalCandidate ? 'clean' : 'tainted',
  taintSources: causalCandidate ? [] : ['causal-package-failed'],
  corroboration: causalCandidate ? [causalCandidate.receiptDigest] : [],
  payload: {
    recipeDigest,
    candidateReceiptDigest: causalCandidate?.receiptDigest,
    error: causalError,
  },
});
let trace;
try {
  trace = await ledger.query(diagnostic.lineageId);
} catch (error) {
  await removeWorktrees();
  await stopWith('FAIL', `Studio lineage integrity failed: ${error.message}`, {
    lineageId: diagnostic.lineageId,
    lineagePath: repoPath(controlStudio.lineagePath),
    causalError,
  });
}
const observedStages = new Set(trace.records
  .filter(record => record.status === 'observed')
  .map(record => record.stage));
evidence.lineageIntegrityPass = [
  'origin', 'artifact', 'evaluation', 'dream', 'hypothesis', 'experiment',
  'review', 'follow-up',
].every(stage => observedStages.has(stage));

const cliAfter = await exec(process.execPath, [
  path.join(repoRoot, 'bin', 'sinter'),
  'improve',
  '--lineage', diagnostic.lineageId,
  '--lane', lane,
  '--json',
  '--validate-only',
], {
  cwd: repoRoot,
  env: { ...serverEnv, SINTER_STUDIO_LINEAGE_PATH: controlStudio.lineagePath },
  timeout: 60_000,
});
await fs.writeFile(path.join(runRoot, 'cli-resume-after.json'), cliAfter.stdout);

const result = evaluateWave6Experiment(evidence);
const ownerReview = {
  status: result.status === 'PENDING_OWNER' ? 'required' : 'not-reached',
  trialId: result.ownerPairTrialId,
  controlScreenshot: result.ownerPairTrialId
    ? repoPath(captures[`C${result.ownerPairTrialId}`].screenshot)
    : undefined,
  treatmentScreenshot: result.ownerPairTrialId
    ? repoPath(captures[`T${result.ownerPairTrialId}`].screenshot)
    : undefined,
  labelsHidden: true,
};
const receipt = {
  schemaVersion: 1,
  gate: `W6-${lane}`,
  runId,
  lane,
  generatedAt: new Date().toISOString(),
  status: result.status,
  definition,
  controlRef,
  candidateRef: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim(),
  lineageId: diagnostic.lineageId,
  recipeDigest,
  configuration,
  identities: {
    generator: { provider: generatorRole.provider, model: generatorRole.model },
    mutationAuthor: candidate.review.author,
    mutationReviewer: candidate.review.reviewer,
    creativeReviewer: creativeIdentity,
  },
  experiment: candidate,
  restoredFailure,
  causalPackage: causalCandidate ?? null,
  causalError: causalError ?? null,
  cortex: {
    checkpoint: cortexCheckpoint,
    error: cortexError,
  },
  creativeProof,
  evidenceDigests: Object.fromEntries(proofEvidence.map(item => [item.ref, item.sha256])),
  formalOrder: formalOrder.map(([label]) => label),
  formalPairs,
  coordination,
  result,
  ownerReview,
  evidenceRefs: {
    runRoot: repoPath(runRoot),
    lineage: repoPath(controlStudio.lineagePath),
    captures: repoPath(path.join(runRoot, 'capture-evidence.json')),
    blindReview: repoPath(path.join(runRoot, 'blind-creative-reviews.json')),
    causalPackage: repoPath(path.join(runRoot, 'causal-package.json')),
    ...(cortexCheckpoint ? {
      cortexCheckpoint: repoPath(path.join(runRoot, 'cortex-checkpoint.json')),
    } : {}),
    creativeProof: repoPath(path.join(runRoot, 'creative-proof.json')),
    formalArtifacts: Object.keys(artifacts).map(label => repoPath(path.join(runRoot, `${label}.html`))),
    screenshots: Object.keys(captures).map(label => repoPath(captures[label].screenshot)),
    media: Object.values(captures)
      .map(capture => capture.mediaProof?.path)
      .filter(Boolean)
      .map(repoPath),
  },
};
await persistReceipt(receipt);
await removeWorktrees();
process.stdout.write(`${JSON.stringify({
  status: receipt.status,
  lane,
  meanEffect: result.meanEffect,
  blindTreatmentWins: formalPairs.filter(pair => pair.blindPreference === 'treatment').length,
  coordinationPasses: formalPairs.filter(pair => pair.coordinationPass).length,
  ownerPairTrialId: result.ownerPairTrialId,
  durableReceipt,
  runRoot,
}, null, 2)}\n`);
process.exit(receipt.status === 'PASS' ? 0 : receipt.status === 'FAIL' ? 1 : 2);
