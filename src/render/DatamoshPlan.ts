/**
 * DatamoshPlan - the only thing the model writes for the datamosh domain.
 *
 * The model returns a small JSON plan (which footage, which seconds, which frames to hold). No model
 * code ever runs: the renderer turns the plan into real ffmpeg + bitstream edits. Every field is
 * range-checked here so a bad plan fails before ffmpeg starts.
 */
import { MAX_HOLD_REPEAT } from './Mpeg4Mosh.js';
import { pickCodeBlock, splitThinking } from '../llm/ModelOutput.js';

export interface MoshSegment { clip: string; start: number; duration: number }
export interface MoshPlan {
  segments: MoshSegment[];
  gop: number;
  fps: number;
  width: number;
  strip: 'all' | number[];
  holds: Array<{ at: number; repeat: number }>;
  post: { saturation: number; hue: number; contrast: number };
}

export const MAX_TOTAL_SECONDS = 12;
export class PlanError extends Error {}

const CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function num(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new PlanError(`plan field "${name}" must be a number from ${min} to ${max}`);
  }
  return value;
}

function extractJson(text: string): unknown {
  const fence = pickCodeBlock(splitThinking(text).answer, ['json']);
  const body = (fence ? fence.body : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new PlanError('plan is not JSON: no object found');
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw new PlanError('plan is not valid JSON'); }
}

export function parseMoshPlan(text: string): { plan: MoshPlan } {
  const raw = extractJson(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') throw new PlanError('plan must be a JSON object');
  const segs = raw.segments;
  if (!Array.isArray(segs) || segs.length < 1 || segs.length > 2) throw new PlanError('plan needs 1 or 2 segments');
  const segments = segs.map((s: Record<string, unknown>, i) => {
    if (typeof s?.clip !== 'string' || !CLIP_ID.test(s.clip)) throw new PlanError(`segment ${i} clip must be a footage id`);
    return { clip: s.clip, start: num(s.start, `segments[${i}].start`, 0, 3600), duration: num(s.duration, `segments[${i}].duration`, 0.5, MAX_TOTAL_SECONDS) };
  });
  if (segments.reduce((sum, s) => sum + s.duration, 0) > MAX_TOTAL_SECONDS) throw new PlanError(`plan is longer than ${MAX_TOTAL_SECONDS} s in total`);
  const stripRaw = raw.strip ?? 'all';
  let strip: 'all' | number[];
  if (stripRaw === 'all') strip = 'all';
  else if (Array.isArray(stripRaw) && stripRaw.every((n) => Number.isInteger(n) && n >= 0) && stripRaw.length <= 500) strip = stripRaw as number[];
  else throw new PlanError('plan "strip" must be "all" or a list of frame indexes');
  const holdsRaw = raw.holds ?? [];
  if (!Array.isArray(holdsRaw) || holdsRaw.length > 12) throw new PlanError('plan "holds" must be a list of at most 12 entries');
  const holds = holdsRaw.map((h: Record<string, unknown>, i) => ({
    at: num(h?.at, `holds[${i}].at`, 0, 100000),
    repeat: num(h?.repeat, `holds[${i}].repeat`, 1, MAX_HOLD_REPEAT),
  }));
  const post = (raw.post ?? {}) as Record<string, unknown>;
  const width = num(raw.width, 'width', 160, 960, 480);
  return {
    plan: {
      segments,
      gop: Math.round(num(raw.gop, 'gop', 2, 120, 12)),
      fps: Math.round(num(raw.fps, 'fps', 8, 30, 24)),
      width: Math.round(width / 2) * 2,
      strip,
      holds,
      post: { saturation: num(post.saturation, 'post.saturation', 0, 4, 1), hue: num(post.hue, 'post.hue', -180, 180, 0), contrast: num(post.contrast, 'post.contrast', 0.5, 2, 1) },
    },
  };
}
