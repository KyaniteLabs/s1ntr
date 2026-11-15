#!/usr/bin/env node
/**
 * Mark rotation packs INVALID when gen/chat fixedJudge route is wrong (T1).
 *
 * Usage:
 *   node scripts/rotation/mark-invalid-pack.mjs <runDir> [--reason text]
 *   node scripts/rotation/mark-invalid-pack.mjs --scan .quality/tour/wave-1
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const scanIdx = args.indexOf('--scan');
const reasonIdx = args.indexOf('--reason');
const reason =
  reasonIdx >= 0
    ? args[reasonIdx + 1]
    : 'fixedJudge route not agy-cliproxy (pre-instrument-fix pack)';

/** Pure: decide whether a summary object should be marked INVALID. */
export function shouldMarkInvalid(summary, { forceMissing = false } = {}) {
  const seat = summary?.seat;
  if (seat !== 'generator' && seat !== 'chat') {
    return { mark: false, detail: 'not gen/chat — skip' };
  }
  // Already canonical/scorable live packs without a stamp: do not auto-clobber
  // (pre-T0 Wave1 AGY packs lacked fixedJudge field but were post-#531 honest).
  const fj = summary.fixedJudge;
  const route = String(fj?.route || '').toLowerCase();
  if (!fj || route === 'unset' || route === '') {
    if (!forceMissing) {
      return {
        mark: false,
        detail: 'missing fixedJudge — skip (pass forceMissing/ --force-missing to clobber)',
      };
    }
    return { mark: true, detail: 'missing or unset fixedJudge (forced)' };
  }
  if (route === 'invalid-kilo' || route.includes('kilo')) {
    return { mark: true, detail: `route=${route}` };
  }
  if (route === 'agy-cliproxy' || route.includes('8317') || route.includes('cliproxy')) {
    return { mark: false, detail: 'already agy-cliproxy' };
  }
  if (route === 'invalid-route') {
    return { mark: true, detail: `route=${route}` };
  }
  // Unknown non-empty route that is not agy → mark
  return { mark: true, detail: `route=${route || 'empty'}` };
}

export function applyInvalidMark(summary, invalidReason) {
  const next = { ...summary };
  next.mode = 'INVALID';
  next.instrumentFailure = true;
  next.invalidReason = invalidReason;
  next.fitness = {
    ...(summary.fitness || {}),
    scorable: false,
    secondaryMetricsAllowed: false,
    reason: invalidReason,
  };
  if (next.metrics && typeof next.metrics === 'object') {
    next.metrics = {
      ...next.metrics,
      northStar: null,
      _suppressed: 'INVALID-instrument',
    };
  }
  if (next.northStar && typeof next.northStar === 'object') {
    next.northStar = { ...next.northStar, value: null };
  }
  const findings = Array.isArray(next.findings) ? [...next.findings] : [];
  findings.push(`INVALID: ${invalidReason}`);
  next.findings = findings;
  return next;
}

export function markDir(runDir, invalidReason = reason, opts = {}) {
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) {
    return { runDir, ok: false, detail: 'no summary.json' };
  }
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch (e) {
    return { runDir, ok: false, detail: `summary.json parse error: ${e.message || e}` };
  }
  const decision = shouldMarkInvalid(summary, opts);
  if (!decision.mark) {
    return { runDir, ok: true, detail: decision.detail };
  }

  const marked = applyInvalidMark(summary, invalidReason);
  fs.writeFileSync(summaryPath, `${JSON.stringify(marked, null, 2)}\n`);

  const runPath = path.join(runDir, 'run.json');
  if (fs.existsSync(runPath)) {
    try {
      const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
      run.mode = 'INVALID';
      run.instrumentFailure = true;
      run.invalidReason = invalidReason;
      fs.writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
    } catch {
      /* leave summary marked; run.json best-effort */
    }
  }
  return { runDir, ok: true, detail: 'marked INVALID' };
}

export function scanRoot(root, invalidReason = reason, opts = {}) {
  const results = [];
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return { scan: root, results: [], error: String(e.message || e) };
  }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const d = path.join(root, ent.name);
    if (!fs.existsSync(path.join(d, 'summary.json'))) continue;
    try {
      results.push(markDir(d, invalidReason, opts));
    } catch (e) {
      results.push({ runDir: d, ok: false, detail: `scan error: ${e.message || e}` });
    }
  }
  return { scan: root, results };
}

// CLI entry (skip when imported by tests)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain || process.argv[1]?.endsWith('mark-invalid-pack.mjs')) {
  const forceMissing = args.includes('--force-missing');
  const opts = { forceMissing };
  if (scanIdx >= 0) {
    const root = path.resolve(args[scanIdx + 1] || '.');
    const out = scanRoot(root, reason, opts);
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const target = args.find((a) => !a.startsWith('--') && a !== reason);
  if (!target) {
    console.error('usage: mark-invalid-pack.mjs <runDir> | --scan <dir> [--force-missing]');
    process.exit(2);
  }
  console.log(JSON.stringify(markDir(path.resolve(target), reason, opts), null, 2));
}
