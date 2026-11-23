import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCardHtml, writeWallCard } from '../../../src/render/NextDomainCard.js';

describe('wall card', () => {
  it('shows every credit line, escaped, and the media with relative paths', () => {
    const html = buildCardHtml({ domain: 'datamosh', title: 'Waves <melt>', credits: ['A "quoted" & <b>credit</b>'], video: 'mosh.mp4', still: 'contact.png', note: 'I-frames stripped: 3' });
    expect(html.startsWith('<!doctype html><meta charset="utf-8">')).toBe(true);
    expect(html).toContain('<video');
    expect(html).toContain('src="mosh.mp4"');
    expect(html).toContain('A &quot;quoted&quot; &amp; &lt;b&gt;credit&lt;/b&gt;');
    expect(html).not.toContain('<b>credit</b>');
    expect(html).toContain('Waves &lt;melt&gt;');
  });

  it('writes card.json with credits and preview.html next to the media', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'card-'));
    try {
      writeFileSync(path.join(dir, 'mosh.mp4'), 'x');
      const card = writeWallCard(dir, { domain: 'datamosh', title: 'T', credits: ['C1', 'C2'], video: 'mosh.mp4', still: 'contact.png' });
      expect(JSON.parse(readFileSync(card.jsonPath, 'utf8'))).toMatchObject({ domain: 'datamosh', credits: ['C1', 'C2'], media: { video: 'mosh.mp4' } });
      expect(readFileSync(card.htmlPath, 'utf8')).toContain('C2');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a card with no credits when credits are required (outside footage)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'card-'));
    try {
      expect(() => writeWallCard(dir, { domain: 'datamosh', title: 'T', credits: [], video: 'm.mp4', requireCredits: true })).toThrow(/credit/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
