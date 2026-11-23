import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs twin of src/utils/scratchSpace.ts
import { browserTmpDir, prepareBrowserScratch } from '../../../scripts/lib/scratch-space.mjs';
import { browserTmpDir as tsBrowserTmpDir } from '../../../src/utils/scratchSpace.js';

describe('scripts/lib/scratch-space.mjs (twin of src/utils/scratchSpace.ts)', () => {
  it('agrees with the TypeScript rule on every case', () => {
    for (const [env, cur] of [[{}, '/srv/models-nvme/a'], [{}, '/var/tmp'], [{ SINTER_BROWSER_TMP: '/x' }, '/srv/models-nvme/a'], [{ SINTER_DATA_VOLUME: '/d' }, '/d/t']] as const) {
      expect(browserTmpDir(env, cur)).toBe(tsBrowserTmpDir(env, cur));
    }
  });
  it.skipIf(process.platform === 'win32')('budgets browser socket paths in bytes for both entry points', () => {
    const atLimit = '/tmp/' + 'x'.repeat(35);
    const overLimit = '/tmp/' + 'é'.repeat(18);
    for (const choose of [browserTmpDir, tsBrowserTmpDir]) {
      expect(choose({}, atLimit)).toBe(atLimit);
      expect(choose({}, overLimit)).toBe('/tmp');
      expect(() => choose({ SINTER_BROWSER_TMP: overLimit }, '/tmp')).toThrow(/SINTER_BROWSER_TMP.*40 bytes/);
    }
  });
  it('moves TMPDIR off the volume and fails plainly when low on space', () => {
    const env: Record<string, string> = { TMPDIR: '/srv/models-nvme/t' };
    expect(prepareBrowserScratch(env, () => 9999)).toBe('/tmp');
    expect(env.TMPDIR).toBe('/tmp');
    expect(() => prepareBrowserScratch({}, () => 10)).toThrow(/10 MB free under .*need at least 512 MB/);
    expect(() => prepareBrowserScratch({ SINTER_SKIP_DISK_PREFLIGHT: '1' }, () => 1)).not.toThrow();
  });
});
