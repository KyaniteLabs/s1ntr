import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ path: '', disappearOnStat: false }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    stat: async (path: string) => {
      if (race.disappearOnStat && path === race.path) {
        race.disappearOnStat = false;
        await actual.rm(path, { recursive: true, force: true });
      }
      return actual.stat(path);
    },
  };
});

import { FileDreamAssimilationRunStore } from '../../../src/creative-run/DreamAssimilationRun.js';

describe('FileDreamAssimilationRunStore lock claim', () => {
  it('retries when the lock directory disappears before its stale-check stat', async () => {
    const requestKey = 'disappearing-lock-owner';
    const root = await mkdtemp(join(tmpdir(), 'dream-lock-race-'));
    const digest = createHash('sha256').update(JSON.stringify(requestKey)).digest('hex');
    const lockPath = join(root, `${digest}.lock`);
    await mkdir(lockPath);
    race.path = lockPath;
    race.disappearOnStat = true;
    const operation = vi.fn(async () => 'claimed');
    try {
      await expect(new FileDreamAssimilationRunStore(root).claim(requestKey, operation))
        .resolves.toBe('claimed');
      expect(race.disappearOnStat).toBe(false);
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      race.disappearOnStat = false;
      race.path = '';
      await rm(root, { recursive: true, force: true });
    }
  });
});
