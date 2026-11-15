/**
 * Arc schema for reverse mode: the energy shape a piece of music must follow.
 * `{sections:[{t_start,t_end,energy 0..1,label}], cues:[{t,kind}]}`.
 */
export const CUE_KINDS = ['hit', 'drop', 'cut'] as const;
export type CueKind = (typeof CUE_KINDS)[number];

export interface ArcSection {
  readonly t_start: number;
  readonly t_end: number;
  readonly energy: number;
  readonly label: string;
}
export interface ArcCue {
  readonly t: number;
  readonly kind: CueKind;
}
/** How the piece ends: a final hit (default) or a phrase that fades out with no hit. */
export const ARC_ENDINGS = ['hit', 'phrase-out'] as const;
export type ArcEnding = (typeof ARC_ENDINGS)[number];

export interface Arc {
  readonly sections: readonly ArcSection[];
  readonly cues: readonly ArcCue[];
  readonly ending?: ArcEnding;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Returns every problem found (empty array = valid). */
export function arcProblems(input: unknown): string[] {
  const problems: string[] = [];
  if (!input || typeof input !== 'object') return ['arc must be an object'];
  const { sections, cues, ending } = input as { sections?: unknown; cues?: unknown; ending?: unknown };
  if (ending !== undefined && !ARC_ENDINGS.includes(ending as ArcEnding)) {
    problems.push(`ending must be one of ${ARC_ENDINGS.join('|')}`);
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    problems.push('sections must be a non-empty array');
  } else {
    let prevEnd = -Infinity;
    sections.forEach((s: Record<string, unknown>, i) => {
      const at = `sections[${i}]`;
      if (!s || typeof s !== 'object') { problems.push(`${at} must be an object`); return; }
      if (!isNum(s.t_start) || s.t_start < 0) problems.push(`${at}.t_start must be a number >= 0`);
      if (!isNum(s.t_end)) problems.push(`${at}.t_end must be a number`);
      if (isNum(s.t_start) && isNum(s.t_end)) {
        if (s.t_end <= s.t_start) problems.push(`${at}.t_end must be greater than t_start`);
        if (s.t_start < prevEnd - 1e-6) problems.push(`${at} overlaps the previous section`);
        prevEnd = s.t_end;
      }
      if (!isNum(s.energy) || s.energy < 0 || s.energy > 1) problems.push(`${at}.energy must be a number from 0 to 1`);
      if (typeof s.label !== 'string' || !s.label.trim()) problems.push(`${at}.label must be a non-empty string`);
    });
  }
  if (cues !== undefined) {
    if (!Array.isArray(cues)) problems.push('cues must be an array');
    else cues.forEach((c: Record<string, unknown>, i) => {
      if (!c || !isNum(c.t) || c.t < 0) problems.push(`cues[${i}].t must be a number >= 0`);
      if (!c || !CUE_KINDS.includes(c.kind as CueKind)) problems.push(`cues[${i}].kind must be one of ${CUE_KINDS.join('|')}`);
    });
  }
  return problems;
}

export class ArcValidationError extends Error {
  constructor(readonly problems: readonly string[], source: string) {
    super(`REVERSE_ARC_INVALID: ${source}: ${problems.join('; ')}`);
    this.name = 'ArcValidationError';
  }
}

/** Validate and return a frozen, normalized arc (cues default to []). */
export function validateArc(input: unknown, source = 'arc'): Arc {
  const problems = arcProblems(input);
  if (problems.length) throw new ArcValidationError(problems, source);
  const raw = input as { sections: ArcSection[]; cues?: ArcCue[]; ending?: ArcEnding };
  return Object.freeze({
    sections: Object.freeze(raw.sections.map((s) => Object.freeze({
      t_start: s.t_start, t_end: s.t_end, energy: s.energy, label: s.label.trim() }))),
    cues: Object.freeze((raw.cues ?? []).map((c) => Object.freeze({ t: c.t, kind: c.kind }))),
    ...(raw.ending ? { ending: raw.ending } : {}),
  });
}

export function parseArcJson(text: string, source: string): Arc {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new ArcValidationError([`not valid JSON (${(e as Error).message})`], source);
  }
  return validateArc(parsed, source);
}

/** Cues file: either a bare array or `{cues:[...]}`. */
export function parseCuesJson(text: string, source: string): readonly ArcCue[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new ArcValidationError([`not valid JSON (${(e as Error).message})`], source);
  }
  const cues = Array.isArray(parsed) ? parsed : (parsed as { cues?: unknown })?.cues;
  if (!Array.isArray(cues)) throw new ArcValidationError(['cues must be an array'], source);
  const problems = arcProblems({ sections: [{ t_start: 0, t_end: 1, energy: 0, label: 'x' }], cues });
  if (problems.length) throw new ArcValidationError(problems, source);
  return Object.freeze((cues as ArcCue[]).map((c) => Object.freeze({ t: c.t, kind: c.kind })));
}

/** Energy of the arc at time t (the section covering t, else the nearest end). */
export function arcEnergyAt(arc: Arc, t: number): number {
  for (const s of arc.sections) if (t >= s.t_start && t < s.t_end) return s.energy;
  const last = arc.sections[arc.sections.length - 1];
  return t >= last.t_end ? last.energy : arc.sections[0].energy;
}

export function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Turn an energy curve (one value per frame, frame length `hop` s) into sections
 * by splitting where the level steps by more than `threshold` between frames.
 */
export function curveToSections(curve: readonly number[], hop: number, opts: {
  threshold?: number; minFrames?: number; labelPrefix?: string } = {}): ArcSection[] {
  if (curve.length === 0) return [];
  const threshold = opts.threshold ?? 0.2;
  const minFrames = Math.max(1, opts.minFrames ?? 2);
  const max = Math.max(...curve, 1e-12);
  const norm = curve.map((v) => Math.min(1, Math.max(0, v / max)));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const cuts = [0];
  for (let i = minFrames; i <= norm.length - minFrames; i++) {
    if (i - cuts[cuts.length - 1] < minFrames) continue;
    if (Math.abs(norm[i] - norm[i - 1]) > threshold) cuts.push(i);
  }
  cuts.push(norm.length);
  const prefix = opts.labelPrefix ?? 'section';
  return cuts.slice(0, -1).map((start, i) => {
    const seg = norm.slice(start, cuts[i + 1]);
    return { t_start: round(start * hop), t_end: round(cuts[i + 1] * hop),
      energy: round(mean(seg)), label: `${prefix} ${i + 1}` };
  });
}
