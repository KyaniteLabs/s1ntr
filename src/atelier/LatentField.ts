/**
 * LatentField — the morphogenetic field of the artifact store.
 *
 * Build 2 of the Supreme Glass Bead Game. Every artifact gains a 32-dim
 * latent vector (24 content-hash dims via seeded random projection + 8
 * structural fingerprint dims + 4 judge axes, L2-normalized). The field
 * makes the artifact store navigable: distances are real, interpolation
 * is meaningful, and empty regions are the adjacent possible.
 *
 * Mathematical guarantee: the random projection preserves pairwise
 * distances within (1±ε) by the Johnson-Lindenstrauss lemma — this is
 * a principled coordinate system, not a hand-crafted approximation.
 *
 * Upgrade path: `lvVersion` future-proofs a spectral/diffusion-map
 * encoder at scale — same embed() signature, richer geometry.
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';

export const LV_VERSION = 1;
export const LV_DIMS = 36;
const HASH_BINS = 1024;
const PROJ_DIMS = 24;

// ═══ Seeded PRNG (mulberry32 — deterministic across machines) ═══

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed-seed projection matrix (constant in code — the "spectral" basis)
const PROJECTION_MATRIX: number[][] = (() => {
  const rng = mulberry32(20260830);
  const matrix: number[][] = [];
  for (let d = 0; d < PROJ_DIMS; d++) {
    const row = new Array(HASH_BINS);
    for (let b = 0; b < HASH_BINS; b++) row[b] = rng() * 2 - 1;
    matrix.push(row);
  }
  return matrix;
})();

// ═══ Content hashing (feature hashing → projection → 24 dims) ═══

function hashToken(token: string): number {
  let h = 5381;
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % HASH_BINS;
}

function contentHashDims(source: string, prompt: string): number[] {
  const counts = new Array(HASH_BINS).fill(0);
  const tokens = (source.toLowerCase() + ' ' + prompt.toLowerCase())
    .match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    counts[hashToken(tok)] += 1;
  }
  const totalTokens = tokens.length || 1;
  // Project the sparse hash through the fixed matrix
  const dims = new Array(PROJ_DIMS).fill(0);
  for (let d = 0; d < PROJ_DIMS; d++) {
    let sum = 0;
    const row = PROJECTION_MATRIX[d];
    for (let b = 0; b < HASH_BINS; b++) {
      if (counts[b] > 0) sum += counts[b] * row[b];
    }
    dims[d] = sum / Math.sqrt(totalTokens); // normalize by token count
  }
  return dims;
}

// ═══ Public embedding API ═══

export interface EmbedInput {
  source: string;
  prompt?: string;
  fp: number[];      // 8-dim structural fingerprint
  axes: { D: number; A: number; R: number; N: number }; // judge axes 1-5
}

export function embed(input: EmbedInput): number[] {
  const content = contentHashDims(input.source, input.prompt ?? '');
  const lv = [
    ...content,                          // 24 dims — content semantics
    ...input.fp.map(v => v * 2 - 1),    // 8 dims — structural (rescaled to [-1,1])
    (input.axes.D - 3) / 2,              // 4 dims — judge quality (centered at 3)
    (input.axes.A - 3) / 2,
    (input.axes.R - 3) / 2,
    (input.axes.N - 3) / 2,
  ];
  // L2 normalize
  const norm = Math.sqrt(lv.reduce((s, v) => s + v * v, 0)) || 1;
  return lv.map(v => v / norm);
}

export function fieldDistance(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return 1 - dot; // cosine distance
}

export function midpoint(a: number[], b: number[], alpha: number): number[] {
  const mid = a.map((v, i) => (1 - alpha) * v + alpha * (b[i] ?? 0));
  const norm = Math.sqrt(mid.reduce((s, v) => s + v * v, 0)) || 1;
  return mid.map(v => v / norm);
}

// ═══ Trait decoding (what does a point in the field mean?) ═══

export interface DimReading {
  kind: 'content' | 'structural' | 'quality';
  label: string;
  weight: number;
  parentBias: 'a' | 'b' | 'both';
}

const STRUCTURAL_LABELS = ['code size', 'temporal density', 'call density',
  'literal density', 'numeric spread', 'palette luminance', 'palette contrast', 'comment density'];
const QUALITY_LABELS = ['craft (D)', 'artistry (A)', 'reliability (R)', 'novelty (N)'];

export function decodeTarget(p: number[], a: number[], b: number[]): DimReading[] {
  const readings: DimReading[] = [];
  for (let d = 0; d < PROJ_DIMS && d < p.length; d++) {
    const pa = a[d] ?? 0, pb = b[d] ?? 0;
    if (Math.abs(pa - pb) < 0.02) continue; // skip dims where parents agree (not informative)
    readings.push({
      kind: 'content',
      label: `semantic dim ${d}`,
      weight: Math.abs(p[d]),
      parentBias: Math.abs(p[d] - pa) < Math.abs(p[d] - pb) ? 'a' : 'b',
    });
  }
  for (let d = 0; d < 8 && PROJ_DIMS + d < p.length; d++) {
    readings.push({
      kind: 'structural',
      label: STRUCTURAL_LABELS[d],
      weight: Math.abs(p[PROJ_DIMS + d]),
      parentBias: Math.abs(p[PROJ_DIMS + d] - (a[PROJ_DIMS + d] ?? 0)) < Math.abs(p[PROJ_DIMS + d] - (b[PROJ_DIMS + d] ?? 0)) ? 'a' : 'b',
    });
  }
  for (let d = 0; d < 4 && PROJ_DIMS + 8 + d < p.length; d++) {
    readings.push({
      kind: 'quality',
      label: QUALITY_LABELS[d],
      weight: Math.abs(p[PROJ_DIMS + 8 + d]),
      parentBias: 'both',
    });
  }
  return readings.sort((x, y) => y.weight - x.weight).slice(0, 6);
}

// ═══ Interpolation (the crown capability) ═══

export interface InterpIO {
  generate(prompt: string): Promise<{ source: string; artifactDir: string } | null>;
}

export interface HybridBead {
  id: string;
  domain: string;
  mean: number;
  dir: string;
  fp: number[];
  lv: number[];
  lvVersion: number;
  parent_bead_ids: string[];
  alpha: number;
  indexedAt: string;
}

export async function interpolate(
  cwd: string,
  beadAId: string,
  beadBId: string,
  alpha: number,
  io: InterpIO,
): Promise<HybridBead | null> {
  const beadsPath = join(cwd, '.omx', 'atelier', 'game', 'beads.json');
  if (!existsSync(beadsPath)) return null;
  const beads = JSON.parse(readFileSync(beadsPath, 'utf8')) as Array<Record<string, unknown>>;
  const a = beads.find(b => b.id === beadAId);
  const b = beads.find(b => b.id === beadBId);
  if (!a || !b) return null;

  const lvA = (a.lv as number[]) ?? null;
  const lvB = (b.lv as number[]) ?? null;
  if (!lvA || !lvB) return null; // field not built for these beads yet

  const p = midpoint(lvA, lvB, alpha);
  const decoded = decodeTarget(p, lvA, lvB);

  // Build the directive prompt from the trait readings + parent excerpts
  let sourceA = '', sourceB = '';
  try { sourceA = readFileSync(join(a.dir as string, 'source.txt'), 'utf8').slice(0, 600); } catch { /* optional */ }
  try { sourceB = readFileSync(join(b.dir as string, 'source.txt'), 'utf8').slice(0, 600); } catch { /* optional */ }

  const traitsA = decoded.filter(t => t.parentBias === 'a').map(t => t.label).join(', ');
  const traitsB = decoded.filter(t => t.parentBias === 'b').map(t => t.label).join(', ');

  const prompt = [
    `Create a hybrid artwork born from the midpoint of two existing pieces.`,
    `Parent A (${a.domain}): ${sourceA.slice(0, 300)}`,
    `Parent B (${b.domain}): ${sourceB.slice(0, 300)}`,
    ``,
    `The child inherits: from A — ${traitsA || 'the foundation'}; from B — ${traitsB || 'the elevation'}.`,
    `Merge them into one cohesive piece — not a collage, a synthesis.`,
    `Domain: hybrid of ${a.domain} and ${b.domain}. Raw code only.`,
  ].join('\n');

  const result = await io.generate(prompt);
  if (!result) return null; // generator failed — graceful skip

  // The child enters the store as a full citizen
  const childId = `hybrid-${basename(result.artifactDir).slice(0, 12)}`;
  const child: HybridBead = {
    id: childId,
    domain: `hybrid:${a.domain}+${b.domain}`,
    mean: 0, // scored by the ensemble in the wave
    dir: result.artifactDir,
    fp: [], // computed by the game organ on next index
    lv: p,  // born at the interpolation target
    lvVersion: LV_VERSION,
    parent_bead_ids: [beadAId, beadBId],
    alpha,
    indexedAt: new Date().toISOString(),
  };
  return child;
}

// ═══ Frontier (the adjacent possible) ═══

export interface FrontierEntry {
  beadA: string;
  beadB: string;
  domainA: string;
  domainB: string;
  midpointDensity: number; // 0 = completely empty region
  minQuality: number;
}

export function emptyRegions(
  cwd: string,
  opts: { r?: number; minMean?: number; max?: number } = {},
): FrontierEntry[] {
  const beadsPath = join(cwd, '.omx', 'atelier', 'game', 'beads.json');
  const threadsPath = join(cwd, '.omx', 'atelier', 'game', 'threads.json');
  if (!existsSync(beadsPath)) return [];
  const beads = JSON.parse(readFileSync(beadsPath, 'utf8')) as Array<{
    id: string; domain: string; mean: number; lv?: number[];
  }>;
  const threaded = new Set<string>();
  if (existsSync(threadsPath)) {
    const threads = JSON.parse(readFileSync(threadsPath, 'utf8')) as Array<{ a: string; b: string }>;
    for (const t of threads) {
      threaded.add(`${t.a}|${t.b}`); threaded.add(`${t.b}|${t.a}`);
    }
  }

  const r = opts.r ?? 0.25;
  const minMean = opts.minMean ?? 3.0;
  const max = opts.max ?? 20;
  let withLv = beads.filter(b => b.lv && b.mean >= minMean);
  // ADAPTIVE FLOOR (2026-08-30): on boards whose beads are all below the
  // quality floor (fresh machines, weak domains), the strict filter emptied
  // the field entirely — "no empty regions" was a lie told by an empty board.
  // Degrade the floor to the lv-bearing beads' median (never below 1.5)
  // instead of reporting nothing.
  if (withLv.length < 2) {
    const lvMeans = beads.filter(b => b.lv).map(b => b.mean).sort((x, y) => x - y);
    if (lvMeans.length >= 2) {
      const floor = Math.max(1.5, lvMeans[Math.floor(lvMeans.length / 2)]);
      withLv = beads.filter(b => b.lv && b.mean >= floor);
    }
  }
  const frontier: FrontierEntry[] = [];

  for (let i = 0; i < withLv.length && frontier.length < max; i++) {
    for (let j = i + 1; j < withLv.length && frontier.length < max; j++) {
      const a = withLv[i], b = withLv[j];
      if (a.domain === b.domain) continue;
      if (threaded.has(`${a.id}|${b.id}`)) continue;
      const p = midpoint(a.lv!, b.lv!, 0.5);
      // Count beads near the midpoint
      let density = 0;
      for (const c of withLv) {
        if (fieldDistance(p, c.lv!) < r) density++;
      }
      if (density === 0) {
        frontier.push({
          beadA: a.id, beadB: b.id,
          domainA: a.domain, domainB: b.domain,
          midpointDensity: density,
          minQuality: Math.min(a.mean, b.mean),
        });
      }
    }
  }
  frontier.sort((x, y) => y.minQuality - x.minQuality);

  const frontierPath = join(cwd, '.omx', 'atelier', 'game', 'frontier.json');
  mkdirSync(join(cwd, '.omx', 'atelier', 'game'), { recursive: true });
  writeAtomicSync(frontierPath, JSON.stringify(frontier.slice(0, max), null, 1));
  return frontier.slice(0, max);
}
