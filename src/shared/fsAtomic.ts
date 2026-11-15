/**
 * Atomic file writes for state that must never be torn (bandit posteriors,
 * Elo tables, domain-best trackers).
 *
 * A direct writeFileSync interleaved with a concurrent reader leaves a
 * half-written JSON: the reader's parse throws, its catch starts a fresh
 * empty table, and the next save() WIPES months of state. writeAtomicSync
 * writes to a temp file then renames — rename is atomic on POSIX, so readers
 * see either the old or the new file, never a torn one.
 */

import { writeFileSync, renameSync } from 'node:fs';

export function writeAtomicSync(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
