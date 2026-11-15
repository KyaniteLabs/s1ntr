import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// CEO law (2026-08-31, "the 500000th time"): ENGLISH ONLY in everything the
// CEO reads. This test enforces it on the CEO-facing repo surfaces and on
// the gate tool itself, so no agent session can ship non-English text there
// without CI going red.
const GATE = path.join(process.cwd(), 'scripts', 'atelier', 'ceo-language-gate.py');

describe('CEO language gate', () => {
  it('the gate tool exists and flags CJK, passing clean text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-gate-'));
    const bad = path.join(dir, 'bad.txt');
    const good = path.join(dir, 'good.txt');
    fs.writeFileSync(bad, 'english line\n\u8fd9\u884c\u662f\u4e2d\u6587\n');
    fs.writeFileSync(good, 'plain english only\n');
    const r1 = spawnSync('python3', [GATE, bad], { encoding: 'utf8' });
    expect(r1.status).toBe(1);
    expect(r1.stdout).toContain('CEO-LANGUAGE-GATE');
    const r2 = spawnSync('python3', [GATE, good], { encoding: 'utf8' });
    expect(r2.status).toBe(0);
  });

  it('CEO-facing surfaces are English only (LEARNINGS + docs/agents)', () => {
    const targets = ['LEARNINGS.md', ...fs.readdirSync(path.join(process.cwd(), 'docs', 'agents'))
      .filter(f => f.endsWith('.md'))
      .map(f => path.join('docs', 'agents', f))];
    expect(targets.length).toBeGreaterThan(5);
    const r = spawnSync('python3', [GATE, ...targets], { encoding: 'utf8' });
    if (r.status !== 0) console.error(r.stdout);
    expect(r.status).toBe(0);
  });
});
