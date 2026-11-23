/**
 * NextDomainCard - the wall card (preview.html + card.json) for next-release domains.
 * Credit lines are rendered from the footage manifests; a card for outside footage cannot be written without one.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export interface CardInput {
  domain: string;
  title: string;
  credits: string[];
  video?: string;
  audio?: string;
  still?: string;
  note?: string;
  requireCredits?: boolean;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function buildCardHtml(card: CardInput): string {
  const media: string[] = [];
  if (card.video) media.push(`<video src="${esc(card.video)}"${card.still ? ` poster="${esc(card.still)}"` : ''} controls loop muted autoplay playsinline></video>`);
  if (card.audio) media.push(`<audio src="${esc(card.audio)}" controls loop></audio>`);
  if (!card.video && card.still) media.push(`<img src="${esc(card.still)}" alt="${esc(card.title)}">`);
  const credits = card.credits.map((c) => `<li>${esc(c)}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(card.title)}</title>`
    + '<style>body{margin:0;background:#0b0b0e;color:#d8d8e0;font:14px ui-monospace,monospace;display:grid;place-items:center;min-height:100vh}'
    + 'main{max-width:960px;padding:16px}video,img{width:100%;display:block}audio{width:100%}ul{padding-left:18px;color:#9a9aa8}h1{font-size:16px;font-weight:400}</style>'
    + `<main><h1>${esc(card.title)} <small>(${esc(card.domain)})</small></h1>${media.join('')}`
    + `${card.note ? `<p>${esc(card.note)}</p>` : ''}${credits ? `<ul class="credits">${credits}</ul>` : ''}</main>`;
}

export function writeWallCard(dir: string, card: CardInput): { htmlPath: string; jsonPath: string } {
  if (card.requireCredits && card.credits.length === 0) throw new Error(`card for ${card.domain} needs a credit line: outside footage must be credited`);
  const htmlPath = path.join(dir, 'preview.html');
  const jsonPath = path.join(dir, 'card.json');
  writeFileSync(htmlPath, buildCardHtml(card));
  writeFileSync(jsonPath, `${JSON.stringify({ domain: card.domain, title: card.title, credits: card.credits, note: card.note, media: { video: card.video, audio: card.audio, still: card.still } }, null, 2)}\n`);
  return { htmlPath, jsonPath };
}
