import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDreamQueuePath, resolveGardenPidPath } from '../../../src/dreaming/dreamQueuePath.js';

describe('dream queue path (Sol F18)', () => {
  it('defaults under HOME', () => {
    expect(resolveDreamQueuePath({ HOME: '/h' } as NodeJS.ProcessEnv)).toBe(path.join('/h', '.sinter', 'dreams', 'queue.json'));
  });
  it('honours the override for producers and the consumer alike', () => {
    expect(resolveDreamQueuePath({ HOME: '/h', SINTER_DREAM_QUEUE_PATH: '/tmp/x/q.json' } as NodeJS.ProcessEnv)).toBe('/tmp/x/q.json');
  });
  it('ignores a blank override', () => {
    expect(resolveDreamQueuePath({ HOME: '/h', SINTER_DREAM_QUEUE_PATH: '  ' } as NodeJS.ProcessEnv)).toBe(path.join('/h', '.sinter', 'dreams', 'queue.json'));
  });
  it('pid file lives beside the queue root', () => {
    expect(resolveGardenPidPath({ HOME: '/h' } as NodeJS.ProcessEnv)).toBe(path.join('/h', '.sinter', 'garden.pid'));
  });
});
