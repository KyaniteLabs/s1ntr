/**
 * `liminal.swarm-session.v1` record tests (#1295).
 *
 * Covers: session-id shape/uniqueness, prompt+domain freezing, round order,
 * blind candidate ordering/filtering, candidate artifact writes, preview
 * export being non-fatal, atomic record IO, listing, and label merging.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '../../../src/utils/Logger.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SWARM_SESSION_SCHEMA,
  buildCandidates,
  buildSwarmSessionRecord,
  candidateExtension,
  createSessionId,
  listSwarmSessions,
  loadSwarmSession,
  sessionFilePath,
  writeSessionLabel,
  writeSwarmSession,
  type SwarmSessionLabel,
} from '../../../src/swarm/SwarmSession.js';
import { SwarmMode, type RoundResult, type SwarmResult } from '../../../src/swarm/types.js';

const P5_CODE = [
  'function setup() {',
  '  createCanvas(400, 400);',
  '}',
  'function draw() {',
  '  background(20);',
  '}',
].join('\n');

function round(roundNum: number, outputs: Array<[string, string]>): RoundResult {
  return {
    admissionStatus: 'exploratory',
    roundNum,
    seed: 'seed',
    outputs: new Map(outputs.map(([id, content]) => [id, {
      personaId: id,
      personaName: `name-${id}`,
      content,
      model: 'm1',
      tokensUsed: content.length,
      latencyMs: 1,
      roundNum,
    }])),
    votes: new Map(outputs.map(([id]) => [id, {
      voterId: id,
      firstChoice: outputs[0]?.[0] ?? '',
      secondChoice: '',
      reasoning: 'r',
    }])),
    scores: new Map(outputs.map(([id]) => [id, 1])),
    winnerId: outputs[0]?.[0] ?? null,
    winnerContent: outputs[0]?.[1] ?? '',
    constraint: 'c',
  };
}

function swarmResult(): SwarmResult {
  return {
    rounds: [
      round(1, [['kai', P5_CODE], ['nova', `${P5_CODE}\n// two`], ['rex', `${P5_CODE}\n// three`]]),
      round(2, [['kai', `${P5_CODE}\n// k2`], ['nova', `${P5_CODE}\n// n2`], ['rex', `${P5_CODE}\n// r2`]]),
    ],
    converged: true,
    convergenceRound: 2,
    finalOutput: `${P5_CODE}\n// k2`,
    totalDurationMs: 12,
    mode: SwarmMode.HYBRID,
    allOutputs: [],
    panelAssignment: [
      { personaId: 'kai', model: 'm1' },
      { personaId: 'nova', model: 'm1' },
      { personaId: 'rex', model: 'm1' },
    ],
  };
}

describe('SwarmSession record (#1295)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-session-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('session id', () => {
    it('is a UTC second plus 6 hex characters', () => {
      const id = createSessionId(new Date('2026-11-11T23:59:00.000Z'));
      expect(id).toMatch(/^20261111T235900Z-[0-9a-f]{6}$/);
    });

    it('is unique across rapid calls in the same second', () => {
      const now = new Date('2026-11-11T23:59:00.000Z');
      const ids = new Set(Array.from({ length: 200 }, () => createSessionId(now)));
      expect(ids.size).toBe(200);
    });
  });

  describe('record builder', () => {
    it('freezes prompt, inferred domain, mode, panel, rounds, and final candidates', () => {
      const record = buildSwarmSessionRecord({
        result: swarmResult(),
        prompt: 'a geometric grid that breathes',
        sessionId: '20261111T235900Z-9f3ac1',
        sessionDir: dir,
        createdAt: new Date('2026-11-11T23:59:00.000Z'),
      });

      expect(record.schema).toBe(SWARM_SESSION_SCHEMA);
      expect(record.prompt).toBe('a geometric grid that breathes');
      expect(record.domain).toBe('geometric');
      expect(record.mode).toBe('hybrid');
      expect(record.converged).toBe(true);
      expect(record.convergenceRound).toBe(2);
      expect(record.panel).toEqual([
        { personaId: 'kai', model: 'm1' },
        { personaId: 'nova', model: 'm1' },
        { personaId: 'rex', model: 'm1' },
      ]);
      expect(record.rounds.map(r => r.roundNum)).toEqual([1, 2]);
      expect(Object.keys(record.rounds[1].outputs)).toEqual(['kai', 'nova', 'rex']);
      expect(record.rounds[1].votes.kai).toEqual({ firstChoice: 'kai', secondChoice: '', reasoning: 'r' });
      expect(record.candidates.map(c => c.index)).toEqual([1, 2, 3]);
      expect(record.candidates.map(c => c.personaId)).toEqual(['kai', 'nova', 'rex']);
      expect(record.candidates[0].sourcePath).toContain(join('candidates', 'candidate-1.js'));
      expect(record.label).toBeUndefined();
    });

    it('keeps only viable final-round candidates, renumbered in display order', () => {
      const result = swarmResult();
      result.rounds[1] = round(2, [
        ['kai', ''],
        ['nova', '[Generation error: timeout]'],
        ['rex', `${P5_CODE}\n// rex`],
      ]);
      const candidates = buildCandidates(result, dir, '20261111T235900Z-9f3ac1');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ index: 1, personaId: 'rex' });
      expect(candidates[0].sourcePath).toContain('candidate-1.js');
    });

    it('preserves voteSource through serialization and leaves unmarked votes unmarked', () => {
      const result = swarmResult();
      result.rounds[0].votes.get('kai')!.voteSource = 'heuristic';
      result.rounds[1].votes.get('nova')!.voteSource = 'llm';
      const record = buildSwarmSessionRecord({
        result, prompt: 'geometric', sessionId: 's-1', sessionDir: dir,
      });
      expect(record.rounds[0].votes.kai.voteSource).toBe('heuristic');
      expect(record.rounds[1].votes.nova.voteSource).toBe('llm');
      expect(record.rounds[0].votes.nova.voteSource).toBeUndefined();
    });

    it('maps svg output to .svg and vector output is not p5-renderable', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
      expect(candidateExtension(svg)).toBe('.svg');
      expect(candidateExtension(P5_CODE)).toBe('.js');
      const result = swarmResult();
      result.rounds[1] = round(2, [['kai', svg], ['nova', P5_CODE], ['rex', P5_CODE]]);
      const record = buildSwarmSessionRecord({
        result, prompt: 'geometric', sessionId: 's-1', sessionDir: dir,
      });
      expect(record.candidates.map(c => c.sourcePath)).toEqual([
        join(dir, 's-1', 'candidates', 'candidate-1.svg'),
        join(dir, 's-1', 'candidates', 'candidate-2.js'),
        join(dir, 's-1', 'candidates', 'candidate-3.js'),
      ]);
    });
  });

  describe('durable writes', () => {
    it('writes candidate sources, a preview, and the session record atomically', async () => {
      const previewed: string[] = [];
      const written = await writeSwarmSession(swarmResult(), 'a geometric grid that breathes', dir, {
        exportHtml: async (_code, outputPath) => {
          previewed.push(outputPath);
          writeFileSync(outputPath, '<html></html>');
        },
      });

      expect(written.sessionPath).toBe(sessionFilePath(dir, written.record.sessionId));
      expect(existsSync(written.sessionPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(written.sessionPath, 'utf-8')) as { candidates: Array<{ sourcePath: string; previewPath?: string }> };
      expect(onDisk.candidates).toHaveLength(3);
      for (const candidate of onDisk.candidates) {
        expect(existsSync(candidate.sourcePath)).toBe(true);
        expect(candidate.previewPath?.endsWith('.html')).toBe(true);
        expect(existsSync(candidate.previewPath!)).toBe(true);
      }
      expect(previewed).toHaveLength(3);
      // Atomic writes leave no sibling temp files behind.
      expect(readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
    });

    it('keeps the source path when preview export fails', async () => {
      const written = await writeSwarmSession(swarmResult(), 'a geometric grid that breathes', dir, {
        exportHtml: async () => { throw new Error('no renderer'); },
      });
      const onDisk = JSON.parse(readFileSync(written.sessionPath, 'utf-8')) as { candidates: Array<{ sourcePath: string; previewPath?: string }> };
      expect(onDisk.candidates.every(c => c.previewPath === undefined)).toBe(true);
      expect(onDisk.candidates.every(c => existsSync(c.sourcePath))).toBe(true);
    });

    it('warns for each candidate whose preview export fails', async () => {
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      try {
        let attempts = 0;
        await writeSwarmSession(swarmResult(), 'a geometric grid that breathes', dir, {
          exportHtml: async () => { attempts++; throw new Error('no renderer'); },
        });
        const previewWarns = warn.mock.calls.map(c => String(c[1])).filter(m => m.startsWith('candidate preview not exported: '));
        expect(attempts).toBe(3); // all three fixture candidates are p5-renderable
        expect(previewWarns).toHaveLength(attempts);
        expect(previewWarns.every(m => m.endsWith('.html:'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('round-trips through load/list and merges a label block', async () => {
      const first = await writeSwarmSession(swarmResult(), 'a geometric grid', dir, {
        exportHtml: async () => { throw new Error('skip'); },
      });
      const label: SwarmSessionLabel = {
        source: 'human',
        goldWinner: 'nova',
        outcomeId: `swarm:${first.record.sessionId}`,
        labelledAt: '2026-11-11T23:59:31.000Z',
        recordedVotes: 6,
        recordedVoters: ['kai', 'nova', 'rex'],
      };
      await writeSessionLabel(dir, first.record, label);

      const loaded = await loadSwarmSession(dir, first.record.sessionId);
      expect(loaded.label).toEqual(label);
      const listed = await listSwarmSessions(dir);
      expect(listed.map(r => r.sessionId)).toContain(first.record.sessionId);
    });

    it('lists newest first and skips foreign or corrupt JSON', async () => {
      const older = buildSwarmSessionRecord({
        result: swarmResult(), prompt: 'older', sessionId: '20260101T000000Z-aaaaaa',
        sessionDir: dir, createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const newer = buildSwarmSessionRecord({
        result: swarmResult(), prompt: 'newer', sessionId: '20260102T000000Z-bbbbbb',
        sessionDir: dir, createdAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      writeFileSync(sessionFilePath(dir, older.sessionId), JSON.stringify(older));
      writeFileSync(sessionFilePath(dir, newer.sessionId), JSON.stringify(newer));
      writeFileSync(join(dir, 'evolution_1.json'), JSON.stringify({ session_id: 'legacy' }));
      writeFileSync(join(dir, 'broken.json'), '{not json');

      const listed = await listSwarmSessions(dir);
      expect(listed.map(r => r.sessionId)).toEqual([newer.sessionId, older.sessionId]);
    });

    it('refuses a foreign session schema', async () => {
      writeFileSync(join(dir, 'x.json'), JSON.stringify({ schema: 'other', sessionId: 'x' }));
      await expect(loadSwarmSession(dir, 'x')).rejects.toThrow(/not a liminal\.swarm-session\.v1/);
    });
  });
});
