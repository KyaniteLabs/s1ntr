import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadTaskPack } from '../../../scripts/rotation/shared.mjs';

describe('Batch A residual gap close', () => {
  it('outer-abort path writes boundaryMs (A1)', () => {
    const src = readFileSync('scripts/rotation/batteries.mjs', 'utf8');
    expect(src).toContain("path=outer-abort");
    expect(src).toContain('boundaryMs.model-invoke');
    expect(src).toContain('outer-abort');
  });

  it('GitHub CI runs compound-loop contract (A2)', () => {
    const yml = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(yml).toContain('check:compound-loop');
  });

  it('harness pack includes compound requeue dogfood (A3)', async () => {
    const pack = await loadTaskPack('harness');
    expect(pack.tasks.some((t: { id: string }) => t.id === 'harness-compound-requeue-dogfood')).toBe(true);
    const dog = pack.tasks.find((t: { id: string; compoundRequeue?: boolean }) => t.id === 'harness-compound-requeue-dogfood');
    expect(dog?.compoundRequeue).toBe(true);
  });

  it('supervisor v3 has anti-thrash stop (A4)', () => {
    const sh = readFileSync('scripts/rotation/mece-6h-supervisor.sh', 'utf8');
    expect(sh).toContain('anti-thrash');
    expect(sh).toContain('MAX_HARVEST_ONLY');
    expect(sh).toContain('mostlyClosedJointRestate');
  });

  it('harvest corpus policy exists (B1)', () => {
    const pol = readFileSync('docs/agents/waves/HARVEST_CORPUS_POLICY.md', 'utf8');
    expect(pol).toContain('Do not');
    expect(pol.toLowerCase()).toContain('research');
  });
});
