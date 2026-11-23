import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROVIDER_ENV = /^(SINTER_|LIMINAL_|ATELIER_|LLM_|HARNESS_|EVALUATOR_)|(_API_KEY|_AUTH_TOKEN|_BASE_URL)$|^CLAUDE_CODE_OAUTH_TOKEN$/;

/**
 * Environment for a test that spawns bin/sinter. The CLI reads the owner's
 * ~/.sinter/config.json and would resolve a REAL provider seat (a paid or
 * token-plan account) if a test reached a generation call. This env makes that
 * impossible: HOME and SINTER_CONFIG_PATH point into a throwaway dir with no
 * config, and every provider/credential variable is dropped. A test that needs a
 * seat must write its own config with an explicit fake or free provider and pass
 * it as `configPath`.
 */
export function isolatedCliEnv(extra: Record<string, string> = {}, configPath?: string): {
  env: NodeJS.ProcessEnv;
  home: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'sinter-cli-home-'));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!PROVIDER_ENV.test(k)) env[k] = v;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.SINTER_CONFIG_PATH = configPath ?? join(home, 'no-default-seat.json');
  return { env: { ...env, ...extra }, home };
}
