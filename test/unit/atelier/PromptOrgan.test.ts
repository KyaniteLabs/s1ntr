import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptOrgan } from '../../../src/atelier/PromptOrgan.js';

// mulberry32(seed=7) draws 0.012 first (conductor fires); seed=1 draws 0.627
// (conductor gate misses, plain roll proceeds).
const CONDUCTOR_SEED = 7;
const PLAIN_SEED = 1;

const gameDir = (cwd: string) => join(cwd, '.omx', 'atelier', 'game');
const today = () => new Date().toISOString().slice(0, 10);

describe('PromptOrgan Conductor lane (Elixis layered-combination v1)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sinter-conductor-organ-test-'));
    delete process.env.SINTER_CONDUCTOR_OFF;
  });
  afterEach(() => { delete process.env.SINTER_CONDUCTOR_OFF; rmSync(cwd, { recursive: true, force: true }); });

  it('emits a layered-combination prompt: pair priors, ONE work phrasing, trailing declaration', () => {
    const p = new PromptOrgan(cwd, CONDUCTOR_SEED).next();
    expect(p.source).toBe('conductor');
    const layered = /A layered combination artwork: (\w+) as the primary layer carrying the composition, with (\w+) woven in as a secondary layer that serves it — the layers must feel like ONE work, not two stapled together/.exec(p.text);
    expect(layered?.length).toBe(3);
    const [primary, secondary] = [layered![1], layered![2]];
    expect(p.domain).toBe(primary); // DOMAIN = primary
    expect(p.text).toContain(`End your response with this exact line after the closing code fence:\nlayers: ${primary}[] ${secondary}[]`);
    // the pair is one of the usable static priors (order preserved), never audio+audio
    expect([['three', 'glsl'], ['p5', 'hydra']]).toContainEqual([primary, secondary]);
    // plan recorded for the adherence check + daily budget counted
    const last = JSON.parse(readFileSync(join(gameDir(cwd), 'conductor-last.json'), 'utf8'));
    expect(last).toEqual({ primary, secondary, ts: p.createdAt });
    const count = JSON.parse(readFileSync(join(gameDir(cwd), 'conductor-count.json'), 'utf8'));
    expect(count).toEqual({ wave: today(), used: 1 });
  });

  it('uses the combination frontier when one exists', () => {
    mkdirSync(gameDir(cwd), { recursive: true });
    writeFileSync(join(gameDir(cwd), 'combination-frontier.json'),
      JSON.stringify([{ primary: 'ascii', secondary: 'dataviz' }]));
    const p = new PromptOrgan(cwd, CONDUCTOR_SEED).next();
    expect(p.source).toBe('conductor');
    expect(p.domain).toBe('ascii');
    expect(p.text).toContain('layers: ascii[] dataviz[]');
  });

  it('fill declaration brackets from recipes (max 3 distinct ids total)', () => {
    mkdirSync(gameDir(cwd), { recursive: true });
    writeFileSync(join(gameDir(cwd), 'recipes.json'), JSON.stringify({
      schema: 'sinter.recipes/0.1', version: 1,
      priors: [{ primary: 'ascii', secondary: 'dataviz', weight: 1, label: 'prior' }],
      learned: {},
      stats: { distinctDomainsPerWave: {} },
    }));
    writeFileSync(join(gameDir(cwd), 'combination-frontier.json'),
      JSON.stringify([{ primary: 'ascii', secondary: 'dataviz' }]));
    // prior-carried libraries fill the brackets
    const book = JSON.parse(readFileSync(join(gameDir(cwd), 'recipes.json'), 'utf8'));
    book.priors[0].libraries = ['a', 'b', 'c', 'd']; // 4 known — only 3 may land
    writeFileSync(join(gameDir(cwd), 'recipes.json'), JSON.stringify(book));
    const p = new PromptOrgan(cwd, CONDUCTOR_SEED).next();
    expect(p.text).toContain('layers: ascii[a,b] dataviz[c]');
    const ids = p.text.match(/layers: .*/)?.[0]?.match(/\[([^\]]*)\]/g)?.join('') ?? '';
    expect(ids.replace(/\[/g, '').replace(/\]/g, '').split(',').filter(Boolean).length).toBeLessThanOrEqual(3);
  });

  it('daily budget: 2 combination prompts per calendar day, then plain organ text', () => {
    mkdirSync(gameDir(cwd), { recursive: true });
    writeFileSync(join(gameDir(cwd), 'conductor-count.json'), JSON.stringify({ wave: today(), used: 2 }));
    for (let i = 0; i < 6; i++) {
      expect(new PromptOrgan(cwd, CONDUCTOR_SEED + i).next().source).not.toBe('conductor');
    }
    // yesterday's counter is stale — budget fresh again
    writeFileSync(join(gameDir(cwd), 'conductor-count.json'), JSON.stringify({ wave: '2026-01-01', used: 99 }));
    expect(new PromptOrgan(cwd, CONDUCTOR_SEED).next().source).toBe('conductor');
  });

  it('kill switch: SINTER_CONDUCTOR_OFF=1 falls back to plain organ text', () => {
    process.env.SINTER_CONDUCTOR_OFF = '1';
    for (let i = 0; i < 6; i++) {
      expect(new PromptOrgan(cwd, CONDUCTOR_SEED + i).next().source).not.toBe('conductor');
    }
    expect(existsSync(join(gameDir(cwd), 'conductor-last.json'))).toBe(false);
  });

  it('kill switch: conductor.state {enabled:false} pauses the lane', () => {
    mkdirSync(gameDir(cwd), { recursive: true });
    writeFileSync(join(gameDir(cwd), 'conductor.state'), JSON.stringify({ enabled: false, reason: 'auto-disable test' }));
    for (let i = 0; i < 6; i++) {
      expect(new PromptOrgan(cwd, CONDUCTOR_SEED + i).next().source).not.toBe('conductor');
    }
    // and a plain turn still works end-to-end
    const p = new PromptOrgan(cwd, PLAIN_SEED).next();
    expect(['combinatorial', 'frontier', 'cross-pollination', 'constraint']).toContain(p.source);
  });
});
