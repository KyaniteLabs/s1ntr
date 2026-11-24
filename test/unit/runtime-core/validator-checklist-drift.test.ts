/**
 * Drift guard: the canonical validator checklists
 * (docs/prompts/validator-checklists.json) and the spine's inline copy
 * (src/runtime-core/ValidatorChecklist.ts) must stay byte-equivalent, and
 * every spine-supported domain must carry a checklist. The spine injects
 * these into the generation user prompt (rejection-rate fix #3, #1078);
 * a silent divergence means models are taught rules that no longer match
 * the validator — this test makes that red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOMAIN_CHECKLISTS } from '../../../src/runtime-core/ValidatorChecklist.js';
import { SUPPORTED_LIMINAL_PRODUCTION_DOMAINS } from '../../../src/runtime-core/LiminalProductionEffects.js';

const canonicalPath = fileURLToPath(new URL('../../../docs/prompts/validator-checklists.json', import.meta.url));
const canonical = JSON.parse(readFileSync(canonicalPath, 'utf8')) as {
  domains: Record<string, string[]>;
  libraryRules: { rules: string[] };
};

describe('validator checklist drift guard', () => {
  it('the spine module and the canonical file carry identical domain checklists', () => {
    expect(DOMAIN_CHECKLISTS).toEqual(canonical.domains);
  });

  it('every spine-supported domain has a checklist (shader aliases to glsl)', () => {
    for (const domain of SUPPORTED_LIMINAL_PRODUCTION_DOMAINS) {
      const key = domain === 'shader' ? 'glsl' : domain;
      const rules = canonical.domains[key];
      expect(Array.isArray(rules), `domain "${domain}" is spine-supported but has no checklist`).toBe(true);
      expect(rules.length, `domain "${domain}" has an empty checklist`).toBeGreaterThan(0);
    }
  });

  it('the canonical file carries the library legality contract', () => {
    expect(canonical.libraryRules.rules.length).toBeGreaterThanOrEqual(5);
    expect(canonical.libraryRules.rules.some(r => r.includes('oklch'))).toBe(true);
  });
});
