import { describe, expect, it } from 'vitest';
import { stripLeadingMetaDescriptor } from '../../../src/core/validators/MetaDescriptor.js';

describe('stripLeadingMetaDescriptor', () => {
  it('removes a leading descriptor and the whitespace after it', () => {
    const html = '<!--SINTER-META-DESCRIPTOR {"a":1} -->\n\n<!DOCTYPE html><html></html>';
    expect(stripLeadingMetaDescriptor(html)).toBe('<!DOCTYPE html><html></html>');
  });

  it('tolerates leading whitespace before the descriptor', () => {
    expect(stripLeadingMetaDescriptor('  \n<!--SINTER-META-DESCRIPTOR x--><p>hi</p>')).toBe('<p>hi</p>');
  });

  it('returns input unchanged when there is no descriptor', () => {
    const html = '<!DOCTYPE html><p>hi</p>';
    expect(stripLeadingMetaDescriptor(html)).toBe(html);
  });

  it('keeps a descriptor that is not leading', () => {
    const html = '<p>x</p><!--SINTER-META-DESCRIPTOR x--><p>y</p>';
    expect(stripLeadingMetaDescriptor(html)).toBe(html);
  });

  it('keeps an unterminated descriptor untouched', () => {
    const html = '<!--SINTER-META-DESCRIPTOR never closed <p>y</p>';
    expect(stripLeadingMetaDescriptor(html)).toBe(html);
  });

  it('handles the empty string', () => {
    expect(stripLeadingMetaDescriptor('')).toBe('');
  });
});
