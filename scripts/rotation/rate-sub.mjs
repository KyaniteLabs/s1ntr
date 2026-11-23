// A rotation child reserves this exit for an attributed provider HTTP 429.
export const RATE_LIMIT_EXIT = 75;

export function isSeatRateLimit(error, model) {
  return Boolean(model && error?.statusCode === 429 && error.model === model);
}

// Scorers and battery adapters may turn a failed provider call into a telemetry gap.
// Observe the governed client before that conversion and preserve its normal result.
export async function observeSeatRateLimit(seat, model, adapters, run) {
  const role = seat === 'chat' ? 'studio' : seat;
  let refusal;
  const watched = {
    ...adapters,
    async createLlmClient(config) {
      const client = await adapters.createLlmClient(config);
      if (config.role !== role || config.model !== model) return client;
      return new Proxy(client, {
        get(target, key) {
          const method = Reflect.get(target, key, target);
          if (typeof method !== 'function') return method;
          if (!['complete', 'generate', 'generateWithImages'].includes(key)) return method.bind(target);
          return async (...args) => {
            try {
              const value = await method.apply(target, args);
              if (value?.success === true) refusal = undefined;
              if (value?.success === false && isSeatRateLimit(value, model)) {
                refusal = Object.assign(new Error('Seat rate limited'), { model, statusCode: 429 });
              }
              return value;
            } catch (error) {
              if (isSeatRateLimit(error, model)) refusal = error;
              throw error;
            }
          };
        },
      });
    },
  };
  const result = await run(watched);
  if (refusal && !result.success) throw refusal;
  return result;
}

/** Only explicitly configured substitutes are attempted. Each keeps its own output directory. */
export async function runWithRateSubs(primary, runSeat, context) {
  const rateSubs = [];
  let current = primary;
  let result = await runSeat(current, context);
  for (const next of primary.substitutes ?? []) {
    if (result.code !== RATE_LIMIT_EXIT) break;
    rateSubs.push({ kind: 'owner-labeled-rate-sub', seat: primary.seat,
      fromBrain: current.brain, toBrain: next.brain, status: 429, silentRepair: false });
    current = next;
    result = await runSeat(current, context);
  }
  return { ...result, requestedBrain: primary.brain, brain: current.brain, outDir: current.outDir, rateSubs };
}
