import { HeadlessRenderer } from '../render/HeadlessRenderer.js';

const AUDIO_DOMAINS = new Set(['music', 'strudel', 'tone']);

export function extractLayerHtml(compositionHtml: string, layerIndex: number): string {
  if (!Number.isInteger(layerIndex) || layerIndex < 1) {
    throw new Error('Layer PNG export requires a non-base layer index (1 or greater)');
  }

  const iframe = new RegExp(
    `<iframe\\b[^>]*data-layer-index="${layerIndex}"[^>]*>`,
  ).exec(compositionHtml)?.[0];
  if (!iframe) throw new Error(`Composition layer ${layerIndex} is unavailable`);

  const domain = /data-domain="([^"]+)"/.exec(iframe)?.[1];
  if (domain && AUDIO_DOMAINS.has(domain)) {
    throw new Error(`Composition layer ${layerIndex} (${domain}) is not visual`);
  }
  if (/data-opaque-background="true"/.test(iframe)) {
    throw new Error(`Composition layer ${layerIndex} violates the transparent foreground contract`);
  }

  const encoded = /src="data:text\/html;base64,([^"]+)"/.exec(iframe)?.[1];
  if (!encoded) throw new Error(`Composition layer ${layerIndex} has no renderable HTML`);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

export async function renderLayerPng(
  compositionHtml: string,
  layerIndex: number,
): Promise<Buffer> {
  const renderer = new HeadlessRenderer();
  try {
    const result = await renderer.render(extractLayerHtml(compositionHtml, layerIndex), {
      domain: 'html',
      omitBackground: true,
    });
    if (!result.success || !result.screenshot) {
      throw new Error(result.error ?? `Failed to render composition layer ${layerIndex}`);
    }
    return result.screenshot.buffer;
  } finally {
    await renderer.close();
  }
}
