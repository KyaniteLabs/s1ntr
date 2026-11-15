import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatLearnedGuidanceSection,
  formatAdaptationGuidanceLine,
  extractAdaptationId,
  identityOracleContainsAdaptationId,
  prependLearnedToDescription,
  writeDiagnosePlanFile,
  recordSelfImproveOutcome,
  withLearnedGuidance,
  LEARNED_SECTION_HEADER,
} from '../../../src/harness/SelfImproveCompoundLoop.js';
import { Status } from '../../../src/types/status.js';

const { mockLog, mockAnalyze, mockRecordPattern, mockRecordAdaptation, mockRecordEpisode, mockGetAdaptations } = vi.hoisted(() => ({
  mockLog: vi.fn(() => ({ written: true as const, path: '/tmp/failures/1-abcdefghi.json', id: '1-abcdefghi' })),
  mockAnalyze: vi.fn(() => []),
  mockRecordPattern: vi.fn(),
  mockRecordAdaptation: vi.fn(() => 'adapt_test'),
  mockRecordEpisode: vi.fn(() => 'ep_test'),
  mockGetAdaptations: vi.fn(() => []),
}));

vi.mock('../../../src/harness/FailureLogger.js', () => ({
  failureLogger: {
    log: mockLog,
    getSessionId: () => 'test-session',
  },
}));

vi.mock('../../../src/harness/PatternDetector.js', () => ({
  patternDetector: {
    analyze: mockAnalyze,
  },
}));

vi.mock('../../../src/harness/HarnessMemory.js', () => ({
  harnessMemory: {
    initialize: vi.fn(async () => undefined),
    save: vi.fn(async () => ({ isErr: () => false })),
    recordPatternOccurrence: mockRecordPattern,
    recordAdaptation: mockRecordAdaptation,
    recordEpisode: mockRecordEpisode,
    getAdaptations: mockGetAdaptations,
  },
}));

describe('SelfImproveCompoundLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnalyze.mockReturnValue([]);
    mockRecordAdaptation.mockReturnValue('adapt_test');
    mockGetAdaptations.mockReturnValue([]);
  });

  it('formatLearnedGuidanceSection returns empty for no lines', () => {
    expect(formatLearnedGuidanceSection([])).toBe('');
    expect(formatLearnedGuidanceSection(['  ', ''])).toBe('');
  });

  it('formatLearnedGuidanceSection caps lines and truncates long ones', () => {
    const long = 'x'.repeat(300);
    const section = formatLearnedGuidanceSection([long, 'b', 'c', 'd']);
    expect(section).toContain(LEARNED_SECTION_HEADER);
    expect(section).toContain('- b');
    expect(section).toContain('- c');
    expect(section).not.toContain('- d');
    expect(section).toMatch(/…/);
    expect(section.split('\n').filter((l) => l.startsWith('- ')).length).toBe(3);
  });

  it('truncation bounds the body but keeps a long identity tag whole (#1292)', () => {
    const id = `adapt_${'a'.repeat(100)}`;
    const line = formatAdaptationGuidanceLine(
      { id, description: 'y'.repeat(400) },
      { provenance: 'harness-memory' },
    );
    const bullet = formatLearnedGuidanceSection([line]).split('\n')[1];
    const tag = `[adaptation:${id} provenance:harness-memory]`;

    expect(bullet.startsWith(`- ${tag} y`)).toBe(true);
    expect(bullet.length - 2).toBe(240);
    expect(bullet.endsWith('…')).toBe(true);
    expect(identityOracleContainsAdaptationId(bullet, id)).toBe(true);
  });

  it('drops lines whose adaptation tag is malformed or unbounded instead of cutting it (#1292)', () => {
    const huge = `[adaptation:adapt_${'z'.repeat(300)}] do the thing`;
    const unclosed = '[adaptation:adapt_1 do the thing';
    const section = formatLearnedGuidanceSection([huge, unclosed, '[adaptation:adapt_ok] keep me']);
    expect(section.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- [adaptation:adapt_ok] keep me']);
  });

  it('identity oracle matches the exact id, not an id prefix (#1292)', () => {
    const text = '- [adaptation:adapt_10 provenance:harness-memory] tip\n- [adaptation:adapt_2] other';
    expect(identityOracleContainsAdaptationId(text, 'adapt_1')).toBe(false);
    expect(identityOracleContainsAdaptationId(text, 'adapt_10')).toBe(true);
    expect(identityOracleContainsAdaptationId(text, 'adapt_2')).toBe(true);
    expect(identityOracleContainsAdaptationId('[adaptation:adapt_1x] [adaptation:adapt_1]', 'adapt_1')).toBe(true);
  });

  it('formatLearnedGuidanceSection dedupes near-identical tips (compound P1)', () => {
    const section = formatLearnedGuidanceSection([
      'Persist receipts/*-plan.md on diagnose success',
      'persist receipts/*-plan.md on diagnose success',
      '  Persist receipts/*-plan.md on diagnose success  ',
      'Raise diagnose maxTokens',
    ]);
    const bullets = section.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBe(2);
    expect(section).toContain('Raise diagnose maxTokens');
  });

  it('withLearnedGuidance creates a measurable prompt delta vs baseline (compound P0 proof)', () => {
    const baseline = 'ARCHITECT DIAGNOSE ONLY — residual';
    expect(withLearnedGuidance(baseline)).toBe(baseline);

    mockGetAdaptations.mockReturnValue([
      { description: 'Wire writeDiagnosePlanFile for harvest' },
      { description: 'Flush HarnessMemory on outcome' },
    ]);
    const withMemory = withLearnedGuidance(baseline);
    expect(withMemory).not.toBe(baseline);
    expect(withMemory.length).toBeGreaterThan(baseline.length);
    expect(withMemory).toContain(LEARNED_SECTION_HEADER);
    expect(withMemory).toContain('Wire writeDiagnosePlanFile');
    expect(withMemory).toContain(baseline);
  });

  it('injects adaptation ids into learned guidance lines (#583 identity feed-forward)', () => {
    mockGetAdaptations.mockReturnValue([
      {
        id: 'adapt_passA_deadbeef',
        description: 'Persist receipts/*-plan.md on diagnose success',
      },
      {
        id: 'adapt_older',
        description: 'old tip',
      },
    ]);
    const next = withLearnedGuidance('ARCHITECT DIAGNOSE ONLY');
    expect(next).toContain('[adaptation:adapt_passA_deadbeef');
    expect(next).toContain('provenance:harness-memory');
    expect(next).toContain('Persist receipts');
    expect(extractAdaptationId(next.split('\n').find((l) => l.includes('adapt_passA')) || '')).toBe(
      'adapt_passA_deadbeef',
    );
    expect(identityOracleContainsAdaptationId(next, 'adapt_passA_deadbeef')).toBe(true);
    expect(identityOracleContainsAdaptationId(next, 'adapt_missing')).toBe(false);
  });

  it('formatAdaptationGuidanceLine is pure and stable', () => {
    expect(formatAdaptationGuidanceLine({ id: 'adapt_1', description: 'fix it' })).toBe(
      '[adaptation:adapt_1] fix it',
    );
    expect(
      formatAdaptationGuidanceLine(
        { id: 'adapt_1', description: 'fix it' },
        { provenance: 'harness-memory' },
      ),
    ).toBe('[adaptation:adapt_1 provenance:harness-memory] fix it');
    expect(formatAdaptationGuidanceLine({ description: 'no id tip' })).toBe('no id tip');
  });

  it('prependLearnedToDescription is idempotent', () => {
    const learned = `${LEARNED_SECTION_HEADER}\n- tip\n`;
    const once = prependLearnedToDescription('body', learned);
    expect(once).toContain(LEARNED_SECTION_HEADER);
    expect(once).toContain('body');
    const twice = prependLearnedToDescription(once, learned);
    expect(twice).toBe(once);
  });

  it('withLearnedGuidance injects recent adaptations from HarnessMemory and is quiet when empty', () => {
    expect(withLearnedGuidance('plain brief')).toBe('plain brief');
    // Array is append-ordered; load prefers recent (tail) first, caps at 3.
    mockGetAdaptations.mockReturnValue([
      { description: 'oldest-should-not-appear' },
      { description: 'Raise diagnose maxTokens before finish_reason=length' },
      { description: 'Persist receipts/*-plan.md on diagnose success' },
      { description: 'Record self-improve outcomes into FailureLogger' },
    ]);
    const next = withLearnedGuidance('ARCHITECT DIAGNOSE ONLY');
    expect(next).toContain(LEARNED_SECTION_HEADER);
    expect(next).toContain('Raise diagnose maxTokens');
    expect(next).toContain('Persist receipts');
    expect(next).toContain('Record self-improve outcomes');
    expect(next).toContain('ARCHITECT DIAGNOSE ONLY');
    expect(next).not.toContain('oldest-should-not-appear');
  });

  it('writeDiagnosePlanFile writes plan markdown under receipts/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-plan-'));
    try {
      const path = writeDiagnosePlanFile(dir, 'harness-compound-diagnose-plan', '# Plan\n\n' + 'x'.repeat(200));
      expect(path).toContain('harness-compound-diagnose-plan-plan.md');
      const body = readFileSync(path, 'utf8');
      expect(body.startsWith('# Plan')).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recordSelfImproveOutcome logs failure and records adaptation when failed', async () => {
    mockAnalyze.mockReturnValue([{ name: 'timeout-pattern', severity: 'high' }]);
    const out = await recordSelfImproveOutcome(
      { status: Status.FAILED, stepCount: 3, lastPlanError: 'boom', toolsUsed: ['readFile'] },
      { taskId: 'tui-self-1', model: 'test-model', description: 'fix something' },
    );
    expect(out.loggedFailure).toBe(true);
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0].error).toContain('boom');
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    expect(mockRecordPattern).toHaveBeenCalledWith('timeout-pattern', 'harness-self-improve');
    expect(mockRecordAdaptation).toHaveBeenCalledTimes(1);
    expect(out.patterns).toBe(1);
  });

  it('recordSelfImproveOutcome reports loggedFailure=false when the failure record did not reach disk (#1313)', async () => {
    mockLog.mockReturnValueOnce({ written: false, id: '1-abcdefghi', error: 'ENOSPC: no space left on device' });
    const out = await recordSelfImproveOutcome(
      { status: Status.FAILED, stepCount: 1, lastPlanError: 'boom' },
      { taskId: 'tui-self-disk-full', model: 'test-model', description: 'fix something' },
    );
    expect(out.loggedFailure).toBe(false);
    // Downstream learning still happens; only the disk-evidence claim changes.
    expect(out.adaptationIds).toEqual(['adapt_test']);
  });

  it('recordSelfImproveOutcome records episode on success without FailureLogger', async () => {
    const out = await recordSelfImproveOutcome(
      { status: Status.SUCCESS, stepCount: 2, toolsUsed: ['typeCheck'] },
      { taskId: 'tui-self-2', model: 'test-model', description: 'happy path' },
    );
    expect(out.loggedFailure).toBe(false);
    expect(mockLog).not.toHaveBeenCalled();
    expect(mockRecordEpisode).toHaveBeenCalledTimes(1);
  });

  it('recordSelfImproveOutcome records diagnose-plan adaptation when plan present', async () => {
    const plan = 'x'.repeat(250);
    await recordSelfImproveOutcome(
      { status: Status.SUCCESS, stepCount: 4, diagnosePlan: plan },
      { taskId: 'tui-diagnose-1', model: 'glm-5.2', description: 'diagnose', kind: 'diagnose' },
    );
    expect(mockRecordAdaptation).toHaveBeenCalledWith(
      expect.objectContaining({
        patternName: 'diagnose-plan-delivered',
        success: true,
      }),
    );
  });

  it('harvest E2E: diagnosePlan ≥200 yields adaptation that withLearnedGuidance surfaces', async () => {
    const plan = '# Residual plan\n\n' + 'Evidence path src/harness/SelfImproveCompoundLoop.ts. '.repeat(10);
    expect(plan.length).toBeGreaterThanOrEqual(200);
    await recordSelfImproveOutcome(
      { status: Status.SUCCESS, stepCount: 3, diagnosePlan: plan, toolsUsed: ['readFile', 'complete'] },
      { taskId: 'tui-diagnose-harvest', model: 'grok-4.5', description: 'diagnose harvest', kind: 'diagnose' },
    );
    mockGetAdaptations.mockReturnValue([
      {
        description: `Diagnose plan delivered (${plan.length} chars) for tui-diagnose-harvest`,
        patternName: 'diagnose-plan-delivered',
        success: true,
      },
    ]);
    const next = withLearnedGuidance('NEXT BRIEF');
    expect(next).toContain(LEARNED_SECTION_HEADER);
    expect(next).toContain('Diagnose plan delivered');
    expect(next).toContain('tui-diagnose-harvest');
    expect(next).toContain('NEXT BRIEF');
  });
});
