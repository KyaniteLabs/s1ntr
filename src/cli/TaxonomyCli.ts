/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * TaxonomyCli — the `sinter taxonomy` command surface: grow the Elixis
 * taxonomy from the name log + plate store + beads, write it to
 * .omx/atelier/game/taxonomy.json (the NamingOrgan's state dir, where a
 * future naming pass can read it as suggestions), and print the report.
 */
import { growTaxonomy, writeTaxonomy, formatTaxonomyReport } from '../atelier/TaxonomyGrowth.js';

export function runTaxonomyCommand(cmdArgs: string[]): void {
  const cwd = process.cwd();
  const taxonomy = growTaxonomy(cwd);
  if (cmdArgs.includes('--json')) {
    console.log(JSON.stringify(taxonomy, null, 1));
  } else {
    console.log(formatTaxonomyReport(taxonomy));
  }
  if (!cmdArgs.includes('--no-write')) {
    const path = writeTaxonomy(cwd, taxonomy);
    console.error(`[taxonomy] wrote ${path}`); // stderr: keeps --json stdout pipeable
  }
}
