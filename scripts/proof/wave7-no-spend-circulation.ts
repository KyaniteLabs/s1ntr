import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  CortexLivingLoopConductor,
  FileCortexCycleStore,
  type LivingLoopExecutionContext,
  type LivingLoopExecutionResult,
  type LivingLoopStep,
  type LivingLoopStepExecutor,
} from '../../src/cortex/CortexLivingLoop.js';
import {
  StudioLivingLoopExecutor,
  CanonicalStudioLivingLoopProviderBoundary,
} from '../../src/cortex/StudioLivingLoopExecutor.js';
import { DreamQueue } from '../../src/dreaming/DreamQueue.js';
import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';
import { StudioLineageLedger } from '../../src/tui-bridge/StudioLineage.js';
import { computeProofSourceFingerprint } from '../../src/runtime-core/ProofReceiptValidator.js';
import { createPreExistingQueueManifest, validateQueueDispositions } from '../../src/runtime-core/Wave7ReleaseContract.js';

const stages: LivingLoopStep[] = [
  'create-evidence', 'consolidate', 'dream', 'autoresearch',
  'review', 'assimilate', 'candidate-request', 'follow-up-create',
];

class CrashAfterPersist implements LivingLoopStepExecutor {
  private crashed = false;
  constructor(private readonly inner: LivingLoopStepExecutor, private readonly step: LivingLoopStep) {}
  async execute(context: LivingLoopExecutionContext): Promise<LivingLoopExecutionResult | null> {
    const result = await this.inner.execute(context);
    if (!this.crashed && context.step === this.step) {
      this.crashed = true;
      throw new Error('INJECTED_PROCESS_RESTART_AFTER_PERSIST');
    }
    return result;
  }
  recover(context: LivingLoopExecutionContext): Promise<LivingLoopExecutionResult | null> {
    return this.inner.recover(context);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function outputPath(): string {
  const flag = process.argv.indexOf('--output');
  if (flag >= 0 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1]);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve('.quality', 'wave-7', 'no-spend-circulation', stamp, 'receipt.json');
}

function request(sourceFingerprint: string, cycleId = 'wave7-no-spend-cycle', lineageId = 'wave7-no-spend-lineage') {
  return {
    cycleId,
    lineageId,
    sourceFingerprint,
    autonomyLevel: 'co-create' as const,
    prerequisites: {
      dreamReceiptDigest: 'a'.repeat(64),
      causalReceiptDigest: 'b'.repeat(64),
      domainReceiptDigest: 'c'.repeat(64),
      assimilationReceiptDigest: 'd'.repeat(64),
    },
    budgets: {
      maxActions: 8, maxTokens: 700, maxCostUsd: 1, maxWallClockMs: 10_000,
    },
    concurrencyLimit: 1,
    leaseTtlMs: 1_000,
  };
}

async function seedLineage(ledger: StudioLineageLedger, sourceFingerprint: string, lineageId = 'wave7-no-spend-lineage'): Promise<void> {
  await ledger.start({
    lineageId, sessionId: 'studio-proof', origin: 'studio',
  });
  await ledger.append(lineageId, {
    stage: 'artifact', status: 'observed', origin: 'studio-create',
    trust: 'verified-system', corroboration: ['fixture:initial-artifact'],
    payload: { codeDigest: 'f'.repeat(64) },
  });
  await ledger.append(lineageId, {
    stage: 'reaction', status: 'observed', origin: 'studio-owner-reaction-fixture',
    trust: 'owner', corroboration: ['fixture:initial-artifact'],
    payload: { artifactDigest: 'f'.repeat(64), lineageId, sourceFingerprint, reactionDigest: '9'.repeat(64) },
  });
  await ledger.append(lineageId, {
    stage: 'hypothesis', status: 'observed', origin: 'studio-consolidate-fixture',
    trust: 'verified-system', corroboration: ['9'.repeat(64)],
    payload: { reactionDigest: '9'.repeat(64) },
  });
}

async function main(): Promise<void> {
  // Deterministic proof harness: match vitest so TuiBridgeService allows living-loop
  // construction without a full product command port (production still requires the port).
  const previousNodeEnv = process.env.NODE_ENV;
  if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test';
  const head = (await simpleGit().revparse(['HEAD'])).trim();
  const planHash = sha256(await readFile(
    path.resolve('docs/plans/prd-wave-7-organism-release-convergence.md'), 'utf8',
  ));
  const sourceFingerprint = (
    computeProofSourceFingerprint(process.cwd())?.replace(/^sha256:/, '') ?? sha256(head)
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'wave7-no-spend-'));
  const previousProjectRoot = process.env.SINTER_PROJECT_ROOT;
  process.env.SINTER_PROJECT_ROOT = root;
  let service: TuiBridgeService | undefined;
  try {
    const ledger = new StudioLineageLedger({ ledgerPath: path.join(root, 'lineage.jsonl') });
    await seedLineage(ledger, sourceFingerprint);
    const queue = new DreamQueue({ persistPath: path.join(root, 'dream-queue.json') });
    const firstDreamId = queue.enqueue('elite-x-compost', [{
      id: 'fixture:initial-artifact', descriptor: [0.5], quality: 0.8,
    }], 0.8);
    const preExistingQueue = createPreExistingQueueManifest(queue.getTasks());
    const boundary = new CanonicalStudioLivingLoopProviderBoundary('deterministic-no-spend');
    let now = Date.now();
    const cycleStore = new FileCortexCycleStore(path.join(root, 'cycles'));
    const conductor = new CortexLivingLoopConductor(
      cycleStore, () => now,
    );
    service = new TuiBridgeService({ livingLoopConductor: conductor });
    const session = service.createSession();
    const executor = new StudioLivingLoopExecutor({
      cycleId: 'wave7-no-spend-cycle', lineageId: 'wave7-no-spend-lineage',
      sourceFingerprint, receiptRoot: path.join(root, 'receipts'),
      evidenceClass: 'deterministic-proof', boundary, dreamQueue: queue,
      lineageLedger: ledger,
    });
    const checkpoint = await service.conductLivingLoop(
      session.sessionId, request(sourceFingerprint), 'studio-owner-fixture', executor,
    );
    const firstEvents = service.getEvents(session.sessionId)
      .filter(event => event.type === 'cortex.action_lifecycle');
    const secondCycleId = 'wave7-no-spend-recovery-cycle';
    const secondLineageId = 'wave7-no-spend-recovery-lineage';
    await seedLineage(ledger, sourceFingerprint, secondLineageId);
    const secondDreamId = queue.enqueue('elite-x-compost', [{
      id: 'fixture:restart-artifact', descriptor: [0.6], quality: 0.82,
    }], 0.82);
    const recoveryBoundary = new CanonicalStudioLivingLoopProviderBoundary('deterministic-no-spend');
    const recoveryRoot = path.join(root, 'recovery-receipts');
    const recoveryExecutor = new StudioLivingLoopExecutor({
      cycleId: secondCycleId, lineageId: secondLineageId, sourceFingerprint,
      receiptRoot: recoveryRoot, evidenceClass: 'deterministic-proof',
      boundary: recoveryBoundary, dreamQueue: queue, lineageLedger: ledger,
    });
    await service.conductLivingLoop(
      session.sessionId, request(sourceFingerprint, secondCycleId, secondLineageId),
      'studio-owner-before-restart', new CrashAfterPersist(recoveryExecutor, 'autoresearch'),
    ).then(() => { throw new Error('INJECTED_RESTART_DID_NOT_INTERRUPT'); }, error => {
      if (!String(error).includes('INJECTED_PROCESS_RESTART_AFTER_PERSIST')) throw error;
    });
    const interrupted = await cycleStore.read(secondCycleId);
    service.destroy();
    service = undefined;
    now += 1_001;
    const resumedConductor = new CortexLivingLoopConductor(cycleStore, () => now);
    service = new TuiBridgeService({ livingLoopConductor: resumedConductor });
    const resumedSession = service.createSession();
    const resumedExecutor = new StudioLivingLoopExecutor({
      cycleId: secondCycleId, lineageId: secondLineageId, sourceFingerprint,
      receiptRoot: recoveryRoot, evidenceClass: 'deterministic-proof',
      boundary: recoveryBoundary, dreamQueue: queue, lineageLedger: ledger,
    });
    const recovered = await service.conductLivingLoop(
      resumedSession.sessionId, request(sourceFingerprint, secondCycleId, secondLineageId),
      'studio-owner-after-restart', resumedExecutor,
    );
    const events = firstEvents;
    const lineage = await ledger.query('wave7-no-spend-lineage');
    const recoveryLineage = await ledger.query(secondLineageId);
    const queueDispositions = validateQueueDispositions(
      preExistingQueue,
      preExistingQueue.items.map(item => ({ taskId: item.id, disposition: 'completed' as const })),
    );
    const allEffects = [...checkpoint.steps, ...recovered.steps]
      .flatMap(step => step.effects.map(effect => effect.id));
    const queueStatus = queue.getStatus();
    const checks = {
      checkpointCompleted: checkpoint.state === 'completed',
      exactProviderManifest: JSON.stringify(boundary.calls.map(call => call.step))
        === JSON.stringify(stages),
      lifecycleEventsComplete: events.length === stages.length * 3,
      dreamQueueCompleted: Boolean(firstDreamId && secondDreamId)
        && queueStatus.completed === 1
        && queue.getTasks('completed')[0]?.id === secondDreamId,
      queueTerminalCounts: queueStatus,
      followUpCreateObserved: lineage.records.some(record =>
        record.stage === 'follow-up' && record.status === 'observed'),
      zeroTransport: Object.values(boundary.transportSentinel).every(value => value === 0),
      interruptedAfterPersist: interrupted?.steps.find(step => step.step === 'autoresearch')?.status === 'running',
      recoveredSecondCycle: recovered.state === 'completed',
      recoveryProviderManifest: JSON.stringify(recoveryBoundary.calls.map(call => call.step)) === JSON.stringify(stages),
      noDuplicateEffects: new Set(allEffects).size === allEffects.length,
      queueDispositionsComplete: queueDispositions.passed,
      recoveryFollowUpObserved: recoveryLineage.records.some(record => record.stage === 'follow-up' && record.status === 'observed'),
      zeroRecoveryTransport: Object.values(recoveryBoundary.transportSentinel).every(value => value === 0),
    };
    if (!Object.values(checks).every(Boolean)) {
      throw new Error(`WAVE7_NO_SPEND_PROOF_FAILED:${JSON.stringify(checks)}`);
    }
    const receipt = {
      schemaVersion: 1,
      gate: 'noSpendCirculationProof',
      passed: true,
      planHash,
      artifactDigest: sha256(JSON.stringify(checks)),
      evidenceClass: 'deterministic-proof',
      noSpendCirculationProof: true,
      livePass: false,
      generatedAt: new Date().toISOString(),
      head,
      sourceFingerprint,
      providerManifest: stages,
      providerCalls: boundary.calls,
      transportSentinel: boundary.transportSentinel,
      recovery: {
        interrupted,
        recovered,
        providerCalls: recoveryBoundary.calls,
        transportSentinel: recoveryBoundary.transportSentinel,
      },
      checks,
      checkpoint,
      queue: queue.getStatus(),
      preExistingQueue,
      queueDispositions,
      lineageRecordDigests: lineage.records.map(record => record.digest),
      recoveryLineageRecordDigests: recoveryLineage.records.map(record => record.digest),
    };
    const target = outputPath();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${target}\n`);
  } finally {
    service?.destroy();
    if (previousProjectRoot === undefined) delete process.env.SINTER_PROJECT_ROOT;
    else process.env.SINTER_PROJECT_ROOT = previousProjectRoot;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(root, { recursive: true, force: true });
  }
}

await main();
