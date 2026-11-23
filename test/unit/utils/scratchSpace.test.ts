import { describe, expect, it } from 'vitest';
import {
  assertFreeSpace, browserTmpDir, LowDiskError, prepareBrowserScratch, useSystemTmpForBrowsers,
} from '../../../src/utils/scratchSpace.js';

describe('browser scratch space', () => {
  it('moves a temp dir that sits on the data volume to system temp', () => {
    expect(browserTmpDir({}, '/srv/models-nvme/scratch/x/tmp')).toBe('/tmp');
    expect(browserTmpDir({}, '/srv/models-nvme')).toBe('/tmp');
    expect(browserTmpDir({}, '/srv/models-nvme-other/tmp')).toBe('/srv/models-nvme-other/tmp');   // prefix is not the volume
    expect(browserTmpDir({}, '/var/tmp')).toBe('/var/tmp');
  });

  it('SINTER_BROWSER_TMP overrides, and SINTER_DATA_VOLUME names another volume', () => {
    expect(browserTmpDir({ SINTER_BROWSER_TMP: '/scratch/b' }, '/srv/models-nvme/t')).toBe('/scratch/b');
    expect(browserTmpDir({ SINTER_DATA_VOLUME: '/data' }, '/data/t')).toBe('/tmp');
  });

  it('rewrites TMPDIR in the given env only when needed', () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/srv/models-nvme/scratch/t' };
    expect(useSystemTmpForBrowsers(env)).toBe('/tmp');
    expect(env.TMPDIR).toBe('/tmp');
    const ok: NodeJS.ProcessEnv = { TMPDIR: '/var/tmp' };
    useSystemTmpForBrowsers(ok);
    expect(ok.TMPDIR).toBe('/var/tmp');
  });

  it('fails with a plain message under the free-space threshold, before any browser starts', () => {
    expect(() => assertFreeSpace('/tmp', {}, () => 100)).toThrow(LowDiskError);
    expect(() => assertFreeSpace('/tmp', {}, () => 100)).toThrow(/100 MB free under \/tmp, need at least 512 MB/);
    expect(assertFreeSpace('/tmp', {}, () => 600)).toBe(600);
  });

  it('threshold and skip are configurable; an unreadable probe does not block', () => {
    expect(() => assertFreeSpace('/tmp', { SINTER_MIN_FREE_MB: '2000' }, () => 600)).toThrow(LowDiskError);
    expect(assertFreeSpace('/tmp', { SINTER_MIN_FREE_MB: '100' }, () => 600)).toBe(600);
    expect(assertFreeSpace('/tmp', { SINTER_SKIP_DISK_PREFLIGHT: '1' }, () => 1)).toBeNull();
    expect(assertFreeSpace('/tmp', {}, () => null)).toBeNull();
  });

  it('prepareBrowserScratch passes on the real system temp dir', () => {
    expect(() => prepareBrowserScratch({ ...process.env, SINTER_MIN_FREE_MB: '1' })).not.toThrow();
  });
});
