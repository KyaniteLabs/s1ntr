import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gallery } from '../../../src/gallery/Gallery.js';
import { Logger } from '../../../src/utils/Logger.js';

describe('Gallery cleanup recovery', () => {
  const projects = ['2000-01-02--newer', '2000-01-01--older'];
  let directory: string;
  let gallery: Gallery;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'gallery-cleanup-'));
    gallery = new Gallery(directory);
    await Promise.all(projects.map(project => fs.mkdir(join(directory, project))));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('counts only completed moves and reports a failed move', async () => {
    const failure = new Error('destination unavailable');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure);
    const warning = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    expect(await gallery.cleanupOldProjects(0, 30)).toBe(1);
    expect(await fs.readdir(join(directory, '_archived'))).toEqual([projects[1]]);
    expect((await fs.readdir(directory)).sort()).toEqual(['_archived', projects[0]].sort());
    expect(warning).toHaveBeenCalledExactlyOnceWith('Gallery',
      `Could not archive project "${projects[0]}"`, failure);
  });

  it('reports zero completed moves when every rename fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('permission denied'));
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    expect(await gallery.cleanupOldProjects(0, 30)).toBe(0);
    expect(await fs.readdir(join(directory, '_archived'))).toEqual([]);
  });

  it('reports a failed inspection and continues with other projects', async () => {
    const failure = new Error('unable to inspect');
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(failure);
    const warning = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    expect(await gallery.cleanupOldProjects(1, 30)).toBe(1);
    expect(await fs.readdir(join(directory, '_archived'))).toEqual([projects[1]]);
    expect(warning).toHaveBeenCalledExactlyOnceWith('Gallery',
      `Could not inspect project "${projects[0]}" for archiving`, failure);
  });

  it.each(['EACCES', 'EIO'])('propagates %s directory read errors instead of empty history', async code => {
    const failure = Object.assign(new Error('directory unreadable'), { code });
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(failure);
    await expect(gallery.loadHistoryFromDir(projects[0])).rejects.toBe(failure);
  });

  it.each(['loadHistory', 'hasIterations', 'getLatestVersion'] as const)(
    '%s preserves errors from the project history reader', async method => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const failure = Object.assign(new Error('history unreadable'), { code: 'EACCES' });
      vi.spyOn(fs, 'readdir').mockResolvedValueOnce(entries).mockRejectedValueOnce(failure);
      vi.spyOn(Logger, 'error').mockImplementation(() => {});
      await expect(gallery[method]('newer')).rejects.toBe(failure);
    });

  it('propagates a gallery listing error instead of hiding all projects', async () => {
    const failure = Object.assign(new Error('gallery unreadable'), { code: 'EACCES' });
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(failure);
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    await expect(gallery.listProjectDirs()).rejects.toBe(failure);
  });
});
