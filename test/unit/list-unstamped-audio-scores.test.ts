import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/list-unstamped-audio-scores.mjs');
const rec = (domain: string, audio: Record<string, unknown>, score = 0.5) =>
  ({ kind: 'create', result: { domain, evidence: { audio }, evaluation: { score, scoreState: 'scored' } } });

describe('list-unstamped-audio-scores (read-only)', () => {
  it('lists tone audio records without a captureVersion and leaves the store untouched', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'unstamped-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'product-projections.json');
    writeFileSync(file, JSON.stringify({
      old: rec('tone', { relevant: true, state: 'audible', peakAmplitude: 0.4 }),
      fresh: rec('tone', { relevant: true, state: 'audible', captureVersion: 2 }),
      strudel: rec('strudel', { relevant: true, state: 'audible' }),
      visual: rec('p5', { relevant: false, state: 'not-applicable' }),
    }));
    const before = readFileSync(file, 'utf8');
    const mtime = statSync(file).mtimeMs;
    const out = JSON.parse(execFileSync('node', [SCRIPT, '--json', file], { encoding: 'utf8' }));
    expect(out.rows.map((r: { key: string }) => r.key)).toEqual(['old']);
    expect(out.stamped).toBe(1);
    const all = JSON.parse(execFileSync('node', [SCRIPT, '--json', '--domain', 'all', dir], { encoding: 'utf8' }));
    expect(all.rows.map((r: { key: string }) => r.key).sort()).toEqual(['old', 'strudel']);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
  }, 120_000);
});
