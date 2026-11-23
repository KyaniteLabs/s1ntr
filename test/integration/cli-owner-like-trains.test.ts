import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SinterFS } from '../../src/fs/SinterFS.js';
import { TasteLearningService } from '../../src/learning/TasteLearningService.js';
import { TasteModelRuntime } from '../../src/learning/TasteModelRuntime.js';
import { signedOwnerLike } from '../helpers/signedOwnerLike.js';
import { ReplayBiasPolicy } from '../../src/learning/ReplayBiasPolicy.js';

const bin = path.resolve(import.meta.dirname, '../../bin/sinter');
const proj = mkdtempSync(path.join(os.tmpdir(), 'owner-like-'));
const launchDir = mkdtempSync(path.join(os.tmpdir(), 'owner-like-cli-'));
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: launchDir, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HOME: proj, USERPROFILE: proj, SINTER_PROJECT_ROOT: proj, NODE_ENV: 'test' } });
  return { rc: r.status, out: r.stdout, err: r.stderr };
};
const SRC: Record<string, string> = {
  a: 'function setup(){createCanvas(400,400)}\nfunction draw(){background(10);ellipse(200,200,50,50)}',
  b: Array.from({ length: 80 }, (_, i) => `if(random()>0.${i % 9}){stroke(${(i * 37) % 255},${(i * 91) % 255},${(i * 13) % 255});line(random(400),random(400),random(${i + 5}),random(400))} else {noise(${i}*frameCount);rotate(random(PI))}`).join('\n'),
  c: 'let t=0;\nfunction setup(){createCanvas(400,400)}\nfunction draw(){t+=frameCount*0.01;translate(width/2,height/2);for(let i=0;i<30;i++){rotate(t);rect(i*4,sin(t)*i,6,6)}}',
};
describe('owner like trains the taste model', () => {
  it('like -> ingest -> train -> model persists and scores differently after another like', async () => {
    const scan = path.join(proj, 'scan');
    const likesById = new Map();
    for (const [id, score] of [['a', 0.9], ['b', 0.4], ['c', 0.7]] as const) {
      likesById.set(id, await signedOwnerLike({ home: proj, scan, id, source: SRC[id]!, score }));
    }
    const likes = path.join(proj, 'likes.jsonl'); const corpus = path.join(proj, 'corpus.jsonl'); writeFileSync(corpus, '');
    const like = (id: string) => JSON.stringify(likesById.get(id));
    writeFileSync(likes, JSON.stringify({ seat: 'seatX', id: 'a', liked: true }) + '\n');
    expect(run(['taste', 'ingest', corpus, '--likes', likes, '--scan', scan]).out).toContain('+0 labelled, 1 not bindable');
    writeFileSync(likes, [like('a'), like('b')].join('\n') + '\n');
    const ing = run(['taste', 'ingest', corpus, '--likes', likes, '--scan', scan]);
    expect(ing.rc, ing.err).toBe(0); expect(ing.out).toContain('+2 labelled');
    const t1 = run(['taste', 'train']); expect(t1.rc, t1.err).toBe(0); expect(t1.out).toContain('Held-out evaluation:');
    const score = () => { const fs = SinterFS.open(proj); try {
      const w = new TasteLearningService(fs).loadLatestModel(); const rt = new TasteModelRuntime(); if (w) rt.load(w);
      return { w, s: w ? rt.score({ qualityScore: 0.5, descriptor: { values: [{ name: 'x', value: 0.9 }, { name: 'y', value: 0.1 }] } } as never) : null };
    } finally { fs.close(); } };
    const before = score(); expect(before.w?.pairCount).toBeGreaterThan(0);
    writeFileSync(likes, [like('a'), like('b'), like('c')].join('\n') + '\n');
    expect(run(['taste', 'ingest', corpus, '--likes', likes, '--scan', scan]).out).toContain('+1 labelled');
    expect(run(['taste', 'train']).rc).toBe(0);
    const after = score();
    // Generation consumer: the gardener loads the persisted model into ReplayBiasPolicy and replays/dreams from what it picks.
    const replay = (w: NonNullable<typeof before.w>) => { const pol = new ReplayBiasPolicy({ biasStrength: 1, minTasteScore: -1e9 }); pol.loadModel(w);
      // Two candidates equal in quality/signals, each strong on ONE axis: the owner's likes moved weight from the last axis to the third.
      const mk = (id: string, hot: number) => ({ id, qualityScore: 0.5, signals: { fertility: 0.5, novelty: 0.5 },
        descriptor: { values: Array.from({ length: w.axisWeights.length }, (_, j) => ({ name: `a${j}`, value: j === hot ? 1 : 0 })) } });
      return pol.selectForReplay([mk('lastAxis', w.axisWeights.length - 1), mk('thirdAxis', 2)] as never, 2).map(e => e.id).join(','); };
    expect(replay(before.w!)).toBe('lastAxis,thirdAxis');
    expect(replay(after.w!)).toBe('thirdAxis,lastAxis');
    expect(after.w!.pairCount).toBeGreaterThan(before.w!.pairCount);
    expect(after.s).not.toBe(before.s);
  }, 300000);
});
