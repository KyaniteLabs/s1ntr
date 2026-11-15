import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const unlinkSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, unlinkSync: unlinkSyncMock };
});

import { writeFileAtomicSync } from '../../../src/utils/atomicWrite.js';
import { Logger } from '../../../src/utils/Logger.js';

describe('writeFileAtomicSync temp cleanup', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    unlinkSyncMock.mockReset();
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  // Parent dir does not exist, so the write itself fails with ENOENT.
  const target = join(tmpdir(), 'sc2-no-such-dir', 'x.json');

  it('rethrows the write error and stays silent when the temp is already absent (ENOENT)', () => {
    unlinkSyncMock.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
    expect(() => writeFileAtomicSync(target, 'data')).toThrow(/ENOENT/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rethrows the write error and warns when the temp cannot be removed (EACCES)', () => {
    unlinkSyncMock.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(() => writeFileAtomicSync(target, 'data')).toThrow(/ENOENT/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain(`could not remove temp file ${target}.tmp-`);
  });
});
