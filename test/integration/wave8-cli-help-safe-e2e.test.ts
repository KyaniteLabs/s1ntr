import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Wave 8 safe CLI help E2E', () => {
  it('runs the built local CLI help path without a browser or provider', () => {
    const output = execFileSync('node', ['bin/sinter', '--help'], {
      cwd: process.cwd(), encoding: 'utf8', env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain('🎨 Sinter: Creative Coding Agent');
    expect(output).toContain('USAGE:');
  });
});
