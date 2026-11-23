import { describe, expect, it } from 'vitest';
import { resolveStatusRoute } from '../../../src/cli/providerStatusRoute.js';

const catalog = [{ name: 'ollama', baseUrl: 'http://localhost:11434/v1' }, { name: 'lmstudio', baseUrl: 'http://localhost:1234/v1' }];

describe('provider status names the seat Generate really uses (Sol F07)', () => {
  it('a nondefault-port local seat is probed at its own URL, not the catalog port', () => {
    const r = resolveStatusRoute({ baseUrl: 'http://127.0.0.1:18080/v1', model: 'qwen' }, 'ollama', catalog);
    expect(r.activeName).toBeUndefined(); // a custom endpoint marks no catalog row active
    expect(r.probeUrl).toBe('http://127.0.0.1:18080/v1');
    expect(r.seatLine).toBe('Generator seat: qwen at http://127.0.0.1:18080/v1');
    expect(r.mismatchNote).toMatch(/default provider is ollama/);
  });
  it('a seat on a catalog endpoint becomes the active provider even if the saved default differs', () => {
    const r = resolveStatusRoute({ baseUrl: 'http://localhost:1234/v1', model: 'm' }, 'ollama', catalog);
    expect(r.activeName).toBe('lmstudio');
    expect(r.mismatchNote).toMatch(/does not move a pinned seat/);
  });
  it('agreeing default and seat produce no warning', () => {
    const r = resolveStatusRoute({ baseUrl: 'http://localhost:11434/v1', model: 'm' }, 'ollama', catalog);
    expect(r.activeName).toBe('ollama');
    expect(r.mismatchNote).toBeNull();
  });
  it('no seat falls back to the saved default with the catalog route', () => {
    const r = resolveStatusRoute(null, 'ollama', catalog);
    expect(r).toEqual({ activeName: 'ollama', probeUrl: undefined, seatLine: null, mismatchNote: null });
  });
});
