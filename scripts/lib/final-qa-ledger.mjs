import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_SECTIONS = ['pendingTests', 'skippedOrGatedTests'];

/**
 * Fragment directory for a ledger file: `<dir of ledger>/ledger/`.
 * One fragment per entry, so parallel PRs add a file instead of editing one shared array.
 * A fragment is `{ "section": "skippedOrGatedTests" | "pendingTests", "entry": { ... } }`.
 */
export function fragmentDirFor(ledgerPath) {
  return path.join(path.dirname(ledgerPath), 'ledger');
}

/**
 * Load the base ledger plus every fragment. Anything malformed or duplicated is pushed to
 * `errors` (never silently skipped). Entries listed inline in the base file still count.
 */
export function loadLedger(ledgerPath, errors, rel = value => value) {
  const base = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const merged = {};
  const seen = new Map();
  for (const section of LEDGER_SECTIONS) {
    merged[section] = Array.isArray(base[section]) ? [...base[section]] : [];
    for (const entry of merged[section]) seen.set(`${section}\0${entry?.path}`, rel(ledgerPath));
  }

  const dir = fragmentDirFor(ledgerPath);
  if (!fs.existsSync(dir)) return merged;
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const label = rel(file);
    if (!fs.statSync(file).isFile()) {
      errors.push(`Ledger fragment dir contains a non-file: ${label}`);
      continue;
    }
    if (!name.endsWith('.json')) {
      errors.push(`Ledger fragment is not a .json file: ${label}`);
      continue;
    }
    let fragment;
    try {
      fragment = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`Malformed ledger fragment ${label}: ${error.message}`);
      continue;
    }
    const entry = fragment?.entry;
    if (!LEDGER_SECTIONS.includes(fragment?.section) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`Malformed ledger fragment ${label}: expected {"section": ${LEDGER_SECTIONS.join('|')}, "entry": {...}}`);
      continue;
    }
    const key = `${fragment.section}\0${entry.path}`;
    if (seen.has(key)) {
      errors.push(`Duplicate ledger entry for ${entry.path || '<unknown>'} in ${label} (already defined in ${seen.get(key)})`);
      continue;
    }
    seen.set(key, label);
    merged[fragment.section].push(entry);
  }
  return merged;
}
