/**
 * LibraryPromptSection — the SINGLE SOURCE OF TRUTH for library capability
 * prompts in generation (#1000 wiring fix; v2 2026-09-01 per the approved
 * #1072 plan).
 *
 * Both the generation spine (LiminalProductionEffects) and the PromptOrgan
 * call this function — no duplicated text anywhere.
 *
 * v2 changes (PE-2, coordinated on #988): domain-aware card sampling — a
 * strudel piece is offered tonaljs, not three-gpu-pathtracer — plus a
 * worked declaration example. Relevance beats a random 4-of-17: the v1
 * section was carried by 12/60 live prompts and ignored by 12/12 models.
 */

import { LIBRARY_CARDS } from '../creative-vocabulary/LibraryCards.js';

const CARD_SAMPLE_SIZE = 4;

/** Cards whose payoff is specific to a domain; absent domains fall back to
 * the full pool (v1 behavior). Keep conservative — a wrong pairing teaches
 * worse than a generic one. */
const DOMAIN_PREFERRED_CARDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  p5: ['culori', 'roughjs', 'perfect-freehand', 'matter-js', 'd3-contour', 'thing', 'paper', 'twgl'],
  three: ['three-webgpu', 'three-tsl', 'three-gpu-pathtracer', 'thing', 'culori'],
  shader: ['twgl', 'thing'],
  glsl: ['twgl', 'thing'],
  strudel: ['tonaljs', 'thing'],
  tone: ['tonaljs'],
  music: ['tonaljs'],
  hydra: ['culori', 'twgl'],
  html: ['d3-delaunay', 'd3-contour', 'd3-geo', 'culori', 'roughjs'],
  dataviz: ['d3-delaunay', 'd3-contour', 'd3-geo', 'culori'],
  svg: ['paper', 'roughjs', 'perfect-freehand', 'culori'],
  kinetic: ['matter-js', 'roughjs', 'perfect-freehand'],
  textgen: ['fontkit', 'harfbuzz', 'culori'],
  meta: ['fontkit', 'harfbuzz', 'culori', 'paper'],
});

export function libraryPromptSection(rng: () => number = Math.random, domain?: string): string {
  const cards = LIBRARY_CARDS;
  if (!cards || cards.length === 0) return '';

  const preferredIds = domain
    ? DOMAIN_PREFERRED_CARDS[domain === 'shader' ? 'glsl' : domain]
    : undefined;

  // Preferred cards are offered first in the domain's OWN rank order (the
  // list IS the ranking; top CARD_SAMPLE_SIZE win the deterministic slots);
  // remaining slots fill randomly from the rest of the pool for variety.
  const sampled: typeof cards[number][] = [];
  const used = new Set<string>();
  for (const id of (preferredIds ?? []).slice(0, CARD_SAMPLE_SIZE)) {
    const card = cards.find(c => c.id === id);
    if (card) { sampled.push(card); used.add(card.id); }
  }
  const rest = cards.filter(c => !used.has(c.id));
  while (sampled.length < Math.min(CARD_SAMPLE_SIZE, cards.length) && rest.length > 0) {
    // rng is not contractually [0,1) — clamp so a hostile/lazy rng cannot
    // index out of bounds
    const raw = rng();
    const frac = raw < 0 ? 0 : raw > 1 ? 0.999999 : raw;
    const i = Math.min(Math.floor(frac * rest.length), rest.length - 1);
    sampled.push(rest.splice(i, 1)[0]);
  }
  const lines = sampled.map(c => `- ${c.id} (${c.access}): ${c.summary}`).join('\n');
  return `\n\nOPTIONAL LIBRARY CAPABILITIES — you may use these (max 3 DISTINCT ids per piece, ONLY if they genuinely serve it; plain-canvas skills are always fine; 'thing' is ONE id covering every @thi.ng/ package):\n${lines}\nIf you use any, END YOUR RESPONSE with this exact line AFTER the closing code fence (never inside code, never mid-prose):\nlibraries: id1, id2\nFor layered pieces: layers: p5[id1] strudel[id2]\n\nEXAMPLE — a p5 piece that builds a perceptual color ramp with culori ends its reply like this:\n\`\`\`\nlibraries: culori\n\`\`\``;
}

export { DOMAIN_PREFERRED_CARDS };
