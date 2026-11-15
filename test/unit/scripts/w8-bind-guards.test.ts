import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WAVE8_REQUIRED_OWNER_DECISIONS } from '../../../src/runtime-core/Wave8ReleaseRoot.js';
import {
  BIND_OWNER_DECISION_KINDS,
  assertComposeBoundToCurrentSource,
  loadVerifiedOwnerDecisionPackets,
  readComposeSourceBinding,
  stableBindJson,
} from '../../../scripts/w8-bind-guards.mts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'w8-bind-'));
  dirs.push(dir);
  return dir;
};

describe('w8 bind guards', () => {
  it('keeps owner kinds aligned with the release-root conjunct', () => {
    expect([...BIND_OWNER_DECISION_KINDS]).toEqual([...WAVE8_REQUIRED_OWNER_DECISIONS]);
  });

  it('accepts an exact compose head and fingerprint match', () => {
    expect(() => assertComposeBoundToCurrentSource({
      currentHead: 'abc123',
      currentFingerprint: 'sha256:deadbeef',
      composeHead: 'abc123',
      composeFingerprint: 'deadbeef',
    })).not.toThrow();
  });

  it('refuses a head or fingerprint mismatch instead of rebinding', () => {
    expect(() => assertComposeBoundToCurrentSource({
      currentHead: 'aaada570',
      currentFingerprint: 'db2c9ea4',
      composeHead: '898b8209',
      composeFingerprint: 'db2c9ea4',
    })).toThrow(/compose-source-mismatch/);
    expect(() => assertComposeBoundToCurrentSource({
      currentHead: 'aaada570',
      currentFingerprint: 'db2c9ea4',
      composeHead: 'aaada570',
      composeFingerprint: 'bfeb4a42',
    })).toThrow(/compose-source-mismatch/);
  });

  it('refuses missing compose bindings', () => {
    expect(() => assertComposeBoundToCurrentSource({
      currentHead: '',
      currentFingerprint: 'deadbeef',
      composeHead: 'abc',
      composeFingerprint: 'deadbeef',
    })).toThrow(/compose-source-binding-missing/);
  });

  it('reads bootstrap head/fp and rejects execution-config drift', () => {
    const live = tmp();
    writeFileSync(join(live, 'bootstrap-release-root.json'), JSON.stringify({
      releaseHead: '898b8209',
      sourceFingerprint: 'bfeb4a42',
    }));
    writeFileSync(join(live, 'execution-config.json'), JSON.stringify({
      preSpendPolicy: { expectedSourceFingerprint: 'bfeb4a42' },
    }));
    expect(readComposeSourceBinding(live)).toEqual({ head: '898b8209', fingerprint: 'bfeb4a42' });

    writeFileSync(join(live, 'execution-config.json'), JSON.stringify({
      preSpendPolicy: { expectedSourceFingerprint: 'ffffffff' },
    }));
    expect(() => readComposeSourceBinding(live)).toThrow(/compose-execution-fingerprint-mismatch/);
  });

  it('consumes independently signed owner packets and refuses mint-shaped failures', () => {
    const dir = tmp();
    const packetsDir = join(dir, 'owner-decisions');
    mkdirSync(packetsDir);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const currentHead = 'abc123';
    const currentFingerprint = 'deadbeef';
    const campaignSubjectDigest = 'subject-1';
    for (const kind of BIND_OWNER_DECISION_KINDS) {
      const unsigned = {
        schema: 'sinter.owner-decision-packet',
        schemaVersion: 1,
        decisionKind: kind,
        campaignRunId: 'camp',
        decision: 'approved',
        detail: kind,
        subjectDigest: campaignSubjectDigest,
        releaseHead: currentHead,
        sourceFingerprint: currentFingerprint,
        keyId: 'owner-test',
        decidedAt: '2026-08-14T00:00:00.000Z',
        owner: 'Simon',
      };
      const signatureBase64 = sign(null, Buffer.from(stableBindJson(unsigned)), privateKey).toString('base64');
      const decisionDigest = createHash('sha256').update(stableBindJson(unsigned)).digest('hex');
      writeFileSync(join(packetsDir, `${kind}.json`), JSON.stringify({
        ...unsigned, signatureBase64, decisionDigest,
      }));
    }

    const verified = loadVerifiedOwnerDecisionPackets({
      packetsDir, publicKeyPem, currentHead, currentFingerprint, campaignSubjectDigest,
    });
    expect(verified.kinds).toEqual([...BIND_OWNER_DECISION_KINDS]);
    expect(verified.digests).toHaveLength(BIND_OWNER_DECISION_KINDS.length);

    const mergePath = join(packetsDir, 'merge.json');
    const before = readFileSync(mergePath, 'utf8');
    expect(() => loadVerifiedOwnerDecisionPackets({
      packetsDir, publicKeyPem, currentHead: 'other', currentFingerprint, campaignSubjectDigest,
    })).toThrow(/owner-packet-source-mismatch/);
    expect(() => loadVerifiedOwnerDecisionPackets({
      packetsDir, publicKeyPem, currentHead, currentFingerprint, campaignSubjectDigest: 'other',
    })).toThrow(/owner-packet-subject-mismatch/);
    rmSync(mergePath);
    expect(() => loadVerifiedOwnerDecisionPackets({
      packetsDir, publicKeyPem, currentHead, currentFingerprint, campaignSubjectDigest,
    })).toThrow(/owner-packets-incomplete/);
    writeFileSync(mergePath, before);
    const tampered = JSON.parse(before) as { signatureBase64: string };
    tampered.signatureBase64 = Buffer.alloc(64).toString('base64');
    writeFileSync(mergePath, JSON.stringify(tampered));
    expect(() => loadVerifiedOwnerDecisionPackets({
      packetsDir, publicKeyPem, currentHead, currentFingerprint, campaignSubjectDigest,
    })).toThrow(/owner-packet-signature-invalid|owner-packet-invalid/);
  });
});
