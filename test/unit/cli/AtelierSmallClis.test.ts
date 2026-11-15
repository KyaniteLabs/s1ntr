import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTaxonomyCommand } from '../../../src/cli/TaxonomyCli.js';
import { runPersonaCommand } from '../../../src/cli/PersonaCli.js';
import { runGbgCommand } from '../../../src/cli/GbgCli.js';
import { runPromptNextCommand } from '../../../src/cli/PromptOrganCli.js';

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sinter-small-cli-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('TaxonomyCli', () => {
  const taxonomyPath = () => join(dir, '.omx', 'atelier', 'game', 'taxonomy.json');

  it('prints a JSON taxonomy and writes it to the state dir, announcing the path on stderr', () => {
    runTaxonomyCommand(['--json']);
    const printed = JSON.parse(out.join('\n'));
    expect(typeof printed).toBe('object');
    expect(existsSync(taxonomyPath())).toBe(true);
    expect(JSON.parse(readFileSync(taxonomyPath(), 'utf8'))).toEqual(printed);
    expect(err).toEqual([`[taxonomy] wrote ${taxonomyPath()}`]);
  });

  it('prints the text report (not JSON) by default', () => {
    runTaxonomyCommand([]);
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0])).toThrow();
  });

  it('does not touch disk with --no-write', () => {
    runTaxonomyCommand(['--no-write']);
    expect(existsSync(taxonomyPath())).toBe(false);
    expect(err).toEqual([]);
  });
});

describe('PersonaCli', () => {
  it('lists the registered personas and this machine persona by default', () => {
    runPersonaCommand([]);
    expect(out[0]).toMatch(/^\[persona\] \d+ cognitive-style personas registered:$/);
    const count = Number(/\] (\d+) cognitive/.exec(out[0])![1]);
    expect(count).toBeGreaterThan(1);
    expect(out.filter(l => l.includes('exploration='))).toHaveLength(count);
    expect(out[out.length - 1]).toMatch(/^\[persona\] this machine: .+ \(.{60}\.\.\.\)$/);
    expect(err).toEqual([]);
  });

  it('treats an explicit "list" the same as no args', () => {
    runPersonaCommand(['list']);
    expect(out[0]).toMatch(/personas registered:$/);
  });

  it('prints usage on stderr for an unknown subcommand and lists nothing', () => {
    runPersonaCommand(['bogus']);
    expect(err).toEqual(['usage: sinter persona [list]']);
    expect(out).toEqual([]);
  });
});

describe('GbgCli', () => {
  it('with no args indexes beads then reports that no move is available on an empty workspace', () => {
    runGbgCommand([]);
    expect(out).toEqual([
      '[gbg] beads +0 (total 0) | cross-domain threads 0',
      '[gbg] no unplayed thread above threshold this pass',
    ]);
  });

  it('--index only indexes and never plays a move', () => {
    runGbgCommand(['--index']);
    expect(out).toEqual(['[gbg] beads +0 (total 0) | cross-domain threads 0']);
  });

  it('an unrecognised flag does nothing', () => {
    runGbgCommand(['--nope']);
    expect(out).toEqual([]);
  });
});

describe('PromptOrganCli', () => {
  const statePath = () => join(dir, '.omx', 'atelier', 'prompts', 'organ-state.json');

  it('emits one JSON line with text/domain/source and persists organ state', () => {
    runPromptNextCommand([]);
    expect(out).toHaveLength(1);
    const printed = JSON.parse(out[0]);
    expect(Object.keys(printed).sort()).toEqual(['domain', 'source', 'text']);
    expect(printed.text.length).toBeGreaterThan(10);
    expect(['combinatorial', 'frontier', 'cross-pollination', 'constraint', 'conductor']).toContain(printed.source);
    expect(existsSync(statePath())).toBe(true);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).turnCount).toBe(1);
  });

  it('stats on a fresh workspace reports zero prompts and no top features', () => {
    runPromptNextCommand(['stats']);
    expect(out).toEqual([
      '[prompt-organ] 0 prompts generated',
      '[prompt-organ] by source: {}',
    ]);
    expect(existsSync(statePath())).toBe(false);
  });

  it('stats counts previously generated prompts', () => {
    mkdirSync(join(dir, '.omx', 'atelier', 'prompts'), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({
      history: [
        { text: 'a', domain: 'p5', source: 'combinatorial', components: {}, createdAt: 'x', scoreOutcome: 0.9 },
        { text: 'b', domain: 'p5', source: 'frontier', components: {}, createdAt: 'x' },
      ],
      featureScores: {},
      turnCount: 2,
    }));
    runPromptNextCommand(['stats']);
    expect(out[0]).toBe('[prompt-organ] 2 prompts generated');
    expect(out[1]).toContain('"combinatorial":1');
    expect(out[1]).toContain('"frontier":1');
  });
});
