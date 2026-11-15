/**
 * Reverse-mode brief: the text block appended to the generation prompt, plus the
 * provenance record. Only derived numbers and labels go in here, never media bytes.
 */
import type { FitRecord } from './RenderFit.js';
import { curveToSections, round, type Arc, type ArcCue } from './Arc.js';
import type { DiagramFeatures, TextFeatures } from './DocumentFeatures.js';
import type { AudioFeatures } from './AudioFeatures.js';
import type { ReferenceCard } from './ReferenceIngest.js';
import type { ImageFeatures, VideoFeatures } from './VisualFeatures.js';

export interface ReverseProvenance {
  readonly schema: 'sinter-reverse-provenance-v1';
  readonly references: ReadonlyArray<Pick<ReferenceCard, 'file' | 'kind' | 'sha256' | 'bytes' | 'features'>>;
  readonly arc: Arc | null;
  /** `file:<name>`, `vision:<name>`, `svg:<name>`, `derived:<name>` or `none`. */
  readonly arcSource: string;
  readonly durationSec: number | null;
  /** Measured fit of the rendered piece (exact-duration check), when it was run. */
  readonly fit?: FitRecord;
}

export interface ReverseBrief {
  readonly promptBlock: string;
  readonly provenance: ReverseProvenance;
}

const fmtList = (xs: readonly number[]) => `[${xs.join(', ')}]`;

function describeAudio(f: AudioFeatures): string {
  return `tempo ${Math.round(f.bpm)} BPM, key ${f.key}, `
    + `bar energy ${fmtList(f.barEnergy)}, onset density ${f.onsetDensity}/s, `
    + `spectral centroid ${Math.round(f.spectralCentroidHz)} Hz, sections ${f.sections
      .map((s) => `${s.t_start}-${s.t_end}s at ${s.energy}`).join('; ')}`;
}

export function describeCard(card: ReferenceCard): string {
  switch (card.kind) {
    case 'audio': {
      const f = card.features as AudioFeatures;
      return `${card.file} (audio, ${f.durationSec}s): ${describeAudio(f)}`;
    }
    case 'image': {
      const f = card.features as ImageFeatures;
      return `${card.file} (image ${f.width}x${f.height}): palette ${f.palette.join(' ')}, brightness ${f.brightness}, `
        + `contrast ${f.contrast}, edge density ${f.edgeDensity}, balance x ${f.balance.x} y ${f.balance.y}`;
    }
    case 'video': {
      const f = card.features as VideoFeatures;
      return `${card.file} (video, ${f.durationSec}s): palette ${f.palette.join(' ')}, `
        + `motion energy per ${f.motionBucketSec}s ${fmtList(f.motionEnergy)}, `
        + `cuts at ${f.cuts.length ? f.cuts.map((t) => `${t}s`).join(', ') : 'none'}, `
        + `${f.cutRhythm.cutsPerMinute} cuts/min, mean shot ${f.cutRhythm.meanShotSec}s`
        + `${f.durationSec - f.analyzedSec > 0.5 ? ` (picture analysed for the first ${f.analyzedSec}s)` : ''}; `
        + `audio track: ${f.audio ? describeAudio(f.audio) : 'none'}`;
    }
    case 'diagram': {
      const f = card.features as DiagramFeatures;
      const curve = f.curve ? `energy curve ${f.curve.map((p) => `${p.x}:${p.energy}`).join(' ')}` : 'no curve';
      return `${card.file} (diagram): labels ${f.labels.length ? f.labels.join(', ') : 'none'}; ${curve}`;
    }
    default: {
      const f = card.features as TextFeatures;
      const [first, ...rest] = f.headings;
      const heads = !first ? 'none'
        : first.level === 1 ? `${first.text}${rest.length ? ` > ${rest.map((h) => h.text).join(', ')}` : ''}`
          : f.headings.map((h) => h.text).join(', ');
      return `${card.file} (text): headings: ${heads}; ${f.words} words, ${f.lines} lines`;
    }
  }
}

export function scaleArc(arc: Arc, duration: number): Arc {
  const end = arc.sections[arc.sections.length - 1].t_end;
  const k = duration / end;
  return {
    sections: arc.sections.map((s, i, all) => ({ ...s, t_start: round(s.t_start * k),
      t_end: i === all.length - 1 ? duration : round(s.t_end * k) })),
    cues: arc.cues.map((c) => ({ ...c, t: round(c.t * k) })),
    ...(arc.ending ? { ending: arc.ending } : {}),
  };
}

/** Arc from the first audio card (its sections) or video card (motion energy + cuts). */
export function deriveArcFromCards(cards: readonly ReferenceCard[]): { arc: Arc; source: string } | null {
  const audio = cards.find((c) => c.kind === 'audio');
  if (audio) {
    const f = audio.features as AudioFeatures;
    if (f.sections.length) return { arc: { sections: f.sections, cues: [] }, source: `derived:${audio.file}` };
  }
  const video = cards.find((c) => c.kind === 'video');
  if (video) {
    const f = video.features as VideoFeatures;
    const sections = curveToSections(f.motionEnergy, f.motionBucketSec, { labelPrefix: 'shot', threshold: 0.3 });
    const last = sections[sections.length - 1];
    if (last) {
      const cues: ArcCue[] = f.cuts.filter((t) => t < last.t_end).map((t) => ({ t, kind: 'cut' as const }));
      return { arc: { sections, cues }, source: `derived:${video.file}` };
    }
  }
  return null;
}

export function buildReverseBrief(input: {
  cards: readonly ReferenceCard[];
  arc: Arc | null;
  arcSource: string;
  durationSec: number | null;
}): ReverseBrief {
  const { cards, arc, arcSource, durationSec } = input;
  const lines = ['', '--- Reverse-mode brief (derived from the references; no reference media is attached) ---'];
  if (durationSec !== null) {
    lines.push(arc?.ending === 'phrase-out'
      ? `Target duration: ${durationSec} seconds. The piece must end at exactly ${durationSec} seconds by phrasing out: no final hit, a natural fade to silence.`
      : `Target duration: ${durationSec} seconds. The piece must end at exactly ${durationSec} seconds on a final hit: a full, naturally decaying chord or kit hit with several octave bands, not a single bleep or a hard cutoff.`);
  }
  if (cards.length) {
    lines.push('References (deterministic feature cards):');
    for (const c of cards) lines.push(`- ${describeCard(c)}`);
  }
  if (arc) {
    lines.push('Energy arc to follow (0 = silence, 1 = peak):');
    for (const s of arc.sections) lines.push(`- ${s.t_start}-${s.t_end}s energy ${s.energy} "${s.label}"`);
    if (arc.cues.length) {
      lines.push('Cues (land these exactly):');
      for (const c of arc.cues) lines.push(`- ${c.kind} at ${c.t}s`);
    }
  }
  lines.push('--- End reverse-mode brief ---');
  return {
    promptBlock: lines.join('\n'),
    provenance: {
      schema: 'sinter-reverse-provenance-v1',
      references: cards.map(({ file, kind, sha256, bytes, features }) => ({ file, kind, sha256, bytes, features })),
      arc,
      arcSource,
      durationSec,
    },
  };
}

export function applyReverseBrief(prompt: string, brief: ReverseBrief): string {
  return `${prompt}\n${brief.promptBlock}`;
}
