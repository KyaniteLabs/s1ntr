/**
 * `sinter swarm run|sessions|label` contract tests (#1295).
 *
 * Acceptance A–D from the spec:
 * A. run writes a complete `liminal.swarm-session.v1` record + candidate sources
 * B. label writes a valid ledger and a replay records 0 with an unchanged file
 * C. the next run reports the labelled voters in `calibratedVoterIds`
 * D. guards exit non-zero without writing (skip/replay exit 0 as specified)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveLedgerPath,
  resolveSessionDir,
  runSwarmCli,
  type SwarmCliDeps,
  type SwarmCliFlags,
} from '../../../src/cli/SwarmCli.js';
import { VotingEngine } from '../../../src/swarm/VotingEngine.js';
import { SWARM_SESSION_SCHEMA } from '../../../src/swarm/SwarmSession.js';
import type { SwarmOllamaCaller, SwarmPersona } from '../../../src/swarm/types.js';

const PROMPT = 'a geometric grid that breathes';
const SVG_CODE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

function persona(id: string, displayName: string): SwarmPersona {
  return {
    id,
    name: id,
    displayName,
    model: 'm1',
    temperature: 0.7,
    maxTokens: 100,
    systemPrompt: `You are ${displayName}.`,
    voice: '',
    thinkingStyle: '',
    votingBias: '',
    constraints: [],
    votingPower: 1,
  };
}

const PERSONAS = [
  persona('kai', 'The Architect'),
  persona('nova', 'The Synthesizer'),
  persona('rex', 'The Improviser'),
];

/** Generation returns SVG (no preview export); voting always elects Piece A. */
const STUB_CALLER: SwarmOllamaCaller = async (_model, _systemPrompt, userPrompt) => {
  if (userPrompt.includes('Piece A')) return '1st: A\n2nd: B\nReasoning: A is strongest';
  return SVG_CODE;
};

interface Invocation {
  code: number;
  out: string[];
  err: string[];
  text: string;
  errText: string;
}

describe('sinter swarm CLI (#1295)', () => {
  let root: string;
  let sessionDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    VotingEngine.clearPerformanceHistory();
    root = mkdtempSync(join(tmpdir(), 'swarm-cli-'));
    sessionDir = join(root, 'sessions');
    ledgerPath = join(root, 'ledger.json');
  });

  afterEach(() => {
    VotingEngine.clearPerformanceHistory();
    rmSync(root, { recursive: true, force: true });
  });

  async function invoke(
    argv: string[],
    flags: SwarmCliFlags = {},
    overrides: Partial<SwarmCliDeps> = {},
  ): Promise<Invocation> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSwarmCli(argv, { sessionDir, ledger: ledgerPath, ...flags }, {
      home: root,
      cwd: root,
      env: {},
      projectConfig: null,
      stdinIsTTY: false,
      stdout: (line = '') => out.push(line),
      stderr: (line = '') => err.push(line),
      callOllama: STUB_CALLER,
      swarmConfig: { personas: PERSONAS, skipRouting: true },
      ...overrides,
    });
    return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
  }

  function writeRawSession(id: string, body: Record<string, unknown>): void {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify(body));
  }

  function records(): Array<Record<string, any>> {
    if (!existsSync(sessionDir)) return [];
    return readdirSync(sessionDir)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(sessionDir, name), 'utf-8')) as Record<string, any>);
  }

  function onlySession(): Record<string, any> {
    const all = records();
    expect(all).toHaveLength(1);
    return all[0];
  }

  function hashFile(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  describe('A. run writes a complete session record', () => {
    it('persists prompt, inferred domain, rounds, and candidate sources without a TTY prompt', async () => {
      const result = await invoke(['run'], { prompt: PROMPT, swarmRounds: 1 });

      expect(result.code).toBe(0);
      expect(result.text).toContain('Swarm output is exploratory; a label calibrates voter weights, it does not admit an artifact.');
      expect(result.text).toContain('Label later with: sinter swarm label ');
      expect(result.text).toContain('Calibrated voters (geometric): none yet');
      // Blind: no persona/model name before a pick (there is no pick here).
      expect(result.text).not.toMatch(/\b(kai|nova|rex)\b/);
      expect(result.text).not.toContain('The Architect');

      const session = onlySession();
      expect(session.schema).toBe(SWARM_SESSION_SCHEMA);
      expect(session.prompt).toBe(PROMPT);
      expect(session.domain).toBe('geometric');
      expect(session.mode).toBe('hybrid');
      expect(session.rounds).toHaveLength(1);
      expect(Object.keys(session.rounds[0].votes).sort()).toEqual(['kai', 'nova', 'rex']);
      expect(session.candidates.map((c: any) => c.index)).toEqual([1, 2, 3]);
      expect(session.candidates.map((c: any) => c.personaId)).toEqual(['kai', 'nova', 'rex']);
      for (const candidate of session.candidates) {
        expect(existsSync(candidate.sourcePath)).toBe(true);
      }
      // A run never creates the ledger.
      expect(existsSync(ledgerPath)).toBe(false);
    });

    it('rejects --domain (v1 infers the domain from the prompt)', async () => {
      const result = await invoke(['run'], { prompt: PROMPT, domain: 'organic' });
      expect(result.code).toBe(1);
      expect(result.errText).toContain('--domain is not supported');
      expect(records()).toHaveLength(0);
    });
  });

  describe('B. label writes the ledger; replays are no-ops', () => {
    it('records a human label from the run prompt and writes a valid ledger', async () => {
      const result = await invoke(['run'], { prompt: PROMPT, swarmRounds: 1 }, {
        stdinIsTTY: true,
        ask: async () => '1',
      });

      expect(result.code).toBe(0);
      expect(result.text).toContain('✓ Label recorded: #1 (kai, The Architect)');
      expect(result.text).toContain('3 votes from 3 voters across 1 round');
      expect(result.text).toContain('outcomeId swarm:');

      const session = onlySession();
      expect(session.label).toMatchObject({
        source: 'human',
        goldWinner: 'kai',
        recordedVotes: 3,
        recordedVoters: ['kai', 'nova', 'rex'],
      });
      expect(session.label.outcomeId).toBe(`swarm:${session.sessionId}`);

      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Record<string, any>;
      expect(ledger.schema).toBe('liminal.voting-calibration.v1');
      expect(ledger.outcomes).toContain(`swarm:${session.sessionId}#r0:kai`);
      expect(ledger.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ expertId: 'kai', domain: 'geometric', correctVotes: 1, totalVotes: 1 }),
      ]));
    });

    it('labels an existing session by persona id, blind before the pick', async () => {
      await invoke(['run'], { prompt: PROMPT, swarmRounds: 1, noLabel: true });
      const id = onlySession().sessionId as string;

      const result = await invoke(['label', id], { winner: 'nova' });

      expect(result.code).toBe(0);
      expect(result.text).toContain('Prompt: ' + PROMPT);
      const labelLine = result.out.findIndex(line => line.includes('✓ Label recorded'));
      expect(labelLine).toBeGreaterThan(0);
      const beforePick = result.out.slice(0, labelLine).join('\n');
      expect(beforePick).not.toMatch(/\b(kai|nova|rex)\b/);
      expect(beforePick).not.toContain('The Synthesizer');
      expect(onlySession().label).toMatchObject({ goldWinner: 'nova', source: 'human' });
    });

    it('is a replay on the second invocation: 0 new votes, ledger byte-identical', async () => {
      await invoke(['run'], { prompt: PROMPT, swarmRounds: 1, noLabel: true });
      const id = onlySession().sessionId as string;
      await invoke(['label', id], { winner: 'nova' });
      const before = hashFile(ledgerPath);
      const sessionBefore = readFileSync(join(sessionDir, `${id}.json`), 'utf-8');

      const replay = await invoke(['label', id], { winner: 'kai' });

      expect(replay.code).toBe(0);
      expect(replay.text).toContain('Already labelled: nova on');
      expect(replay.text).toContain('0 new votes; ledger unchanged');
      expect(hashFile(ledgerPath)).toBe(before);
      expect(readFileSync(join(sessionDir, `${id}.json`), 'utf-8')).toBe(sessionBefore);
    });
  });

  describe('B2. heuristic self-votes never calibrate the ledger', () => {
    const SESSION_ID = '20261111T170000Z-abcdef';
    const VOTERS = ['alpha', 'beta', 'gamma'];

    /** Production-shaped 2-round record: round 0 heuristic self-votes, round 1 LLM votes. */
    function twoRoundSession(opts: { markSource: boolean }): Record<string, unknown> {
      const source = (value: 'llm' | 'heuristic') => (opts.markSource ? { voteSource: value } : {});
      return {
        schema: SWARM_SESSION_SCHEMA,
        sessionId: SESSION_ID,
        createdAt: '2026-11-11T17:00:00.000Z',
        prompt: PROMPT,
        domain: 'geometric',
        mode: 'hybrid',
        converged: false,
        convergenceRound: null,
        panel: VOTERS.map(voterId => ({ personaId: voterId, model: 'm1' })),
        candidates: VOTERS.map((voterId, i) => ({
          index: i + 1,
          personaId: voterId,
          personaName: voterId.toUpperCase(),
          model: 'm1',
          lines: 1,
          sourcePath: `/tmp/${SESSION_ID}/candidates/candidate-${i + 1}.js`,
        })),
        rounds: [
          {
            roundNum: 1,
            outputs: {},
            votes: Object.fromEntries(VOTERS.map(voterId => [voterId, {
              firstChoice: voterId,
              secondChoice: '',
              reasoning: 'Heuristic render-grounded: score=1.00 (gate=1 lum=0.50 rend=0.80)',
              ...source('heuristic'),
            }])),
            scores: { alpha: 1, beta: 1, gamma: 1 },
            winnerId: 'beta',
          },
          {
            roundNum: 2,
            outputs: {},
            votes: {
              alpha: { firstChoice: 'beta', secondChoice: 'gamma', reasoning: 'Beta matches the brief best.', ...source('llm') },
              beta: { firstChoice: 'beta', secondChoice: 'gamma', reasoning: 'Beta is the strongest piece here.', ...source('llm') },
              gamma: { firstChoice: 'alpha', secondChoice: 'beta', reasoning: 'Alpha is the tighter composition.', ...source('llm') },
            },
            scores: { alpha: 0, beta: 2, gamma: 0 },
            winnerId: 'beta',
          },
        ],
        finalOutput: '',
      };
    }

    async function labelTwoRound(opts: { markSource: boolean }): Promise<Invocation> {
      writeRawSession(SESSION_ID, twoRoundSession(opts));
      return invoke(['label', SESSION_ID], { winner: 'beta' });
    }

    function ledgerOutcomes(): string[] {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Record<string, any>;
      return [...ledger.outcomes].sort();
    }

    function ledgerRecords(): Record<string, any> {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Record<string, any>;
      return Object.fromEntries(ledger.records.map((r: any) => [r.expertId, r]));
    }

    it('labels from LLM votes only, keeps every round, and replays as a no-op', async () => {
      const result = await labelTwoRound({ markSource: true });

      expect(result.code).toBe(0);
      expect(result.text).toContain('3 votes from 3 voters across 2 rounds (3 synthetic votes excluded)');

      const records = ledgerRecords();
      expect(records.alpha).toMatchObject({ correctVotes: 1, totalVotes: 1 });
      expect(records.beta).toMatchObject({ correctVotes: 1, totalVotes: 1 });
      expect(records.gamma).toMatchObject({ correctVotes: 0, totalVotes: 1 });
      expect(ledgerOutcomes()).toEqual([
        `swarm:${SESSION_ID}#r1:alpha`,
        `swarm:${SESSION_ID}#r1:beta`,
        `swarm:${SESSION_ID}#r1:gamma`,
      ]);

      const session = onlySession();
      expect(session.label).toMatchObject({ recordedVotes: 3, skippedSyntheticVotes: 3 });
      // Every round stays in the record; the heuristic votes keep their marker.
      expect(session.rounds).toHaveLength(2);
      expect(Object.keys(session.rounds[0].votes).sort()).toEqual(['alpha', 'beta', 'gamma']);
      expect(session.rounds[0].votes.alpha.voteSource).toBe('heuristic');
      expect(session.rounds[1].votes.alpha.voteSource).toBe('llm');

      const before = hashFile(ledgerPath);
      const replay = await invoke(['label', SESSION_ID], { winner: 'alpha' });
      expect(replay.code).toBe(0);
      expect(replay.text).toContain('0 new votes; ledger unchanged');
      expect(hashFile(ledgerPath)).toBe(before);
    });

    it('backfills voteSource for legacy records that carry no marker', async () => {
      const result = await labelTwoRound({ markSource: false });

      expect(result.code).toBe(0);
      expect(result.text).toContain('3 votes from 3 voters across 2 rounds (3 synthetic votes excluded)');

      const records = ledgerRecords();
      expect(records.alpha).toMatchObject({ correctVotes: 1, totalVotes: 1 });
      expect(records.beta).toMatchObject({ correctVotes: 1, totalVotes: 1 });
      expect(records.gamma).toMatchObject({ correctVotes: 0, totalVotes: 1 });
      expect(ledgerOutcomes()).toEqual([
        `swarm:${SESSION_ID}#r1:alpha`,
        `swarm:${SESSION_ID}#r1:beta`,
        `swarm:${SESSION_ID}#r1:gamma`,
      ]);

      const session = onlySession();
      expect(session.label).toMatchObject({ recordedVotes: 3, skippedSyntheticVotes: 3 });
      expect(session.rounds).toHaveLength(2);
    });
  });

  describe('C. a later run reports calibrated voters', () => {
    it('lists the labelled voters in the next run in the same domain', async () => {
      await invoke(['run'], { prompt: PROMPT, swarmRounds: 1 }, {
        stdinIsTTY: true,
        ask: async () => '1',
      });

      const second = await invoke(['run'], { prompt: PROMPT, swarmRounds: 1 });

      expect(second.code).toBe(0);
      expect(second.text).toContain('Calibrated voters (geometric): kai, nova, rex');
    });
  });

  describe('D. guards', () => {
    it('skips on `s`: no ledger and no label block', async () => {
      const result = await invoke(['run'], { prompt: PROMPT, swarmRounds: 1 }, {
        stdinIsTTY: true,
        ask: async () => 's',
      });
      expect(result.code).toBe(0);
      expect(result.text).toContain('Label later with: sinter swarm label ');
      expect(existsSync(ledgerPath)).toBe(false);
      expect(onlySession().label).toBeUndefined();
    });

    it('exits 1 for an unknown winner and lists the valid picks', async () => {
      await invoke(['run'], { prompt: PROMPT, swarmRounds: 1, noLabel: true });
      const id = onlySession().sessionId as string;
      const result = await invoke(['label', id], { winner: 'nobody' });
      expect(result.code).toBe(1);
      expect(result.errText).toContain('unknown winner "nobody"');
      expect(result.errText).toContain('kai, nova, rex');
      expect(existsSync(ledgerPath)).toBe(false);
      expect(onlySession().label).toBeUndefined();
    });

    it('exits 1 for a missing session', async () => {
      const result = await invoke(['label', '20260101T000000Z-abcdef'], { winner: 'kai' });
      expect(result.code).toBe(1);
      expect(result.errText).toContain('not found');
    });

    it('refuses a legacy session without a prompt', async () => {
      const id = '20260101T000000Z-abcdef';
      writeRawSession(id, {
        schema: SWARM_SESSION_SCHEMA,
        sessionId: id,
        createdAt: '2026-01-01T00:00:00.000Z',
        domain: 'geometric',
        mode: 'hybrid',
        converged: false,
        convergenceRound: null,
        panel: [],
        candidates: [{
          index: 1, personaId: 'kai', personaName: 'K', model: 'm1', lines: 1, sourcePath: '/tmp/x.svg',
        }],
        rounds: [{ roundNum: 1, outputs: {}, votes: { kai: { firstChoice: 'kai', secondChoice: '', reasoning: '' } }, scores: {}, winnerId: 'kai' }],
        finalOutput: '',
      });
      const result = await invoke(['label', id], { winner: 'kai' });
      expect(result.code).toBe(1);
      expect(result.errText).toContain('has no prompt');
      expect(existsSync(ledgerPath)).toBe(false);
    });

    it('refuses a session with no parsed votes', async () => {
      const id = '20260101T000000Z-abcdef';
      writeRawSession(id, {
        schema: SWARM_SESSION_SCHEMA,
        sessionId: id,
        createdAt: '2026-01-01T00:00:00.000Z',
        prompt: PROMPT,
        domain: 'geometric',
        mode: 'hybrid',
        converged: false,
        convergenceRound: null,
        panel: [],
        candidates: [{
          index: 1, personaId: 'kai', personaName: 'K', model: 'm1', lines: 1, sourcePath: '/tmp/x.svg',
        }],
        rounds: [{ roundNum: 1, outputs: {}, votes: { kai: { firstChoice: '', secondChoice: '', reasoning: 'err' } }, scores: {}, winnerId: 'kai' }],
        finalOutput: '',
      });
      const result = await invoke(['label', id], { winner: 'kai' });
      expect(result.code).toBe(1);
      expect(result.errText).toContain('no parsed votes');
      expect(existsSync(ledgerPath)).toBe(false);
    });

    it('refuses a corrupt ledger without starting from empty', async () => {
      await invoke(['run'], { prompt: PROMPT, swarmRounds: 1, noLabel: true });
      const id = onlySession().sessionId as string;
      writeFileSync(ledgerPath, '{not json');

      const result = await invoke(['label', id], { winner: 'kai' });

      expect(result.code).toBe(1);
      expect(result.errText).toContain('is not valid JSON');
      expect(readFileSync(ledgerPath, 'utf-8')).toBe('{not json');
      expect(onlySession().label).toBeUndefined();
    });

    it('does not prompt without a TTY for label and prints the follow-up', async () => {
      await invoke(['run'], { prompt: PROMPT, swarmRounds: 1, noLabel: true });
      const id = onlySession().sessionId as string;
      const result = await invoke(['label', id]);
      expect(result.code).toBe(0);
      expect(result.text).toContain(`Label with: sinter swarm label ${id} --winner <index|personaId>`);
      expect(existsSync(ledgerPath)).toBe(false);
    });

    it('never prompts on a non-TTY run even without --no-label', async () => {
      const result = await invoke(['run'], { prompt: PROMPT, swarmRounds: 1 }, {
        ask: async () => {
          throw new Error('must not prompt without a TTY');
        },
      });
      expect(result.code).toBe(0);
      expect(result.text).toContain('Label later with:');
    });
  });

  describe('sessions listing', () => {
    it('hides labelled sessions by default and shows the label with --all', async () => {
      await invoke(['run'], { prompt: PROMPT, swarmRounds: 1 }, {
        stdinIsTTY: true,
        ask: async () => '1',
      });
      const id = onlySession().sessionId as string;

      const hidden = await invoke(['sessions']);
      expect(hidden.code).toBe(0);
      expect(hidden.text).not.toContain(id);

      const all = await invoke(['sessions'], { all: true });
      expect(all.code).toBe(0);
      expect(all.text).toContain(id);
      expect(all.text).toContain('kai');
    });

    it('rejects an invalid --limit', async () => {
      const result = await invoke(['sessions'], { limit: '0' });
      expect(result.code).toBe(1);
      expect(result.errText).toContain('--limit must be a positive integer');
    });
  });

  describe('path resolution (one helper, all verbs)', () => {
    it('resolves the ledger path: flag > env > config > default', async () => {
      const base = { home: root, env: {}, projectConfig: null };
      expect(await resolveLedgerPath({ ledger: '/flag/ledger.json' }, {
        ...base,
        env: { SINTER_CALIBRATION_LEDGER: '/env/ledger.json' },
        projectConfig: { swarm: { calibrationLedgerPath: '/config/ledger.json' } },
      })).toBe('/flag/ledger.json');
      expect(await resolveLedgerPath({}, {
        ...base,
        env: { SINTER_CALIBRATION_LEDGER: '/env/ledger.json' },
        projectConfig: { swarm: { calibrationLedgerPath: '/config/ledger.json' } },
      })).toBe('/env/ledger.json');
      expect(await resolveLedgerPath({}, {
        ...base,
        projectConfig: { swarm: { calibrationLedgerPath: '/config/ledger.json' } },
      })).toBe('/config/ledger.json');
      expect(await resolveLedgerPath({}, base)).toBe(join(root, '.sinter', 'calibration', 'voting-calibration.json'));
      expect(await resolveLedgerPath({ ledger: '~/x.json' }, { ...base, home: '/home/u' })).toBe('/home/u/x.json');
    });

    it('resolves the session dir: flag > env > default', () => {
      expect(resolveSessionDir({ sessionDir: '/flag' }, { SINTER_SWARM_SESSION_DIR: '/env' }, '/home/u')).toBe('/flag');
      expect(resolveSessionDir({}, { SINTER_SWARM_SESSION_DIR: '/env' }, '/home/u')).toBe('/env');
      expect(resolveSessionDir({}, {}, '/home/u')).toBe(join('/home/u', '.sinter', 'swarm', 'sessions'));
    });
  });
});
