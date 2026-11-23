import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTournament, savedDirFromOutput } from '../../../src/cli/BestOfTournament.js';

const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bestof-')); roots.push(root);
  const art = (name: string) => { const d = path.join(root, 'artifacts', name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'source.txt'), name); return d; };
  return { root, art, rejectDir: path.join(root, 'rejects') };
}

describe('Sol audit F06: best-of keeps every receipt resolvable and says which cases may win', () => {
  it('winner, accepted loser and generated-but-rejected case; no artifact is moved', () => {
    const w = world();
    const dirs = [w.art('win'), w.art('lose'), w.art('rejected')];
    const statuses = [0, 0, 3];
    const means: Record<string, number> = { [dirs[0]]: 7.5, [dirs[1]]: 5.1 };
    const logs: string[] = [];
    const r = runTournament('a field', 3, {
      rejectDir: w.rejectDir, log: (l) => logs.push(l),
      runChild: (_p, i) => ({ status: statuses[i], stdout: `Quality\n✅ Saved: ${dirs[i]}/source.txt\n` }),
      score: (d) => means[d] ?? 9.9, // the rejected one would out-score both if it were wrongly eligible
    });
    expect(r.winner?.dir).toBe(dirs[0]);
    expect(r.runnerUp?.dir).toBe(dirs[1]);
    expect(r.notAccepted).toEqual([dirs[2]]);
    // every artifact, loser and rejected included, still holds its bytes where the receipt expects them
    for (const d of dirs) expect(fs.readFileSync(path.join(d, 'source.txt'), 'utf8')).toBe(path.basename(d));
    const ref = JSON.parse(fs.readFileSync(path.join(w.rejectDir, 'lose.json'), 'utf8'));
    expect(ref.artifactDirectory).toBe(dirs[1]);
    expect(logs.join('\n')).toMatch(/NOT accepted \(exit 3\)/);
  });

  it('a child that fails or prints no Saved line is never eligible; nothing eligible means no winner', () => {
    const w = world();
    const r = runTournament('p', 2, { rejectDir: w.rejectDir, log: () => undefined, score: () => 5,
      runChild: (_p, i) => (i === 0 ? { status: 1, stdout: '' } : { status: 0, stdout: 'no saved line' }) });
    expect(r.winner).toBeUndefined();
  });

  it('parses the Saved line anywhere in the output', () => {
    expect(savedDirFromOutput('x\n✅ Saved: /a/b/source.txt\ny')).toBe('/a/b');
  });
});
