import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HTMLWrapper } from '../../src/utils/htmlWrapper.js';

const css = readFileSync(new URL('../../gui/src/index.css', import.meta.url), 'utf8');
function token(name: string): string {
  const value = css.match(new RegExp(`--sinter-${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Missing colour token: ${name}`);
  return value;
}
function luminance(hex: string): number {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
describe('Studio small-text contrast (WCAG 1.4.3)', () => {
  it.each(['bg-void', 'bg-shell', 'bg-deep', 'surface-1', 'surface-2', 'surface-3'])(
    'keeps dim labels readable on %s', background => {
      expect(contrast(token('dim'), token(background))).toBeGreaterThanOrEqual(4.5);
    },
  );
  it('also covers the lightest raised-panel gradient endpoint', () => {
    const endpoint = css.match(/--sinter-slab-3: linear-gradient\(180deg, (#[0-9a-f]{6})/i)?.[1];
    expect(endpoint).toBe('#313137');
    expect(contrast(token('dim'), endpoint!)).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps the Tone Play label readable across its gradient', () => {
    const html = HTMLWrapper.wrap('const bpm = 120;', { domain: 'tone' });
    const rule = html.match(/#start\s*\{([^}]+)\}/)?.[1] ?? '';
    const foreground = rule.match(/color:\s*(#[0-9a-f]{6}|white)/)?.[1];
    expect(typeof foreground).toBe('string');
    for (const background of ['#f59e0b', '#ef4444']) {
      expect(contrast(foreground === 'white' ? '#ffffff' : foreground!, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('rejects a missing token instead of silently measuring a fallback', () => {
    expect(() => token('missing')).toThrow('Missing colour token: missing');
  });
});
