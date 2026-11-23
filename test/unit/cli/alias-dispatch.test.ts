import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { normalizeCliCommand } from '../../../src/cli/PromptArgs.js';
import { PUBLIC_MEDIUMS } from '../../../src/types/mediumNames.js';
import { isolatedCliEnv } from '../../helpers/isolatedCli.js';

const COMMAND_ROWS: Array<[string[], string[]]> = [
  [['domains', 'gauntlet'], ['mediums', 'check']],
  [['sss-score', 'a.svg'], ['score', 'a.svg']],
  [['dream', 'status'], ['learn', 'status']],
  [['dream', 'run', 'c.json'], ['learn', 'study', 'c.json']],
  [['dream', 'transfer', 'c.json'], ['learn', 'reserve', 'c.json']],
  [['dream', 'autoseal'], ['learn', 'pick-best']],
  [['dream', 'guard'], ['learn', 'verify']],
  [['dream', 'guard'], ['learn', 'guard']],
  [['dream', 'compound', 'c.json'], ['learn', 'stack', 'c.json']],
  [['dream', 'activate', 'c.json'], ['learn', 'activate', 'c.json']],
  [['compost', 'add', 'x.txt'], ['motifs', 'add', 'x.txt']],
  [['compost', 'digest'], ['motifs', 'mine']],
  [['compost', 'seeds', 'list'], ['motifs', 'list']],
  [['compost', 'soup', 'start'], ['motifs', 'evolve', 'start']],
  [['compost', 'soup', 'stop'], ['motifs', 'evolve', 'stop']],
  [['compost', 'soup', 'status'], ['motifs', 'evolve', 'status']],
  [['gbg'], ['crossovers']],
  [['garden', 'status'], ['autopilot', 'status']],
  [['garden', 'rebalance'], ['autopilot', 'balance']],
  [['garden', 'start'], ['autopilot', 'start']],
  [['garden', 'stop'], ['autopilot', 'stop']],
  [['garden', 'tend'], ['autopilot', 'curate']],
  [['ship', 'rollback'], ['promote', 'rollback']],
  [['ship', 'rollback'], ['promote', '--undo']],
  [['ship', 'garden'], ['promote', 'garden']],
  [['islands'], ['movements']],
  [['phases'], ['turning-points']],
  [['bridge', '3001'], ['api', '3001']],
  [['organism', 'inspect'], ['session', 'inspect']],
  [['name'], ['titles', 'make']],
  [['conductor'], ['titles', 'budget']],
  [['taxonomy'], ['vocabulary']],
  [['field', 'frontier'], ['neighbors']],
  [['field', 'interpolate'], ['breed']],
  [['market', 'status'], ['release-check']],
  [['prompt-next'], ['prompt', 'next']],
  [['prompt', 'synthesize'], ['prompt', 'from-graph']],
  [['ledger', 'query'], ['events']],
  [['ledger', 'list'], ['tasks']],
  [['emergence', 'score'], ['surprise', 'score']],
  [['judgment', 'compare'], ['judge', 'compare']],
  [['improve', 'scan'], ['self-improve', 'scan']],
  [['improve', 'run'], ['self-improve', 'run']],
  [['self-improve', 'gauntlet'], ['self-improve', 'gauntlet']],
];

it.each(COMMAND_ROWS)('dispatches %j and %j identically', (old, alias) => {
  expect(normalizeCliCommand(alias[0], alias.slice(1))).toEqual({ cmd: old[0], cmdArgs: old.slice(1) });
});

const { home, env } = isolatedCliEnv();
afterAll(() => rmSync(home, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve('bin/sinter'), ...args],
  { cwd: home, env, encoding: 'utf8', timeout: 30_000 });

it('prints the canonical command help for aliases and judge rounds', () => {
  for (const [alias, canonical] of [
    [['learn', 'verify'], 'dream'], [['tasks'], 'ledger'], [['judge', '--json', 'compare'], 'judgment'], [['judge', 'sweep', '--round', '3'], 'third-judge'],
  ] as const) {
    const result = run(...alias, '--help');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(run(canonical, '--help').stdout);
  }
});

it('lists public mediums and passes the tasks alias to the ledger parser', () => {
  const mediums = run('mediums', 'list');
  expect(mediums.status, mediums.stderr).toBe(0);
  for (const id of PUBLIC_MEDIUMS) expect(mediums.stdout).toContain('  ' + id + '  ');
  const list = run('tasks', '--lane', '1');
  expect(list.status, list.stderr).toBe(0);
  expect(list.stdout).toBe(run('ledger', 'list', '--lane', '1').stdout);
});

it('rejects --record through the governed generate flag check', () => {
  const result = run('generate', '--record', 'a quiet field');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--learn');
});

it.each([['--reference', '--ref'], ['--energy', '--arc'], ['--hits', '--cues']])(
  'passes %s to the same compose validation as %s', (alias, original) => {
    const args = ['compose', '--spec', 'unused.json'];
    const result = run(...args, alias, 'input');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('work with a compose prompt');
    expect(result.stderr).toBe(run(...args, original, 'input').stderr);
  },
);
