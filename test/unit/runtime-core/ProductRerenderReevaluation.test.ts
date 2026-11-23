import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileLiminalArtifactStore, FileLiminalOperationJournal,
} from '../../../src/runtime-core/LiminalCommandFilePersistence.js';
import {
  LiminalCommandService, createTestReceiptAuthority, type LiminalCommandResult,
} from '../../../src/runtime-core/LiminalCommandService.js';
import { commandFactory } from '../../../src/runtime-core/ProductionLiminalRuntime.js';
import {
  createRerenderGrantVerifier, parseRerenderGrant, rerenderReevaluateProductRun,
} from '../../../src/runtime-core/ProductRerenderReevaluation.js';
import type { RenderedObservation } from '../../../src/runtime-core/LiminalCommandService.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const PROMPT = 'a slow orrery with seven moons';
const identities = { generator: 'cli/gen', evaluator: 'glm/judge', harness: 'cfg/h',
  studio: 'cfg/s', renderer: 'fake-renderer/v1' };
const sourceRefs = { sourceHeadSha: HEAD, canonicalMainSha: MAIN, sourceKind: 'git-origin-main' as const,
  sourceHeadSource: 'git-head' as const, canonicalMainSource: 'git-origin-main' as const };

function observation(late: string): RenderedObservation {
  return { status: 'rendered', rendererIdentity: 'fake-renderer/v1',
    earlyFrame: Buffer.from('early-frame'), lateFrame: Buffer.from(late),
    runtimeErrors: [], audio: { relevant: false, state: 'not-applicable' },
    containment: { networkIsolated: true, permissionsDenied: true, cleanupSucceeded: true } as never };
}

describe('rerenderReevaluateProductRun (#1649)', () => {
  let root: string;
  let runRoot: string;
  const authority = createTestReceiptAuthority('rerender-product-run');
  const render = vi.fn();
  const evaluate = vi.fn();
  const generate = vi.fn();
  const effects = { generate, render, evaluate } as never;
  let parent: LiminalCommandResult;
  let parentKey: string;

  async function writeGrant(overrides: Record<string, unknown> = {}, name = 'grant.json') {
    const file = path.join(root, name);
    await writeFile(file, JSON.stringify({ schema: 'sinter.rerender-reevaluation-authority',
      schemaVersion: 1, sourceHeadSha: HEAD,
      parentReceiptSignature: parent.receipt.signature,
      parentEvidenceDigest: parent.receipt.evidenceDigest,
      maxTransportAttempts: 1, candidateCount: 0, evaluatorTimeoutMs: 60000, ...overrides }));
    return file;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'rerender-run-'));
    runRoot = path.join(root, 'run');
    generate.mockReset().mockImplementation(async input => {
      await input.startTransport();
      return { source: 'x', playable: '<canvas id="orrery"/>', provenance: 'fake' };
    });
    render.mockReset().mockImplementation(async () =>
      observation(render.mock.calls.length === 1 ? 'late-1' : 'late-fixed'));
    evaluate.mockReset().mockImplementation(async input => {
      await input.startTransport();
      return { score: evaluate.mock.calls.length === 1 ? 0.2 : 0.8, degraded: false,
        identityValid: true, evaluatorIdentity: input.identity,
        evidenceDigest: input.evidenceDigest };
    });
    const create = commandFactory(sourceRefs, identities)({ prompt: PROMPT, domain: 'p5' });
    const service = new LiminalCommandService({ effects,
      artifacts: new FileLiminalArtifactStore(path.join(runRoot, 'artifacts')),
      journal: new FileLiminalOperationJournal(path.join(runRoot, 'operation-journal.json')),
      authority });
    parent = await service.execute(create);
    parentKey = create.idempotencyKey;
    await writeFile(path.join(runRoot, 'product-projections.json'), JSON.stringify({
      [parentKey]: { kind: 'create', status: 'completed', commandDigest: 'x', result: parent } }));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const run = (grantPath: string, extra = {}) => rerenderReevaluateProductRun(runRoot, grantPath, {
    effects, authority, promptText: PROMPT, canonicalMainCandidates: [MAIN], ...extra });

  it('re-judges a real run root on fresh evidence and leaves the parent untouched', async () => {
    const grantPath = await writeGrant();
    const out = await run(grantPath);
    expect(render).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.result.evaluation.score).toBe(0.8);
    expect(out.result.lineageId).toBe(parent.lineageId);
    expect(out.result.receipt.evidenceDigest).not.toBe(parent.receipt.evidenceDigest);
    expect(out.result.receipt.actionAuthorityDigest).toBe(sha(await readFile(grantPath, 'utf8')));
    const stored = JSON.parse(await readFile(path.join(runRoot, 'product-projections.json'), 'utf8'));
    expect(stored[parentKey].result.receipt.signature).toBe(parent.receipt.signature);
    // same grant again: stored result, no second render or judge call
    const again = await run(grantPath);
    expect(again.result.operationId).toBe(out.result.operationId);
    expect(render).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a wrong parent signature', { parentReceiptSignature: 'f'.repeat(64) }, 'REEVALUATION_GRANT_PARENT_MISMATCH'],
    ['a wrong evidence digest', { parentEvidenceDigest: 'f'.repeat(64) }, 'REEVALUATION_GRANT_PARENT_MISMATCH'],
    ['a stale source head', { sourceHeadSha: 'c'.repeat(40) }, 'REEVALUATION_GRANT_PARENT_MISMATCH'],
    ['a second attempt', { maxTransportAttempts: 2 }, 'REEVALUATION_GRANT_INVALID'],
    ['a candidate count', { candidateCount: 1 }, 'REEVALUATION_GRANT_INVALID'],
    ['a wrong schema', { schema: 'sinter.other' }, 'REEVALUATION_GRANT_INVALID'],
  ])('refuses %s before any render', async (_name, override, code) => {
    const grantPath = await writeGrant(override);
    await expect(run(grantPath)).rejects.toThrow(code);
    expect(render).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a Forgejo pull request command without a local main reflog', async () => {
    const currentSourceRefs = { sourceHeadSha: HEAD, canonicalMainSha: MAIN,
      sourceKind: 'forgejo-actions-pull-request' as const,
      sourceHeadSource: 'forgejo-actions-github-sha' as const,
      canonicalMainSource: 'forgejo-event-pull-request-base' as const, eventHeadSha: HEAD };
    const create = commandFactory(currentSourceRefs, identities)({ prompt: PROMPT, domain: 'p5' });
    const service = new LiminalCommandService({ effects,
      artifacts: new FileLiminalArtifactStore(path.join(runRoot, 'artifacts')),
      journal: new FileLiminalOperationJournal(path.join(runRoot, 'operation-journal.json')),
      authority });
    parent = await service.execute(create);
    parentKey = create.idempotencyKey;
    await writeFile(path.join(runRoot, 'product-projections.json'), JSON.stringify({
      [parentKey]: { kind: 'create', result: parent } }));
    const grantPath = await writeGrant();
    const out = await run(grantPath, { currentSourceRefs, canonicalMainCandidates: [] });
    expect(out.command).toEqual(create);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('reconstructs the exact staged profile and explicit transport cap from a persisted Create', async () => {
    const create = commandFactory(sourceRefs, identities, { reasoning: 'xhigh', strictness: 'harsh' })({
      prompt: PROMPT, domain: 'p5', maxTransportAttempts: 5,
    });
    const service = new LiminalCommandService({ effects,
      artifacts: new FileLiminalArtifactStore(path.join(runRoot, 'artifacts')),
      journal: new FileLiminalOperationJournal(path.join(runRoot, 'operation-journal.json')),
      authority });
    parent = await service.execute(create);
    parentKey = create.idempotencyKey;
    await writeFile(path.join(runRoot, 'product-projections.json'), JSON.stringify({
      [parentKey]: { kind: 'create', result: parent } }));
    const out = await run(await writeGrant());
    expect(out.command).toEqual(create);
    expect(out.result.attempts.maximum).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('refuses a grant reused on another run', async () => {
    const grantPath = await writeGrant();
    const other = path.join(root, 'other');
    await writeFile(path.join(root, 'noop'), '');
    await expect(rerenderReevaluateProductRun(other, grantPath, { effects, authority,
      promptText: PROMPT, canonicalMainCandidates: [MAIN] })).rejects.toThrow();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the command cannot be rebuilt from the evidence', async () => {
    const grantPath = await writeGrant();
    await expect(run(grantPath, { promptText: 'a different prompt' }))
      .rejects.toThrow('REEVALUATION_COMMAND_UNRECOVERABLE');
    await expect(run(grantPath, { canonicalMainCandidates: ['d'.repeat(40)] }))
      .rejects.toThrow('REEVALUATION_COMMAND_UNRECOVERABLE');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('verifier accepts only this grant, this parent, this evidence and one attempt', () => {
    const grant = parseRerenderGrant(JSON.stringify({
      schema: 'sinter.rerender-reevaluation-authority', schemaVersion: 1, sourceHeadSha: HEAD,
      parentReceiptSignature: parent.receipt.signature,
      parentEvidenceDigest: parent.receipt.evidenceDigest,
      maxTransportAttempts: 1, candidateCount: 0, evaluatorTimeoutMs: 1000 }));
    const verify = createRerenderGrantVerifier(grant, 'e'.repeat(64));
    const good = { action: 'rerender-reevaluate' as const, digest: 'e'.repeat(64),
      parent: parent.receipt, evidenceDigest: parent.receipt.evidenceDigest!,
      maxTransportAttempts: 1 as const };
    expect(verify(good)).toBe(true);
    expect(verify({ ...good, action: 'reevaluate' })).toBe(false);
    expect(verify({ ...good, digest: '1'.repeat(64) })).toBe(false);
    expect(verify({ ...good, evidenceDigest: '1'.repeat(64) })).toBe(false);
    expect(verify({ ...good, parent: { ...parent.receipt, signature: '1'.repeat(64) } })).toBe(false);
  });
});
