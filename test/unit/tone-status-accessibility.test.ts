import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { HTMLWrapper } from '../../src/utils/htmlWrapper.js';

describe('Tone wrapper status announcements', () => {
  it.each([
    { code: '', selector: '#status' },
    { code: 'const bpm = 120;', selector: '#status' },
    { code: '<main><button>Start audio</button></main>', selector: '#sinter-tone-status' },
  ])('emits a status live region for $selector', ({ code, selector }) => {
    const dom = new JSDOM(HTMLWrapper.wrap(code, { domain: 'tone' }));
    try {
      const status = dom.window.document.querySelector(selector);
      expect(status?.getAttribute('role')).toBe('status');
      expect(status?.textContent).toMatch(/Ready/);
    } finally { dom.window.close(); }
  });
});
