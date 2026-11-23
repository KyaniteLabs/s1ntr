/**
 * Dogfood finding 4: gallery, site seed and swarm sessions printed nothing readable (or a bare usage error).
 * Each now prints a result, or a precise reason with a non-zero exit code. All through the real binary.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000, hookTimeout: 280_000 });
let work: string; let fake: FakeProvider; let env: NodeJS.ProcessEnv; let proj: string;
const run = (args: string[]) => runSinterAsync(args, env, proj);
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-surfaces-')); fake = await startFakeProvider();
  proj = path.join(work, 'proj'); mkdirSync(proj, { recursive: true });
  env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

describe('gallery', () => {
  it('says the gallery is empty and where, exit 0, before any generate', async () => {
    const r = await run(['gallery', 'list']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Gallery \S+\/gallery is empty\./);
  });
  it('rejects a --gallery directory that does not exist, exit 1', async () => {
    const r = await run(['gallery', 'list', '--gallery', path.join(work, 'nope')]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/No gallery at \S+\/nope/);
  });
  it('lists the piece after one accepted generate', async () => {
    const g = await run(['generate', '-o', path.join(work, 'out'), '--domain', 'html', 'a slow orbit of colored light']);
    expect(g.status).toBe(0);
    const r = await run(['gallery', 'list']);
    expect(r.out).toMatch(/1 project/);
    expect(r.out).toMatch(/\d{4}-\d{2}-\d{2}--html-[0-9a-f]{8}\s+1 version\s+latest v1/);
  });
  it('archive inspect without an id names the missing argument and the way to find one, exit 1', async () => {
    const r = await run(['archive', 'inspect']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('archive inspect needs an artifact id. List the ids with: sinter archive list');
  });
});

describe('site seed', () => {
  it('prints each seeded slot and the state file, then reports nothing to seed on the second run', async () => {
    const first = await run(['site', 'seed', '--slots', '3']);
    expect(first.status).toBe(0);
    expect(first.out).toMatch(/Seeded slot "[\w-]+" \(/);
    expect(first.out).toMatch(/Seeded 3 slot\(s\) → \S+slots\.json/);
    const again = await run(['site', 'seed', '--slots', '3']);
    expect(again.out).toMatch(/All 3 requested slot\(s\) already exist — nothing to seed/);
  });
});

describe('swarm sessions', () => {
  it('names the directory it looked in when there are none', async () => {
    const r = await run(['swarm', 'sessions']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/No swarm sessions found in \S+\/\.sinter\/swarm\/sessions/);
  });
});
