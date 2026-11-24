import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveEventLedgerBaseDir } from '../../../src/telemetry/EventLedger.js';

describe('unit-test telemetry isolation', () => {
  it('never resolves the event ledger under the real home', () => {
    const dir = resolveEventLedgerBaseDir();
    expect(dir.startsWith(`${homedir()}/.sinter`)).toBe(false);
    expect(dir).toBe(process.env.SINTER_EVENT_LEDGER_PATH);
  });
});
