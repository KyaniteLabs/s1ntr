import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bootstrapExecutorAuthority } from '../identity/executorAuthorityBootstrap.js';
import {
  formatHarnessExecutorProjection,
  projectExecutorAttemptHistory,
  type HarnessExecutorProjection,
} from '../identity/harnessTransportGuard.js';

export function readExecutorTruthProjection(rootDir = process.env.SINTER_EXECUTOR_AUTHORITY_ROOT
  ?? join(homedir(), '.sinter', 'executor-authority')): HarnessExecutorProjection {
  const attemptsDir = join(rootDir, 'attempts');
  if (!existsSync(attemptsDir)) return { status: 'idle', attempts: [] };
  const authority = bootstrapExecutorAuthority({ rootDir });
  const attempts = [...(authority.readAttemptHistory?.() ?? [])];
  return projectExecutorAttemptHistory(attempts);
}

/** CLI command implementation: emits the exact JSON DTO consumed by Studio. */
export function runExecutorTruthCli(options: { rootDir?: string; write?: (line: string) => void } = {}): HarnessExecutorProjection {
  const projection = readExecutorTruthProjection(options.rootDir);
  (options.write ?? ((line: string) => process.stdout.write(`${line}\n`)))(formatHarnessExecutorProjection(projection));
  return projection;
}
