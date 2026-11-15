/**
 * H-TELEM-01 tour-telemetry-report — no live LLM.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  readJsonl,
  summarizeEvents,
  reportHomeDay,
  reportPackDir,
} from '../../../scripts/rotation/tour-telemetry-report.mjs';

describe('tour-telemetry-report', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telem-rpt-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parseArgs reads day/wave/pack-dir', () => {
    expect(parseArgs(['--day', '2026-07-28']).day).toBe('2026-07-28');
    expect(parseArgs(['--wave', '1']).wave).toBe('1');
    expect(parseArgs(['--pack-dir', '/tmp/x']).packDir).toBe(path.resolve('/tmp/x'));
  });

  it('summarizeEvents reports 0% tourWaveId as forensic', () => {
    const rows = [
      { event: 'seat.observation', payload: { seat: 'generator', mode: null } },
      { event: 'seat.observation', payload: { seat: 'chat' } },
    ];
    const s = summarizeEvents(rows);
    expect(s.n).toBe(2);
    expect(s.tourWaveIdCoverage).toBe(0);
    expect(s.forensic).toBe(true);
  });

  it('summarizeEvents counts join keys + evaluator_case + pack_complete', () => {
    const rows = [
      {
        event: 'seat.observation',
        payload: {
          seat: 'harness',
          tourWaveId: 'wave-1@deadbeef',
          mode: 'live',
          gapClass: 'instrument_pipe',
          usagePresent: false,
          productCandidate: true,
          taskId: 'harness-fix-one-lint-class',
        },
      },
      {
        event: 'eval.planted_case',
        payload: {
          seat: 'evaluator',
          tourWaveId: 'wave-1@deadbeef',
          instrument: 'planted-GT',
          mode: 'live',
        },
      },
      {
        event: 'seat.pack_complete',
        payload: {
          seat: 'generator',
          mode: 'live',
          northStar: 0.8,
          tourWaveId: 'wave-1@deadbeef',
        },
      },
    ];
    const s = summarizeEvents(rows);
    expect(s.tourWaveIdCoverage).toBe(1);
    expect(s.forensic).toBe(false);
    expect(s.evaluatorCases).toBe(1);
    expect(s.packCompletes.length).toBe(1);
    expect(s.productCandidates).toContain('harness-fix-one-lint-class');
    expect(s.gapClass.instrument_pipe).toBe(1);
  });

  it('reportHomeDay is honest when file missing', async () => {
    const home = path.join(dir, 'events');
    fs.mkdirSync(path.join(home, 'seat'), { recursive: true });
    const r = await reportHomeDay(home, '2099-01-01', ['seat']);
    expect(r.lanes.seat.missing).toBe(true);
    expect(r.lanes.seat.n).toBe(0);
  });

  it('reportHomeDay computes coverage from jsonl', async () => {
    const home = path.join(dir, 'events');
    fs.mkdirSync(path.join(home, 'seat'), { recursive: true });
    const file = path.join(home, 'seat', '2026-07-28.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ event: 'seat.observation', payload: { seat: 'generator' } })}\n`
        + `${JSON.stringify({
          event: 'seat.observation',
          payload: { seat: 'chat', tourWaveId: 'wave-1@abc', mode: 'live' },
        })}\n`,
    );
    const r = await reportHomeDay(home, '2026-07-28', ['seat']);
    expect(r.lanes.seat.n).toBe(2);
    expect(r.lanes.seat.tourWaveIdCoverage).toBe(0.5);
    expect(r.lanes.seat.forensic).toBe(false);
  });

  it('reportPackDir reads summary + receipts', async () => {
    const pack = path.join(dir, 'pack');
    fs.mkdirSync(path.join(pack, 'receipts'), { recursive: true });
    fs.writeFileSync(
      path.join(pack, 'summary.json'),
      JSON.stringify({
        seat: 'generator',
        model: 'grok-4.5',
        mode: 'live',
        northStar: { id: 'ns', value: 0.8 },
        join: { tourWaveId: 'wave-1@deadbeef' },
      }),
    );
    fs.writeFileSync(
      path.join(pack, 'receipts', 'gen-p5-easy.json'),
      JSON.stringify({
        taskId: 'gen-p5-easy',
        verdict: 'ok',
        extra: { domain: 'p5' },
        metrics: {},
      }),
    );
    const r = await reportPackDir(pack);
    expect(r.summary?.mode).toBe('live');
    expect(r.summary?.northStar).toBe(0.8);
    expect(r.receipts.length).toBe(1);
    expect(r.receipts[0].domain).toBe('p5');
  });

  it('readJsonl counts bad lines', () => {
    const f = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(f, '{ok:true}\nnot-json\n{"event":"x"}\n');
    const { rows, badLines } = readJsonl(f);
    expect(rows.length).toBe(1);
    expect(badLines).toBe(2);
  });
});
