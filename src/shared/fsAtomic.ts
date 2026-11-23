/**
 * Atomic file writes for state that must never be torn (bandit posteriors, Elo tables, domain-best
 * trackers, the provider budget ledger).
 *
 * One implementation lives in utils/atomicWrite.ts (temp file with a unique suffix, rename, temp
 * cleanup on failure). This name is kept for the callers that already import it.
 */
import { writeFileAtomicSync } from '../utils/atomicWrite.js';

export function writeAtomicSync(file: string, data: string): void {
  writeFileAtomicSync(file, data);
}
