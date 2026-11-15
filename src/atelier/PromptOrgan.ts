import { libraryPromptSection } from '../runtime-core/LibraryPromptSection.js';
/**
 * PromptOrgan — the generative prompt engine. Infinite creative prompts
 * targeted at the frontier, replacing the static hand-written rotation.
 *
 * The prompts ARE the genotype of the artworks. A static list is a fixed
 * genome. This organ is the germline — it creates new variation by:
 * 1. Combinatorial composition (domain × structure × mood × technique × constraint)
 * 2. Frontier targeting (empty regions of the latent field → what to generate there)
 * 3. Cross-pollination (domain A's winning structure → ask for it in domain B)
 * 4. Learning (prompt features that produce high-scoring art get reinforced)
 *
 * Output: 1 prompt per turn, infinitely varied, frontier-directed.
 *
 * CONDUCTOR LANE (Elixis layered-combination v1, PRD 2026-09-01): before the
 * normal strategy roll, an active Conductor may spend the turn on a LAYERED
 * COMBINATION prompt — a primary + secondary art-form pair (from the
 * combination frontier when one exists, else the static priors, one audio
 * layer max) phrased as ONE work with a trailing `layers: primary[] secondary[]`
 * declaration. The lane is carved INSIDE this organ (25% of eligible turns,
 * ≤2 per calendar day via conductor-count.json), so balancer/frontier
 * clobbers cannot remove it. Kill switch: SINTER_CONDUCTOR_OFF=1 or
 * .omx/atelier/game/conductor.state {enabled:false} falls back to plain organ
 * text instantly; ConductorCheck auto-disables the lane on 2 consecutive
 * sub-baseline combination scores (evidence recorded in conductor.state).
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import { Logger } from '../utils/Logger.js';

/** A missing file is an expected first-run state; anything else is a real read failure. */
const isMissingFile = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
import { loadOrCreate as loadRecipeBook, librariesFor, usablePriorPairs } from './RecipeBook.js';
import { injectSeedMotifs } from './CompostPromptMemory.js';

// ═══ Combinatorial components (deterministic — no LLM needed for the base) ═══

const STRUCTURAL_INTENTS: Record<string, string[]> = {
  p5: [
    'drifting particles forming and dissolving a recognizable shape',
    'concentric waves rippling from invisible touch points',
    'sharp geometric shards colliding and reforming in rhythmic pulses',
    'an organic growth simulation — branching structures reaching toward light',
    'a single continuous line that draws an entire scene without lifting',
    'layered parallax depth — foreground, midground, background breathing at different rates',
    'text that becomes texture — words dissolving into pure visual pattern',
    'a mirror study — left and right in dialogue, symmetry broken at key moments',
  ],
  three: [
    'impossible architecture — staircases that fold into themselves, Escher logic',
    'a gravitational dance between two abstract forms',
    'crystalline structures growing in real time, branching like coral',
    'a camera journey through a procedurally generated landscape',
    'floating debris field — hundreds of small objects with individual physics',
    'a single light source moving through a dark space, revealing geometry',
    'morphing topology — a sphere becoming a torus becoming a Klein bottle',
  ],
  glsl: [
    'liquid metal folds with iridescent reflections',
    'a fractal terrain flythrough at dawn on an alien world',
    'a single candle flame in absolute darkness, realistic light falloff',
    'Voronoi cells like living tissue, translucent membranes pulsing',
    'caustic light patterns at the bottom of a pool, water distortion',
    'an aurora borealis with volumetric light and particle trails',
    'a black hole accretion disk, gravitational lensing, extreme physics',
  ],
  hydra: [
    'analog feedback loops, organic blooms of color',
    'datamoshing between two contrasting scenes',
    'a single source pushed through extreme transformations',
    'flowing water-like distortions with caustic light',
    'kaleidoscopic symmetry that breaks and reforms',
    'glitch artifacts as aesthetic — harsh digital beauty',
  ],
  strudel: [
    'harmonic arpeggios over a warm drone with gentle euclidean pulse',
    'syncopated drum patterns with strategic silence, break-beat energy',
    'a singing melody line over sparse chord changes, breathing space',
    'the same melody entering at staggered times, evolving canon',
    'ambient texture — no traditional rhythm, sound as environment',
    'a bass-heavy groove with melodic fragments floating above',
    'layered counterpoint — three independent voices that agree',
    'a rhythm that gradually speeds up or slows down, tempo as narrative',
  ],
  tone: [
    'granular rain textures with soft bell tones',
    'a driving sequencer pattern that evolves over time, filter sweeps',
    'layered strings and brass building to a crescendo',
    'a single sustained tone acquiring harmonics, La Monte Young patience',
    'prepared piano-like plucks with resonant delays',
    'a walking bass line with sparse harmonic commentary above',
  ],
  kinetic: [
    'a single word breathing between weights',
    'text fragments scattering and reassembling',
    'a poem written letter-by-letter, each arrival changing the mood',
    'typography as landscape — letters as architectural forms',
  ],
  ascii: [
    'ocean waves in character density',
    'a rotating 3D wireframe in different character densities',
    'fire or plasma rendered in ASCII gradients',
  ],
  dataviz: [
    'hidden mathematical structure revealed in drifting particles',
    'audio waveform sculpted into a 3D landscape',
    'network graph that grows organically, nodes pulsing with data',
  ],
  svg: [
    'nested arcs with precise negative space',
    'a single continuous line drawing an entire landscape',
    'geometric Islamic-style tile patterns with subtle variation',
  ],
  hyperframes: [
    'layered paper-cut parallax with dawn colors',
    'a split-screen contrast between order and chaos',
    'a journey through a procedural world with multiple layers',
  ],
};

const MOODS = [
  'meditative and still', 'urgent and driving', 'nostalgic and warm',
  'cold and crystalline', 'playful and bouncing', 'dark and foreboding',
  'triumphant and soaring', 'intimate and whispered', 'vast and lonely',
  'electric and nervous', 'underwater and dreamlike', 'autumnal and melancholic',
];

const TECHNIQUES = [
  'with extreme layering — at least 5 simultaneous systems',
  'with brutal minimalism — nothing extra, nothing wasted',
  'with gradual acceleration — starting impossibly slow, building to overwhelming',
  'with strategic silence — the pauses ARE the composition',
  'with a single repeating motif that transforms each cycle',
  'with competing rhythms that periodically align',
  'with a color palette that shifts through the entire spectrum over time',
  'with symmetry that breaks at exactly the right moment',
  'with extreme contrast — pitch black against pure white, silence against noise',
  'with mechanical precision that becomes organic through repetition',
];

const CROSS_POLLINATION_TEMPLATES = [
  'Take the structural logic of {sourceStructure} and express it in {targetDomain} — the same form, different medium',
  'What would {sourceDomain} sound/look like if it had the emotional temperature of {mood}?',
  'Create a piece that could be a Glass Bead Game thread between {domainA} and {domainB} — embody their shared structure',
];

const CONSTRAINTS = [
  'using only one color family',
  'in exactly 64 beats/measures/units',
  'that starts and ends in the same place but is transformed by the journey',
  'where every element is necessary — remove anything and it collapses',
  'that could loop forever without becoming boring',
  'where the most important thing happens in the negative space',
  'that feels handmade despite being algorithmic',
];

// ═══ Types ═══

export interface GeneratedPrompt {
  text: string;
  domain: string;
  source: 'combinatorial' | 'frontier' | 'cross-pollination' | 'constraint' | 'conductor';
  components: { intent?: string; mood?: string; technique?: string; constraint?: string };
  createdAt: string;
  scoreOutcome?: number; // filled after the turn is scored
}

export interface PromptOrganState {
  history: GeneratedPrompt[];
  turnCount?: number;
  /** Features that correlate with high scores (learned through outcomes). */
  featureScores: Record<string, { total: number; count: number }>;
}

const STATE_PATH = (cwd: string) => join(cwd, '.omx', 'atelier', 'prompts', 'organ-state.json');

// ═══ Deterministic seeded random (same organ contract as the game) ═══

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══ The Organ ═══

export class PromptOrgan {
  private state: PromptOrganState;
  private rng: () => number;

  constructor(private cwd: string, seed?: number) {
    this.rng = mulberry32(seed ?? Date.now());
    try {
      this.state = JSON.parse(readFileSync(STATE_PATH(cwd), 'utf8'));
    } catch {
      this.state = { history: [], featureScores: {}, turnCount: 0 };
    }
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }

  private pickWeighted<T>(arr: T[], weightFn: (item: T) => number): T {
    const weights = arr.map(weightFn);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /** Generate a combinatorial prompt (no LLM — deterministic composition). */
  combinatorial(domain?: string): GeneratedPrompt {
    const domains = Object.keys(STRUCTURAL_INTENTS);
    const d = domain ?? this.pick(domains);
    const intents = STRUCTURAL_INTENTS[d] ?? STRUCTURAL_INTENTS.p5;
    const intent = this.pickWeighted(intents, i => {
      // Prefer intents that have historically scored well
      const key = `intent:${i.slice(0, 30)}`;
      const s = this.state.featureScores[key];
      return s ? 1 + (s.total / s.count) : 1;
    });
    const mood = this.pick(MOODS);
    const technique = this.rng() > 0.5 ? this.pick(TECHNIQUES) : undefined;
    const constraint = this.rng() > 0.7 ? this.pick(CONSTRAINTS) : undefined;

    const parts = [`${d} piece: ${intent}`, mood];
    if (technique) parts.push(technique);
    if (constraint) parts.push(constraint);

    return {
      text: `A ${parts.join(', ')}`,
      domain: d,
      source: 'combinatorial',
      components: { intent, mood, technique, constraint },
      createdAt: new Date().toISOString(),
    };
  }

  /** Generate a frontier-targeted prompt (aimed at empty regions of the latent field). */
  frontier(): GeneratedPrompt | null {
    try {
      const frontierPath = join(this.cwd, '.omx', 'atelier', 'game', 'frontier.json');
      if (!existsSync(frontierPath)) return null;
      const frontier = JSON.parse(readFileSync(frontierPath, 'utf8')) as Array<{
        domainA: string; domainB: string; minQuality: number;
      }>;
      if (frontier.length === 0) return null;
      const target = this.pick(frontier);

      return {
        text: `A ${target.domainA} piece that could structurally thread with ${target.domainB}: create something whose internal logic mirrors cross-domain patterns — the kind of work a Glass Bead Game would connect across these two worlds`,
        domain: this.rng() > 0.5 ? target.domainA : target.domainB,
        source: 'frontier',
        components: {},
        createdAt: new Date().toISOString(),
      };
    } catch { return null; }
  }

  /** Generate a cross-pollination prompt (Glass Bead Game move as prompt seed). */
  crossPollination(): GeneratedPrompt {
    const domains = Object.keys(STRUCTURAL_INTENTS);
    const sourceDomain = this.pick(domains);
    const targetDomain = this.pick(domains.filter(d => d !== sourceDomain));
    const sourceIntents = STRUCTURAL_INTENTS[sourceDomain] ?? [];
    const sourceStructure = this.pick(sourceIntents);
    const template = this.pick(CROSS_POLLINATION_TEMPLATES);

    const text = template
      .replace('{sourceStructure}', sourceStructure)
      .replace('{sourceDomain}', sourceDomain)
      .replace('{targetDomain}', targetDomain)
      .replace('{domainA}', sourceDomain)
      .replace('{domainB}', targetDomain)
      .replace('{mood}', this.pick(MOODS));

    return {
      text,
      domain: targetDomain,
      source: 'cross-pollination',
      components: {},
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * OPTIONAL capability knowledge (CEO rule: knowledge, never defaults — the
   * model decides at plan time). ~1 in 3 turns carries a rotating sample of
   * 4 of the 19 LibraryCards so every card cycles into context over time
   * without paying ~1.2K tokens every single turn (least-compute law).
   */
private libraryCapabilitySuffix(): string {
    if (this.rng() > 0.35) return '';
    // SINGLE SOURCE OF TRUTH: delegates to LibraryPromptSection (#1060)
    return libraryPromptSection(this.rng);
  }

  // ═══ Conductor lane (Elixis layered-combination v1) ═══

  private gamePath(name: string): string {
    return join(this.cwd, '.omx', 'atelier', 'game', name);
  }

  /** Kill switch + daily budget: env SINTER_CONDUCTOR_OFF=1 or conductor.state
   *  {enabled:false} disables instantly; the lane is capped at 2 combination
   *  prompts per calendar day (conductor-count.json {wave, used}). */
  private conductorLaneOpen(): boolean {
    if (process.env.SINTER_CONDUCTOR_OFF === '1') return false;
    try {
      const state = JSON.parse(readFileSync(this.gamePath('conductor.state'), 'utf8')) as { enabled?: boolean };
      if (state?.enabled === false) return false;
    } catch (err) {
      // ENOENT: no state file, the lane defaults on. A torn file also defaults on, which would silently ignore the kill switch.
      if (!isMissingFile(err)) Logger.warn('PromptOrgan', 'conductor.state unreadable (kill switch ignored, lane defaults on):', err);
    }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const count = JSON.parse(readFileSync(this.gamePath('conductor-count.json'), 'utf8')) as { wave?: string; used?: number };
      if (count?.wave === today && (count.used ?? 0) >= 2) return false;
    } catch (err) {
      // ENOENT: no counter yet. A torn counter resets the daily budget.
      if (!isMissingFile(err)) Logger.warn('PromptOrgan', 'conductor-count.json unreadable (daily budget treated as fresh):', err);
    }
    return true;
  }

  private noteConductorTurn(): void {
    const path = this.gamePath('conductor-count.json');
    const today = new Date().toISOString().slice(0, 10);
    let used = 0;
    try {
      const count = JSON.parse(readFileSync(path, 'utf8')) as { wave?: string; used?: number };
      if (count?.wave === today) used = count.used ?? 0;
    } catch (err) {
      // ENOENT: first turn. A torn counter restarts the count at zero.
      if (!isMissingFile(err)) Logger.warn('PromptOrgan', 'conductor-count.json unreadable (count restarts at 0):', err);
    }
    writeAtomicSync(path, JSON.stringify({ wave: today, used: used + 1 }, null, 1));
  }

  /** Candidate pair: the combination frontier when one exists, else the static
   *  priors (audio+audio pairs excluded — ONE audio layer max). */
  private combinationCandidate(): { primary: string; secondary: string } | null {
    try {
      const frontierPath = this.gamePath('combination-frontier.json');
      if (existsSync(frontierPath)) {
        const entries = JSON.parse(readFileSync(frontierPath, 'utf8')) as Array<{
          primary?: string; secondary?: string; domainA?: string; domainB?: string;
        }>;
        const pairs = entries
          .map(e => ({ primary: e.primary ?? e.domainA ?? '', secondary: e.secondary ?? e.domainB ?? '' }))
          .filter(p => p.primary && p.secondary && p.primary !== p.secondary)
          .filter(p => !(['strudel', 'tone', 'audio'].includes(p.primary) && ['strudel', 'tone', 'audio'].includes(p.secondary)));
        if (pairs.length > 0) return this.pick(pairs);
      }
    } catch (err) { Logger.warn('PromptOrgan', 'combination-frontier.json unreadable (falling back to priors):', err); }
    const priors = usablePriorPairs();
    if (priors.length === 0) return null;
    const [primary, secondary] = this.pick(priors);
    return { primary, secondary };
  }

  /** The combination prompt: one work, two layers, trailing declaration. */
  private conductorPrompt(): GeneratedPrompt | null {
    const pair = this.combinationCandidate();
    if (!pair) return null;
    const { primary, secondary } = pair;
    const libs = librariesFor(loadRecipeBook(this.cwd), primary, secondary).slice(0, 3); // max 3 distinct ids total
    const primaryLibs = libs.slice(0, Math.ceil(libs.length / 2));
    const secondaryLibs = libs.slice(primaryLibs.length);
    const bracket = (ids: string[]) => ids.length > 0 ? `[${ids.join(',')}]` : '[]';
    const declaration = `layers: ${primary}${bracket(primaryLibs)} ${secondary}${bracket(secondaryLibs)}`;
    const text = `A layered combination artwork: ${primary} as the primary layer carrying the composition, `
      + `with ${secondary} woven in as a secondary layer that serves it — the layers must feel like ONE work, not two stapled together`
      + `\n\nEnd your response with this exact line after the closing code fence:\n${declaration}`;
    const createdAt = new Date().toISOString();
    try {
      writeAtomicSync(this.gamePath('conductor-last.json'), JSON.stringify({ ...pair, ts: createdAt }, null, 1));
    } catch (err) { Logger.warn('PromptOrgan', 'conductor plan record write failed (adherence check will not run; prompt still ships):', err); }
    this.noteConductorTurn();
    return {
      text,
      domain: primary,
      source: 'conductor',
      components: {},
      createdAt,
    };
  }

  /** Generate the next prompt (mix of strategies — frontier-weighted). */
  next(): GeneratedPrompt {
    const turn = this.state.turnCount ?? this.state.history.length;
    this.state.turnCount = turn + 1;
    // Conductor lane first: a bounded carve INSIDE the organ (see header).
    if (this.conductorLaneOpen() && this.rng() < 0.25) {
      const combination = this.conductorPrompt();
      if (combination) {
        combination.text += this.libraryCapabilitySuffix();
        combination.text = injectSeedMotifs(combination.text, this.cwd, turn);
        return combination;
      }
    }
    const roll = this.rng();
    let p: GeneratedPrompt;
    if (roll < 0.3) {
      const f = this.frontier();
      if (f) p = f;
      else p = this.combinatorial();
    } else if (roll < 0.45) {
      p = this.crossPollination();
    } else {
      p = this.combinatorial();
    }
    p.text += this.libraryCapabilitySuffix();
    p.text = injectSeedMotifs(p.text, this.cwd, turn);
    return p;
  }

  /** Record an outcome (called after the turn is scored). */
  recordOutcome(prompt: GeneratedPrompt, score: number): void {
    prompt.scoreOutcome = score;
    this.state.history.push(prompt);
    // Update feature scores
    for (const [key, value] of Object.entries(prompt.components)) {
      if (!value) continue;
      const k = `${key}:${String(value).slice(0, 30)}`;
      if (!this.state.featureScores[k]) this.state.featureScores[k] = { total: 0, count: 0 };
      this.state.featureScores[k].total += score;
      this.state.featureScores[k].count += 1;
    }
    this.save();
  }

  save(): void {
    mkdirSync(join(this.cwd, '.omx', 'atelier', 'prompts'), { recursive: true });
    writeAtomicSync(STATE_PATH(this.cwd), JSON.stringify(this.state, null, 1));
  }

  /** Stats for the control center. */
  stats(): { totalPrompts: number; bySource: Record<string, number>; topFeatures: Array<{ feature: string; avgScore: number }> } {
    const bySource: Record<string, number> = {};
    for (const p of this.state.history) {
      bySource[p.source] = (bySource[p.source] ?? 0) + 1;
    }
    const topFeatures = Object.entries(this.state.featureScores)
      .filter(([, v]) => v.count >= 2)
      .map(([k, v]) => ({ feature: k, avgScore: v.total / v.count }))
      .sort((a, b) => b.avgScore - a.avgScore)
      .slice(0, 10);
    return { totalPrompts: this.state.history.length, bySource, topFeatures };
  }
}
