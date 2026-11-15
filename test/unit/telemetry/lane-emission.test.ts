/**
 * Lane emission: real producer paths write ledger rows (not hand-built shapes).
 * Override NODE_ENV=test skip via SINTER_EVENT_LEDGER_PATH / forceInTest.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitRalphLoopScoringEvents } from '../../../src/core/RalphLoop.js';
import { HarnessAgent } from '../../../src/harness/agent/HarnessAgent.js';
import { rateLimiter } from '../../../src/harness/tools/RateLimiter.js';
import { telemetryWrapper } from '../../../src/harness/tools/TelemetryWrapper.js';
import { CapabilityRegistry } from '../../../src/llm/CapabilityRegistry.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import {
  EventLedger,
  classifyToolError,
  hashToolArgs,
  inputHash,
  queryEventLedger,
} from '../../../src/telemetry/EventLedger.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  CapabilityRegistry.clearOverrides();
  delete process.env.SINTER_EVENT_LEDGER_PATH;
  delete process.env.SINTER_EVENT_LEDGER_FORCE;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tempBase(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinter-lane-emit-'));
  roots.push(root);
  return root;
}

describe('classifyToolError (no raw prose in payload)', () => {
  it('maps ApplyEdit-style leaks to string_not_found without retaining content', () => {
    const leak = 'String not found in file. Expected:\napiToken=sk-live-secret-value...';
    expect(classifyToolError(leak)).toBe('string_not_found');
    expect(classifyToolError('Request timed out after 30s')).toBe('timeout');
    expect(classifyToolError('Rate limit exceeded')).toBe('rate_limit');
    expect(classifyToolError('unknown failure xyz')).toBe('tool_error');
    expect(classifyToolError(undefined)).toBeUndefined();
  });
});

describe('telemetry lane emission — real producers', () => {
  it('RalphLoop scoring emit writes generation.scored + eval.verdict once', async () => {
    const baseDir = await tempBase();
    process.env.SINTER_EVENT_LEDGER_PATH = baseDir;

    const obs = {
      schemaVersion: 1 as const,
      timestamp: '2026-07-26T00:00:00.000Z',
      runId: 'gen-1',
      episodeId: 'gen-1',
      domain: 'p5',
      provider: 'openai',
      model: 'gpt-test',
      sourceFingerprint: inputHash('sketch'),
      score: 0.8,
      confidence: 1,
      failureClass: 'none',
      honest: true,
      graduationEligible: true,
      activeAdaptationIds: [] as string[],
      cohort: 'control' as const,
    };

    await emitRalphLoopScoringEvents(obs, 100);

    const gen = await queryEventLedger({ event: 'generation.scored' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    const ev = await queryEventLedger({ event: 'eval.verdict' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    expect(gen.events).toHaveLength(1);
    expect(gen.events[0].role).toBe('generator');
    expect(gen.events[0].payload).toMatchObject({ schemaVersion: 1, score: 0.8, honest: true });
    expect(ev.events).toHaveLength(1);
    expect(ev.events[0].payload).toMatchObject({
      score: 0.8,
      confidence: 1,
      failureClass: 'none',
      degraded: false,
    });
    // Optional fields present when known (lane shape consistency).
    expect(ev.events[0].payload).toHaveProperty('score');
    expect(ev.events[0].payload).toHaveProperty('confidence');
    expect(ev.events[0].payload).toHaveProperty('failureClass');
  });

  it('LLMClient vision-degraded emit writes eval.verdict with failureClass, no raw drop prose as reason', async () => {
    const baseDir = await tempBase();
    process.env.SINTER_EVENT_LEDGER_PATH = baseDir;

    const TEXT_ONLY = 'qwen2.5-7b-instruct';
    const provider = {
      name: 'openai',
      getModel: vi.fn(() => TEXT_ONLY),
      getConfig: vi.fn(() => ({ model: TEXT_ONLY, provider: 'openai', baseUrl: 'https://api.openai.com/v1' })),
      setModel: vi.fn(),
      generate: vi.fn(async () => ok({ content: 'function setup() {}', success: true })),
    };
    const client = new LLMClient({ model: TEXT_ONLY, apiKey: 'fake-test-key' });
    vi.spyOn(client as never as { resolveModel: () => Promise<string> }, 'resolveModel')
      .mockResolvedValue(TEXT_ONLY);
    vi.spyOn(client as never as { getProvider: () => Promise<unknown> }, 'getProvider')
      .mockResolvedValue(provider);

    await client.generate('system', 'user prompt', undefined, true, [{
      mimeType: 'image/png',
      dataBase64: 'ZmFrZS1wbng=',
      width: 400,
      height: 400,
      label: 'rendered-artifact',
    }]);

    // recordEvent is fire-and-forget; flush microtasks
    await new Promise(r => setTimeout(r, 50));

    const { events } = await queryEventLedger({ event: 'eval.verdict' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe('vision-degraded');
    expect(events[0].payload).toMatchObject({
      degraded: true,
      failureClass: 'scorer',
      reason: 'vision-degraded',
    });
    expect(events[0].payload).toHaveProperty('failureClass', 'scorer');
    expect(events[0].payload).not.toHaveProperty('score');
    expect(events[0].payload).not.toHaveProperty('confidence');
    expect(events[0].evidenceRefs).toEqual(['rendered-artifact']);
  });

  it('HarnessAgent tool emit writes harness.action with errorClass only (no raw error leak)', async () => {
    const baseDir = await tempBase();
    process.env.SINTER_EVENT_LEDGER_PATH = baseDir;

    const mockLLM = {
      config: { model: 'harness-model' },
      getConfig: () => ({ model: 'harness-model' }),
    };
    const agent = new HarnessAgent(mockLLM as unknown as LLMClient);

    const leakError =
      'String not found in file. Expected:\napiToken=sk-live-SECRET\noldString-content-leak';
    vi.spyOn(
      agent as unknown as {
        getToolInstance: (name: string) => { execute: (p: unknown) => Promise<unknown> } | null;
      },
      'getToolInstance',
    ).mockReturnValue({
      execute: async () => ({ success: false, error: leakError }),
    });

    // Spy singletons to avoid delays and pass through tool.execute.
    vi.spyOn(rateLimiter, 'execute').mockImplementation(async (_op, fn) => ({ result: await fn() }));
    vi.spyOn(telemetryWrapper, 'wrap').mockImplementation(async (tool, params) => tool.execute(params));

    const secretParams = {
      path: 'src/a.ts',
      oldString: 'apiToken=sk-live-SECRET',
      newString: 'x',
      apiToken: 'sk-should-never-hash-raw',
    };
    const result = await (agent as unknown as {
      callTool: (name: string, params: unknown) => Promise<{ success: boolean; error?: string }>;
    }).callTool('applyEdit', secretParams);

    expect(result.success).toBe(false);
    expect(result.error).toContain('sk-live-SECRET'); // tool return still has raw error

    await new Promise(r => setTimeout(r, 50));

    const { events } = await queryEventLedger({ event: 'harness.action' }, {
      baseDir,
      includeLegacyFitness: false,
    });
    expect(events).toHaveLength(1);
    const row = events[0];
    expect(row.domain).toBe('harness');
    expect(row.role).toBe('harness');
    expect(row.payload.tool).toBe('applyEdit');
    expect(row.payload.outcome).toBe('failure');
    expect(row.payload.errorClass).toBe('string_not_found');
    expect(row.payload).not.toHaveProperty('error');
    expect(row.payload.argsHash).toBe(hashToolArgs(secretParams));
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('sk-live-SECRET');
    expect(serialized).not.toContain('oldString-content-leak');
    expect(serialized).not.toContain('sk-should-never-hash-raw');
  });

  it('real ApplyEditTool string_not_found never leaks oldString secret into harness.action row', async () => {
    const baseDir = await tempBase();
    process.env.SINTER_EVENT_LEDGER_PATH = baseDir;
    // Must live under allowed project prefixes (src/tmp) for ApplyEditTool.validatePath.
    const tmpDir = path.join(process.cwd(), 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const targetFile = path.join(tmpDir, `__apply_edit_secret_ledger_${Date.now()}.ts`);
    await writeFile(targetFile, 'export const value = 1;\n');

    try {
      const mockLLM = {
        config: { model: 'harness-model' },
        getConfig: () => ({ model: 'harness-model' }),
      };
      const agent = new HarnessAgent(mockLLM as unknown as LLMClient);

      // Real tool path — only strip rate-limit delay / telemetry wrapper.
      vi.spyOn(rateLimiter, 'execute').mockImplementation(async (_op, fn) => ({ result: await fn() }));
      vi.spyOn(telemetryWrapper, 'wrap').mockImplementation(async (tool, params) => tool.execute(params));

      const FAKE_SECRET = 'sk-testsecret123';
      const params = {
        path: targetFile,
        oldString: FAKE_SECRET,
        newString: 'x',
        createBackup: false,
      };
      const result = await (agent as unknown as {
        callTool: (name: string, params: unknown) => Promise<{ success: boolean; error?: string }>;
      }).callTool('applyEdit', params);

      expect(result.success).toBe(false);
      // ApplyEditTool embeds oldString.slice(0,200) in result.error (tool return OK).
      expect(result.error).toContain(FAKE_SECRET);
      expect(classifyToolError(result.error)).toBe('string_not_found');

      await new Promise(r => setTimeout(r, 50));

      const { events } = await queryEventLedger({ event: 'harness.action' }, {
        baseDir,
        includeLegacyFitness: false,
      });
      expect(events).toHaveLength(1);
      const row = events[0];
      expect(row.payload.errorClass).toBe('string_not_found');
      expect(row.payload).not.toHaveProperty('error');
      expect(row.domain).toBe('harness');
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(FAKE_SECRET);
      expect(serialized).not.toContain('sk-testsecret');
    } finally {
      await rm(targetFile, { force: true });
    }
  });

  it('EventLedger.record returns null in test without explicit path; forceInTest overrides', async () => {
    const skipped = await new EventLedger().record({
      event: 'seat.observation',
      model: null,
      provider: null,
      role: null,
      runId: null,
      episodeId: null,
      domain: null,
      inputHash: null,
      verdict: null,
      latencyMs: null,
      costUsd: null,
      evidenceRefs: [],
      payload: { note: 'skip', seat: 's', actorModel: 'm' },
    });
    expect(skipped).toBeNull();

    const root = await tempBase();
    const forced = await new EventLedger({ baseDir: root, day: '2026-07-26', forceInTest: true }).record({
      event: 'seat.observation',
      model: null,
      provider: null,
      role: null,
      runId: null,
      episodeId: null,
      domain: null,
      inputHash: null,
      verdict: null,
      latencyMs: null,
      costUsd: null,
      evidenceRefs: [],
      payload: { note: 'forced', seat: 's', actorModel: 'm' },
    });
    expect(forced?.event.payload).toMatchObject({ note: 'forced' });
  });
});
