import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PreferenceEventLogger } from '../../../src/learning/PreferenceEventLogger.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('counts the same winner and loser when pair order is reversed', async () => {
 const dir = await mkdtemp(join(process.cwd(), 'sinter-pair-')); roots.push(dir);
 const logger = new PreferenceEventLogger({ prefDir: dir });
 await logger.log({ action: 'pairwise-a', artifactId: 'winner', comparedTo: 'loser' });
 await logger.log({ action: 'pairwise-b', artifactId: 'loser', comparedTo: 'winner' });
 const restored = new PreferenceEventLogger({ prefDir: dir });
 expect(Object.fromEntries(await restored.getPreferenceCounts())).toEqual({
  winner: { positive: 2, negative: 0 }, loser: { positive: 0, negative: 2 },
 });
 expect((await restored.getPairwiseComparisons()).map(p => [p.winner, p.loser])).toEqual([
  ['winner', 'loser'], ['winner', 'loser'],
 ]);
});
