import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'teaser', 'ab');

interface Registry {
  epoch: { id: string; state: string };
  experiments: Array<{ key: string; active: boolean }>;
}

const registry = JSON.parse(readFileSync(join(AB, 'experiments.json'), 'utf8')) as Registry;
const coordination = readFileSync(join(AB, 'COORDINATION.md'), 'utf8');
const currentStatus = coordination.split('## CURRENT STATUS')[1]?.split('\n## ')[0] ?? '';

describe('A/B coordination prose agrees with the frozen registry (#1294)', () => {
  it('a current-status section comes first and names the registry as the authority', () => {
    const headings = coordination.split('\n').filter((line) => line.startsWith('## '));
    expect(headings[0]).toMatch(/^## CURRENT STATUS/);
    expect(currentStatus).toContain('`teaser/ab/experiments.json` is the authority');
  });

  it('the status reports the registry epoch state', () => {
    expect(currentStatus).toContain(`epoch \`${registry.epoch.id}\` as **${registry.epoch.state}**`);
  });

  it('every inactive experiment is listed as inactive, and none is called armed in the current status', () => {
    const inactive = registry.experiments.filter((e) => !e.active).map((e) => e.key);
    expect(inactive).toEqual(['e02-reserved-copy', 'tc1-title-card', 'e08-domain-mark']);
    for (const key of inactive) {
      expect(currentStatus).toContain(`\`${key}\`: active false`);
    }
    // "ARMED" may appear only as the quoted historical word, never as a live claim
    expect(currentStatus.replace('"ARMED"', '')).not.toMatch(/\bARMED\b/);
  });

  it('the old ARMED and live lines are marked historical/superseded', () => {
    const armedLine = coordination.split('\n').find((l) => l.includes('E-02 reserved-beat copy ARMED'));
    const liveLine = coordination.split('\n').find((l) => l.includes('E-02 assignment + measurement'));
    expect(armedLine).toContain('now FROZEN');
    expect(liveLine).toContain('superseded');
  });
});
