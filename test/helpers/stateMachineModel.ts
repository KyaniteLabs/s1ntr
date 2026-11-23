/**
 * Tiny deterministic driver for stateful model tests (no extra dependency).
 *
 * `runModel` executes `runs` independent random walks of `steps` commands,
 * each walk seeded so any failure message names a reproducible seed.
 */

/** mulberry32 — small, fast, deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ModelCommand<S> {
  name: string;
  run: (state: S, rand: () => number) => void;
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

export function runModel<S>(options: {
  runs: number;
  steps: number;
  setup: (seed: number) => S;
  commands: readonly ModelCommand<S>[];
  invariant: (state: S) => void;
  teardown?: (state: S) => void;
}): void {
  for (let seed = 1; seed <= options.runs; seed++) {
    const rand = seededRandom(seed);
    const state = options.setup(seed);
    const trail: string[] = [];
    try {
      options.invariant(state);
      for (let step = 0; step < options.steps; step++) {
        const command = pick(rand, options.commands);
        trail.push(command.name);
        command.run(state, rand);
        options.invariant(state);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`model failed (seed ${seed}) after [${trail.join(', ')}]: ${message}`);
    } finally {
      options.teardown?.(state);
    }
  }
}
