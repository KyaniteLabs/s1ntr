#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { StudioLineageLedger } from '../../dist/tui-bridge/StudioLineage.js';

const args = process.argv.slice(2);
const lineageId = args.find((arg) => !arg.startsWith('--'));
const ledgerArg = args.find((arg) => arg.startsWith('--ledger='));

if (!lineageId) {
  console.error('Usage: pnpm wave5:lineage -- <lineage-id> [--ledger=<jsonl-path>]');
  process.exitCode = 2;
} else {
  const ledgerPath = ledgerArg
    ? path.resolve(ledgerArg.slice('--ledger='.length))
    : undefined;
  try {
    const trace = await new StudioLineageLedger({ ledgerPath }).query(lineageId);
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
