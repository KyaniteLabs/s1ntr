/**
 * SinterGym — Gymnasium-shaped RL environment over the atelier flywheel.
 *
 * Modes:
 *  - replay: steps draw from logged turns (trend.jsonl + control.json) — offline
 *    policy training at ZERO model cost; the sample-efficiency unlock.
 *  - live: step() emits an action manifest the standing loop consumes next turn
 *    (selection/seat directives); the loop's scored turn completes the transition.
 *
 * Observation: domain, control-median quality, per-lesson credibility/outcomes,
 * turn index. Action: MultiBinary over eligible lessons (which to ABLATE — bounded
 * ablation, matching the bandit engine) + seat hint. Reward: ensemble (D+A)/2
 * minus the domain's control median (exogenous baseline, Architect A1).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GymTurn {
  readonly turn: number;
  readonly domain: string;
  readonly axes: { D: number; A: number; R: number; N: number };
  readonly arm: string;
  readonly lessonIds: readonly string[];
}

export interface SinterGymOptions {
  readonly rootDir?: string;
  readonly seed?: number;
}

function parseAxes(raw: string): GymTurn['axes'] | null {
  try {
    const kv = Object.fromEntries(raw.split(/\s+/).filter(x => x.includes('=')).map(x => {
      const [k, v] = x.split('=');
      return [k, Number(v)];
    }));
    if (Number.isFinite(kv.D) && Number.isFinite(kv.A)) {
      return { D: kv.D, A: kv.A, R: kv.R ?? 0, N: kv.N ?? 0 };
    }
  } catch { /* malformed line */ }
  return null;
}

export class SinterGym {
  readonly actionSpace = { type: 'multi_binary', desc: '1 = ablate this lesson this turn' } as const;
  readonly observationSpace = { type: 'dict', keys: ['domain', 'control_median', 'lessons', 'turn'] } as const;

  private readonly episodes: GymTurn[] = [];
  private readonly controlMedians = new Map<string, number>();
  private cursor = 0;

  constructor(options: SinterGymOptions = {}) {
    const root = options.rootDir ?? process.cwd();
    const trendPath = join(root, '.omx', 'atelier', 'lessons', 'trend.jsonl');
    const controlPath = join(root, '.omx', 'atelier', 'lessons', 'control.json');
    if (existsSync(trendPath)) {
      const seenDomains = new Map<string, number[]>();
      for (const line of readFileSync(trendPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line) as { turn: number; domain?: string; axes: string; arm?: string };
          const axes = parseAxes(t.axes);
          if (!axes) continue;
          const domain = t.domain ?? 'p5';
          const q = (axes.D + axes.A) / 2;
          const list = seenDomains.get(domain) ?? [];
          list.push(q); seenDomains.set(domain, list);
          this.episodes.push({ turn: t.turn, domain, axes, arm: t.arm ?? '?', lessonIds: [] });
        } catch { /* skip */ }
      }
      // One sort per domain after the read: sorting inside the loop re-sorted a
      // domain's whole history on every line (quadratic in logged turns).
      for (const [domain, list] of seenDomains) {
        this.controlMedians.set(domain, list.sort((a, b) => a - b)[Math.floor(list.length / 2)]);
      }
    }
    if (existsSync(controlPath)) {
      try {
        const controls = JSON.parse(readFileSync(controlPath, 'utf8')) as Record<string, { q: number }[]>;
        for (const [domain, entries] of Object.entries(controls)) {
          const qs = entries.map(e => e.q).sort((a, b) => a - b);
          if (qs.length) this.controlMedians.set(domain, qs[Math.floor(qs.length / 2)]);
        }
      } catch { /* keep trend-derived medians */ }
    }
  }

  get episodeCount(): number { return this.episodes.length; }

  /** Gym reset: returns the first observation of a (shuffled) replay epoch. */
  reset(): { domain: string; control_median: number; turn: number } | null {
    this.cursor = 0;
    return this.observe();
  }

  private observe(): { domain: string; control_median: number; turn: number } | null {
    const ep = this.episodes[this.cursor];
    if (!ep) return null;
    return { domain: ep.domain, control_median: this.controlMedians.get(ep.domain) ?? 0, turn: ep.turn };
  }

  /**
   * Replay step: the ACTION is ignored during pure replay (behavior policy = the
   * history); reward = quality minus exogenous control median. Trainers wrap this
   * with their own candidate actions scored against counterfactual baselines.
   */
  step(_action: number[] | null):
    { observation: ReturnType<SinterGym['observe']>; reward: number; done: boolean } {
    const ep = this.episodes[this.cursor];
    if (!ep) return { observation: null, reward: 0, done: true };
    const q = (ep.axes.D + ep.axes.A) / 2;
    const median = this.controlMedians.get(ep.domain) ?? q;
    const reward = Math.round((q - median) * 100) / 100;
    this.cursor += 1;
    const done = this.cursor >= this.episodes.length;
    return { observation: this.observe(), reward, done };
  }

  /** Random-baseline policy for sanity: ablate nothing. */
  static zeroAction(lessonCount: number): number[] {
    return new Array(lessonCount).fill(0);
  }
}

/** Deploy manifest: the live loop consumes this to realize a trained policy.
 * Schema note (S2 completion 2026-09-01): `recommendations` [{id, weight}] is
 * the shape bandit_bridge.read_policy_manifest reads - the writer and reader
 * had drifted (writer-only fields, reader-only fields) so even a manifest
 * read as empty. Both shapes now ship. */
export function writePolicyManifest(root: string, policy: {
  name: string; domain: string; ablateLessonIds: string[]; note: string;
  recommendations?: readonly { id: string; weight: number }[];
}): string {
  const path = join(root, '.omx', 'atelier', 'lessons', 'policy-manifest.json');
  mkdirSync(join(root, '.omx', 'atelier', 'lessons'), { recursive: true });
  const recommendations = policy.recommendations
    ?? policy.ablateLessonIds.map(id => ({ id, weight: 1 / Math.max(1, policy.ablateLessonIds.length) }));
  writeFileSync(path, JSON.stringify({
    ...policy,
    recommendations,
    writtenAt: new Date().toISOString(),
  }, null, 2));
  return path;
}
