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
  p5: ['culori', 'roughjs', 'perfect-freehand', 'matter-js', 'd3-contour', 'thing', 'paper', 'twgl', 'sinter-flow', 'sinter-look'],
  three: ['three-webgpu', 'three-tsl', 'three-gpu-pathtracer', 'holospot', 'thing', 'culori', 'three-mesh-bvh', 'sinter-look'],
  // A fragment shader cannot import JS libraries; only its own include kit applies.
  shader: ['sinter-glsl'],
  glsl: ['sinter-glsl'],
  strudel: ['tonaljs', 'thing', 'sinter-music'],
  tone: ['tonaljs', 'sinter-music'],
  music: ['tonaljs', 'sinter-music'],
  hydra: ['culori', 'twgl', 'sinter-look'],
  html: ['d3-delaunay', 'd3-contour', 'd3-geo', 'culori', 'roughjs', 'sinter-flow', 'sinter-look', 'd3'],
  dataviz: ['d3-delaunay', 'd3-contour', 'd3-geo', 'culori'],
  svg: ['paper', 'roughjs', 'perfect-freehand', 'culori'],
  kinetic: ['matter-js', 'roughjs', 'perfect-freehand', 'rapier2d', 'sinter-flow', 'd3'],
  meta: ['fontkit', 'harfbuzz', 'culori', 'paper', 'sinter-flow', 'sinter-look'],
  // `meta` was renamed `custom`; the key never followed, so custom pieces got
  // four random cards. Same list under the live name.
  custom: ['fontkit', 'harfbuzz', 'culori', 'paper', 'sinter-flow', 'sinter-look', 'd3'],
});

/** Brief cues: a card in a domain's preferred list that the head slots never
 * reach (p5's paper/twgl/thing, three's thing/culori, html's roughjs...) is
 * promoted when the brief names what it is for. No cue match, no change. */
const CARD_CUES: Readonly<Record<string, RegExp>> = Object.freeze({
  paper: /\b(boolean|union|intersect|offset path|cut ?file|plotter|vector (shape|cut))/i,
  twgl: /\b(ping-?pong|gpgpu|framebuffer|feedback buffer|reaction[- ]diffusion|fluid sim)/i,
  thing: /\b(tessellat|subdivision|spline|convex hull|voronoi|delaunay|computational geometry|packing)/i,
  culori: /\b(palette|oklch|colou?r (ramp|scale|science)|gradient ramp|perceptual)/i,
  roughjs: /\b(sketch(y|ed)?|hand-?drawn|hachure|doodle)/i,
  d3: /\b(force[- ]directed|force layout|network graph|node[- ]link|treemap|hierarch|dendrogram|circle packing|sunburst)/i,
  'd3-contour': /\b(contour|isoline|topograph)/i,
  rapier2d: /\b(deterministic physics|replay|same seed|rigid ?bod)/i,
  'matter-js': /\b(physics|collision|gravity|stack(ing)?|falling|bounc)/i,
  'three-mesh-bvh': /\b(raycast|ray ?cast|bvh|picking|sculpt|paint(ing)? on|closest point|collision mesh)/i,
  'sinter-look': /\b(crt|scanline|phosphor|film grain|grain|vhs|retro|terminal|analog(ue)?|monitor|80s|cyberpunk|blade runner)/i,
  'sinter-flow': /\b(flow ?field|particles?|curl|perlin|noise field|swarm|wind|drift|streamline)/i,
  'sinter-music': /\b(euclid|polyrhythm|arpeggi|markov|song (form|structure)|verse|chorus|generative (rhythm|melody))/i,
});
const CUE_SLOTS = 2;

/** Domains whose output is plain text or Python: no JS library can load there, so no card is offered. */
const NO_LIBRARY_DOMAINS: ReadonlySet<string> = new Set(['ascii', 'textgen', 'blender', 'nbe']);

export function libraryPromptSection(rng: () => number = Math.random, domain?: string, brief?: string): string {
  const cards = LIBRARY_CARDS;
  if (!cards || cards.length === 0) return '';
  if (domain && NO_LIBRARY_DOMAINS.has(domain)) return '';

  const preferredIds = domain
    ? DOMAIN_PREFERRED_CARDS[domain === 'shader' ? 'glsl' : domain === 'meta' ? 'custom' : domain]
    : undefined;

  // Preferred cards are offered first in the domain's OWN rank order (the
  // list IS the ranking; top CARD_SAMPLE_SIZE win the deterministic slots);
  // remaining slots fill randomly from the rest of the pool for variety.
  const sampled: typeof cards[number][] = [];
  const used = new Set<string>();
  // Per-brief promotion: cue-matched cards from the domain's own list take up
  // to CUE_SLOTS of the four slots ahead of the head ranking.
  const cued = brief
    ? (preferredIds ?? []).filter((id) => CARD_CUES[id]?.test(brief)).slice(0, CUE_SLOTS)
    : [];
  const head = (preferredIds ?? []).filter((id) => !cued.includes(id));
  for (const id of [...cued, ...head].slice(0, CARD_SAMPLE_SIZE)) {
    const card = cards.find(c => c.id === id);
    if (card) { sampled.push(card); used.add(card.id); }
  }
  // Cards scoped to named domains (`domains`) never fill random slots elsewhere.
  const rest = cards.filter(c => !used.has(c.id) && (!c.domains || (domain !== undefined && c.domains.includes(domain))))
    .filter(c => !(domain === 'glsl' || domain === 'shader') || c.domains !== undefined);
  while (sampled.length < Math.min(CARD_SAMPLE_SIZE, cards.length) && rest.length > 0) {
    // rng is not contractually [0,1) — clamp so a hostile/lazy rng cannot
    // index out of bounds
    const raw = rng();
    const frac = raw < 0 ? 0 : raw > 1 ? 0.999999 : raw;
    const i = Math.min(Math.floor(frac * rest.length), rest.length - 1);
    sampled.push(rest.splice(i, 1)[0]);
  }
  // The card's worked calls ARE the API contract: without them the model
  // guesses method names (holo.update, holo.material) and the piece throws.
  // Rules (a library's own composition law) ride the card the same way.
  const lines = sampled.map(c => {
    const calls = c.highPayoffCalls.length > 0 ? `\n    calls: ${c.highPayoffCalls.join(' | ')}` : '';
    const rules = c.rules && c.rules.length > 0 ? `\n    rules: ${c.rules.join(' | ')}` : '';
    return `- ${c.id} (${c.access}): ${c.summary}${calls}${rules}`;
  }).join('\n');
  return `\n\nOPTIONAL LIBRARY CAPABILITIES — you may use these (max 3 DISTINCT ids per piece, ONLY if they genuinely serve it; plain-canvas skills are always fine; 'thing' is ONE id covering every @thi.ng/ package):\n${lines}\nIf you use any, END YOUR RESPONSE with this exact line AFTER the closing code fence (never inside code, never mid-prose):\nlibraries: id1, id2\nFor layered pieces: layers: p5[id1] strudel[id2]\n\nEXAMPLE — a p5 piece that builds a perceptual color ramp with culori ends its reply like this:\n\`\`\`\nlibraries: culori\n\`\`\``;
}

export { DOMAIN_PREFERRED_CARDS };
