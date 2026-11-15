import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainIncubatorStore,
  evaluateDomainIncubator,
  parseDomainIncubationGateReceipt,
  parseDomainIncubationRecommendation,
  recommendDomainIncubation,
  type DomainIncubationGateReceipt,
  type DomainIncubationInput,
} from '../../../src/index.js';

const receiptPath = path.resolve(
  'docs/agents/waves/receipts/wave-5-W5-12-domain-incubator.json',
);

describe('DomainIncubator', () => {
  let receipt: DomainIncubationGateReceipt;
  const temporaryRoots: string[] = [];

  beforeAll(async () => {
    receipt = parseDomainIncubationGateReceipt(
      JSON.parse(await readFile(receiptPath, 'utf8')),
    );
  });

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root =>
      rm(root, { recursive: true, force: true })));
  });

  function recommendationInput(): DomainIncubationInput {
    const {
      schemaVersion: _schema,
      candidateId: _candidate,
      status: _status,
      allowedAction: _action,
      promotion: _promotion,
      receiptDigest: _digest,
      ...input
    } = receipt.recommendation;
    return input;
  }

  it('recommends but cannot promote a complete evidence envelope', () => {
    const recommendation = recommendDomainIncubation(recommendationInput());
    expect(parseDomainIncubationRecommendation(recommendation)).toEqual(recommendation);
    expect(recommendation.status).toBe('recommended');
    expect(recommendation.promotion).toBe('forbidden');
    expect(recommendation).not.toHaveProperty('promote');
  });

  it('persists recommendation and evaluation in an isolated directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'domain-incubator-test-'));
    temporaryRoots.push(root);
    const store = new DomainIncubatorStore(root);
    const recommendation = receipt.recommendation;
    await store.save(recommendation);
    await store.save(receipt.accepted);
    await expect(store.load(recommendation.candidateId, 'recommended'))
      .resolves.toEqual(recommendation);
    await expect(store.load(recommendation.candidateId, 'ready-for-owner-review'))
      .resolves.toEqual(receipt.accepted);
  });

  it('rejects a weak candidate instead of promoting it', () => {
    const proof = structuredClone(receipt.accepted.proof);
    proof.generation.runnable = false;
    const evaluated = evaluateDomainIncubator(receipt.recommendation, proof);
    expect(evaluated.status).toBe('rejected');
    expect(evaluated.rejectionReasons).toContain('generation');
    expect(evaluated.promotion).toBe('forbidden');
  });

  it('fails closed without all four evidence organs', () => {
    const input = recommendationInput();
    input.signals = input.signals.filter(signal => signal.kind !== 'causal');
    expect(() => recommendDomainIncubation(input))
      .toThrow(/EVIDENCE_ENVELOPE_INCOMPLETE/);
  });

  it('rejects tampered recommendation and gate receipts', () => {
    const recommendation = structuredClone(receipt.recommendation);
    recommendation.promotion = 'allowed' as 'forbidden';
    expect(() => parseDomainIncubationRecommendation(recommendation)).toThrow();

    const gate = structuredClone(receipt);
    gate.persistedRoundTrip = false;
    expect(() => parseDomainIncubationGateReceipt(gate)).toThrow(/digest mismatch/);
  });
});
