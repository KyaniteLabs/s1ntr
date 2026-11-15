import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidDomain } from '../../../src/types/domains.js';

// Meta postmortem guard (2026-08-31): the loop's prompt table carries domains
// the CLI must be able to dispatch EXPLICITLY. The meta failure class was a
// table domain that could never win text-detection — if the table ever names
// a domain the CLI rejects, turns fail forever with a misleading signature.
// This test pins: every domain the loop can pick is a valid forced domain.
const LOOP = path.join(process.cwd(), '.omx', 'atelier', 'system-loop.sh');

function loopDomains(): string[] {
  if (!fs.existsSync(LOOP)) return [];
  const src = fs.readFileSync(LOOP, 'utf8');
  const m = src.match(/DOMAINS=\(([^)]*)\)/);
  if (!m) return [];
  return m[1].trim().split(/\s+/).filter(Boolean);
}

describe('loop domain surface is dispatchable', () => {
  it('the loop table is readable (or skipped on machines without .omx)', () => {
    const doms = loopDomains();
    if (doms.length === 0) return; // CI: .omx is untracked state
    expect(doms.length).toBeGreaterThanOrEqual(14);
  });

  it('every loop-table domain is a valid forced domain', () => {
    for (const d of loopDomains()) {
      expect(isValidDomain(d)).toBe(true);
    }
  });

  it('the frontier case map covers every table domain (no silent fallthrough)', () => {
    const doms = loopDomains();
    if (doms.length === 0) return;
    const src = fs.readFileSync(LOOP, 'utf8');
    const caseBlock = src.slice(src.indexOf('case "$FRONTIER"'), src.indexOf('esac', src.indexOf('case "$FRONTIER"')));
    for (const d of doms) {
      expect(caseBlock).toContain(`${d})`);
    }
  });
});
