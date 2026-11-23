import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('market quickstart docs', () => {
  it('gives a human the exact ready-to-show commands without narrowing creative domains', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('## Ready-to-show market path');
    expect(readme).toContain('sinter "a luminous blue-green particle garden"');
    expect(readme).toContain('pnpm proof:studio-smoke');
    expect(readme).toContain('pnpm run proof:live-provider-smoke -- --provider=glm --timeout-ms=120000');
    expect(readme).toContain('pnpm proof:live-creative-domains -- --provider=glm --all --timeout-ms=120000 --out=.omx/proof/live-creative-domains');
    expect(readme).toContain('sinter market status');
    expect(readme).toContain('p5, SVG, shader, Three.js, Hydra, Strudel, Tone.js, ASCII, kinetic type and CSS motion');
    // Removed mediums are no longer advertised (their ids stay as silent aliases).
    expect(readme).not.toMatch(/Revideo|HyperFrames/);
  });
});
