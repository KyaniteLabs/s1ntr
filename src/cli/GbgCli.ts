/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * GbgCli — the `sinter gbg` command surface for the Glass Bead Game organ.
 * Per wave the loop plays one move; manual invocation works too.
 */

import { indexBeads, findThreads, playMove } from '../atelier/GlassBeadGame.js';

export function runGbgCommand(cmdArgs: string[]): void {
  const cwd = process.cwd();
  if (cmdArgs.includes('--index') || cmdArgs.includes('--move') || cmdArgs.length === 0) {
    const indexed = indexBeads(cwd);
    const threads = findThreads(cwd);
    console.log(`[gbg] beads +${indexed.added} (total ${indexed.total}) | cross-domain threads ${threads.length}`);
  }
  if (cmdArgs.includes('--move') || cmdArgs.length === 0) {
    const move = playMove(cwd);
    if (move) {
      console.log(`[gbg] MOVE (${move.kind}): ${move.thread.domainA} × ${move.thread.domainB} @ ${move.thread.similarity.toFixed(4)} -> ${move.output}`);
    } else {
      console.log('[gbg] no unplayed thread above threshold this pass');
    }
  }
}
