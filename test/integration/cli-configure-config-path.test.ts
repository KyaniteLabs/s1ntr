/**
 * F07: `sinter --configure` wrote ~/.sinter/config.json even when SINTER_CONFIG_PATH selected another
 * file, so the file the generation path reads never changed and the success line named the wrong file.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.setConfig({ testTimeout: 90_000 });

describe('F07: --configure honors SINTER_CONFIG_PATH', () => {
  it('writes only the selected file and names it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cfg-path-'));
    const home = path.join(root, 'home'); const alt = path.join(root, 'alt', 'config.json');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, SINTER_CONFIG_PATH: alt };
    try {
      const r = spawnSync('node', ['bin/sinter', '--configure', '--provider', 'ollama', '--model', 'local-m'],
        { cwd: process.cwd(), env, encoding: 'utf8', timeout: 80_000 });
      expect(r.status).toBe(0);
      expect(existsSync(alt)).toBe(true);
      expect(JSON.parse(readFileSync(alt, 'utf8')).defaultProvider).toBe('ollama');
      expect(existsSync(path.join(home, '.sinter', 'config.json'))).toBe(false);
      expect(r.stdout).toContain(alt);
      expect(r.stdout).not.toContain('~/.sinter/config.json');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
