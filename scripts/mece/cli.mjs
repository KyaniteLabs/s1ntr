#!/usr/bin/env node
/**
 * Dispatcher for `sinter mece` (UMD-V2 MECE inventory/diagnose).
 *
 * bin/sinter spawns this file for `sinter mece <subcommand> ...`; each
 * subcommand delegates to its sibling module in this directory. It can also
 * be run directly: `node scripts/mece/cli.mjs <subcommand> ...`.
 *
 * Note: bin/sinter's own flag parser only forwards positional arguments here,
 * so flag-heavy flows (`--write`, `--check`) still run the sibling modules
 * directly, e.g. via the `mece:inventory` / `mece:diagnose` package scripts.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkBudget, loadBudget } from './budget.mjs';

const USAGE = `usage: sinter mece <subcommand> [args]

UMD-V2 MECE inventory/diagnose.

subcommands:
  manifest                 Validate the MECE manifest (summary JSON, exit 1 on validation errors)
  inventory                Build the cluster ledger (writes .quality/mece/ledger.json)
  diagnose <clusterId>     Diagnose one cluster (e.g. C-core) and write its plan JSON
  budget [<usage.json>]    Print the effective wave budget; with a usage JSON file, check it
                           against the ceilings (exit 1 on breach)
  help                     Show this usage

Budget ceilings: SINTER_WAVE_BUDGET_{CALLS,TOKENS,USD,MS} (LIMINAL_WAVE_BUDGET_* aliases win).`;

function printUsage(stream = process.stdout) {
  stream.write(`${USAGE}\n`);
}

const DELEGATES = {
  manifest: () => import('./manifest.mjs'),
  inventory: () => import('./inventory.mjs'),
  diagnose: () => import('./diagnose-cluster.mjs'),
};

export async function main(argv = process.argv.slice(2)) {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printUsage();
    return 0;
  }
  const delegate = DELEGATES[sub];
  if (delegate) {
    const mod = await delegate();
    return mod.main(rest) ?? 0;
  }
  if (sub === 'budget') {
    const usagePath = rest.find((a) => !a.startsWith('-'));
    if (usagePath) {
      const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
      const result = checkBudget(usage);
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    console.log(JSON.stringify(loadBudget(), null, 2));
    return 0;
  }
  printUsage(process.stderr);
  console.error(`mece: unknown subcommand '${sub}'`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code);
      // else let stdout drain and the loop exit naturally
    },
    (err) => {
      console.error(`mece error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    },
  );
}
