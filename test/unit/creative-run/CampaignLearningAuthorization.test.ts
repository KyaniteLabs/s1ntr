import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// undici is imported transitively by the provider layer; this lifecycle never touches the network.
vi.mock('undici', () => ({ Agent: class {} }));

import { DurableCampaignLearningAuthorizationLifecycle } from '../../../src/creative-run/CampaignLearningAuthorization.js';
import type { CampaignClosurePersistence } from '../../../src/creative-run/CampaignClosure.js';
import type { EnvelopeAuthority } from '../../../src/creative-run/OwnerQualityReview.js';

const ID = 'learn-1';
const BINDING = { campaignRunId: 'run-1', manifestDigest: 'm'.repeat(64) };
const SCOPE = { binding: BINDING, briefId: 'brief-1', now: '2026-11-14T12:00:00.000Z' };
const evidenceKey = `campaign-closure:evidence:learning:${ID}`;
const stateKey = `campaign-closure:learning-state:${ID}`;

// Same canonical form the module uses for digests.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${stable(r[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = (v: unknown) => sha(stable(v));

class MemoryPersistence implements CampaignClosurePersistence {
  readonly data = new Map<string, string>();
  read(key: string) { return Promise.resolve(this.data.get(key) ?? null); }
  write(key: string, value: string) { this.data.set(key, value); return Promise.resolve(); }
  claim<T>(_key: string, operation: () => Promise<T>) { return operation(); }
}

const authority = {
  keyId: 'test-key',
  signReview: (v: unknown) => `sig:${digest(v)}`,
  verifyReview: (v: unknown, sig: string) => sig === `sig:${digest(v)}`,
} as unknown as EnvelopeAuthority;

function buildEvidence(over: { issuedAt?: string; expiresAt?: string } = {}) {
  const authorizationBody = {
    schema: 'sinter.learning-authorization', schemaVersion: 1, decision: 'allow',
    issuer: { id: 'issuer' }, owner: { id: 'owner' }, authorityRegistryId: 'reg', applicationBoundary: 'test',
    ruleId: 'rule-1', artifactDigest: 'a'.repeat(64), planDigest: 'plan-1', revisionReceiptDigest: 'rev-1',
    issuedAt: over.issuedAt ?? '2026-11-14T00:00:00.000Z', expiresAt: over.expiresAt ?? '2026-11-15T00:00:00.000Z',
    maximumTransfers: 1, initialRevocationState: 'active',
  };
  const authorization = { ...authorizationBody, authorizationDigest: sha(JSON.stringify(authorizationBody)) };
  const provisionalBody = {
    schema: 'sinter.provisional-learning-transfer', schemaVersion: 1,
    authorizationDigest: authorization.authorizationDigest, ruleId: 'rule-1', ruleValue: 1,
    artifactDigest: 'a'.repeat(64), planDigest: 'plan-1', revisionReceiptDigest: 'rev-1',
    priorContext: {}, nextContext: {},
  };
  const provisional = { ...provisionalBody, provisionalDigest: sha(JSON.stringify(provisionalBody)) };
  const stageBody = {
    schema: 'sinter.learning-stage-receipt', schemaVersion: 1, status: 'staged', reason: 'STAGED',
    persistenceBoundary: 'test', provisional, mutationCounters: {},
  };
  const stage = { ...stageBody, receiptDigest: sha(JSON.stringify(stageBody)) };
  const manifest = { intent: { goal: 'learn' } };
  const unsigned = {
    id: ID, binding: BINDING, briefId: 'brief-1', manifestIntentDigest: digest(manifest.intent), manifest,
    planDigest: 'plan-1', route: { provider: 'fake', model: 'fake-1' }, revisionReceiptDigest: 'rev-1',
    authorization, stage, provisional,
  };
  return { ...unsigned, signatureBase64: authority.signReview(unsigned), evidenceDigest: digest(unsigned) };
}

function activeState() {
  const body = { authorizationEvidenceId: ID, state: 'active' };
  return { ...body, stateDigest: digest(body) };
}

let store: MemoryPersistence;
let life: DurableCampaignLearningAuthorizationLifecycle;

function seed(evidence: object = buildEvidence(), state: object | null = activeState()) {
  store.data.set(evidenceKey, JSON.stringify(evidence));
  if (state) store.data.set(stateKey, JSON.stringify(state));
}

beforeEach(() => {
  store = new MemoryPersistence();
  life = new DurableCampaignLearningAuthorizationLifecycle(store, authority);
});

describe('resolveLearningAuthorization', () => {
  it('returns a verified, frozen evidence record', async () => {
    seed();
    const ev = await life.resolveLearningAuthorization(ID);
    expect(ev.id).toBe(ID);
    expect(ev.route).toEqual({ provider: 'fake', model: 'fake-1' });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  it('fails when the evidence is missing', async () => {
    await expect(life.resolveLearningAuthorization(ID)).rejects.toThrow(`CAMPAIGN_CLOSURE_EVIDENCE_MISSING:learning:${ID}`);
  });

  it('rejects a tampered body (digest no longer matches)', async () => {
    seed({ ...buildEvidence(), briefId: 'brief-evil' });
    await expect(life.resolveLearningAuthorization(ID)).rejects.toThrow('CAMPAIGN_CLOSURE_EVIDENCE_SIGNATURE_INVALID');
  });

  it('rejects a forged signature even when the digest matches', async () => {
    seed({ ...buildEvidence(), signatureBase64: 'sig:forged' });
    await expect(life.resolveLearningAuthorization(ID)).rejects.toThrow('CAMPAIGN_CLOSURE_EVIDENCE_SIGNATURE_INVALID');
  });

  it('rejects evidence whose authorization was denied, even if freshly signed and digested', async () => {
    const good = buildEvidence();
    const authBody = { ...good.authorization, decision: 'deny' } as Record<string, unknown>;
    delete authBody.authorizationDigest;
    const authorization = { ...authBody, authorizationDigest: sha(JSON.stringify(authBody)) };
    const { signatureBase64: _s, evidenceDigest: _d, ...rest } = good;
    const unsigned = { ...rest, authorization };
    seed({ ...unsigned, signatureBase64: authority.signReview(unsigned), evidenceDigest: digest(unsigned) });
    await expect(life.resolveLearningAuthorization(ID)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_INVALID');
  });

  it('rejects an authorization digest that does not match its body', async () => {
    const good = buildEvidence();
    const { signatureBase64: _s, evidenceDigest: _d, ...rest } = good;
    const unsigned = { ...rest, authorization: { ...good.authorization, authorizationDigest: 'f'.repeat(64) } };
    seed({ ...unsigned, signatureBase64: authority.signReview(unsigned), evidenceDigest: digest(unsigned) });
    await expect(life.resolveLearningAuthorization(ID)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_INVALID');
  });
});

describe('state and active resolution', () => {
  it('reads the active state', async () => {
    seed();
    expect(await life.resolveLearningAuthorizationState(ID)).toMatchObject({ authorizationEvidenceId: ID, state: 'active' });
  });

  it('fails closed when the state record is missing or corrupted', async () => {
    seed(buildEvidence(), null);
    await expect(life.resolveLearningAuthorizationState(ID)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_STATE_MISSING');
    store.data.set(stateKey, JSON.stringify({ ...activeState(), state: 'consumed' }));
    await expect(life.resolveLearningAuthorizationState(ID)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_STATE_INVALID');
  });

  it('returns the evidence for a matching scope inside the validity window', async () => {
    seed();
    expect((await life.resolveActiveLearningAuthorization(ID, SCOPE)).id).toBe(ID);
  });

  it.each([
    ['another campaign run', { ...SCOPE, binding: { ...BINDING, campaignRunId: 'run-2' } }, 'CAMPAIGN_LEARNING_AUTHORIZATION_SCOPE_MISMATCH'],
    ['another manifest', { ...SCOPE, binding: { ...BINDING, manifestDigest: 'x' } }, 'CAMPAIGN_LEARNING_AUTHORIZATION_SCOPE_MISMATCH'],
    ['another brief', { ...SCOPE, briefId: 'brief-2' }, 'CAMPAIGN_LEARNING_AUTHORIZATION_SCOPE_MISMATCH'],
    ['a time before issue', { ...SCOPE, now: '2026-11-13T23:59:59.000Z' }, 'CAMPAIGN_LEARNING_AUTHORIZATION_NOT_YET_VALID'],
    ['the exact expiry instant', { ...SCOPE, now: '2026-11-15T00:00:00.000Z' }, 'CAMPAIGN_LEARNING_AUTHORIZATION_EXPIRED'],
    ['an unparseable time', { ...SCOPE, now: 'soon' }, 'CAMPAIGN_LEARNING_AUTHORIZATION_TIME_INVALID'],
  ])('refuses %s', async (_name, scope, code) => {
    seed();
    await expect(life.resolveActiveLearningAuthorization(ID, scope)).rejects.toThrow(code);
  });

  it('refuses an authorization that expires before it was issued', async () => {
    seed(buildEvidence({ issuedAt: '2026-11-14T00:00:00.000Z', expiresAt: '2026-11-13T00:00:00.000Z' }));
    await expect(life.resolveActiveLearningAuthorization(ID, SCOPE)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_TIME_INVALID');
  });
});

describe('execution lifecycle', () => {
  it('begins an execution once and is idempotent for the same execution id', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    expect(exec).toMatchObject({ authorizationEvidenceId: ID, executionId: 'exec-1', beganAt: SCOPE.now, briefId: 'brief-1' });
    expect((await life.resolveLearningAuthorizationState(ID)).state).toBe('executing');
    expect(await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' })).toEqual(exec);
  });

  it('refuses a blank execution id and a second, different execution', async () => {
    seed();
    await expect(life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: '  ' }))
      .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_ID_REQUIRED');
    await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await expect(life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-2' }))
      .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
  });

  it('requires an explicit arm: the deprecated three-argument form fails closed', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await expect(life.resolveLearningAuthorizationExecution(ID, exec, SCOPE.now))
      .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_ARM_REQUIRED');
    await expect(life.resolveLearningAuthorizationExecution(ID, exec, 'sideways' as never, SCOPE.now))
      .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_ARM_INVALID');
  });

  it('refuses an execution record that is not the live one', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await expect(life.resolveLearningAuthorizationExecution(ID, { ...exec, authorizationEvidenceDigest: 'z' }, 'treatment', SCOPE.now))
      .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
    await expect(life.resolveLearningAuthorizationExecution(ID, { ...exec, executionId: 'exec-9' }, 'treatment', SCOPE.now))
      .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
  });

  it('refuses a clock that runs backwards from the execution start', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await expect(life.resolveLearningAuthorizationExecution(ID, exec, 'control', '2026-11-14T11:00:00.000Z'))
      .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_TIME_INVALID');
  });

  it('will not commit until both treatment and control arms were authorized', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await life.resolveLearningAuthorizationExecution(ID, exec, 'treatment', SCOPE.now);
    await life.resolveLearningAuthorizationExecution(ID, exec, 'treatment', SCOPE.now);
    expect((await life.resolveLearningAuthorizationState(ID)).authorizedArms).toEqual(['treatment']);
    await expect(life.commitLearningAuthorizationExecution(ID, exec, SCOPE.now))
      .rejects.toThrow('CAMPAIGN_LEARNING_COMPARISON_INCOMPLETE');
  });

  it('consumes the authorization once both arms ran, and a repeat commit is idempotent', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await life.resolveLearningAuthorizationExecution(ID, exec, 'treatment', SCOPE.now);
    await life.resolveLearningAuthorizationExecution(ID, exec, 'control', SCOPE.now);
    const done = await life.commitLearningAuthorizationExecution(ID, exec, SCOPE.now);
    expect(done).toMatchObject({ state: 'consumed', authorizedArms: ['treatment', 'control'] });
    expect(await life.commitLearningAuthorizationExecution(ID, exec, SCOPE.now)).toEqual(done);
    await expect(life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' }))
      .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
  });

  it('refuses to commit a different execution against a consumed authorization', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await life.resolveLearningAuthorizationExecution(ID, exec, 'treatment', SCOPE.now);
    await life.resolveLearningAuthorizationExecution(ID, exec, 'control', SCOPE.now);
    await life.commitLearningAuthorizationExecution(ID, exec, SCOPE.now);
    const { executionDigest: _d, ...body } = exec;
    const other = { ...body, executionId: 'exec-2' };
    await expect(life.commitLearningAuthorizationExecution(ID, { ...other, executionDigest: digest(other) }, SCOPE.now))
      .rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
  });

  it('aborting an execution returns the authorization to active', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    expect(await life.abortLearningAuthorizationExecution(ID, exec)).toMatchObject({ state: 'active' });
    expect((await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-2' })).executionId).toBe('exec-2');
  });

  it('cannot abort when nothing is executing', async () => {
    seed();
    const exec = await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await life.abortLearningAuthorizationExecution(ID, exec);
    await expect(life.abortLearningAuthorizationExecution(ID, exec)).rejects.toThrow('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
  });
});

describe('revoke and consume', () => {
  it('revokes an active authorization, idempotently, and then blocks use', async () => {
    seed();
    expect(await life.revokeLearningAuthorization(ID)).toMatchObject({ state: 'revoked' });
    expect(await life.revokeLearningAuthorization(ID)).toMatchObject({ state: 'revoked' });
    await expect(life.resolveActiveLearningAuthorization(ID, SCOPE)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
    await expect(life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'e' }))
      .rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
  });

  it('cannot revoke while an execution is in flight', async () => {
    seed();
    await life.beginLearningAuthorizationExecution(ID, { ...SCOPE, executionId: 'exec-1' });
    await expect(life.revokeLearningAuthorization(ID)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
  });

  it('never consumes directly: callers must go through an execution', async () => {
    seed();
    await expect(life.consumeLearningAuthorization(ID)).rejects.toThrow('CAMPAIGN_LEARNING_AUTHORIZATION_EXECUTION_REQUIRED');
    expect((await life.resolveLearningAuthorizationState(ID)).state).toBe('active');
  });

  it('refuses to revoke or consume unknown evidence', async () => {
    await expect(life.revokeLearningAuthorization('nope')).rejects.toThrow('CAMPAIGN_CLOSURE_EVIDENCE_MISSING:learning:nope');
    await expect(life.consumeLearningAuthorization('nope')).rejects.toThrow('CAMPAIGN_CLOSURE_EVIDENCE_MISSING:learning:nope');
  });
});
