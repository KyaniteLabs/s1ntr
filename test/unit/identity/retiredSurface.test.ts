import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { bootstrapExecutorAuthority } from '../../../src/identity/executorAuthorityBootstrap.js';
import {
  issueExecutorAttestation,
  NonceLedger,
  retiredSurfaceSuccessor,
  verifyExecutorAttestation,
  type ExecutorAttestationV2,
} from '../../../src/identity/executorAttestation.js';
import { projectExecutorAttemptHistory } from '../../../src/identity/harnessTransportGuard.js';
import { HostAdapterRegistry, type HostAdapterDescriptor } from '../../../src/identity/hostAdapterRegistry.js';
import type { ProviderSurface } from '../../../src/identity/types.js';
import { NOW_ISO, SOL_IDENTITY, SOL_SEAT, SOL_SUBSCRIPTION_FUNDING } from './helpers.js';

// #1591: the LAN gateway surface was renamed; host ledgers still hold records
// signed under the old name and must keep replaying.
// Built from parts: the public mirror rewrites the fleet host name in source text,
// which changed this input and broke the hash lookup in the public snapshot.
const RETIRED = ['nuc', 'box-litellm'].join('') as ProviderSurface;
const KEY = { keyId: 'k', secret: Buffer.from('retired-surface-test-secret', 'utf8') };
const adapter = (surface: string): HostAdapterDescriptor => ({
  adapterId: `host-${surface}`,
  surface: surface as ProviderSurface,
  provider: 'unknown',
  canEnforceNoSubstitution: true,
});
// The registry as it stood when the old records were signed, and as it is now.
const legacy = new HostAdapterRegistry(KEY, [adapter(RETIRED)]);
const current = new HostAdapterRegistry(KEY, [adapter('lan-gateway-litellm')]);

function oldRecord(registry = legacy, surface: ProviderSurface = RETIRED, extra: { terminalReason?: string; exhaustionClass?: 'subscription-quota-exhausted' } = {}) {
  return issueExecutorAttestation(registry, {
    attestationId: 'att-old', runDigest: 'r', requestDigest: 'q', attemptDigest: 'a',
    requestedIdentity: SOL_IDENTITY, resolvedIdentity: SOL_IDENTITY, effort: SOL_IDENTITY.effort,
    fallbackChain: [{ ordinal: 0, identity: SOL_IDENTITY }],
    seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat',
    issuedAt: NOW_ISO, nonce: 'n-old', surface,
    durationMs: 0, success: true, ...extra,
    quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
  });
}

describe('retired provider surfaces in the attempt ledger (#1591)', () => {
  it('maps the retired name to its successor without shipping the name', () => {
    expect(retiredSurfaceSuccessor(RETIRED)).toBe('lan-gateway-litellm');
    expect(retiredSurfaceSuccessor('lan-gateway-litellm')).toBeUndefined();
  });

  it('a signature-valid old record replays as history', () => {
    expect(verifyExecutorAttestation(current, oldRecord(), NOW_ISO, { historical: true })).toEqual({ ok: true });
  });

  it('present admission still refuses the retired surface', () => {
    const result = verifyExecutorAttestation(current, oldRecord(), NOW_ISO);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-surface');
  });

  it('a forged old record still fails', () => {
    const record = oldRecord();
    const forged: ExecutorAttestationV2 = {
      subject: record.subject as ExecutorAttestationV2['subject'],
      signature: record.signature.slice(0, -2) + 'XX',
    };
    const result = verifyExecutorAttestation(current, forged, NOW_ISO, { historical: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-invalid');
  });

  it('an old record signed by another host key still fails', () => {
    const foreign = new HostAdapterRegistry({ keyId: 'k', secret: Buffer.from('other-secret', 'utf8') }, [adapter(RETIRED)]);
    const result = verifyExecutorAttestation(current, oldRecord(foreign), NOW_ISO, { historical: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature-invalid');
  });

  it('an old record bound to a different adapter id still fails', () => {
    const odd = new HostAdapterRegistry(KEY, [{ ...adapter(RETIRED), adapterId: 'host-something-else' }]);
    const result = verifyExecutorAttestation(current, oldRecord(odd), NOW_ISO, { historical: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-adapter');
  });

  it('an unknown surface that is not retired still fails verification as history', () => {
    const other = new HostAdapterRegistry(KEY, [adapter('made-up-surface')]);
    const record = oldRecord(other, 'made-up-surface' as ProviderSurface);
    const result = verifyExecutorAttestation(current, record, NOW_ISO, { historical: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-surface');
  });

  it('a host ledger holding an old record still bootstraps and replays it', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'retired-surface-'));
    try {
      bootstrapExecutorAuthority({ rootDir });
      const stored = JSON.parse(readFileSync(join(rootDir, 'trust-key.json'), 'utf8')) as { keyId: string; secretBase64: string };
      const hostKey = { keyId: stored.keyId, secret: Buffer.from(stored.secretBase64, 'base64') };
      const record = oldRecord(new HostAdapterRegistry(hostKey, [adapter(RETIRED)]));
      writeFileSync(join(rootDir, 'attempts', 'old.json'), JSON.stringify(record));
      new NonceLedger(join(rootDir, 'nonces')).burn(record.subject.nonce, record.subject.attestationId, NOW_ISO);

      const authority = bootstrapExecutorAuthority({ rootDir });
      const history = authority.readAttemptHistory();
      expect(history.map(entry => entry.attestation.subject.attestationId)).toContain('att-old');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // #1783: a surface retired without a hash entry above must not brick the host.
  // The record is authentic (its signature verified), only its surface is unknown
  // to this build, so history skips it loudly. Tampering still fails closed.
  function ledgerWith(surface: string, tamper = false, extra = {}) {
    const rootDir = mkdtempSync(join(tmpdir(), 'unknown-surface-'));
    bootstrapExecutorAuthority({ rootDir });
    const stored = JSON.parse(readFileSync(join(rootDir, 'trust-key.json'), 'utf8')) as { keyId: string; secretBase64: string };
    const hostKey = { keyId: stored.keyId, secret: Buffer.from(stored.secretBase64, 'base64') };
    const record = oldRecord(new HostAdapterRegistry(hostKey, [adapter(surface)]), surface as ProviderSurface, extra);
    const body = tamper ? { ...record, signature: record.signature.slice(0, -2) + 'XX' } : record;
    writeFileSync(join(rootDir, 'attempts', 'old.json'), JSON.stringify(body));
    new NonceLedger(join(rootDir, 'nonces')).burn(record.subject.nonce, record.subject.attestationId, NOW_ISO);
    return rootDir;
  }

  it('a host ledger holding an authentic record of an unknown surface still bootstraps and keeps it as history', async () => {
    const rootDir = ledgerWith('some-retired-surface');
    const prior = { path: process.env.SINTER_EVENT_LEDGER_PATH, force: process.env.SINTER_EVENT_LEDGER_FORCE };
    process.env.SINTER_EVENT_LEDGER_PATH = join(rootDir, 'events');
    process.env.SINTER_EVENT_LEDGER_FORCE = '1';
    try {
      const authority = bootstrapExecutorAuthority({ rootDir });
      expect(authority.readAttemptHistory().map(entry => entry.attestation.subject.attestationId)).toContain('att-old');
      // The note is telemetry, not only stderr.
      const events = join(rootDir, 'events');
      const eventFiles = (): string[] => !existsSync(events) ? [] : readdirSync(events, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.jsonl'));
      for (let i = 0; i < 100 && eventFiles().length === 0; i += 1) await new Promise(r => setTimeout(r, 20));
      const logged = eventFiles().flatMap(f => readFileSync(join(events, f), 'utf8').trim().split('\n')).map(line => JSON.parse(line) as { event: string; payload: Record<string, unknown> });
      expect(logged).toHaveLength(1);
      expect(logged[0].event).toBe('identity.ledgerRecordUnknownSurface');
      expect(logged[0].payload).toMatchObject({ reason: 'unknown-surface', attestationId: 'att-old', file: 'old.json' });
      expect(JSON.stringify(logged[0])).not.toContain('some-retired-surface');
    } finally {
      for (const [key, value] of [['SINTER_EVENT_LEDGER_PATH', prior.path], ['SINTER_EVENT_LEDGER_FORCE', prior.force]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('quota counters and unresolved state of an unknown-surface record survive retirement and restart', () => {
    const rootDir = ledgerWith('some-retired-surface', false, { terminalReason: 'quota', exhaustionClass: 'subscription-quota-exhausted' });
    try {
      for (let boot = 0; boot < 2; boot += 1) {
        const history = bootstrapExecutorAuthority({ rootDir }).readAttemptHistory();
        expect(history).toHaveLength(1);
        expect(history[0].attestation.subject.funding.quotaCounters).toEqual(SOL_SUBSCRIPTION_FUNDING.quotaCounters);
        const projection = projectExecutorAttemptHistory(history);
        expect(projection.status).toBe('verified');
        expect(projection.terminalReason).toBe('quota');
        expect(projection.exhaustionClass).toBe('subscription-quota-exhausted');
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('a host ledger holding a forged record of an unknown surface still fails closed', () => {
    const rootDir = ledgerWith('some-retired-surface', true);
    try {
      expect(() => bootstrapExecutorAuthority({ rootDir })).toThrow(/attempt ledger verification failed: signature-invalid/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
