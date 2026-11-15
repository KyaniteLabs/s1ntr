import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprint,
  cosineSimilarity,
  indexBeads,
  findThreads,
  playMove,
} from '../../../src/atelier/GlassBeadGame.js';

function artifactDir(root: string, id: string, domain: string, code: string, axes = 'D=3.00 A=3.00 R=3.00 N=3.00') {
  const dir = join(root, 'output', 'artifacts', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'source.txt'), code);
  writeFileSync(join(dir, 'playable.html'), `<html><body>${id}</body></html>`);
  return { turn: 1, domain, axes, artifact: dir };
}

describe('GlassBeadGame organ', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sinter-gbg-test-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('fingerprint is deterministic and bounded', () => {
    const src = 's("bd sd").gain(0.2).room(0.4) // beat';
    const a = fingerprint(src);
    const b = fingerprint(src);
    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
    for (const v of a) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
  });

  it('cosine similarity: identical=1, orthogonal=0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('indexes beads from trend rows and finds cross-domain threads only', () => {
    mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
    const same = 's("bd sd hh").gain(0.25).room(0.4).pan("<0.3 0.7>") // rhythm';
    const rows = [
      artifactDir(cwd, 'aaa', 'strudel', same),
      artifactDir(cwd, 'bbb', 'tone', same.replace(/bd sd hh/g, 'c4 e4 g4')),
      artifactDir(cwd, 'ccc', 'hydra', 'osc(30, 0.1).rotate(0, 0.05).out(o0)'),
      // a same-domain near-duplicate that must NOT thread with aaa
      artifactDir(cwd, 'ddd', 'strudel', same.replace(/0.25/, '0.26')),
    ];
    writeFileSync(join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl'),
      rows.map(r => JSON.stringify(r)).join('\n') + '\n');

    const indexed = indexBeads(cwd);
    expect(indexed.total).toBe(4);
    // re-index is idempotent
    expect(indexBeads(cwd).added).toBe(0);

    const threads = findThreads(cwd, { threshold: 0.99, max: 50 });
    expect(threads.length).toBeGreaterThan(0);
    for (const t of threads) {
      expect(t.domainA).not.toBe(t.domainB);
    }
  });

  it('default threshold is 0.995 and each unordered domain pair is capped at 40 threads', () => {
    const gameDir = join(cwd, '.omx', 'atelier', 'game');
    mkdirSync(gameDir, { recursive: true });
    const bead = (id: string, domain: string, fp: number[]) =>
      ({ id, domain, mean: 3, dir: join(cwd, 'art', id), fp, indexedAt: '2026-08-31T00:00:00Z' });
    // 60 hydra + 60 p5 with IDENTICAL fingerprints -> cosine 1.0, 3600 candidate
    // threads for the single hydra|p5 pair (the old pool-monopoly shape).
    const unit = [1, 0, 0, 0, 0, 0, 0, 0];
    const beads = [
      ...Array.from({ length: 60 }, (_, i) => bead(`h${i}`, 'hydra', unit)),
      ...Array.from({ length: 60 }, (_, i) => bead(`p${i}`, 'p5', unit)),
      // cosine vs any unit-vector bead = 0.99/sqrt(0.99^2+0.1^2) ~ 0.99496:
      // above the OLD 0.985 bar, below the new 0.995 default.
      bead('s0', 'strudel', [0.99, 0.1, 0, 0, 0, 0, 0, 0]),
      bead('t0', 'tone', unit),
    ];
    writeFileSync(join(gameDir, 'beads.json'), JSON.stringify(beads));

    const byDefault = findThreads(cwd); // no options — production defaults
    const hydraP5 = byDefault.filter(t => new Set([t.domainA, t.domainB]).has('hydra') && new Set([t.domainA, t.domainB]).has('p5'));
    expect(hydraP5.length).toBe(40); // per-pair cap holds
    expect(byDefault.some(t => new Set([t.domainA, t.domainB]).has('strudel'))).toBe(false); // 0.99496 < 0.995 default

    const loose = findThreads(cwd, { threshold: 0.985 });
    expect(loose.some(t => new Set([t.domainA, t.domainB]).has('strudel'))).toBe(true); // old bar would have kept it
  });

  it('plays one move per call: pairing for cross-domain, duet for audio pairs', () => {
    mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
    const audioish = 'note("<c3 e3 g3>").gain(0.2).room(0.4).attack(9) // pad';
    const rows = [
      artifactDir(cwd, 's1', 'strudel', audioish),
      artifactDir(cwd, 't1', 'tone', audioish.replace(/c3 e3 g3/, '220 330 440')),
    ];
    writeFileSync(join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl'),
      rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    indexBeads(cwd);
    findThreads(cwd, { threshold: 0.95, max: 50 });

    const first = playMove(cwd);
    expect(first?.kind).toBe('duet');
    const html = readFileSync(first!.output, 'utf8');
    expect(html).toContain('Play both');
    expect(html).toContain('iframe');

    // the same thread is never played twice
    const second = playMove(cwd);
    expect(second).toBeNull();
  });
});
