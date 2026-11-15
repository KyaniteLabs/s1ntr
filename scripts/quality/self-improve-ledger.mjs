import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEDGER_PATH_ENV = 'SINTER_PROGRESS_LEDGER_PATH';
export const LEGACY_LEDGER_RELATIVE = 'docs/validation/self-improve-ledger.jsonl';

export function resolveLedgerWritePath(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const configured = env[LEDGER_PATH_ENV]?.trim();
  return configured
    ? path.resolve(cwd, configured)
    : path.join(home, '.sinter', 'quality', 'self-improve-ledger.jsonl');
}

export function resolveLedgerReadPath(options = {}) {
  const env = options.env ?? process.env;
  const runtimePath = resolveLedgerWritePath(options);
  const exists = options.exists ?? fs.existsSync;
  if (env[LEDGER_PATH_ENV]?.trim()) {
    return runtimePath;
  }
  if (exists(runtimePath)) return runtimePath;
  return path.join(options.cwd ?? process.cwd(), LEGACY_LEDGER_RELATIVE);
}

export function appendLedgerRecord(record, options = {}) {
  const ledgerPath = resolveLedgerWritePath(options);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
  return ledgerPath;
}

export function exportLedgerSnapshot(options = {}) {
  const sourcePath = options.sourcePath ?? resolveLedgerReadPath(options);
  const now = options.now ?? new Date();
  const destinationDir = options.destinationDir
    ?? path.join(options.cwd ?? process.cwd(), 'docs', 'validation', 'self-improve-snapshots');
  const records = fs.readFileSync(sourcePath, 'utf8').split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  fs.mkdirSync(destinationDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const destinationPath = path.join(destinationDir, `self-improve-${stamp}.jsonl`);
  fs.writeFileSync(destinationPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { sourcePath, destinationPath, records: records.length };
}
