import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('final QA copy drift guardrails', () => {
  it('keeps the shared dual-host launch domain copy aligned across README, launch thread, and architecture', () => {
    const readme = readRepoFile('README.md');
    const launchThread = readRepoFile('docs/marketing/launch-thread-ready.md');
    const architecture = readRepoFile('docs/architecture.html');
    // Dual-host truth (G006): shared public copy is the 12 domains present on both
    // mirrors. HTML / DataViz may exist on one host lineage and must not be sold as
    // universal totals in the shared README.
    const sharedLaunchDomains =
      'p5.js, SVG, GLSL, Three.js, Hydra, Strudel, Tone.js, Revideo, HyperFrames, ASCII, Kinetic, TextGen';

    expect(readme).toContain(sharedLaunchDomains);
    expect(launchThread).toContain(sharedLaunchDomains);
    expect(architecture).toContain(sharedLaunchDomains);
    expect(architecture).toContain('12 shared launch creative domains');
    expect(architecture).toContain('src/generators/hyperframes/');
    // Host-lineage extras stay visible in architecture without claiming universal totals.
    expect(architecture).toContain('src/generators/dataviz/');
    expect(readme).toContain('Host-specific domains (for example HTML or DataViz');
  });

  it('separates CreativeBoard terminology from five-persona swarm terminology', () => {
    const readme = readRepoFile('README.md');
    const features = readRepoFile('docs/features.html');
    const cli = readRepoFile('bin/sinter');

    expect(readme).toContain('CreativeBoard critique');
    expect(readme).toContain('3-agent board (Minimalist / Expressionist / Technician)');
    expect(readme).toContain('5 default runtime personas (Kai / Nova / Rex / Sam / Max)');
    expect(readme).toContain('Five default personas (Kai, Nova, Rex, Sam, Max) generate in parallel');
    expect(features).toContain('Five default personas (Kai, Nova, Rex, Sam, Max) generate in parallel');
    expect(cli).toContain('Use Sinter swarm (5 default personas) for generation');
    expect(cli).not.toContain('7-persona');
  });

  it('does not describe the Live AV utility as a disabled Hydra preview surface', () => {
    const appSource = readRepoFile('gui/src/App.tsx');
    const features = readRepoFile('docs/features.html');
    const cli = readRepoFile('bin/sinter');

    expect(appSource).toContain('Live AV');
    expect(appSource).toContain('Hydra — read-only video synth code');
    expect(features).toContain('<strong>Live AV</strong>');
    expect(cli).toContain('Sinter: Live AV');
    expect(appSource).not.toContain('sandbox-pending');
    expect(appSource).not.toContain('until an isolated Hydra runtime is available');
  });
});
