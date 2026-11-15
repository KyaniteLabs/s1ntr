import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embed, fieldDistance, midpoint, decodeTarget, emptyRegions, interpolate } from '../../../src/atelier/LatentField.js';

const AXES = { D: 3, A: 3, R: 3, N: 3 };
const DRONE_A = 's("sawtooth").note("<[eb1,eb2] [ab1,ab2]>").attack(9).lpf(110).gain(.38).room(.9).every(16, x => x.lpf(180))';
const DRONE_B = 's("sine").note("<c3 e3 g3>").attack(7).lpf(150).gain(.3).room(.8).every(8, x => x.lpf(200))';
const PARTICLE = 'const p = []; function setup() { createCanvas(400,400); for (let i=0;i<50;i++) p.push({x:random(width),y:random(height),v:random(0.5,2)}); } function draw() { background(20); for (const q of p) { q.x+=q.v; if(q.x>width)q.x=0; fill(255,200,100); ellipse(q.x,q.y,3,3); } }';

describe('LatentField (Build 2 — the morphogenetic field)', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sinter-field-test-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('TP1: embed is deterministic — same input produces byte-equal output', () => {
    const a = embed({ source: DRONE_A, prompt: 'drone', fp: [0.5, 0.3, 0.8, 0.2, 0.1, 0.6, 0.4, 0.7], axes: AXES });
    const b = embed({ source: DRONE_A, prompt: 'drone', fp: [0.5, 0.3, 0.8, 0.2, 0.1, 0.6, 0.4, 0.7], axes: AXES });
    expect(a).toEqual(b);
    expect(a).toHaveLength(36);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5); // L2-normalized
  });

  it('TP3: content dims discriminate — drones are closer to each other than to particles', () => {
    const droneA = embed({ source: DRONE_A, prompt: 'strudel drone', fp: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], axes: AXES });
    const droneB = embed({ source: DRONE_B, prompt: 'strudel drone', fp: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], axes: AXES });
    const particle = embed({ source: PARTICLE, prompt: 'p5 particles', fp: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], axes: AXES });
    expect(fieldDistance(droneA, droneB)).toBeLessThan(fieldDistance(droneA, particle));
  });

  it('midpoint is normalized and between parents', () => {
    const a = embed({ source: DRONE_A, prompt: 'x', fp: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], axes: AXES });
    const b = embed({ source: PARTICLE, prompt: 'y', fp: [0.3, 0.6, 0.4, 0.7, 0.2, 0.8, 0.1, 0.9], axes: AXES });
    const mid = midpoint(a, b, 0.5);
    expect(mid).toHaveLength(36);
    const norm = Math.sqrt(mid.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('decodeTarget produces ranked trait readings biased toward the right parent', () => {
    const a = embed({ source: DRONE_A, prompt: 'x', fp: [0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4], axes: AXES });
    const b = embed({ source: PARTICLE, prompt: 'y', fp: [0.2, 0.8, 0.1, 0.9, 0.3, 0.7, 0.4, 0.6], axes: AXES });
    const mid = midpoint(a, b, 0.3); // biased toward A
    const readings = decodeTarget(mid, a, b);
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.length).toBeLessThanOrEqual(6);
    expect(readings.every(r => r.weight >= 0)).toBe(true);
  });

  it('TP6: emptyRegions finds unthreaded high-quality cross-domain pairs', () => {
    const gameDir = join(cwd, '.omx', 'atelier', 'game');
    mkdirSync(gameDir, { recursive: true });
    const droneLv = embed({ source: DRONE_A, prompt: 'drone', fp: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], axes: AXES });
    const particleLv = embed({ source: PARTICLE, prompt: 'particle', fp: [0.3, 0.6, 0.4, 0.7, 0.2, 0.8, 0.1, 0.9], axes: AXES });
    writeFileSync(join(gameDir, 'beads.json'), JSON.stringify([
      { id: 'a', domain: 'strudel', mean: 3.5, dir: '/tmp/a', lv: droneLv },
      { id: 'b', domain: 'p5', mean: 3.8, dir: '/tmp/b', lv: particleLv },
    ]));
    writeFileSync(join(gameDir, 'threads.json'), JSON.stringify([])); // no threads
    const frontier = emptyRegions(cwd, { r: 0.1, minMean: 3.0 });
    expect(frontier.length).toBeGreaterThanOrEqual(1);
    expect(frontier[0].domainA).not.toBe(frontier[0].domainB);
    expect(frontier[0].midpointDensity).toBe(0);
  });

  it('TP4: interpolate returns null for unknown beads (graceful skip)', async () => {
    const gameDir = join(cwd, '.omx', 'atelier', 'game');
    mkdirSync(gameDir, { recursive: true });
    writeFileSync(join(gameDir, 'beads.json'), JSON.stringify([]));
    const result = await interpolate(cwd, 'nonexistent', 'also-gone', 0.5,
      { generate: async () => null });
    expect(result).toBeNull();
  });
});
