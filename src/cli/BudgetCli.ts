/* eslint-disable no-console -- CLI command output: console output is intentional */
import { budgetStatus } from '../llm/ProviderBudgetLedger.js';

/** `sinter budget status` — per-endpoint USD caps, spend, and closure state. */
export function runBudgetCommand(cmdArgs: string[]): void {
  if (cmdArgs[0] && cmdArgs[0] !== 'status') {
    console.error('usage: sinter budget [status]');
    process.exitCode = 2;
    return;
  }
  const rows = budgetStatus();
  if (rows.length === 0) {
    console.log('[budget] no metered endpoints (add entries to ~/.sinter/provider-budgets.json)');
    return;
  }
  for (const r of rows) {
    const state = r.closed ? 'CLOSED' : 'open';
    console.log(
      `[budget] ${r.host}  $${r.spendUsd.toFixed(4)}/$${r.capUsd.toFixed(2)}  ${state}` +
        `  remaining $${r.remainingUsd.toFixed(2)}` +
        (r.allowedModels?.length ? `  earmarked: ${r.allowedModels.join(', ')}` : '') +
        // Only endpoints that report a cost per response are counted; the cap
        // still refuses once you mark spend reached by hand.
        (r.costReported ? '' : '  spend not tracked') +
        (r.note ? `  (${r.note})` : ''),
    );
  }
}
