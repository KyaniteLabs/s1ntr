import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';

describe('Wave 8 safe CLI help E2E', () => {
  it('runs the built local CLI help path without a browser or provider', () => {
    const output = execFileSync('node', ['bin/sinter', '--help'], {
      cwd: process.cwd(), encoding: 'utf8', env: isolatedCliEnv({ PATH: process.env.PATH ?? '' }).env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain('🎨 S1NTR: a tool for coding art.');
    expect(output).toContain('USAGE:');
  });
});
