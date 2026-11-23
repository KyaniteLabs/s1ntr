/** Lane 4 row 39: `sinter dream transfer|activate|compound` are reachable through the real CLI and fail closed
 * (typed error, exit 1, no stack) when the production Dream config is absent. The compound proof itself is covered
 * in-process by compound-create-product.test.ts; a full run needs a renderer and real holdouts. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bin = path.resolve(import.meta.dirname, '../../bin/sinter');
const home = mkdtempSync(path.join(os.tmpdir(), 'dream-cli-home-'));
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: home, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, HOME: home, USERPROFILE: home } });
  return { rc: r.status, err: r.stderr };
};

describe('dream transfer / activate / compound CLI', () => {
  for (const action of ['transfer', 'activate', 'compound']) {
    it(`${action} without a command file prints usage and exits 1`, () => {
      const r = run(['dream', action]);
      expect(r.rc).toBe(1);
      expect(r.err).toContain(`Usage: sinter dream ${action} <governed-command.json>`);
    });
    it(`${action} without production Dream config fails closed with a typed error`, () => {
      const file = path.join(home, `${action}.json`);
      writeFileSync(file, '{}');
      const r = run(['dream', action, file]);
      expect(r.rc).toBe(1);
      expect(r.err).toContain('DREAM_PRODUCTION_CONFIG_REQUIRED');
      expect(r.err).not.toMatch(/\n\s+at /);
    });
  }
});
