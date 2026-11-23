import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { bootstrapProductionReceiptAuthority, LiminalCommandService }
  from '../../src/runtime-core/LiminalCommandService.js';
import { bootstrapProductionLiminalOwnerReviewAuthority }
  from '../../src/runtime-core/LiminalOwnerReviewAuthority.js';
import { FileLiminalArtifactStore, FileLiminalOperationJournal }
  from '../../src/runtime-core/LiminalCommandFilePersistence.js';
import { FileLiminalProductCommandStore, LiminalProductCommandPort }
  from '../../src/runtime-core/LiminalProductCommandPort.js';

export async function signedOwnerLike(input: {
  home: string; scan: string; id: string; source: string; score: number; stateRoot?: string;
}) {
  const root = path.join(input.scan, 'seatX', input.id);
  const stateRoot = input.stateRoot ?? root;
  await mkdir(root, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = input.home;
  try {
    const key = path.join(input.home, '.sinter', 'authority', 'liminal-command-receipt.key');
    const authority = await bootstrapProductionReceiptAuthority(key);
    const rendererIdentity = 'fake/renderer';
    const service = new LiminalCommandService({
      authority,
      artifacts: new FileLiminalArtifactStore(path.join(root, 'artifacts')),
      journal: new FileLiminalOperationJournal(path.join(stateRoot, 'operation-journal.json')),
      effects: {
        generate: async ({ startTransport }) => {
          await startTransport();
          return { source: input.source, playable: '<html></html>', provenance: 'fixture' };
        },
        render: async () => ({ status: 'rendered', rendererIdentity,
          earlyFrame: Buffer.from('early'), lateFrame: Buffer.from('late'), runtimeErrors: [],
          audio: { relevant: false, state: 'not-applicable' } }),
        evaluate: async ({ identity, evidenceDigest }) =>
          ({ score: input.score, degraded: false, identityValid: true, evaluatorIdentity: identity, evidenceDigest }),
      },
    });
    const port = new LiminalProductCommandPort(service, await bootstrapProductionLiminalOwnerReviewAuthority(key),
      new FileLiminalProductCommandStore(path.join(stateRoot, 'product-projections.json')));
    const createKey = 'fixture-create-' + input.id;
    const create = await port.submitCreate('cli', {
      schema: 'sinter.liminal-command', schemaVersion: 1, kind: 'generate-candidate', idempotencyKey: createKey,
      prompt: 'Test artwork ' + input.id, domain: 'p5', layers: ['visual'], canonicalMainSha: 'a'.repeat(40),
      authorityPackageDigest: 'b'.repeat(64), maxTransportAttempts: 2, evalMode: 'strict-browser',
      safeMode: 'c0-no-empirical-teaching', rendererIdentity, renderAuthorization: 'test-fake',
      roles: { generator: 'fake/gen', evaluator: 'fake/judge', harness: 'fake/harness', studio: 'fake/studio' },
    });
    if (create.kind !== 'create' || !create.result.evidence.evidenceDigest) throw new Error('expected Create');
    const ownerReviewKey = 'fixture-review-' + input.id;
    const artifactDigest = create.result.receipt.artifactDigest;
    await port.submitOwnerReview('studio', { schema: 'sinter.liminal-owner-review-command', schemaVersion: 1,
      idempotencyKey: ownerReviewKey, createIdempotencyKey: createKey, operationId: create.result.operationId,
      artifactRootDigest: artifactDigest, evidenceRootDigest: create.result.evidence.evidenceDigest,
      decision: 'accepted', feedback: 'Accepted test artwork', criterionDigest: 'c'.repeat(64) });
    return { seat: 'seatX', id: input.id, liked: true, at: '2026-11-18T10:00:00Z',
      createKey, ownerReviewKey, artifactDigest };
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}
