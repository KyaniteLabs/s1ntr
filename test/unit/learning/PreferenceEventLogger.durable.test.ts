import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreferenceEventLogger } from '../../../src/learning/PreferenceEventLogger.js';
const prefDir = path.join(os.tmpdir(), `liminal-prefs-${process.pid}`);
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await fs.rm(prefDir, {recursive:true,force:true}); });
it('retains concurrent same-millisecond preferences after reload', async () => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  const logger = new PreferenceEventLogger({prefDir});
  await Promise.all(['first','second'].map(artifactId => logger.log({action:'pin',artifactId})));
  const reloaded = new PreferenceEventLogger({prefDir});
  expect((await reloaded.getEvents()).map(e => e.artifactId).sort()).toEqual(['first','second']);
  expect((await logger.getEvents()).map(e => e.artifactId).sort()).toEqual(['first','second']);
});
it('does not report a preference in memory after persistence fails', async () => {
  const logger = new PreferenceEventLogger({prefDir});
  await logger.getEvents();
  await fs.writeFile(prefDir, 'not a directory');
  await expect(logger.log({action:'pin',artifactId:'unsaved'})).rejects.toMatchObject({code:'EEXIST'});
  expect(await logger.getEvents()).toEqual([]);
});
