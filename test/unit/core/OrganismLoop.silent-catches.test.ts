import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SinterFS } from '../../../src/fs/SinterFS.js';
import { GalleryFSAdapter } from '../../../src/fs/adapters/GalleryFSAdapter.js';
import { Logger } from '../../../src/utils/Logger.js';

const mockGenerate = vi.hoisted(() => vi.fn());
vi.mock('../../../src/musicToVisual/generateMusicToVisual.js', () => ({
  generateMusicToVisual: mockGenerate,
}));
const { runOrganismMode } = await import('../../../src/core/OrganismLoop.js');

const music = `$: s("bd hh*2").gain(0.8).room(0.2)
$: s("cp").rarely(x => x.rev()).gain(0.6)
$: note("c3 eb3 g3 bb3").s("sawtooth").slow(2).gain(0.5)
bpm(120)`;
const visual = `osc(10, 0.1, 0.8)
  .color(1, 0.2, 0.5)
  .rotate(() => time * 0.1)
  .modulate(noise(3))
  .out(o0)
shape(4, 0.5)
  .repeat(3, 3)
  .out(o1)
render(o0)`;

describe('OrganismLoop SinterFS failures are reported, not swallowed', () => {
  let projectRoot: string;
  let galleryDir: string;
  let originalCwd: typeof process.cwd;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'sc3-organism-'));
    galleryDir = mkdtempSync(join(tmpdir(), 'sc3-organism-gallery-'));
    originalCwd = process.cwd;
    process.cwd = () => projectRoot;
    mockGenerate.mockResolvedValue({ musicCode: music, visualCode: visual });
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    mockGenerate.mockReset();
    process.cwd = originalCwd;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(galleryDir, { recursive: true, force: true });
  });

  it('warns on recordRun and saveOrganism failure while the run still completes', async () => {
    const fs = SinterFS.open(projectRoot);
    vi.spyOn(fs, 'recordRun').mockImplementation(() => { throw new Error('event store down'); });
    const saveSpy = vi.spyOn(GalleryFSAdapter.prototype, 'saveOrganism').mockRejectedValue(new Error('adapter down'));
    try {
      const result = await runOrganismMode(
        'strudel + hydra organism',
        { maxIterations: 1, galleryDir, project: 'organism-project' } as never,
        Date.now(),
        fs,
      );
      expect(result.iterations).toBe(1);
      expect(result.completed).toBe(true);
      const messages = warn.mock.calls.map(c => String(c[1]));
      expect(messages).toContain('GalleryFSAdapter saveOrganism failed:');
      expect(messages).toContain('SinterFS recordRun (completed) failed:');
    } finally {
      saveSpy.mockRestore();
      fs.close();
    }
  });
});
