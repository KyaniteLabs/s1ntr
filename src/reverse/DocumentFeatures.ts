/** Deterministic feature cards for SVG diagrams and text/markdown. No model calls. */
import { round, type ArcSection } from './Arc.js';

export interface CurvePoint { x: number; energy: number }

export interface DiagramFeatures {
  labels: string[];
  shapes: Record<string, number>;
  /** Polyline/path read as an energy curve (low y = high energy); null when none. */
  curve: CurvePoint[] | null;
}

const SHAPE_TAGS = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path'];
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

const PARAMS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Endpoints of each segment of an SVG path `d` attribute. */
export function pathPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const pts: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let cmd = '';
  for (let i = 0; i < tokens.length;) {
    if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i++]; if (cmd.toLowerCase() === 'z') continue; }
    const lower = cmd.toLowerCase();
    const n = PARAMS[lower];
    if (!n || i + n > tokens.length) break;
    const a = tokens.slice(i, i + n).map(Number);
    i += n;
    const rel = cmd === lower;
    if (lower === 'h') x = rel ? x + a[0] : a[0];
    else if (lower === 'v') y = rel ? y + a[0] : a[0];
    else {
      const ex = a[n - 2];
      const ey = a[n - 1];
      x = rel ? x + ex : ex;
      y = rel ? y + ey : ey;
    }
    pts.push([x, y]);
    if (lower === 'm') cmd = rel ? 'l' : 'L';
  }
  return pts;
}

function toCurve(points: Array<[number, number]>): CurvePoint[] | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  if (!points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  const stride = Math.max(1, Math.ceil(points.length / 32));
  return points.filter((_, i) => i % stride === 0 || i === points.length - 1).map(([px, py]) => ({
    x: round(maxX > minX ? (px - minX) / (maxX - minX) : 0),
    energy: round(maxY > minY ? (maxY - py) / (maxY - minY) : 0.5),
  }));
}

export function analyzeSvg(text: string): DiagramFeatures {
  if (!/<svg\b/i.test(text)) throw new Error('no <svg> root element');
  const labels = [...text.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|apos);/g, (e) => ENTITIES[e]).trim())
    .filter(Boolean);
  const shapes: Record<string, number> = {};
  for (const tag of SHAPE_TAGS) {
    const n = (text.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length;
    if (n) shapes[tag] = n;
  }
  let curve: CurvePoint[] | null = null;
  for (const m of text.matchAll(/<polyline\b[^>]*\bpoints\s*=\s*"([^"]*)"/gi)) {
    const nums = (m[1].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []).map(Number);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    curve = toCurve(pts);
    if (curve) break;
  }
  if (!curve) {
    for (const m of text.matchAll(/<path\b[^>]*\bd\s*=\s*"([^"]*)"/gi)) {
      curve = toCurve(pathPoints(m[1]));
      if (curve) break;
    }
  }
  return { labels, shapes, curve };
}

/** Sections from a diagram curve: one per label when labelled, else up to 8 even slices. */
export function curveToArcSections(curve: readonly CurvePoint[], labels: readonly string[], duration: number): ArcSection[] {
  const at = (x: number) => {
    for (let i = 1; i < curve.length; i++) {
      if (x <= curve[i].x || i === curve.length - 1) {
        const a = curve[i - 1];
        const b = curve[i];
        return b.x === a.x ? b.energy : a.energy + ((b.energy - a.energy) * (Math.min(Math.max(x, a.x), b.x) - a.x)) / (b.x - a.x);
      }
    }
    return curve[0].energy;
  };
  const n = labels.length > 0 ? labels.length : Math.min(8, Math.max(1, curve.length - 1));
  return Array.from({ length: n }, (_, i) => {
    const samples = Array.from({ length: 21 }, (__, k) => at((i + k / 20) / n));
    return {
      t_start: round((i / n) * duration),
      t_end: round(((i + 1) / n) * duration),
      energy: round(samples.reduce((a, b) => a + b, 0) / samples.length),
      label: labels.length > 0 ? labels[i] : `section ${i + 1}`,
    };
  });
}

export interface TextFeatures {
  headings: Array<{ level: number; text: string }>;
  words: number;
  lines: number;
}

export function analyzeText(text: string): TextFeatures {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const headings = lines.flatMap((l) => {
    const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(l);
    return m ? [{ level: m[1].length, text: m[2] }] : [];
  });
  const words = lines.map((l) => l.replace(/^#{1,6}\s+/, '')).join(' ').split(/\s+/).filter(Boolean).length;
  return { headings, words, lines: lines.length };
}
