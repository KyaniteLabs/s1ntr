import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDomainTeaching } from '../../../src/generators/DomainTeaching.js';

describe('retained domain teaching', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sinter-teaching-'));
    mkdirSync(join(root, '.omx/atelier/lessons'), { recursive: true });
    writeFileSync(join(root, 'source.txt'), 'RETAINED_EXEMPLAR_SOURCE');
    writeFileSync(join(root, '.omx/atelier/lessons/hints.json'), JSON.stringify([
      { id: 'retained-p5', text: 'RETAINED_P5_LESSON', domains: ['p5'] },
      { id: 'retained-audio', text: 'UNRELATED_AUDIO_LESSON', domains: ['tone'] },
    ]));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  for (const [scoreScale, expected] of [[10, '6.70/10'], [5, '3.35/5'], [undefined, '6.70 (scale unrecorded)']] as const) {
    it(`reuses lessons and exemplar with recorded scale ${scoreScale}`, () => {
      writeFileSync(join(root, '.omx/atelier/best-per-domain.json'), JSON.stringify({
        p5: { dir: root, mean: scoreScale === 5 ? 3.35 : 6.7, scoreScale },
      }));
      const teaching = buildDomainTeaching('p5');
      expect(teaching).toContain('RETAINED_P5_LESSON');
      expect(teaching).not.toContain('UNRELATED_AUDIO_LESSON');
      expect(teaching).toContain('RETAINED_EXEMPLAR_SOURCE');
      expect(teaching).toContain(expected);
      expect(buildDomainTeaching('tone')).not.toContain('RETAINED_EXEMPLAR_SOURCE');
    });
  }
  it('a corrupt exemplar tracker keeps the lessons and is reported, not swallowed (Sol G16)', () => {
    writeFileSync(join(root, '.omx/atelier/best-per-domain.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const teaching = buildDomainTeaching('p5');
    expect(teaching).toContain('RETAINED_P5_LESSON');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exemplar tracker'));
  });
  it('an invalid lessons file is reported while the tracker exemplar survives', () => {
    writeFileSync(join(root, '.omx/atelier/lessons/hints.json'), '][');
    writeFileSync(join(root, '.omx/atelier/best-per-domain.json'), JSON.stringify({ p5: { dir: root, mean: 6.7, scoreScale: 10 } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildDomainTeaching('p5')).toContain('RETAINED_EXEMPLAR_SOURCE');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system lessons'));
  });
});
