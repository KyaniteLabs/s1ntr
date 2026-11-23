import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readRequiredSinterConfig } from '../../src/cli/readRequiredSinterConfig.js';

describe('readRequiredSinterConfig (sss-score on a fresh home, dogfood finding)', () => {
  it('a missing config names the file and the fix instead of a raw ENOENT', () => {
    const p = path.join(os.tmpdir(), 'no-such-dir-sinter', 'config.json');
    expect(() => readRequiredSinterConfig(p, 'sss-score')).toThrow(/sss-score needs the judge seats.*config\.json.*provider/s);
    expect(() => readRequiredSinterConfig(p, 'sss-score')).not.toThrow(/ENOENT/);
  });
  it('parses an existing config', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const p = path.join(d, 'config.json');
    fs.writeFileSync(p, '{"roles":{}}');
    expect(readRequiredSinterConfig(p, 'x')).toEqual({ roles: {} });
  });
});
