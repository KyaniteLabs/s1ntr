import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Resolve existing links even when the final config (or its parent) is yet to be created.
function statePath(target: string): string {
  if (lstatSync(target, { throwIfNoEntry: false })) return realpathSync(target);
  const parent = dirname(target);
  if (parent === target) throw new Error('PROOF_ISOLATION_PATH_UNRESOLVED: cannot resolve the proof root');
  return join(statePath(parent), basename(target));
}

export function assertProofCannotTouchRealState(target: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.SINTER_PROOF_ISOLATION !== '1') return;
  const rel = relative(realpathSync(userInfo().homedir), statePath(resolve(target)));
  if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
    throw new Error('PROOF_ISOLATION_REAL_STATE_FORBIDDEN: use a temporary home and config for this proof');
  }
}
