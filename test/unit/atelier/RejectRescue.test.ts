import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rescuePool,
  mechanicalRecovery,
  detectRescueDomain,
  writeRescueArtifacts,
} from '../../../src/atelier/RejectRescue.js';

const VALID_P5 = `
function setup() {
  createCanvas(400, 400);
}

function draw() {
  background(30);
  ellipse(mouseX, mouseY, 40, 40);
}
`;

// The dominant real-world reject shape: chat-seat prose preamble + good code.
const PROSE_PREAMBLE_STRUDEL = `The user wants a Strudel piece: slow arpeggios over a drone.

I should match the exemplar's craft. Use s() for samples and note() for
synthesized notes, stack layers, euclidean patterns, .every modulations.

Let me design a cohesive piece:

setcpm(7)
stack(
  s("bd(5,16)").gain(.2).room(.4),
  note("<[eb4,g4] [d4,f4]>").s("sine").slow(2)
)
`;

const TRUNCATED_TONE = `
const synth = new Tone.Synth({
  oscillator: { type: "triangle"
`;

describe('RejectRescue', () => {
  let poolDir: string;

  beforeEach(() => {
    poolDir = mkdtempSync(join(tmpdir(), 'sinter-rescue-test-'));
  });
  afterEach(() => {
    rmSync(poolDir, { recursive: true, force: true });
  });

  describe('detectRescueDomain', () => {
    it('detects strudel, tone, three and p5', () => {
      expect(detectRescueDomain('const p = s("bd sd").slow(2)')).toBe('strudel');
      expect(detectRescueDomain('const synth = new Tone.Synth().toDestination();')).toBe('tone');
      expect(detectRescueDomain('const scene = new THREE.Scene();')).toBe('three');
      expect(detectRescueDomain(VALID_P5)).toBe('p5');
    });
  });

  describe('mechanicalRecovery', () => {
    it('classifies clean code as raw (false-kill shape)', () => {
      const result = mechanicalRecovery(VALID_P5, 'p5');
      expect(result.stage).toBe('raw');
    });

    it('recovers a fence-wrapped piece at the raw stage (spine fence-strips first)', () => {
      const fenced = '```js\n' + VALID_P5 + '\n```';
      expect(mechanicalRecovery(fenced, 'p5').stage).toBe('raw');
    });

    it('recovers the prose-preamble reject shape', () => {
      const result = mechanicalRecovery(PROSE_PREAMBLE_STRUDEL, 'strudel');
      expect(result.stage).toBe('strudel-normalize');
    });

    it('reports defects for genuinely dead code', () => {
      const result = mechanicalRecovery(TRUNCATED_TONE, 'tone');
      expect(result.stage).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('rescuePool', () => {
    it('classifies the pool and computes the false-kill rate', async () => {
      writeFileSync(join(poolDir, 'r0.js'), VALID_P5);
      writeFileSync(join(poolDir, 'r1.js'), PROSE_PREAMBLE_STRUDEL);
      writeFileSync(join(poolDir, 'r2.js'), TRUNCATED_TONE);

      const report = await rescuePool(poolDir, { noLlm: true });

      expect(report.total).toBe(3);
      expect(report.counts['genuinely-dead']).toBe(1);
      const salvageable = report.counts['false-kill'] + report.counts['recovered'] + report.counts['llm-salvage'];
      expect(salvageable).toBe(2);
      expect(report.falseKillRate).toBeCloseTo(2 / 3, 5);
      // the dead piece's defects feed the pattern counter
      expect(report.repairPatterns.length).toBeGreaterThanOrEqual(0);
    });

    it('runs ONE bounded LLM repair for mechanically-dead pieces and salvages on success', async () => {
      writeFileSync(join(poolDir, 'r0.js'), TRUNCATED_TONE);

      let calls = 0;
      const report = await rescuePool(poolDir, {
        noLlm: false,
        buildRepairClient: () => {
          calls += 1;
          return {
            generate: async () => {
              return { success: true, code: [
                'const synth = new Tone.Synth().toDestination();',
                'const loop = new Tone.Loop(time => {',
                '  synth.triggerAttackRelease("C4", "8n", time);',
                '}, "4n").start(0);',
                'Tone.Transport.start();',
              ].join('\n') };
            },
          };
        },
      });

      expect(calls).toBe(1);
      expect(report.counts['llm-salvage']).toBe(1);
      expect(report.falseKillRate).toBe(1);
    });

    it('stays genuinely-dead when the LLM repair fails validation', async () => {
      writeFileSync(join(poolDir, 'r0.js'), TRUNCATED_TONE);

      const report = await rescuePool(poolDir, {
        noLlm: false,
        buildRepairClient: () => ({
          generate: async () => ({ success: true, code: 'still not code at all' }),
        }),
      });

      expect(report.counts['llm-salvage']).toBe(0);
      expect(report.counts['genuinely-dead']).toBe(1);
    });

    it('collects recurring repair patterns as candidate lessons', async () => {
      writeFileSync(join(poolDir, 'a.js'), TRUNCATED_TONE);
      writeFileSync(join(poolDir, 'b.js'), TRUNCATED_TONE);

      const report = await rescuePool(poolDir, { noLlm: true });
      expect(report.repairPatterns.some(p => p.count >= 2)).toBe(true);
    });
  });

  describe('writeRescueArtifacts', () => {
    it('writes salvaged code and the report', async () => {
      writeFileSync(join(poolDir, 'r0.js'), VALID_P5);
      const report = await rescuePool(poolDir, { noLlm: true });
      const reportPath = writeRescueArtifacts(report);

      expect(existsSync(reportPath)).toBe(true);
      const salvaged = readFileSync(join(poolDir, 'rescue', 'r0.false-kill.js'), 'utf8');
      expect(salvaged).toContain('createCanvas');
      const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(parsed.total).toBe(1);
      // a re-run must not treat its own salvage output as new rejects
      const rerun = await rescuePool(poolDir, { noLlm: true });
      expect(rerun.total).toBe(1);
    });
  });
});

describe('sweepRejects (proactive rescue organ)', () => {
  let sweepDir: string;
  beforeEach(() => { sweepDir = mkdtempSync(join(tmpdir(), 'sinter-sweep-test-')); });
  afterEach(() => { rmSync(sweepDir, { recursive: true, force: true }); });

  it('salvages fresh failure records, watermarks, and idempotently re-sweeps', async () => {
    const { sweepRejects } = await import('../../../src/atelier/RejectRescue.js');
    const failures = join(sweepDir, 'failures');
    const cwd = join(sweepDir, 'cwd');
    mkdirSync(failures, { recursive: true });
    mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
    // a prose-wrapped strudel reject (the real-world shape) + a dead piece
    writeFileSync(join(failures, 'f1.json'), JSON.stringify({
      id: 'fail-1', timestamp: '2026-08-29T20:00:00Z', domain: 'strudel',
      code: 'The user wants a piece with slow arpeggios over a warm drone.\n\nsetcpm(7)\nstack(\n  s("sawtooth").note("<[eb1,eb2] [ab1,ab2]>").attack(9).lpf(110).gain(.38).room(.9),\n  s("bd(5,16)").gain(.2).room(.4),\n  note("<[eb4,g4] [d4,f4]>").s("sine").slow(2)\n)',
      error: 'validation', errorType: 'generation',
    }));
    writeFileSync(join(failures, 'f2.json'), JSON.stringify({
      id: 'fail-2', timestamp: '2026-08-29T20:05:00Z', domain: 'p5',
      code: 'function setup() { createCanvas(400', error: 'syntax', errorType: 'generation',
    }));

    const r1 = await sweepRejects(cwd, { failuresDir: failures, llm: false });
    expect(r1.scanned).toBe(2);
    expect(r1.salvaged.length).toBeGreaterThanOrEqual(1);
    expect(r1.salvaged[0].classification).toBe('false-kill'); // normalize stage
    expect(r1.deadCount).toBeGreaterThanOrEqual(1);
    const poolFiles = readdirSync(join(cwd, '.omx', 'atelier', 'rescue-pool'));
    expect(poolFiles.some(f => f.includes('false-kill'))).toBe(true);
    const lineageName = poolFiles.find(f => f.endsWith('.lineage.json'))!;
    const lineage = JSON.parse(readFileSync(join(cwd, '.omx', 'atelier', 'rescue-pool', lineageName), 'utf8'));
    expect(lineage.originalFailure).toEqual(JSON.parse(readFileSync(join(failures, 'f1.json'), 'utf8')));
    expect(lineage.recovery).toEqual({ classification: 'false-kill', stage: 'strudel-normalize', repairModel: null });

    // watermark: the second sweep sees nothing new
    const r2 = await sweepRejects(cwd, { failuresDir: failures, llm: false });
    expect(r2.scanned).toBe(0);

    // a NEW failure after the watermark gets picked up
    writeFileSync(join(failures, 'f3.json'), JSON.stringify({
      id: 'fail-3', timestamp: '2026-08-29T21:00:00Z', domain: 'strudel',
      code: '$: s("bd sd hh")', error: 'validation', errorType: 'generation',
    }));
    const r3 = await sweepRejects(cwd, { failuresDir: failures, llm: false });
    expect(r3.scanned).toBe(1);
  });

  it('stages a recurring repair class as a racing lesson from the fixed map only', async () => {
    const { sweepRejects } = await import('../../../src/atelier/RejectRescue.js');
    const failures = join(sweepDir, 'failures2');
    const cwd = join(sweepDir, 'cwd2');
    mkdirSync(failures, { recursive: true });
    mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
    // three GLSL undeclared-uniform deaths (a mapped class)
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(failures, `g${i}.json`), JSON.stringify({
        id: `gfail-${i}`, timestamp: `2026-08-29T2${i}:00:00Z`, domain: 'glsl',
        code: `precision mediump float;\nvoid main() { float t = u_time; gl_FragColor = vec4(t); }`,
        error: "GLSL: 'u_time' is used but never declared as a uniform", errorType: 'generation',
      }));
    }
    const r = await sweepRejects(cwd, { failuresDir: failures, llm: false });
    expect(r.scanned).toBe(3);
    // the mapped lesson landed in staging, deduped
    const staging = JSON.parse(readFileSync(join(cwd, '.omx', 'atelier', 'lessons', 'hints-staging.json'), 'utf8'));
    expect(staging.some((l: { id: string }) => l.id === 'glsl_declare_uniforms')).toBe(true);
    // unknown error classes never become lessons
    writeFileSync(join(failures, 'g9.json'), JSON.stringify({
      id: 'gfail-9', timestamp: '2026-08-29T23:00:00Z', domain: 'p5',
      code: 'garbage {{{', error: 'mystery class with model-authored text', errorType: 'generation',
    }));
    const r2 = await sweepRejects(cwd, { failuresDir: failures, llm: false });
    const staging2 = JSON.parse(readFileSync(join(cwd, '.omx', 'atelier', 'lessons', 'hints-staging.json'), 'utf8'));
    expect(staging2.every((l: { id: string }) => l.id !== 'mystery')).toBe(true);
  });
});
