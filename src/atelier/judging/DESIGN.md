# The Judging Organ

The organ gives every artwork one fail-closed judging path across the three
canonical judging senses. It owns routing and quorum state, not provider SDKs.

## Modules

- `types.ts` defines lane identity, injected transport contracts, verdicts,
  outcomes, ladder receipts, and throughput types.
- `LaneBreakers.ts` tracks consecutive failures per
  `provider|model|transport`. Three failures open a lane by default; a clock
  controlled cooldown permits one half-open probe.
- `ProviderPool.ts` registers lanes by sense, resolves the primary and
  same-sense substitutes, injects transports, and records lane health.
- `JudgingOrgan.ts` executes one lane per required sense, applies the quota
  ladder, emits null-filled missing verdicts, and exposes promotion/stats
  decisions.
- `index.ts` is the public barrel.

## Quota ladder

For each required sense, the organ tries the healthy primary lane, then healthy
substitutes in priority order. A missing healthy lane is deferred and marked
queued. A lane that was available but failed is recorded as a failure; the
organ then records a defer/requeue step. If a required sense still has no
verdict, the outcome is `insufficient_quorum` and every sense is returned
all-null. The denominator is never reduced and no cross-sense lane is borrowed.

Deferred work is not a failed judgement. It increments `deferred`; a completed
three-sense panel increments `scored`; fail-closed panels increment
`insufficientQuorum`. The ladder receipt makes each attempted action visible.

## Ownership

The organ imports `JUDGING_PHASES` and `dimensionsForPhase` from
`dimensions.ts`. It never copies the frozen ownership table. Each phase's
dimensions are enumerated at runtime, so every verdict has exactly the
canonical rows for its owner and no other rows. `canPromote` requires a numeric
1..10 value for every canonical dimension and a complete three-sense quorum; any null,
deferred phase, or insufficient quorum blocks promotion.
