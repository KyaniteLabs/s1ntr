/** Bound direct generation so it leaves time for later attempts. */
export function directAttemptTimeoutMs(configuredTimeout?: number): number {
  const override = Number(process.env.SINTER_KINETIC_DIRECT_TIMEOUT_MS);
  if (Number.isFinite(override) && override >= 5_000) return override;
  return Math.min(configuredTimeout ?? 60_000, 60_000);
}
