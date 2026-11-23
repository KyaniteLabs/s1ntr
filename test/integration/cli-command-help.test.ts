/**
 * Dogfood finding 5: `sinter <cmd> --help` printed the global help for every subcommand.
 * Gate: every command registered in bin/sinter (cmd === '<name>') has its own help (usage, flags, example),
 * and the real binary prints it, not the global help.
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { COMMAND_HELP } from '../../src/cli/CommandHelp.js';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';
import { runSinterAsync } from '../helpers/fakeProviderServer.js';

const { env, home } = isolatedCliEnv();
afterAll(() => rmSync(home, { recursive: true, force: true }));
vi.setConfig({ testTimeout: 280_000 });
const root = path.resolve(__dirname, '../..');
const registered = [...new Set([...readFileSync(path.join(root, 'bin/sinter'), 'utf8').matchAll(/cmd === '([a-z0-9-]+)'/g)].map(m => m[1] as string))];

describe('per-command help', () => {
  it('registers help for every command bin/sinter dispatches on', () => {
    expect(registered.length).toBeGreaterThan(60);
    expect(registered.filter(c => !(c in COMMAND_HELP))).toEqual([]);
  });
  it('every help entry has usage, a summary and an example', () => {
    for (const [name, e] of Object.entries(COMMAND_HELP)) {
      expect(e.usage.length, name).toBeGreaterThan(0);
      expect(e.summary.length, name).toBeGreaterThan(5);
      expect(e.example, name).toContain('sinter');
    }
  });
  it('the real binary prints each command its own help, never the global help', async () => {
    const bad: string[] = [];
    for (const name of Object.keys(COMMAND_HELP).filter(n => n !== 'help')) {
      const r = await runSinterAsync([name, '--help'], env, root);
      const okOut = r.out.startsWith(`sinter ${name}:`) && r.out.includes('Usage:') && r.out.includes('Example:')
        && !r.out.includes('Creative Coding Agent');
      if (r.status !== 0 || !okOut) bad.push(`${name} (exit ${r.status}): ${r.out.slice(0, 80).replace(/\n/g, ' ')}`);
    }
    expect(bad).toEqual([]);
  });
  it('a sample shows the flags and the example', async () => {
    const r = await runSinterAsync(['swarm', '--help'], env, root);
    expect(r.out).toContain('sinter swarm sessions [--all] [--limit 20]');
    expect(r.out).toContain('--winner <index|personaId>');
    expect(r.out).toContain('Example:\n  sinter swarm sessions --all');
  });
});
