import { describe, expect, it, vi } from 'vitest';
import { LlmAtelierTransports, type GovernedTransportRunner } from '../../../src/atelier/LlmAtelierTransports.js';
import type { LLMClient } from '../../../src/llm/LLMClient.js';

const directive = { id: 'fixture', nicheKey: 'host-niche', hypothesis: 'make errors visible',
  verifyingMetric: 'errorVisibility' as const, boundedEdit: 'add an error state',
  authoredBy: 'fixture', createdAt: '2026-01-01T00:00:00Z' };

function fixture(text: string, success = true) {
  const client: Pick<LLMClient, 'complete' | 'getConfig'> = {
    complete: vi.fn<LLMClient['complete']>().mockResolvedValue({ success, text, error: success ? undefined : 'offline' }),
    getConfig: () => ({ provider: 'fixture', model: 'fixture-model', baseUrl: 'http://127.0.0.1:1' }),
  };
  const governedRun: GovernedTransportRunner = ({ effect }) => effect();
  return new LlmAtelierTransports({ brain: client, generator: client, eyes: [client], governedRun });
}

const directiveInput = { nicheKey: 'host-niche', incumbents: [], librarySummaries: [] };
const critiqueInput = { html: '<html></html>', specBrief: 'fixture', controls: ['save'] };

describe('Atelier response contracts', () => {
  it('rejects unsupported role operations rather than returning fabricated results', async () => {
    const transports = fixture('[]');
    await expect(transports.brain.critique(critiqueInput)).rejects.toThrow('brain does not critique');
    await expect(transports.brain.probe({ html: '', control: 'save' })).rejects.toThrow('brain does not probe');
    await expect(transports.generator.critique(critiqueInput)).rejects.toThrow('generator does not critique');
    await expect(transports.generator.probe({ html: '', control: 'save' })).rejects.toThrow('generator does not probe');
  });

  it('accepts fenced structured output without inventing missing content', async () => {
    await expect(fixture('```json\n[]\n```').eyes[0].critique(critiqueInput)).resolves.toEqual([]);
    const html = '<HTML><body>fixture</body></HTML>';
    await expect(fixture('```html\n' + html + '\n```').generator.generateCandidate({ directive, baseHtml: html }))
      .resolves.toBe(html);
  });

  it.each(['not json', '{}', '[null]', '[{"element":"save"}]'])('rejects a malformed critique instead of reporting no defects: %s', async text => {
    await expect(fixture(text).eyes[0].critique(critiqueInput)).rejects.toThrow('ATELIER_INVALID_RESPONSE');
  });

  it('accepts an explicit empty critique and a complete anchored critique', async () => {
    await expect(fixture('[]').eyes[0].critique(critiqueInput)).resolves.toEqual([]);
    const item = { element: 'save', defect: 'disabled', mechanicalFix: 'enable save', vendor: 'model-claimed' };
    await expect(fixture(JSON.stringify([item])).eyes[0].critique(critiqueInput))
      .resolves.toEqual([{ ...item, vendor: 'eye-0' }]);
  });

  it.each(['YES and NO', 'NO, do not answer YES', 'not sure', ''])('rejects an ambiguous grounding response: %s', async text => {
    await expect(fixture(text).eyes[0].probe({ html: '<html></html>', control: 'save' }))
      .rejects.toThrow('ATELIER_INVALID_RESPONSE');
  });

  it.each([['YES', true], [' NO\n', false]] as const)('accepts the exact grounding response %s', async (text, expected) => {
    await expect(fixture(text).eyes[0].probe({ html: '<html></html>', control: 'save' })).resolves.toBe(expected);
  });

  it.each(['', '<html><body>incomplete', 'not html'])('rejects a malformed candidate instead of appending a closing tag: %s', async text => {
    await expect(fixture(text).generator.generateCandidate({ directive, baseHtml: '<html></html>' }))
      .rejects.toThrow('ATELIER_INVALID_RESPONSE');
  });

  it('accepts a complete HTML candidate and preserves provider failures', async () => {
    const html = '<!DOCTYPE html><html><body>fixture</body></html>';
    await expect(fixture(html).generator.generateCandidate({ directive, baseHtml: html })).resolves.toBe(html);
    await expect(fixture('', false).brain.authorDirective(directiveInput)).rejects.toThrow('ATELIER_TRANSPORT_FAILED');
  });

  it.each(['not json', '{broken', '{}', '{"verifyingMetric":"invented"}',
    JSON.stringify({ ...directive, boundedEdit: '' })])('rejects an invalid directive instead of inventing one: %s', async text => {
    await expect(fixture(text).brain.authorDirective(directiveInput)).rejects.toThrow('ATELIER_INVALID_RESPONSE');
  });

  it('keeps the host-selected niche and validated directive fields', async () => {
    const result = await fixture(JSON.stringify({ ...directive, nicheKey: 'model-selected' }))
      .brain.authorDirective(directiveInput);
    expect(result).toMatchObject({ id: 'fixture', nicheKey: 'host-niche',
      hypothesis: directive.hypothesis, boundedEdit: directive.boundedEdit, verifyingMetric: 'errorVisibility' });
  });
});
