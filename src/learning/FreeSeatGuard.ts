import { existsSync } from 'node:fs';

/** Providers that bill the owner's paid accounts; a learning step must never reach them. */
const PAID_PROVIDERS = new Set(['anthropic', 'claude', 'claude-code', 'openai', 'codex', 'auto', '']);

export const FREE_SEATS_ONLY_ENV = 'SINTER_LEARNING_FREE_SEATS_ONLY';

/**
 * Fail-closed check for learning stages that call a provider (compost add, dream).
 * Active only when SINTER_LEARNING_FREE_SEATS_ONLY=1. Throws with a clear message when the
 * pinned seat config file is missing or the generator role resolved to a paid default.
 */
export function assertFreeLearningSeat(env: NodeJS.ProcessEnv, resolvedProvider: string | undefined): void {
  if (env[FREE_SEATS_ONLY_ENV] !== '1') return;
  const configPath = env.SINTER_CONFIG_PATH;
  if (!configPath || !existsSync(configPath)) {
    throw new Error(`LEARNING_NO_FREE_SEAT: ${FREE_SEATS_ONLY_ENV}=1 but SINTER_CONFIG_PATH `
      + `${configPath ? `(${configPath}) does not exist` : 'is not set'}; configure a free seat `
      + '(for example GLM Flash in learning/compost-config.json). Refusing to fall back to a paid provider.');
  }
  const provider = (resolvedProvider ?? '').toLowerCase();
  if (PAID_PROVIDERS.has(provider)) {
    throw new Error(`LEARNING_NO_FREE_SEAT: the generator role resolved to "${provider || 'unset'}", a paid or `
      + `default provider. Fix the seat in ${configPath}; learning never uses a paid provider.`);
  }
}
