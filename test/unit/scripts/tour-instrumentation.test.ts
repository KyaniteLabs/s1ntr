import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeTourWaveId,
  resolveJoinKeys,
  stampJoinKeys,
  claimFingerprint,
  sampleContention,
  recordOperatorInvoke,
  appendClaimLifecycle,
  instrumentationSelfCheck,
  CLAIM_LEDGER_SCHEMA,
  INSTRUMENTATION_CLAIM_IDS,
  TOUR_ID,
} from '../../../scripts/rotation/tour-instrumentation.mjs';
import { buildSummary, buildTaskReceipt } from '../../../scripts/rotation/shared.mjs';

describe('tour-instrumentation (TI-1..5)', () => {
  let dir: string;
  let ledger: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tour-inst-'));
    ledger = join(dir, 'ledger.json');
    writeFileSync(
      ledger,
      JSON.stringify(
        {
          schema: CLAIM_LEDGER_SCHEMA,
          tourId: TOUR_ID,
          status: 'open',
          claims: INSTRUMENTATION_CLAIM_IDS.map((id) => ({
            id,
            fingerprint: id.toLowerCase(),
            title: id,
            tag: 'instrumentation',
            status: 'open',
          })),
          lifecycle: [],
        },
        null,
        2,
      ),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('makeTourWaveId uses wave and 8-char tip', () => {
    expect(makeTourWaveId(1, '37f4a875f7d7726964a4dbefc99bc82c1de55882')).toBe(
      'wave-1@37f4a875',
    );
  });

  it('resolveJoinKeys + stampJoinKeys attach tourWaveId', () => {
    const keys = resolveJoinKeys({
      wave: 1,
      seat: 'generator',
      model: 'grok-4.5',
      pipeHost: 'api.x.ai',
      tip: 'abcdef12deadbeef',
    });
    expect(keys.tourId).toBe(TOUR_ID);
    expect(keys.tourWaveId).toBe('wave-1@abcdef12');
    expect(keys.pipeHost).toBe('api.x.ai');
    const stamped = stampJoinKeys({ kind: 'rotation.summary' }, keys);
    expect(stamped.join.tourWaveId).toBe('wave-1@abcdef12');
    expect(stamped.kind).toBe('rotation.summary');
  });

  it('claimFingerprint is stable 16 hex and seat-sensitive', () => {
    const a = claimFingerprint({
      title: 'Join keys missing',
      seat: 'harness',
      pathHints: ['scripts/rotation/shared.mjs'],
    });
    const b = claimFingerprint({
      title: 'Join keys missing',
      seat: 'harness',
      pathHints: ['scripts/rotation/shared.mjs'],
    });
    const c = claimFingerprint({
      title: 'Join keys missing',
      seat: 'generator',
      pathHints: ['scripts/rotation/shared.mjs'],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(a).not.toBe(c);
  });

  it('buildSummary stamps join when wave set', () => {
    const summary = buildSummary({
      seat: 'generator',
      model: 'grok-4.5',
      reasoningLevel: 'high',
      runDir: '/tmp/x',
      taskReceipts: [{ taskId: 't1' }],
      metrics: { northStar: 0.5 },
      wave: { id: '1', campaign: 'wave-1' },
      tip: 'deadbeefcafebabe',
      pipeHost: 'api.x.ai',
    });
    expect(summary.join?.tourWaveId).toBe('wave-1@deadbeef');
    expect(summary.join?.model).toBe('grok-4.5');
    expect(summary.join?.pipeHost).toBe('api.x.ai');
  });

  it('buildTaskReceipt stamps join when wave set', () => {
    const r = buildTaskReceipt({
      seat: 'chat',
      model: 'glm-5.2',
      taskId: 'c1',
      promptHash: 'abc',
      reasoningLevel: 'high',
      latencyMs: 10,
      verdict: 'pass',
      wave: 1,
      tip: '1122334455667788',
      pipeHost: 'api.z.ai',
    });
    expect(r.join?.tourWaveId).toBe('wave-1@11223344');
    expect(r.join?.seat).toBe('chat');
  });

  it('buildSummary omits join when no wave', () => {
    const summary = buildSummary({
      seat: 'harness',
      model: 'gpt-5.6-sol',
      reasoningLevel: 'high',
      runDir: '/tmp/x',
      taskReceipts: [],
      metrics: {},
    });
    expect(summary.join).toBeUndefined();
  });

  it('recordOperatorInvoke writes JSONL with join', () => {
    const { filePath, record } = recordOperatorInvoke({
      commandClass: 'market.status',
      exitCode: 0,
      durationMs: 12,
      seat: 'orchestrator',
      wave: 0,
      tip: 'aabbccdd',
      baseDir: dir,
    });
    expect(existsSync(filePath)).toBe(true);
    const line = readFileSync(filePath, 'utf8').trim().split('\n').at(-1)!;
    const parsed = JSON.parse(line);
    expect(parsed.schema).toBe('sinter-tour-operator-invoke-v1');
    expect(parsed.commandClass).toBe('market.status');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.join.tourWaveId).toBe('wave-0@aabbccdd');
    expect(record.join.tourWaveId).toBe('wave-0@aabbccdd');
  });

  it('appendClaimLifecycle merges status and appends lifecycle', () => {
    const r = appendClaimLifecycle({
      action: 'merge',
      claimId: 'TI-1',
      ledgerPath: ledger,
      baseDir: dir,
      wave: 0,
      tip: 'ffffffff',
      pr: '#999',
      detail: 'landed',
    });
    expect(r.claimFound).toBe(true);
    const j = JSON.parse(readFileSync(ledger, 'utf8'));
    expect(j.lifecycle).toHaveLength(1);
    expect(j.lifecycle[0].action).toBe('merge');
    expect(j.lifecycle[0].join.tourWaveId).toBe('wave-0@ffffffff');
    const claim = j.claims.find((c: { id: string }) => c.id === 'TI-1');
    expect(claim.status).toBe('merged');
    expect(claim.pr).toBe('#999');
  });

  it('instrumentationSelfCheck passes with TI claims present', () => {
    const check = instrumentationSelfCheck({ ledgerPath: ledger, tmpRoot: join(dir, 'tmp') });
    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
  });

  it('instrumentationSelfCheck fails when TI claim missing', () => {
    writeFileSync(
      ledger,
      JSON.stringify(
        {
          schema: CLAIM_LEDGER_SCHEMA,
          claims: [{ id: 'TI-1', status: 'open' }],
          lifecycle: [],
        },
        null,
        2,
      ),
    );
    const check = instrumentationSelfCheck({ ledgerPath: ledger, tmpRoot: join(dir, 'tmp2') });
    expect(check.ok).toBe(false);
    expect(check.errors.some((e) => e.includes('TI-2'))).toBe(true);
  });

  it('sampleContention returns schema and memory fields', () => {
    const s = sampleContention({ cwd: dir });
    expect(s.schema).toBe('sinter-tour-contention-v1');
    expect(typeof s.freememMb).toBe('number');
    expect(s.freememMb).toBeGreaterThan(0);
  });
});
