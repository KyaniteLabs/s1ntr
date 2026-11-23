/**
 * Comorbidity of the #1893 regression (a parser rewrite dropped `let prompt`, so EVERY `generate` threw
 * "prompt is not defined" and nothing in CI noticed): spawn the real binary through each command family the
 * global parser feeds, and fail on a crash signature. `generate` also runs end to end on the fake provider.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

let fake: FakeProvider; let work: string;
beforeAll(async () => { fake = await startFakeProvider(); work = mkdtempSync(path.join(tmpdir(), 'sinter-smoke-')); });
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

const CRASH = /ReferenceError|is not defined|is not a function|Cannot read propert|Unknown option|Unhandled|ERR_MODULE_NOT_FOUND/;

describe('generate through the real parser, on the fake provider', () => {
  it('a positional prompt and --prompt both reach the provider and save an artifact', async () => {
    for (const [i, argv] of [
      ['generate', '--domain', 'html', 'a lantern drifting over water'],
      ['generate', '--domain', 'html', '--prompt', 'a kite over a quiet harbor'],
    ].entries()) {
      const calls = fake.calls.length;
      const home = path.join(work, `home-${i}`); const state = path.join(work, `state-${i}`);
      const r = await runSinterAsync([...argv, '-o', path.join(work, `out-${i}`)], fakeProviderEnv(fake, { home, stateRoot: state }));
      expect(r.out, argv.join(' ')).not.toMatch(CRASH);
      expect(r.out, argv.join(' ')).toMatch(/Saved: /);
      expect(fake.calls.length, argv.join(' ')).toBeGreaterThan(calls);
      expect(r.status, argv.join(' ')).toBe(0);
    }
  });
});

describe('every parser-fed command family starts without a crash signature', () => {
  const families: string[][] = [
    ['--help'], ['ledger'], ['ledger', 'status'], ['compost', 'status'], ['compost', 'branch', 'list'], ['image'],
    ['gbg'], ['taxonomy', '--no-write'], ['phases'], ['islands'], ['mece', 'manifest', '--check'], ['rotation', '--dry-run'],
    ['ship', 'garden'], ['archive', 'list'], ['archive', 'branch', 'x'], ['garden', 'status'], ['report', 'fitness'],
    ['best-of', '--help'], ['compose', '--help'], ['config', 'show'],
  ];
  for (const argv of families) {
    it(`sinter ${argv.join(' ')}`, async () => {
      const home = path.join(work, `fam-${argv.join('_').replace(/\W/g, '')}`);
      const r = await runSinterAsync(argv, fakeProviderEnv(fake, { home, stateRoot: path.join(home, 'state') }));
      expect(r.out).not.toMatch(CRASH);
    });
  }
});
