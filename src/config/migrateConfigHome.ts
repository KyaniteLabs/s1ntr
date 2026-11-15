/**
 * One-time move of a legacy config home (~/.liminal or ~/.atelier) to ~/.sinter,
 * so keys, config, memory and gallery carry over. Runs before any config read.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ConfigHomeMigration = 'none' | 'skipped' | 'moved' | 'copied' | 'failed';

type MigrationFs = Pick<typeof fs, 'existsSync' | 'renameSync' | 'cpSync' | 'rmSync'>;

const LEGACY_HOMES = ['.liminal', '.atelier'];

// Asking for help or the version must not move the user's files.
const PRINT_ONLY_FLAGS = new Set(['--help', '-h', '--version']);

export function migrateConfigHome(
  home: string | undefined,
  args: readonly string[],
  fsImpl: MigrationFs = fs,
): ConfigHomeMigration {
  if (!home) return 'none';
  if (args.some((arg) => PRINT_ONLY_FLAGS.has(arg))) return 'skipped';
  const newDir = path.join(home, '.sinter');
  if (fsImpl.existsSync(newDir)) return 'none';

  const legacy = LEGACY_HOMES.map((name) => path.join(home, name)).find((dir) => fsImpl.existsSync(dir));
  if (!legacy) return 'none';

  try {
    fsImpl.renameSync(legacy, newDir);
    return 'moved';
  } catch {
    // Another Sinter process may have finished the move between our check and our
    // rename. ~/.sinter is then the user's only copy, so it is never deleted here.
    if (fsImpl.existsSync(newDir)) return 'none';

    // The move failed (another drive, or a file in use). Copy everything into a
    // private folder and put it in place in one step, keeping the original. A
    // failed copy removes only that private folder, so the next run tries again.
    const staging = `${newDir}.migrating-${process.pid}`;
    try {
      fsImpl.cpSync(legacy, staging, { recursive: true });
      fsImpl.renameSync(staging, newDir);
      return 'copied';
    } catch {
      fsImpl.rmSync(staging, { recursive: true, force: true });
      return fsImpl.existsSync(newDir) ? 'none' : 'failed';
    }
  }
}
