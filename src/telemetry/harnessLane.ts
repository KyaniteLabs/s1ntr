/**
 * Harness-lane telemetry on the #400 event ledger fabric.
 *
 * Fail-open: ledger failures never break the agent run. Gaps are marked via
 * harness.telemetryGap (honest, never faked).
 */

import { detectProviderLabel } from '../config/ProviderRuntime.js';
import type { LLMClient } from '../llm/LLMClient.js';
import { Logger } from '../utils/Logger.js';
import {
  recordEvent,
  type SinterEventInput,
} from './EventLedger.js';

export interface HarnessSeatAttribution {
  model: string | null;
  provider: string | null;
  role: 'harness';
}

/**
 * Scrub absolute filesystem paths from durable ledger reason strings so
 * /Users/<user>/... never lands in JSONL.
 */
export function scrubLedgerReason(reason: string): string {
  return reason
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:'"`]+[\\/])+[^\s:'"`]*/g, '[path]')
    .slice(0, 200);
}

/** Resolve seat model + provider route from an LLM client (post-resolve preferred). */
export function resolveHarnessSeat(llm: LLMClient | {
  getConfig: () => { model?: string; provider?: string; baseUrl?: string };
  getRole?: () => string | undefined;
}): HarnessSeatAttribution {
  const cfg = llm.getConfig();
  // Literal "auto" is an unresolved placeholder (remote hosts skip auto-detect).
  const rawModel = (cfg.model && cfg.model.trim()) ? cfg.model.trim() : null;
  const model = rawModel && rawModel.toLowerCase() !== 'auto' ? rawModel : null;
  const labeled = detectProviderLabel(cfg.baseUrl || '', cfg.model || '');
  const provider = (cfg.provider && cfg.provider.trim())
    ? cfg.provider
    : (labeled && labeled !== 'llm' && labeled !== 'unknown' ? labeled : null);
  return {
    model,
    provider,
    role: 'harness',
  };
}

/**
 * Best-effort resolve of the effective seat model before attribution.
 * Never throws — falls back to getConfig().model.
 */
export async function resolveHarnessSeatModel(
  llm: LLMClient | {
    getConfig: () => { model?: string };
    resolveEffectiveModel?: () => Promise<string>;
  },
): Promise<string> {
  try {
    if (typeof llm.resolveEffectiveModel === 'function') {
      const resolved = await llm.resolveEffectiveModel();
      if (resolved && resolved.trim()) return resolved;
    }
  } catch {
    // fail-open: keep configured model
  }
  const model = llm.getConfig().model;
  return (model && model.trim()) ? model : 'unknown';
}

export interface RecordHarnessLaneResult {
  ok: boolean;
  /** True when the primary write failed (gap marked if possible) */
  telemetryGap: boolean;
}

/**
 * Record a harness-lane event. Fail-open: never throws.
 * On failure, attempts a harness.telemetryGap marker (also fail-open).
 */
export async function recordHarnessLaneEvent(
  input: Omit<SinterEventInput, 'role'> & { role?: string | null },
  options?: Parameters<typeof recordEvent>[1],
): Promise<RecordHarnessLaneResult> {
  const eventInput: SinterEventInput = {
    ...input,
    role: input.role ?? 'harness',
  };
  try {
    await recordEvent(eventInput, options);
    return { ok: true, telemetryGap: false };
  } catch (err) {
    const reason = scrubLedgerReason(err instanceof Error ? err.message : String(err));
    Logger.warn(
      'harnessLane',
      `Failed to record ${eventInput.event}: ${reason}`,
    );
    // Honest gap marker — never invent the original event.
    if (eventInput.event !== 'harness.telemetryGap') {
      try {
        await recordEvent({
          event: 'harness.telemetryGap',
          model: eventInput.model ?? null,
          provider: eventInput.provider ?? null,
          role: 'harness',
          runId: eventInput.runId ?? null,
          episodeId: eventInput.episodeId ?? null,
          domain: eventInput.domain ?? 'harness',
          inputHash: null,
          verdict: 'gap',
          latencyMs: null,
          costUsd: null,
          evidenceRefs: [],
          payload: {
            failedEvent: eventInput.event,
            reason,
          },
        }, options);
      } catch (gapErr) {
        Logger.warn(
          'harnessLane',
          `Failed to record telemetryGap for ${eventInput.event}: ${
            gapErr instanceof Error ? gapErr.message : String(gapErr)
          }`,
        );
      }
    }
    return { ok: false, telemetryGap: true };
  }
}
