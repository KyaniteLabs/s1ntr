import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fingerprintArtifactDir, runTournament, savedDirFromOutput } from '../../../src/cli/BestOfTournament.js';
import { extractBriefElements } from '../../../src/evaluation/BriefCoverage.js';
import { computeVisualFingerprint } from '../../../src/evaluation/VisualDiversity.js';
import type { DecodedImagePixels } from '../../../src/render/DecodedImageVisibility.js';

const roots: string[] = [];
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bestof-')); roots.push(root);
  const art = (name: string) => { const d = path.join(root, 'artifacts', name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'source.txt'), name); return d; };
  return { root, art, rejectDir: path.join(root, 'rejects') };
}

describe('Sol audit F06: best-of keeps every receipt resolvable and says which cases may win', () => {
  it('winner, accepted loser and generated-but-rejected case; no artifact is moved', async () => {
    const w = world();
    const dirs = [w.art('win'), w.art('lose'), w.art('rejected')];
    const statuses = [0, 0, 3];
    const means: Record<string, number> = { [dirs[0]]: 7.5, [dirs[1]]: 5.1 };
    const logs: string[] = [];
    const r = await runTournament('a field', 3, {
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

  it('a child that fails or prints no Saved line is never eligible; nothing eligible means no winner', async () => {
    const w = world();
    const r = await runTournament('p', 2, { rejectDir: w.rejectDir, log: () => undefined, score: () => 5,
      runChild: (_p, i) => (i === 0 ? { status: 1, stdout: '' } : { status: 0, stdout: 'no saved line' }) });
    expect(r.winner).toBeUndefined();
  });

  it('parses the Saved line anywhere in the output', () => {
    expect(savedDirFromOutput('x\n✅ Saved: /a/b/source.txt\ny')).toBe('/a/b');
  });
});

function pattern(paint: (x: number, y: number) => [number, number, number]): DecodedImagePixels {
  const width = 64; const height = 64;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x, y); const i = (y * width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { width, height, data };
}
const orb = (jitter: number) => pattern((x, y) => (Math.hypot(x - (32 + jitter), y - 32) < 14 ? [250, 230, 80] : [8, 14, 24]));
const bands = pattern((x, y) => (y < 24 ? [230, 120, 40] : x > 40 ? [40, 210, 190] : [35, 20, 60]));
async function writeFrame(dir: string, img: DecodedImagePixels): Promise<void> {
  await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } }).png().toFile(path.join(dir, 'late-frame.png'));
}

describe('#1855 diversity: best-of takes for one prompt are pushed apart and look-alikes are penalised', () => {
  it('gives every take its own one-line seed direction and keeps it out of the brief the judge checks', async () => {
    const w = world();
    const seen: string[] = [];
    await runTournament('fireflies over a misty pond', 3, { rejectDir: w.rejectDir, log: () => undefined, score: () => null,
      runChild: (p) => { seen.push(p); return { status: 1, stdout: '' }; } });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain('Take 1 visual direction — Wide Establishing Depth');
    expect(seen[1]).toContain('Take 2 visual direction — Intimate Macro Detail');
    expect(seen[2]).toContain('Take 3 visual direction — Graphic Silhouette & Negative Space');
    for (const p of seen) {
      expect(p.includes('\n')).toBe(false);
      expect(extractBriefElements(p)).toEqual(extractBriefElements('fireflies over a misty pond'));
    }
  });

  it('reads each take\'s rendered frame and picks a different-looking runner-up over a near-clone of the winner', async () => {
    const w = world();
    const dirs = [w.art('clone-a'), w.art('clone-b'), w.art('distinct')];
    await writeFrame(dirs[0], orb(0));
    await writeFrame(dirs[1], orb(1));
    await writeFrame(dirs[2], bands);
    const means: Record<string, number> = { [dirs[0]]: 8.0, [dirs[1]]: 7.9, [dirs[2]]: 7.0 };
    const logs: string[] = [];
    // No fingerprint dep: the real default reads late-frame.png from each saved take.
    const r = await runTournament('fireflies', 3, { rejectDir: w.rejectDir, log: (l) => logs.push(l),
      runChild: (_p, i) => ({ status: 0, stdout: `Saved: ${dirs[i]}/source.txt\n` }), score: (d) => means[d] ?? null });
    expect(r.diversityRanked).toBe(true);
    expect(r.winner?.dir).toBe(dirs[0]);
    expect(r.winner?.diversityPenalty).toBe(0);
    expect(r.runnerUp?.dir).toBe(dirs[2]);
    expect(r.runnerUp?.diversityPenalty).toBe(0);
    const clone = JSON.parse(fs.readFileSync(path.join(w.rejectDir, 'clone-b.json'), 'utf8'));
    expect(clone.loserTo).toBe(dirs[0]);
    expect(clone.diversityPenalty).toBeGreaterThan(0.2);
    expect(logs.filter(l => l.includes('clone-b looks like a higher take'))).toHaveLength(1);
  });

  it('falls back to plain score order when a take has no readable frame', async () => {
    const w = world();
    const dirs = [w.art('a'), w.art('b')];
    await writeFrame(dirs[0], orb(0));
    const logs: string[] = [];
    const r = await runTournament('p', 2, { rejectDir: w.rejectDir, log: (l) => logs.push(l),
      runChild: (_p, i) => ({ status: 0, stdout: `Saved: ${dirs[i]}/source.txt\n` }), score: (d) => (d === dirs[0] ? 5 : 6) });
    expect(r.diversityRanked).toBe(false);
    expect(r.winner?.dir).toBe(dirs[1]);
    expect(r.runnerUp?.dir).toBe(dirs[0]);
    expect(logs).toContain('[best-of] diversity ranking skipped: 1/2 takes had a readable frame');
    expect(await fingerprintArtifactDir(dirs[1])).toBeNull();
    expect(await fingerprintArtifactDir(dirs[0])).toEqual(computeVisualFingerprint(orb(0)));
  });
});
