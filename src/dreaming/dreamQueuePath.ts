/**
 * One resolver for the dream queue file, used by every producer (garden tend/start, the TUI bridge, the
 * post-generation writer) and the consumer (the self-improve cycle). Sol F18: the override was honoured by
 * the producers but the consumer always read the default, so a custom queue was never consumed.
 */
import os from 'node:os';
import path from 'node:path';

export function resolveDreamQueuePath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.SINTER_DREAM_QUEUE_PATH?.trim();
  return override ? path.resolve(override) : path.join(env.HOME || home, '.sinter', 'dreams', 'queue.json');
}

/** Pid file the long-running gardener writes so `garden stop` can reach it from another shell. */
export function resolveGardenPidPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.HOME || home, '.sinter', 'garden.pid');
}
