import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeValidator } from '../../../src/core/CodeValidator.js';
import { aggregateFitnessObservations, buildFitnessObservationReport, createFitnessObservation } from '../../../src/quality/FitnessObservationStore.js';

// The deleted src/config/model-routing.ts held a hand-written March 2026 ranking of six retired models per
// medium. It had zero importers (the old-API callers were: none). What it carried lives in live sources:
//   min size -> CodeValidator.getMinSize; prompt hints -> the production brief (closeout-group-c test);
//   best model -> the operator's own runs (report fitness). The operator's seat config alone chooses models.
describe('model routing table is gone; its live replacements cover it', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  it('no source file re-introduces a hard-coded model id table or imports the old module', () => {
    expect(existsSync('src/config/model-routing.ts')).toBe(false);
    for (const f of walk('src')) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/config\/model-routing/);
      expect(text, f).not.toMatch(/MINIMAX_M2_5|QWEN_CODER_40B|GEMMA_3_4B/);
    }
  });
  it('minimum size per medium comes from the live validator for every medium the old table named', () => {
    for (const d of ['p5', 'glsl', 'three', 'hydra', 'strudel', 'revideo', 'html', 'ascii']) {
      expect(CodeValidator.getMinSize(d as never), d).toBeGreaterThan(0);
    }
  });
  it('best seat per medium is read from the operator own recorded runs, never a ranking', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'routing-seat-'));
    try {
      const rows = [
        ...[0.9, 0.8, 0.85].map((score, i) => createFitnessObservation({ runId: `a${i}`, domain: 'p5', provider: 'zai', model: 'glm', sourceCode: 'x', score, confidence: 0.9, failureClass: 'none', durationMs: 4000 })),
        ...[0.4, 0.5, 0.3].map((score, i) => createFitnessObservation({ runId: `b${i}`, domain: 'p5', provider: 'kilo', model: 'ds', sourceCode: 'y', score, confidence: 0.9, failureClass: 'none', durationMs: 2000 })),
        createFitnessObservation({ runId: 'c0', domain: 'html', provider: 'zai', model: 'glm', sourceCode: 'z', score: 0.9, confidence: 0.9, failureClass: 'none' }),
      ];
      const file = path.join(dir, 'fitness.jsonl');
      writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const best = (await buildFitnessObservationReport({ filePath: file })).bestSeatByMedium;
      expect(best.p5).toBe('zai/glm');
      expect(best.html).toBeNull(); // one run is not evidence
      const report = aggregateFitnessObservations(rows);
      expect(report.byMediumSeat.p5['kilo/ds'].meanDurationMs).toBe(2000);
      expect(report.byMediumSeat.p5['zai/glm'].meanScore).toBeCloseTo(0.85, 5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
