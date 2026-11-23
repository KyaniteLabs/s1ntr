import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedCliEnv } from '../../helpers/isolatedCli.js';

// A test that spawns bin/sinter must not be able to fall through to the owner's default
// seat (~/.sinter/config.json). Pin SINTER_CONFIG_PATH/HOME (isolatedCliEnv does both, fakeProviderEnv pins a fixture home and endpoint), or,
// when the file only reads bin/sinter or mocks the spawn, say so with `// @no-cli-spawn: why`.
const PINNED = /SINTER_CONFIG_PATH|LIMINAL_CONFIG_PATH|HOME|isolatedCliEnv|\bfakeProviderEnv\s*\(|@no-cli-spawn/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('CLI-spawning tests cannot reach the default seat', () => {
  it('every test that spawns bin/sinter pins its config/HOME or declares it does not spawn', () => {
    const offenders = walk('test').filter(f => {
      if (f.endsWith('test-cli-default-seat-guard.test.ts')) return false;
      const s = readFileSync(f, 'utf8');
      if (!/bin\/(sinter|liminal)/.test(s)) return false;
      if (!/spawnSync|execFileSync|execSync|spawn\(|execFile/.test(s)) return false;
      return !PINNED.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it('isolatedCliEnv points at an empty home and drops provider credentials', () => {
    process.env.MINIMAX_API_KEY = 'x'; process.env.ANTHROPIC_API_KEY = 'x'; process.env.OPENAI_API_KEY = 'x';
    try {
      const { env, home } = isolatedCliEnv();
      expect(env.HOME).toBe(home);
      expect(env.SINTER_CONFIG_PATH).toBe(join(home, 'no-default-seat.json'));
      expect(existsSync(env.SINTER_CONFIG_PATH as string)).toBe(false);
      for (const k of ['MINIMAX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) expect(env[k]).toBeUndefined();
    } finally {
      delete process.env.MINIMAX_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
    }
  });
});
