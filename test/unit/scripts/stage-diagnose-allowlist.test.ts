import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isPathAllowlisted } from '../../../src/harness/DiagnosePathAllowlist.js';

describe('stage-diagnose-inputs allowlist SSOT (W9-L4-01)', () => {
  it('does not hardcode ALLOW_PREFIXES dual list', () => {
    const src = readFileSync('scripts/rotation/stage-diagnose-inputs.mjs', 'utf8');
    expect(src).not.toMatch(/const ALLOW_PREFIXES\s*=/);
    expect(src).toContain('DiagnosePathAllowlist');
    expect(src).toContain('isPathAllowlisted');
  });

  it('allowlist rejects .quality and allows docs', () => {
    expect(isPathAllowlisted('.quality/wave1/x.md')).toBe(false);
    expect(isPathAllowlisted('docs/agents/waves/staged/x.md')).toBe(true);
  });
});
