/** Imported corpus rows alone cannot authorize persisted taste weights. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bin = path.resolve(import.meta.dirname, '../../bin/sinter');
const proj = mkdtempSync(path.join(os.tmpdir(), 'taste-persist-'));
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: proj, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HOME: proj, USERPROFILE: proj, SINTER_PROJECT_ROOT: proj } });
  return { rc: r.status, out: r.stdout, err: r.stderr };
};

describe('taste train admission across processes', () => {
  it('refuses a model from labels with no signed render evidence', () => {
    const src = (n: string, body: string) => { const f = path.join(proj, `${n}.txt`); writeFileSync(f, body); return f; };
    const a = src('a', 'function setup(){createCanvas(400,400)}function draw(){background(10);ellipse(200,200,50,50)}');
    const b = src('b', 'function setup(){createCanvas(400,400);noLoop()}function draw(){for(let i=0;i<400;i+=4){line(i,0,400-i,400)}}');
    const row = (id: string, score: number, f: string) => JSON.stringify({ run_dir: `out/${id}/`, finished_utc: '2026-11-18T00:00:00Z',
      model: 'm', domain: 'p5', score, admission_eligible: true, degraded: false, artifact_digest: id.repeat(64).slice(0, 64), source_path: f });
    const corpus = path.join(proj, 'corpus.jsonl');
    writeFileSync(corpus, [row('a', 0.9, a), row('b', 0.3, b)].join('\n') + '\n');
    expect(run(['taste', 'ingest', corpus]).out).toContain('+2 archived');
    expect(run(['preferences', 'model']).rc).toBe(1);           // nothing persisted yet
    const train = run(['taste', 'train']);
    expect(train.err).toContain('Not trained:');
    expect(train.out).not.toContain('Persisted:');
    expect(run(['preferences', 'model']).rc).toBe(1);
  }, 240000);
});
