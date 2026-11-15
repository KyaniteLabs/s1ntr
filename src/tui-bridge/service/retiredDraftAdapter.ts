/**
 * Extracted from TuiBridgeService.ts: the test-only retired draft adapter hook.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import type { ClarifyResult, GenerationSuccess } from '../../core/clarify.js';

export type RetiredDraftResult = ClarifyResult | GenerationSuccess;

export interface RetiredDraftGenerator {
  generate(prompt: string, source: string, stream: boolean,
    signal: AbortSignal): Promise<RetiredDraftResult>;
}

export interface RetiredDraftTestAdapter {
  create(domain: string): RetiredDraftGenerator;
  score(code: string, domain: string): number;
}

let retiredDraftTestAdapter: RetiredDraftTestAdapter | undefined;

export function installRetiredDraftTestAdapter(adapter: RetiredDraftTestAdapter): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('RETIRED_DRAFT_TEST_ADAPTER_FORBIDDEN');
  retiredDraftTestAdapter = adapter;
}

export function getRetiredDraftTestAdapter(): RetiredDraftTestAdapter | undefined {
  return retiredDraftTestAdapter;
}
