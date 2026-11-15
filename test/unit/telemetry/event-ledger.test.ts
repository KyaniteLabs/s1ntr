import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EventLedger,
  canonicalJson,
  createSinterEvent,
  filterEvents,
  fitnessObservationAsEvent,
  hashToolArgs,
  inputHash,
  isSinterEvent,
  queryEventLedger,
  readEventsFromFile,
  redactSecrets,
  resolveEventLedgerBaseDir,
  resolveEventLedgerPath,
  type SinterEvent,
  type SinterEventInput,
} from '../../../src/telemetry/EventLedger.js';
import { laneForEvent } from '../../../src/telemetry/events.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinter-event-ledger-'));
  roots.push(root);
  return root;
}

function baseEvent(
  event: string,
  overrides: Partial<SinterEventInput> = {},
): SinterEventInput {
  return {
    event,
    model: 'gpt-test',
    provider: 'openai',
    role: 'generator',
    runId: 'run-1',
    episodeId: 'ep-1',
    domain: 'p5',
    inputHash: inputHash({ prompt: 'hello' }),
    verdict: 'honest',
    latencyMs: 12,
    costUsd: null,
    evidenceRefs: [],
    payload: { ok: true },
    ts: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('laneForEvent', () => {
  it('maps dotted event names to lane directories', () => {
    expect(laneForEvent('generation.scored')).toBe('generation');
    expect(laneForEvent('eval.verdict')).toBe('eval');
    expect(laneForEvent('harness.action')).toBe('harness');
    expect(laneForEvent('seat.observation')).toBe('seat');
    expect(laneForEvent('solo')).toBe('solo');
  });
});

describe('hash helpers', () => {
  it('canonicalJson sorts keys so inputHash is deterministic', () => {
    const a = inputHash({ z: 1, a: { y: 2, b: 3 }, list: [1, 2] });
    const b = inputHash({ a: { b: 3, y: 2 }, list: [1, 2], z: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('hashToolArgs redacts secret-like keys before hashing', () => {
    const clean = hashToolArgs({ path: 'src/a.ts', content: 'x' });
    const withSecretA = hashToolArgs({
      path: 'src/a.ts',
      content: 'x',
      apiKey: 'sk-live-secret-value',
    });
    const withSecretB = hashToolArgs({
      path: 'src/a.ts',
      content: 'x',
      apiKey: 'sk-other-value',
    });
    const nested = hashToolArgs({
      path: 'src/a.ts',
      content: 'x',
      headers: { Authorization: 'Bearer tok', accept: 'json' },
    });

    expect(clean).not.toBe(withSecretA);
    // Different secret values with the same key name hash equal after redaction.
    expect(withSecretA).toBe(withSecretB);
    expect(JSON.stringify(redactSecrets({ apiKey: 'sk', token: 't', ok: 1 }))).toBe(
      JSON.stringify({ apiKey: '[redacted]', token: '[redacted]', ok: 1 }),
    );
    // Suffix/contains secret names (apiToken, accessToken, clientSecret, …).
    const suffixKeys = redactSecrets({
      apiToken: 'a',
      accessToken: 'b',
      clientSecret: 'c',
      dbPassword: 'd',
      refreshToken: 'e',
      authToken: 'f',
      path: 'ok',
    }) as Record<string, unknown>;
    expect(suffixKeys).toEqual({
      apiToken: '[redacted]',
      accessToken: '[redacted]',
      clientSecret: '[redacted]',
      dbPassword: '[redacted]',
      refreshToken: '[redacted]',
      authToken: '[redacted]',
      path: 'ok',
    });
    // Compound camelCase names (gate: openaiApiKey, bearerToken, authHeader).
    const compounds = redactSecrets({
      openaiApiKey: 'sk-openai',
      bearerToken: 'tok',
      authHeader: 'Bearer xyz',
      Authorization: 'Bearer abc',
      author: 'not-secret',
      path: 'ok',
    }) as Record<string, unknown>;
    expect(compounds).toEqual({
      openaiApiKey: '[redacted]',
      bearerToken: '[redacted]',
      authHeader: '[redacted]',
      Authorization: '[redacted]',
      author: 'not-secret',
      path: 'ok',
    });
    // Nested authorization redacted; digest must not embed raw secret strings.
    for (const d of [clean, withSecretA, nested]) {
      expect(d).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(d).not.toContain('sk-live');
      expect(d).not.toContain('Bearer');
    }
    expect(
      hashToolArgs({ tool: 'x', password: 'one' }),
    ).toBe(
      hashToolArgs({ tool: 'x', password: 'two' }),
    );
  });
});

describe('SinterEvent schema validation', () => {
  it('createSinterEvent fills schemaVersion and rejects malformed input fail-closed', () => {
    const ok = createSinterEvent(baseEvent('generation.scored'));
    expect(ok.schemaVersion).toBe(2);
    expect(ok.event).toBe('generation.scored');
    expect(isSinterEvent(ok)).toBe(true);

    expect(() => createSinterEvent(baseEvent('', { event: '' }))).toThrow(/event is required/);
    expect(() => createSinterEvent(baseEvent('x', {
      payload: null as unknown as Record<string, unknown>,
    }))).toThrow(/payload must be a non-null object/);
    expect(() => createSinterEvent(baseEvent('x', {
      latencyMs: Number.NaN,
    }))).toThrow(/latencyMs/);
    expect(() => createSinterEvent(baseEvent('x', {
      inputHash: 'not-a-hash',
    }))).toThrow(/inputHash/);
    expect(() => createSinterEvent(baseEvent('x', {
      evidenceRefs: [1 as unknown as string],
    }))).toThrow(/evidenceRefs/);
  });

  it('isSinterEvent rejects unversioned and malformed rows', () => {
    expect(isSinterEvent({ schemaVersion: 1, event: 'x' })).toBe(false);
    expect(isSinterEvent({ ...createSinterEvent(baseEvent('e')), payload: [] })).toBe(false);
    expect(isSinterEvent(null)).toBe(false);
  });
});

describe('event ledger path resolution', () => {
  it('defaults to ~/.sinter/telemetry/events and honors SINTER_EVENT_LEDGER_PATH', () => {
    const runtime = resolveEventLedgerBaseDir({
      home: '/tmp/sinter-home',
      cwd: '/tmp/repo',
      env: {},
    });
    const overridden = resolveEventLedgerBaseDir({
      cwd: '/tmp/repo',
      env: { SINTER_EVENT_LEDGER_PATH: 'runtime/events' },
    });
    const filePath = resolveEventLedgerPath('generation.scored', {
      home: '/tmp/sinter-home',
      env: {},
      day: '2026-07-26',
    });

    expect(runtime).toBe('/tmp/sinter-home/.sinter/telemetry/events');
    expect(overridden).toBe('/tmp/repo/runtime/events');
    expect(filePath).toBe(
      '/tmp/sinter-home/.sinter/telemetry/events/generation/2026-07-26.jsonl',
    );
  });
});

describe('event ledger persistence', () => {
  it('appends one JSONL row per record and supports concurrent writers', async () => {
    const root = await tempRoot();
    const filePath = path.join(root, 'events.jsonl');
    const ledger = new EventLedger({ filePath });

    await Promise.all(Array.from({ length: 30 }, (_, index) =>
      ledger.record(baseEvent('generation.scored', {
        runId: `run-${index}`,
        ts: `2026-07-26T00:00:${String(index).padStart(2, '0')}.000Z`,
        payload: { n: index },
      })),
    ));

    const { events, malformedCount } = await readEventsFromFile(filePath);
    expect(malformedCount).toBe(0);
    expect(events).toHaveLength(30);
    expect(new Set(events.map(e => e.runId)).size).toBe(30);
    expect(events.every(e => e.schemaVersion === 2)).toBe(true);
  });

  it('rotates atomically and bounds retained archives', async () => {
    const root = await tempRoot();
    const filePath = path.join(root, 'events.jsonl');
    const ledger = new EventLedger({
      filePath,
      maxBytes: 500,
      maxArchives: 2,
    });

    for (let index = 0; index < 8; index += 1) {
      await ledger.record(baseEvent('eval.verdict', {
        runId: String(index),
        ts: `2026-07-26T00:00:0${index}.000Z`,
        payload: { degraded: false, pad: 'x'.repeat(40) },
      }));
    }

    const { events, malformedCount } = await readEventsFromFile(filePath, { maxArchives: 2 });
    expect(malformedCount).toBe(0);
    // maxBytes=500 + maxArchives=2 → some rows rotate out; active+archives still hold several.
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeLessThanOrEqual(7);
    await expect(readFile(`${filePath}.3`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects oversized single events without writing', async () => {
    const root = await tempRoot();
    const filePath = path.join(root, 'events.jsonl');
    const ledger = new EventLedger({ filePath, maxBytes: 32 });

    await expect(ledger.record(baseEvent('harness.action', {
      payload: { tool: 'readFile', argsHash: inputHash({}), outcome: 'success' },
    }))).rejects.toThrow('exceeds the configured retention size');
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips malformed legacy lines on read without rewriting the file', async () => {
    const root = await tempRoot();
    const filePath = path.join(root, 'events.jsonl');
    const garbage = '{"schemaVersion":1,"event":"old"}\nnot-json\n';
    await writeFile(filePath, garbage);

    const { events, malformedCount } = await readEventsFromFile(filePath);
    expect(events).toEqual([]);
    expect(malformedCount).toBe(2);
    expect(await readFile(filePath, 'utf8')).toBe(garbage);
  });

  it('writes each lane event once under lane/day layout', async () => {
    const root = await tempRoot();
    const ledger = new EventLedger({ baseDir: root, day: '2026-07-26' });

    const generation = await ledger.record(baseEvent('generation.scored', {
      role: 'generator',
      payload: {
        schemaVersion: 1,
        timestamp: '2026-07-26T00:00:00.000Z',
        runId: 'run-1',
        episodeId: null,
        domain: 'p5',
        provider: 'openai',
        model: 'gpt-test',
        sourceFingerprint: inputHash('code'),
        score: 0.8,
        confidence: 1,
        failureClass: 'none',
        honest: true,
        graduationEligible: true,
        activeAdaptationIds: [],
        cohort: 'control',
      },
    }));
    const evalEvent = await ledger.record(baseEvent('eval.verdict', {
      role: 'evaluator',
      verdict: 'degraded',
      evidenceRefs: ['/tmp/shot.png'],
      payload: {
        degraded: true,
        reason: 'vision-degraded',
        visionEvidenceRefs: ['/tmp/shot.png'],
      },
    }));
    const harness = await ledger.record(baseEvent('harness.action', {
      role: 'harness',
      domain: 'harness',
      inputHash: hashToolArgs({ path: 'a.ts', apiKey: 'sk-secret' }),
      verdict: 'success',
      payload: {
        tool: 'readFile',
        argsHash: hashToolArgs({ path: 'a.ts', apiKey: 'sk-secret' }),
        outcome: 'success',
      },
    }));

    expect(generation?.filePath).toContain(`${path.sep}generation${path.sep}2026-07-26.jsonl`);
    expect(evalEvent?.filePath).toContain(`${path.sep}eval${path.sep}2026-07-26.jsonl`);
    expect(harness?.filePath).toContain(`${path.sep}harness${path.sep}2026-07-26.jsonl`);

    const { events } = await queryEventLedger({}, { baseDir: root, includeLegacyFitness: false });
    expect(events).toHaveLength(3);
    expect(events.filter(e => e.event === 'generation.scored')).toHaveLength(1);
    expect(events.filter(e => e.event === 'eval.verdict')).toHaveLength(1);
    expect(events.filter(e => e.event === 'harness.action')).toHaveLength(1);
    const harnessPayload = events.find(e => e.event === 'harness.action')!.payload;
    expect(JSON.stringify(harnessPayload)).not.toContain('sk-secret');
  });
});

describe('query and legacy fitness lift', () => {
  it('filterEvents applies event, model, role, since, and limit', () => {
    const rows: SinterEvent[] = [
      createSinterEvent(baseEvent('generation.scored', {
        model: 'a', role: 'generator', ts: '2026-07-01T00:00:00.000Z', runId: '1',
      })),
      createSinterEvent(baseEvent('eval.verdict', {
        model: 'b', role: 'evaluator', ts: '2026-07-02T00:00:00.000Z', runId: '2',
      })),
      createSinterEvent(baseEvent('harness.pass.complete', {
        model: 'c', role: 'harness', ts: '2026-07-03T00:00:00.000Z', runId: '3',
      })),
    ];

    expect(filterEvents(rows, { event: 'generation.scored' }).map(e => e.runId)).toEqual(['1']);
    expect(filterEvents(rows, { model: 'b' }).map(e => e.runId)).toEqual(['2']);
    expect(filterEvents(rows, { role: 'harness' }).map(e => e.runId)).toEqual(['3']);
    expect(filterEvents(rows, { since: '2026-07-02T00:00:00.000Z' }).map(e => e.runId)).toEqual(['2', '3']);
    expect(filterEvents(rows, { limit: 1 }).map(e => e.runId)).toEqual(['1']);
  });

  it('lifts FitnessObservation v1 as generation.scored payload', () => {
    const obs = {
      schemaVersion: 1,
      timestamp: '2026-07-26T00:00:00.000Z',
      runId: 'fit-1',
      episodeId: 'fit-1',
      domain: 'p5',
      provider: 'openai',
      model: 'gpt-test',
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      score: 0.8,
      confidence: 1,
      failureClass: 'none',
      honest: true,
      graduationEligible: true,
      activeAdaptationIds: [] as string[],
      cohort: 'control' as const,
    };
    const lifted = fitnessObservationAsEvent(obs);
    expect(lifted).toMatchObject({
      schemaVersion: 2,
      event: 'generation.scored',
      role: 'generator',
      runId: 'fit-1',
      domain: 'p5',
      verdict: 'honest',
      inputHash: obs.sourceFingerprint,
    });
    expect(lifted?.payload).toEqual(obs);
    expect(isSinterEvent(lifted)).toBe(true);
    expect(fitnessObservationAsEvent({ schemaVersion: 2 })).toBeNull();
    // Invalid fingerprint must not bypass createSinterEvent validation.
    const badHash = fitnessObservationAsEvent({
      ...obs,
      sourceFingerprint: 'not-a-valid-hash',
    });
    expect(badHash?.inputHash).toBeNull();
    expect(badHash?.role).toBe('generator');
    expect(isSinterEvent(badHash)).toBe(true);
  });

  it('queryEventLedger merges ledger rows with legacy fitness file', async () => {
    const root = await tempRoot();
    const baseDir = path.join(root, 'events');
    const fitnessPath = path.join(root, 'fitness.jsonl');
    const ledger = new EventLedger({ baseDir, day: '2026-07-26' });
    await ledger.record(baseEvent('harness.action', {
      model: 'gpt-test',
      runId: 'h-1',
      payload: { tool: 'readFile', argsHash: inputHash({}), outcome: 'success' },
    }));

    await writeFile(fitnessPath, `${JSON.stringify({
      schemaVersion: 1,
      timestamp: '2026-07-26T01:00:00.000Z',
      runId: 'fit-legacy',
      episodeId: 'fit-legacy',
      domain: 'hydra',
      provider: 'openai',
      model: 'gpt-test',
      sourceFingerprint: `sha256:${'b'.repeat(64)}`,
      score: 0.5,
      confidence: 1,
      failureClass: 'none',
      honest: true,
      graduationEligible: true,
      activeAdaptationIds: [],
      cohort: 'control',
    })}\n`);

    const all = await queryEventLedger({}, {
      baseDir,
      fitnessPath,
      includeLegacyFitness: true,
    });
    expect(all.events.map(e => e.event).sort()).toEqual(['generation.scored', 'harness.action']);

    const onlyHarness = await queryEventLedger({ event: 'harness.action' }, {
      baseDir,
      fitnessPath,
      includeLegacyFitness: true,
    });
    expect(onlyHarness.events).toHaveLength(1);
    expect(onlyHarness.events[0].runId).toBe('h-1');

    const limited = await queryEventLedger({ model: 'gpt-test', limit: 1 }, {
      baseDir,
      fitnessPath,
      includeLegacyFitness: true,
    });
    expect(limited.events).toHaveLength(1);
  });
});
