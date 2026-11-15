/**
 * H-TELEM-06 historical fit extract — no live LLM.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractPack,
  scanRoots,
  renderMarkdown,
} from '../../../scripts/rotation/extract-historical-fit.mjs';

describe('extract-historical-fit', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-fit-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks gen pack with kilo fixedJudge non-scorable', () => {
    const pack = path.join(dir, 'generator-bad');
    fs.mkdirSync(path.join(pack, 'receipts'), { recursive: true });
    fs.writeFileSync(
      path.join(pack, 'summary.json'),
      JSON.stringify({
        seat: 'generator',
        model: 'grok-4.5',
        mode: 'live',
        northStar: { value: 0.9 },
        fixedJudge: { route: 'invalid-kilo', model: 'gemini-3.1-pro-low' },
      }),
    );
    const p = extractPack(pack);
    expect(p?.scorable).toBe(false);
    expect(p?.invalid).toBe(true);
  });

  it('extracts scorable generator domain rows', () => {
    const pack = path.join(dir, 'generator-good');
    fs.mkdirSync(path.join(pack, 'receipts'), { recursive: true });
    fs.writeFileSync(
      path.join(pack, 'summary.json'),
      JSON.stringify({
        seat: 'generator',
        model: 'grok-4.5',
        mode: 'live',
        northStar: { id: 'blind', value: 0.8 },
        fixedJudge: { route: 'agy-cliproxy', model: 'gemini-3.1-pro-low' },
      }),
    );
    fs.writeFileSync(
      path.join(pack, 'receipts', 'gen-p5-easy.json'),
      JSON.stringify({
        taskId: 'gen-p5-easy',
        verdict: 'ok',
        latencyMs: 1000,
        extra: { domain: 'p5', difficultyTier: 'easy' },
        metrics: { gateAt1: true },
        scores: {},
      }),
    );
    // put score on extra.raw for extractor
    fs.writeFileSync(
      path.join(pack, 'receipts', 'gen-p5-hard.json'),
      JSON.stringify({
        taskId: 'gen-p5-hard',
        verdict: 'ok',
        latencyMs: 2000,
        extra: { domain: 'p5', raw: { score: 0.68, gatesAtShot1: false } },
        metrics: { score: 0.68, gateAt1: false },
      }),
    );
    const p = extractPack(pack);
    expect(p?.scorable).toBe(true);
    expect(p?.tasks.length).toBe(2);
    const md = renderMarkdown([p!]);
    expect(md).toContain('Scorable packs');
    expect(md).toContain('gen-p5-easy');
    expect(md).toContain('wave-1-FULL-HARVEST');
  });

  it('scanRoots finds nested packs', () => {
    const root = path.join(dir, 'archives');
    const pack = path.join(root, 'run-a', 'chat-flash');
    fs.mkdirSync(path.join(pack, 'receipts'), { recursive: true });
    fs.writeFileSync(
      path.join(pack, 'summary.json'),
      JSON.stringify({ seat: 'chat', model: 'flash', mode: 'live', northStar: { value: 1 } }),
    );
    const packs = scanRoots([root]);
    expect(packs.length).toBe(1);
    expect(packs[0].seat).toBe('chat');
  });
});
