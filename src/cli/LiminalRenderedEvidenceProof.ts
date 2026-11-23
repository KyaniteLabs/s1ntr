/**
 * FIXTURE PROOF (Sol L3-18): fixed non-PNG buffers and a fake judge. It proves the receipt wiring only; it is
 * not evidence that real rendering, perception or judging work. Real coverage: test/integration/create-render-judge-admission.test.ts.
 */
import path from 'node:path';
import {
  LiminalCommandService,
  createTestReceiptAuthority,
  type LiminalCommandEffects,
  type LiminalCommandResult,
  type LiminalCreativeCommand,
  type RenderedObservation,
} from '../runtime-core/LiminalCommandService.js';
import {
  FileLiminalArtifactStore,
  FileLiminalOperationJournal,
} from '../runtime-core/LiminalCommandFilePersistence.js';
import { runLiminalCommandJourney } from './LiminalCommandCli.js';

export interface RenderedEvidenceProofResult {
  readonly command: LiminalCreativeCommand;
  readonly result: LiminalCommandResult;
  readonly externalCalls: {
    readonly network: 0;
    readonly browser: 0;
    readonly provider: 0;
    readonly metered: 0;
  };
}

const PROOF_COMMAND: LiminalCreativeCommand = Object.freeze({
  schema: 'sinter.liminal-command',
  schemaVersion: 1,
  kind: 'generate-candidate',
  idempotencyKey: 'wave8-rendered-evidence-zero-call-proof-v1',
  prompt: 'Deterministic fake temporal composition for rendered-evidence proof',
  domain: 'p5',
  layers: ['temporal-field'],
  canonicalMainSha: '0'.repeat(40),
  authorityPackageDigest: '0'.repeat(64),
  maxTransportAttempts: 2,
  evalMode: 'strict-browser',
  safeMode: 'c0-no-empirical-teaching',
  rendererIdentity: 'fake-renderer/v1',
  renderAuthorization: 'test-fake',
  roles: { generator: 'fake/generator', evaluator: 'fake/evaluator',
    harness: 'fake/harness', studio: 'fake/studio' },
});

function fakeRenderedObservation(): RenderedObservation {
  return {
    status: 'rendered',
    rendererIdentity: PROOF_COMMAND.rendererIdentity,
    earlyFrame: Buffer.from('liminal-fake-early-frame-v1'),
    lateFrame: Buffer.from('liminal-fake-late-frame-v1'),
    runtimeErrors: [],
    timingMs: 3_000,
    containment: { networkIsolated: true, permissionsDenied: true, cleanupSucceeded: true },
    audio: { relevant: false, state: 'not-applicable' },
  };
}

/** Execute the official zero-external-call proof through one public Liminal command. */
export async function runRenderedEvidenceProof(root: string): Promise<RenderedEvidenceProofResult> {
  const effects: LiminalCommandEffects = {
    generate: async input => {
      await input.startTransport({ fake: true });
      return {
      source: 'function setup(){createCanvas(64,64)} function draw(){background(0)}',
      playable: '<!doctype html><html><body><canvas width="64" height="64"></canvas></body></html>',
      provenance: JSON.stringify({ source: 'deterministic-fake', externalCalls: 0 }),
      };
    },
    render: () => Promise.resolve(fakeRenderedObservation()),
    evaluate: async input => {
      await input.startTransport({ fake: true });
      return {
      score: 0.75,
      degraded: false,
      identityValid: input.identity === PROOF_COMMAND.roles.evaluator,
      evaluatorIdentity: input.identity,
      evidenceDigest: input.evidenceDigest,
      };
    },
  };
  const service = new LiminalCommandService({
    effects,
    artifacts: new FileLiminalArtifactStore(path.join(root, 'artifacts')),
    journal: new FileLiminalOperationJournal(path.join(root, 'operation-journal.json')),
    authority: createTestReceiptAuthority('wave8-diagnostic-test-key'),
  });
  const result = await runLiminalCommandJourney(service, PROOF_COMMAND);
  return Object.freeze({ command: PROOF_COMMAND, result,
    externalCalls: Object.freeze({ network: 0, browser: 0, provider: 0, metered: 0 }) });
}
