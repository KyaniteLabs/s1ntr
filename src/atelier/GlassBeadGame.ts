/**
 * GlassBeadGame — the relational organ. SINTER×Elixis: every scored artifact
 * becomes a bead; the game finds isomorphic structures ACROSS domains; each
 * wave plays one move — the strongest thread becomes either an exhibited
 * pairing, or (when both beads are sound domains) a DUET playable layering
 * both pieces behind one control.
 *
 * Why this organ exists: novelty-as-distance saturates; novelty-as-connective-
 * potential compounds. The thread graph turns the artifact store from a pool
 * into game state — dense neighborhoods are played-out, empty regions are the
 * open game. V1 is fully deterministic (no LLM): code-structural fingerprints,
 * cosine similarity across domains, moves recorded under .omx/atelier/game/.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import { embed, LV_VERSION } from './LatentField.js';

export interface Bead {
  id: string;
  domain: string;
  mean: number;
  dir: string;
  /** Deterministic code-structural fingerprint (8 dims, normalized). */
  fp: number[];
  indexedAt: string;
  /** Day-one universal field: lineage for interpolation, migration, auditing. */
  parent_bead_ids?: string[];
  /** Which model generated this artwork (provenance for per-model analytics). */
  model?: string;
  /** Which cognitive-style persona was active (provenance for per-persona analytics). */
  personaId?: string;
  /** Latent field vector (32 dims — see LatentField.ts). Backfilled lazily. */
  lv?: number[];
  lvVersion?: number;
  alpha?: number;
}

export interface Thread {
  a: string;
  b: string;
  domainA: string;
  domainB: string;
  similarity: number;
}

export interface MoveRecord {
  at: string;
  kind: 'pairing' | 'duet';
  thread: Thread;
  output: string;
}

const AUDIO_DOMAINS = new Set(['strudel', 'tone', 'audio']);
const STATE_DIR = (cwd: string) => join(cwd, '.omx', 'atelier', 'game');
const BEADS = (cwd: string) => join(STATE_DIR(cwd), 'beads.json');
const THREADS = (cwd: string) => join(STATE_DIR(cwd), 'threads.json');
const MOVES = (cwd: string) => join(STATE_DIR(cwd), 'moves.json');
const MOVES_DIR = (cwd: string) => join(STATE_DIR(cwd), 'moves');

function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Code-structural fingerprint, domain-agnostic by construction:
 * [length, time-construct density, call density, literal density,
 *  numeric variance, color-luminance mean, color-luminance variance,
 *  comment density] — each normalized to 0..1.
 */
export function fingerprint(source: string): number[] {
  const len = source.length;
  if (len === 0) return new Array(8).fill(0);
  const timeConstructs = (source.match(/\b(sin|cos|tan|time|tick|rate|freq|bpm|cpm|tempo|now)\b/gi) ?? []).length;
  const calls = (source.match(/\w+\s*\(/g) ?? []).length;
  const literals = (source.match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? []).length;
  const nums = (source.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const numMean = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  const numVar = nums.length ? nums.reduce((a, b) => a + (b - numMean) ** 2, 0) / nums.length : 0;
  const lums: number[] = [];
  for (const m of source.matchAll(/#?([0-9a-f]{6})\b/gi)) {
    const v = Number.parseInt(m[1], 16);
    lums.push((0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255);
  }
  const comments = (source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? []).join('').length;
  const lumMean = lums.length ? lums.reduce((a, b) => a + b, 0) / lums.length : 0.5;
  const lumVar = lums.length ? lums.reduce((a, b) => a + (b - lumMean) ** 2, 0) / lums.length : 0;
  const norm = (v: number, scale: number) => Math.min(1, v / scale);
  return [
    norm(len, 20000),
    norm(timeConstructs / (len / 1000), 20),
    norm(calls / (len / 1000), 80),
    norm(literals / (len / 1000), 40),
    norm(Math.sqrt(numVar), 500),
    lumMean,
    norm(Math.sqrt(lumVar), 0.5),
    norm(comments / len, 0.3),
  ];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : Math.max(-1, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/** Index new scored artifacts (from trend.jsonl rows with artifact dirs). */
export function indexBeads(cwd: string): { added: number; total: number; backfilled?: number } {
  const trendPath = join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl');
  const beads = loadJson<Bead[]>(BEADS(cwd), []);
  const known = new Set(beads.map(b => b.id));
  let added = 0;
  if (existsSync(trendPath)) {
    for (const line of readFileSync(trendPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { domain?: string; axes?: string; artifact?: string };
        if (!row.artifact || !row.domain) continue;
        const m = /D=([\d.]+) A=([\d.]+) R=([\d.]+) N=([\d.]+)/.exec(row.axes ?? '');
        if (!m) continue;
        const mean = m.slice(1).map(Number).reduce((a, b) => a + b, 0) / 4;
        const id = basename(row.artifact);
        if (known.has(id)) continue;
        const sourcePath = join(row.artifact, 'source.txt');
        if (!existsSync(sourcePath)) continue;
        const source = readFileSync(sourcePath, 'utf8');
        const prompt = existsSync(join(row.artifact, 'prompt.txt'))
          ? readFileSync(join(row.artifact, 'prompt.txt'), 'utf8').slice(0, 200)
          : '';
        const fp = fingerprint(source);
        const m2 = /D=([\d.]+) A=([\d.]+) R=([\d.]+) N=([\d.]+)/.exec(row.axes ?? '');
        const axes = m2
          ? { D: Number(m2[1]), A: Number(m2[2]), R: Number(m2[3]), N: Number(m2[4]) }
          : { D: 3, A: 3, R: 3, N: 3 };
        // Provenance: which model and persona made this artwork
        const personaPath = join(cwd, '.omx', 'atelier', 'personas', 'active-persona.json');
        let personaId: string | undefined;
        try { personaId = (JSON.parse(readFileSync(personaPath, 'utf8')) as { id?: string }).id; } catch { /* no persona assigned */ }
        // Model from the trace (nearest matching trace for this artifact)
        let model: string | undefined;
        try {
          const traceDir = join(process.env.HOME || '.', '.sinter', 'reasoning');
          const traces = readdirSync(traceDir).filter((f: string) => f.endsWith('.json')).slice(-30);
          for (const tf of traces) {
            try {
              const t = JSON.parse(readFileSync(join(traceDir, tf), 'utf8')) as { prompt?: string; model?: string; rawOutput?: string };
              if (t.rawOutput && t.rawOutput.includes(row.artifact.slice(-20))) { model = t.model; break; }
            } catch { /* unreadable or non-JSON trace: skip it, model attribution is best-effort */ }
          }
        } catch { /* no reasoning-trace dir: model stays unattributed */ }
        beads.push({
          id,
          domain: row.domain,
          mean,
          dir: row.artifact,
          fp,
          lv: embed({ source, prompt, fp, axes }),
          lvVersion: LV_VERSION,
          model: model ?? (row as { model?: string }).model,
          personaId: personaId ?? (row as { persona?: string }).persona,
          indexedAt: new Date().toISOString(),
        });
        known.add(id);
        added += 1;
      } catch { /* skip malformed rows */ }
    }
  }
  // Backfill lv for beads indexed before the Latent Field existed
  let backfilled = 0;
  for (const bead of beads) {
    if (!bead.lv) {
      const srcPath = join(bead.dir, 'source.txt');
      if (existsSync(srcPath)) {
        const src = readFileSync(srcPath, 'utf8');
        const promptPath = join(bead.dir, 'prompt.txt');
        const prompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8').slice(0, 200) : '';
        bead.lv = embed({ source: src, prompt, fp: bead.fp, axes: { D: bead.mean, A: bead.mean, R: bead.mean, N: bead.mean } });
        bead.lvVersion = LV_VERSION;
        backfilled += 1;
      }
    }
  }

  beads.sort((a, b) => a.mean - b.mean);
  mkdirSync(STATE_DIR(cwd), { recursive: true });
  writeAtomicSync(BEADS(cwd), JSON.stringify(beads, null, 1));
  return { added, total: beads.length, backfilled };
}

/** Cross-domain threads above threshold, strongest first.
 *  Elixis riding fix (PRD 2026-09-01 item B): threshold raised 0.985 → 0.995
 *  (the loose bar flooded the pool with near-duplicate hydra×p5 threads) and a
 *  per-pair cap of 40 — within each unordered domain pair only the 40 strongest
 *  threads survive, so one dense neighborhood can no longer monopolize the pool. */
export function findThreads(cwd: string, options: { threshold?: number; max?: number } = {}): Thread[] {
  const beads = loadJson<Bead[]>(BEADS(cwd), []);
  const threads: Thread[] = [];
  for (let i = 0; i < beads.length; i++) {
    for (let j = i + 1; j < beads.length; j++) {
      const a = beads[i], b = beads[j];
      if (a.domain === b.domain) continue; // the game is played ACROSS domains
      const similarity = cosineSimilarity(a.fp, b.fp);
      if (similarity >= (options.threshold ?? 0.995)) {
        threads.push({ a: a.id, b: b.id, domainA: a.domain, domainB: b.domain, similarity });
      }
    }
  }
  const PER_PAIR_CAP = 40;
  const byPair = new Map<string, Thread[]>();
  for (const t of threads) {
    const key = [t.domainA, t.domainB].sort().join('|');
    const bucket = byPair.get(key);
    if (bucket) bucket.push(t);
    else byPair.set(key, [t]);
  }
  const capped: Thread[] = [];
  for (const bucket of byPair.values()) {
    bucket.sort((x, y) => y.similarity - x.similarity);
    capped.push(...bucket.slice(0, PER_PAIR_CAP));
  }
  capped.sort((x, y) => y.similarity - x.similarity);
  const kept = capped.slice(0, options.max ?? 200);
  writeAtomicSync(THREADS(cwd), JSON.stringify(kept, null, 1));
  return kept;
}

function duetPlayable(dirA: string, dirB: string, title: string): string {
  // Both playables embedded; one header control clicks both inner buttons.
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>body{margin:0;background:#0b0b12;color:#eee;font-family:ui-monospace,monospace;padding:16px}
h3{color:#f59e0b;margin:0 0 6px}.duet{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:900px){.duet{grid-template-columns:1fr}}
iframe{width:100%;height:70vh;border:0;border-radius:10px;background:#000}
#both{padding:14px 22px;font:800 16px system-ui;background:linear-gradient(90deg,#f59e0b,#ec4899);color:#111;border:0;border-radius:10px;cursor:pointer;margin-bottom:12px}
.note{color:#94a3b8;font-size:12px;margin:0 0 12px}</style></head>
<body><h3>${title} — a Glass Bead Game duet</h3>
<button id="both" onclick="document.querySelectorAll('iframe').forEach(f=>{try{const b=f.contentDocument.getElementById('sinter-strudel-play')||f.contentDocument.getElementById('sinter-tone-start');if(b)b.click();}catch(e){}})">&#9654; Play both</button>
<p class="note">Two sound-domain artworks found structurally isomorphic. The move is the pairing; play them together.</p>
<div class="duet">
<iframe src="../../${basename(dirname(dirA))}/${basename(dirA)}/playable.html"></iframe>
<iframe src="../../${basename(dirname(dirB))}/${basename(dirB)}/playable.html"></iframe>
</div></body></html>`;
}

/** Play one move per wave: exhibit the strongest UNPLAYED thread. */
export function playMove(cwd: string): MoveRecord | null {
  const beads = loadJson<Bead[]>(BEADS(cwd), []);
  const byId = new Map(beads.map(b => [b.id, b]));
  const threads = loadJson<Thread[]>(THREADS(cwd), []);
  const moves = loadJson<MoveRecord[]>(MOVES(cwd), []);
  const played = new Set(moves.map(m => `${m.thread.a}|${m.thread.b}`));
  const thread = threads.find(t => !played.has(`${t.a}|${t.b}`) && !played.has(`${t.b}|${t.a}`));
  if (!thread) return null;
  const a = byId.get(thread.a);
  const b = byId.get(thread.b);
  if (!a || !b) return null;

  mkdirSync(MOVES_DIR(cwd), { recursive: true });
  const isAudioPair = AUDIO_DOMAINS.has(a.domain) && AUDIO_DOMAINS.has(b.domain);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let output: string;

  if (isAudioPair) {
    output = join(MOVES_DIR(cwd), `${stamp}-${a.id.slice(0, 8)}-x-${b.id.slice(0, 8)}.duet.html`);
    writeFileSync(output, duetPlayable(a.dir, b.dir, `${a.domain} x ${b.domain}`));
  } else {
    output = join(MOVES_DIR(cwd), `${stamp}-${a.id.slice(0, 8)}-x-${b.id.slice(0, 8)}.md`);
    const dims = ['code size', 'time-construct density', 'call density', 'literal density',
      'numeric spread', 'palette luminance', 'palette contrast', 'comment density'];
    const resonance = a.fp
      .map((v, i) => ({ dim: dims[i], delta: Math.abs(v - b.fp[i]) }))
      .sort((x, y) => x.delta - y.delta)
      .slice(0, 3)
      .map(r => `${r.dim} (|Δ|=${r.delta.toFixed(3)})`)
      .join(', ');
    writeFileSync(output, [
      `# Move: ${a.domain} × ${b.domain}`,
      '',
      `**${a.dir}** (mean ${a.mean.toFixed(2)}) × **${b.dir}** (mean ${b.mean.toFixed(2)})`,
      '',
      `Thread strength: cosine ${thread.similarity.toFixed(4)} across domains.`,
      `Strongest resonances: ${resonance}.`,
      '',
      'The move is the pairing: two works from different domains sharing one structure.',
    ].join('\n'));
  }

  const record: MoveRecord = { at: new Date().toISOString(), kind: isAudioPair ? 'duet' : 'pairing', thread, output };
  moves.push(record);
  writeAtomicSync(MOVES(cwd), JSON.stringify(moves, null, 1));
  return record;
}
