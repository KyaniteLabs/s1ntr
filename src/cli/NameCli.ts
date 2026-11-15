/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * NameCli — the `sinter name` command surface: plates for champions and
 * moves via the Elixis game engine, plus semantic thread confirmation.
 */
import { nameChampions, confirmThreadSemantically } from '../atelier/NamingOrgan.js';

export async function runNameCommand(): Promise<void> {
  const cwd = process.cwd();
  const naming = await nameChampions(cwd);
  if (!naming.elixisUp) {
    console.log('[name] elixis unreachable — plates skipped this wave (organ never fatal)');
    return;
  }
  for (const entry of naming.named) {
    console.log(`[name] ${entry.kind} ${entry.domain} -> "${entry.plate.name}" · silk "${entry.plate.silk}"${entry.plate.subtitle ? ` · ${entry.plate.subtitle.slice(0, 60)}` : ''}`);
  }
  if (naming.named.length === 0) console.log(`[name] ${naming.skipped}`);

  const semantic = await confirmThreadSemantically(cwd);
  if (semantic) {
    console.log(`[name] thread confirmation: ${semantic.confirmed ? 'SEMANTIC' : 'no bridge'} (${semantic.threads} threads, ${semantic.tensions} tensions)`);
  }
}
