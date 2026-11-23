import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

let root: string;
let fake: FakeProvider;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'archive-rescore-'));
  fake = await startFakeProvider();
});
afterEach(async () => { await fake.close(); rmSync(root, { recursive: true, force: true }); });
function run(...args: string[]) {
  const env = fakeProviderEnv(fake, { home: join(root, 'home'), stateRoot: join(root, 'state') });
  return runSinterAsync(['rescore', ...args], { ...env, QUALITY_ARCHIVE_PATH: join(root, 'archive.json') });
}

it('reports a missing archive without opening a grant or creating a backup', async () => {
  const result = await run('--all', '--domain', 'svg', '--persist');
  expect(result.out).toMatch(/no quality archive at .*nothing to re-score/);
  expect(result.status).toBe(0);
  expect(existsSync(join(root, 'state', 'operation-journal.json'))).toBe(false);
  expect(fake.calls).toHaveLength(0);
});

it('rejects an undersized selection before calling a judge', async () => {
  writeFileSync(join(root, 'archive.json'), JSON.stringify({ archives: { svg: [] } }));
  const result = await run('--domain', 'svg');
  expect(result.out).toContain('RESCORE_ARCHIVE_TOO_SMALL');
  expect(result.status).toBe(2);
  expect(fake.calls).toHaveLength(0);
});

it('enforces the shared cap across real evaluator grants and leaves the archive intact', async () => {
  const output = '<svg viewBox="0 0 200 200"><rect width="200" height="200" fill="#365274"/><circle cx="66" cy="75" r="49" fill="orange"/><path d="M10 130L180 35L130 195Z" fill="#398779"/></svg>';
  const entries = ['first', 'second'].map(id => ({ id, domain: 'svg', prompt: id, output, qualityScore: 0.3 }));
  const bytes = JSON.stringify({ archives: { svg: entries } });
  writeFileSync(join(root, 'archive.json'), bytes);
  const result = await run('--all', '--domain', 'svg', '--max-provider-calls', '1');
  expect(fake.judged, result.out).toHaveLength(1);
  expect(fake.generated).toHaveLength(0);
  const rows = result.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  expect(rows.map(r => r.scoreState)).toEqual(['scored', 'unscored']);
  expect(readFileSync(join(root, 'archive.json'), 'utf8')).toBe(bytes);
  const journal = JSON.parse(readFileSync(join(root, 'state', 'operation-journal.json'), 'utf8'));
  expect(journal.events.filter((e: { type: string }) => e.type === 'transport-started')).toHaveLength(1);
}, 120_000);
