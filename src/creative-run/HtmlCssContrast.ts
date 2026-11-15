export const FIGURE_GROUND_TARGET = 'figure-ground-contrast-ratio' as const;
export const FIGURE_GROUND_METRIC = 'html-css-figure-ground-contrast-ratio' as const;
export const WCAG_CONTRAST_METRIC = 'html-css-wcag-text-contrast-ratio' as const;

export interface HtmlCssContrastAnalysis {
  readonly kind: 'html-css-static-body-colors';
  readonly foreground: string;
  readonly background: string;
  readonly contrastRatio: number;
  readonly extractorId: 'sinter-html-css-static-body-color-extractor';
  readonly extractorVersion: 1;
  readonly contrastAlgorithm: 'wcag-2.1-relative-luminance-contrast-ratio';
}

const SUPPORTED_BODY_PROPERTIES = new Set(['color', 'background-color']);

function unsupported(): never {
  throw new Error('HTML_CSS_FIGURE_GROUND_UNSUPPORTED');
}

function normalizedHex(value: string): string {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return `#${[...color.slice(1)].map((channel) => `${channel}${channel}`).join('')}`;
  }
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  return unsupported();
}

function linearChannel(hex: string): number {
  const channel = Number.parseInt(hex, 16) / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const red = linearChannel(color.slice(1, 3));
  const green = linearChannel(color.slice(3, 5));
  const blue = linearChannel(color.slice(5, 7));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 1_000_000) / 1_000_000;
}

function bodyDeclarations(css: string): ReadonlyMap<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = /^\s*body\s*\{([^{}]*)\}\s*$/i.exec(withoutComments);
  if (!match) return unsupported();
  const declarations = new Map<string, string>();
  for (const entry of match[1]!.split(';')) {
    const declaration = entry.trim();
    if (!declaration) continue;
    const separator = declaration.indexOf(':');
    if (separator <= 0 || declaration.indexOf(':', separator + 1) >= 0) return unsupported();
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SUPPORTED_BODY_PROPERTIES.has(property) || !value
      || value.includes('!important') || declarations.has(property)) {
      return unsupported();
    }
    declarations.set(property, value);
  }
  if (declarations.size !== SUPPORTED_BODY_PROPERTIES.size) return unsupported();
  return declarations;
}

export function analyzeHtmlCssContrast(creativeBytes: string): HtmlCssContrastAnalysis {
  if (!creativeBytes.trim()
    || /<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(creativeBytes)
    || /\bstyle\s*=/i.test(creativeBytes)
    || /<script\b/i.test(creativeBytes)) return unsupported();
  const document = /^\s*<!doctype html>\s*<html>\s*<head>\s*<title>[^<>]*<\/title>\s*<style>([\s\S]*?)<\/style>\s*<\/head>\s*<body>([^<>]*)<\/body>\s*<\/html>(?:\s*<!--[\s\S]*?-->\s*)*$/i
    .exec(creativeBytes);
  if (!document || !document[2]!.trim()) return unsupported();
  const declarations = bodyDeclarations(document[1]!);
  const foreground = normalizedHex(declarations.get('color') ?? '');
  const background = normalizedHex(declarations.get('background-color') ?? '');
  return Object.freeze({
    kind: 'html-css-static-body-colors',
    foreground,
    background,
    contrastRatio: contrastRatio(foreground, background),
    extractorId: 'sinter-html-css-static-body-color-extractor',
    extractorVersion: 1,
    contrastAlgorithm: 'wcag-2.1-relative-luminance-contrast-ratio',
  });
}
