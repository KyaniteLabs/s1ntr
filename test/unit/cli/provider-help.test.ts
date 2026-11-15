import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binPath = path.join(repoRoot, 'bin', 'sinter');
const TRACE_PREFIX = 'SINTER_TRACE_MODULE_LOADS=';

// Exact-string help lines for every top-level command/flag documented in the
// 2026-06-10 audit. These strings are taken verbatim from printHelp() in
// bin/sinter — if the help text changes, this test must be updated in lockstep.
const REQUIRED_HELP_LINES = [
  '  preferences <subcommand>  Preferences: export, stats, train, model',
  '  taste <train|eval>          Train or evaluate the taste model from preferences',
  '  dream run <command.json>    Run canonical admitted-evidence research',
  '  garden <subcommand>         Autonomous gardener: status, rebalance, start, stop, tend [budget]',
  '  emergence <score|probe>     Score or probe emergence for a text or file output',
  '  fs <artifacts|refs|runs>    Inspect Sinter content store: artifacts, refs, runs',
  '  --learn                     Feed generation results into the quality archive [not with generate]',
  '  --output, -o <path>         Output directory (relative to project or inside ~/.sinter)',
  '  --output-mode <mode>        svg only: standalone (default) or fragment (inline <svg> for a host page)',
  '  --tokens <a,b,...>          fragment: host CSS custom properties to colour with, e.g. art-red,art-ink',
  '  --ref <path>                Reverse mode: a reference (audio, image, video with its soundtrack, svg diagram, text); repeatable. Never sent to a provider',
  '  --arc <file>                Reverse mode: energy arc as .json, .svg, or an image (an image is downscaled, then read by the vision model)',
  '  --duration <seconds>        Reverse mode: exact length; tone/strudel output is rendered, measured and revised once (needs a browser). Arc "ending":"phrase-out" skips the final hit',
  '  --cues <cues.json>          Reverse mode: hit/drop/cut cues to land at exact times',
];

describe('liminal CLI provider setup help', () => {
  it('advertises the documented ProviderRuntime providers instead of legacy provider names', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '--help'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOTENV_CONFIG_QUIET: 'true',
      },
    });

    const providerLine = stdout.split('\n').find(line => line.includes('--provider <name>')) ?? '';
    expect(providerLine).toContain('lmstudio');
    expect(providerLine).toContain('ollama');
    expect(providerLine).toContain('openai');
    expect(providerLine).toContain('minimax');
    expect(providerLine).toContain('glm');
    expect(providerLine).toContain('openrouter');
    expect(providerLine).not.toContain('kimi');
    expect(providerLine).not.toContain('moonshot');
    expect(providerLine).not.toContain('inception');
  });

  it.each([
    ['--help', ['--help']],
    ['--version', ['--version']],
    ['provider status', ['provider', 'status']],
  ])('keeps %s on its existing early path', async (_name, args) => {
    const { stderr } = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOTENV_CONFIG_QUIET: 'true',
        SINTER_TRACE_MODULE_LOADS: '1',
      },
    });
    const traceLine = stderr.split('\n').find(line => line.startsWith(TRACE_PREFIX));
    expect(traceLine?.startsWith(TRACE_PREFIX)).toBe(true);
    expect(traceLine).not.toContain('better-sqlite3');
  });

  it('keeps CLI provider shorthand wired to canonical runtime endpoints and provider env', async () => {
    const source = await fs.readFile(binPath, 'utf-8');

    expect(source).toMatch(/glm:\s*\{[\s\S]*?baseUrl:\s*['"]https:\/\/api\.z\.ai\/api\/anthropic['"]/);
    expect(source).toMatch(/minimax:\s*\{[\s\S]*?baseUrl:\s*['"]https:\/\/api\.minimax\.io\/anthropic['"]/);
    expect(source).toMatch(/openrouter:\s*\{[\s\S]*?baseUrl:\s*['"]https:\/\/openrouter\.ai\/api\/v1['"]/);
    expect(source).toMatch(/openrouter:\s*\{[\s\S]*?model:\s*['"]deepseek\/deepseek-v4\.1-flash-1017['"]/);
    // Kimi runs only through kimi-cli; no API shorthand.
    expect(source).not.toMatch(/^\s*(kimi|moonshot):\s*\{/m);
    // CLI provider flags affect only the generator role.
    expect(source).toContain("const envPrefix = 'LIMINAL_GENERATOR'");
  });
});

describe('sinter CLI --help completeness', () => {
  it('documents garden, taste, preferences, dream, emergence, fs and --learn as exact help lines', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '--help'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOTENV_CONFIG_QUIET: 'true',
      },
    });

    for (const line of REQUIRED_HELP_LINES) {
      expect(stdout.split('\n')).toContain(line);
    }
  });
});
