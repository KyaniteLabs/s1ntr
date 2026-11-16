#!/usr/bin/env node
/**
 * Test Quality Checker for Liminal
 *
 * Standalone script that enforces test quality patterns without ESLint plugin
 * registration hassles. Run as:
 *   - `node scripts/testing/test-quality-check.mjs`
 *   - `node scripts/testing/test-quality-check.mjs --strict`
 *   - `node scripts/testing/test-quality-check.mjs --baseline scripts/testing/test-quality-baseline.txt`
 *   - `node scripts/testing/test-quality-check.mjs --write-baseline scripts/testing/test-quality-baseline.txt`
 *   - `node scripts/testing/test-quality-check.mjs --prune-baseline scripts/testing/test-quality-baseline.txt`
 *     (drops baseline lines whose weak assertion is gone; never adds one)
 *   - CI step (parallel to eslint)
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = violations found (warnings treated as errors in CI)
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { cwd } from 'node:process';

const ROOT = cwd();
const args = process.argv.slice(2);

function getArgValue(flag) {
  const equalsArg = args.find(arg => arg.startsWith(`${flag}=`));
  if (equalsArg) return equalsArg.slice(flag.length + 1);

  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];

  return undefined;
}

const strictMode = process.env.STRICT_QUALITY === '1' || args.includes('--strict');
const baselineArg = getArgValue('--baseline') ?? process.env.TEST_QUALITY_BASELINE;
const writeBaselineArg = getArgValue('--write-baseline');
const pruneBaselineArg = getArgValue('--prune-baseline');
const baselinePath = baselineArg ? resolve(ROOT, baselineArg) : undefined;
const pruneBaselinePath = pruneBaselineArg ? resolve(ROOT, pruneBaselineArg) : undefined;
const writeBaselinePath = writeBaselineArg ? resolve(ROOT, writeBaselineArg) : undefined;

// ── Configuration ────────────────────────────────────────────────────────
const CONFIG = {
  // Directories to scan for test files
  testDirs: ['test/'],

  // Maximum number of violations before hard failure
  maxErrors: Infinity,
  maxWarnings: Infinity,

  // Treat warnings as errors only in strict mode (STRICT_QUALITY=1 or --strict).
  // Pre-existing warnings are tracked as tech debt; they don't block CI
  // until STRICT_QUALITY enforcement is turned on deliberately.
  warningAsError: strictMode,

  // toBeDefined cap: warning now, error in strict mode.
  toBeDefinedStrict: strictMode,
};

// ── Violation tracking ────────────────────────────────────────────────────
const violations = {
  errors: [],
  warnings: [],
};

function addViolation(severity, rule, file, line, message) {
  violations[severity === 'error' ? 'errors' : 'warnings'].push({
    rule,
    file,
    line,
    message,
  });
}

function fingerprintViolation(violation) {
  const loc = violation.line ? `:${violation.line}` : '';
  return `${violation.rule}\t${violation.file}${loc}\t${violation.message}`;
}

function stableFingerprintViolation(violation) {
  return `${violation.rule}\t${violation.file}\t${violation.message}`;
}

function loadBaseline() {
  if (!baselinePath) return new Map();

  if (!existsSync(baselinePath)) {
    console.error(`Missing test-quality baseline: ${baselinePath}`);
    process.exit(1);
  }

  const lines = readFileSync(baselinePath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  const counts = new Map();
  for (const line of lines) {
    const [rule, location, ...message] = line.split('\t');
    const file = location.replace(/:\d+$/, '');
    const fingerprint = `${rule}\t${file}\t${message.join('\t')}`;
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function parseBaselineLine(line) {
  const [rule, location, ...message] = line.trim().split('\t');
  const lineNumber = Number(location.match(/:(\d+)$/)?.[1] ?? 0);
  const file = location.replace(/:\d+$/, '');
  return { fingerprint: `${rule}\t${file}\t${message.join('\t')}`, exact: `${rule}\t${file}:${lineNumber}\t${message.join('\t')}` };
}

// Rewrites the baseline keeping, per fingerprint, only as many lines as there are
// current warnings. Lines whose recorded line number still matches are kept first,
// so an unrelated prune does not churn the file. Comments and order are preserved.
function pruneBaseline(path) {
  if (!existsSync(path)) {
    console.error(`Missing test-quality baseline: ${path}`);
    process.exit(1);
  }

  const current = new Map();
  const currentExact = new Set();
  for (const warning of violations.warnings) {
    const fingerprint = stableFingerprintViolation(warning);
    current.set(fingerprint, (current.get(fingerprint) ?? 0) + 1);
    currentExact.add(`${warning.rule}\t${warning.file}:${warning.line ?? 0}\t${warning.message}`);
  }

  const rawLines = readFileSync(path, 'utf8').split('\n');
  const isEntry = line => line.trim().length > 0 && !line.trim().startsWith('#');

  const keep = new Set();
  const budget = new Map(current);
  const take = (index, fingerprint) => {
    keep.add(index);
    budget.set(fingerprint, budget.get(fingerprint) - 1);
  };
  for (const exactPass of [true, false]) {
    rawLines.forEach((line, index) => {
      if (!isEntry(line) || keep.has(index)) return;
      const { fingerprint, exact } = parseBaselineLine(line);
      if ((budget.get(fingerprint) ?? 0) <= 0) return;
      if (!exactPass || currentExact.has(exact)) take(index, fingerprint);
    });
  }

  const kept = rawLines.filter((line, index) => !isEntry(line) || keep.has(index));
  writeFileSync(path, kept.join('\n'));
  return rawLines.length - kept.length;
}

// ── Rule: require-vi-hoisted ──────────────────────────────────────────────
// Detects mock variables used in vi.mock() factories that aren't vi.hoisted()
function checkViHoisted(content, filePath) {
  const lines = content.split('\n');

  // Find all const declarations at module level
  const declarations = new Map(); // name -> { line, isHoisted }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: const { mockX, mockY } = vi.hoisted(() => ...  (destructuring form)
    const hoistedMatch = line.match(/const\s*\{([^}]+)\}\s*=\s*vi\.hoisted/);
    if (hoistedMatch) {
      const names = hoistedMatch[1].split(',').map(n => n.trim().split(':')[0].trim()).filter(Boolean);
      for (const name of names) {
        declarations.set(name, { line: i + 1, hoisted: true });
      }
      continue;
    }

    // Match: const mockX = vi.hoisted(...)  (direct assignment form)
    const hoistedDirectMatch = line.match(/^const\s+(\w+)\s*=\s*vi\.hoisted/);
    if (hoistedDirectMatch) {
      declarations.set(hoistedDirectMatch[1], { line: i + 1, hoisted: true });
      continue;
    }

    // Match: const mockX = vi.fn()
    const constMatch = line.match(/^const\s+(\w+)\s*=\s*/);
    if (constMatch) {
      const name = constMatch[1];
      if (name.startsWith('mock') || name.startsWith('Mock') || name.includes('Mock')) {
        declarations.set(name, { line: i + 1, hoisted: false });
      }
    }
  }

  // Find vi.mock() calls and extract identifiers used in their factories
  const mockBlocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('vi.mock(')) {
      // Find the factory function - scan ahead for the arrow function or function expression
      let depth = 0;
      let factoryStart = -1;
      let blockFound = false;
      for (let j = i; j < lines.length && j < i + 50; j++) {
        const l = lines[j];
        if (l.includes('()') && (l.includes('=>') || l.includes('{'))) {
          factoryStart = j;
        }
        depth += (l.match(/\(/g) || []).length - (l.match(/\)/g) || []).length;
        if (depth <= 0 && factoryStart >= 0 && j > i + 1) {
          // We have the complete vi.mock() block
          const block = lines.slice(i, j + 1).join('\n');
          mockBlocks.push(block);
          blockFound = true;
          break;
        }
      }
      // Only fall back to 30-line window if we couldn't find the closing paren
      if (!blockFound && factoryStart >= 0) {
        mockBlocks.push(lines.slice(i, i + 30).join('\n'));
      }
    }
  }

  // Check each mock block for references to non-hoisted variables
  for (const block of mockBlocks) {
    for (const [name, info] of declarations) {
      if (!info.hoisted) {
        // Check if this variable name appears inside the mock block
        const regex = new RegExp(`\\b${name}\\b`, 'g');
        if (regex.test(block)) {
          addViolation(
            'error',
            'require-vi-hoisted',
            filePath,
            info.line,
            `\`${name}\` is used inside vi.mock() but not created with vi.hoisted(). ` +
            `This causes ReferenceError: Cannot access '${name}' before initialization. ` +
            `Wrap in: const { ${name} } = vi.hoisted(() => ({ ${name}: vi.fn() }))`,
          );
        }
      }
    }
  }
}

// ── Rule: no-weak-test-assertions ──────────────────────────────────────────
// Detects weak assertion patterns that indicate PADDING/WEAK quality
function checkWeakAssertions(content, filePath) {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // toBeDefined() — proves existence only
    if (line.includes('.toBeDefined()')) {
      addViolation(
        'warning',
        'no-weak-test-assertions',
        filePath,
        i + 1,
        'toBeDefined() only proves the value is not undefined, not that it is correct. ' +
        'Use toBe(expectedValue) or toEqual(expectedShape) instead.',
      );
    }

    // toBeTruthy() — passes for any truthy value
    if (/\.toBeTruthy\s*\(\s*\)/.test(line)) {
      addViolation(
        'warning',
        'no-weak-test-assertions',
        filePath,
        i + 1,
        'toBeTruthy() passes for any truthy value (1, "abc", {}, []). ' +
        'Use toBe(true), toBe(expectedValue), or toEqual(expectedShape) instead.',
      );
    }

    // toBeFalsy() — passes for any falsy value
    if (/\.toBeFalsy\s*\(\s*\)/.test(line)) {
      addViolation(
        'warning',
        'no-weak-test-assertions',
        filePath,
        i + 1,
        'toBeFalsy() passes for any falsy value (false, 0, "", null, undefined). ' +
        'Use toBe(false), toBeNull(), toBeUndefined(), or a concrete expected value instead.',
      );
    }

    // typeof x === 'boolean' without checking the expected value
    if (line.includes("typeof") && line.includes("'boolean'") && line.includes("expect")) {
      addViolation(
        'warning',
        'no-weak-test-assertions',
        filePath,
        i + 1,
        'typeof x === "boolean" only checks the type, not the expected value. ' +
        'Use expect(x).toBe(true) or expect(x).toBe(false) instead.',
      );
    }

    // toContain with single character
    const singleCharMatch = line.match(/\.toContain\s*\(\s*['"]([^'"]{1})['"]\s*\)/);
    if (singleCharMatch) {
      addViolation(
        'warning',
        'no-weak-test-assertions',
        filePath,
        i + 1,
        `toContain('${singleCharMatch[1]}') with single char matches almost anything. ` +
        'Use a longer, more specific substring or toMatch(/pattern/) instead.',
      );
    }

    // not.toBeNull()/not.toBeUndefined() — proves non-empty existence only
    const notNullishMatch = line.match(/\.not\.toBe(Null|Undefined)\s*\(\s*\)/);
    if (notNullishMatch) {
      const matcher = `not.toBe${notNullishMatch[1]}`;
      addViolation(
        'warning',
        'no-weak-test-assertions',
        filePath,
        i + 1,
        `${matcher}() only proves the value exists, not that it is correct. ` +
        'Use toEqual(expectedShape), toMatchObject(expectedShape), or an exact expected value instead.',
      );
    }

    // expect.anything() — accepts any non-nullish value
    if (/\.(?:toEqual|toStrictEqual)\s*\(\s*expect\.anything\s*\(\s*\)\s*\)/.test(line)) {
      addViolation(
        'warning',
        'no-weak-test-assertions',
        filePath,
        i + 1,
        'expect.anything() accepts any non-nullish value. ' +
        'Assert a concrete value, shape, or domain-specific invariant instead.',
      );
    }

    // toHaveBeenCalled()/toBeCalled() — proves the mock ran, not how often or with what.
    // The negated form asserts exactly zero calls, so it stays allowed.
    const bareCalledMatch = line.match(/\.(toHaveBeenCalled|toBeCalled)\s*\(\s*\)/);
    if (bareCalledMatch) {
      const before = line.slice(0, bareCalledMatch.index).trimEnd();
      const previousLine = before.length === 0 ? previousCodeLine(lines, i) : before;
      if (!previousLine.endsWith('.not')) {
        addViolation(
          'warning',
          'no-weak-test-assertions',
          filePath,
          i + 1,
          `${bareCalledMatch[1]}() only proves the mock ran at least once, not how often or with what. ` +
          'Use toHaveBeenCalledWith(expectedArgs), toHaveBeenCalledTimes(n), or assert the outcome the call produces instead.',
        );
      }
    }
  }
}

function previousCodeLine(lines, index) {
  for (let i = index - 1; i >= 0; i--) {
    const candidate = lines[i].trim();
    if (candidate.length > 0) return candidate;
  }
  return '';
}

// ── Rule: no-padding-tests ────────────────────────────────────────────────
// Detects PADDING pattern: test files with only constructor + generateReport tests
function checkPaddingTests(content, filePath) {
  const testNames = [];
  const describeMatch = content.match(/it\(['"]([^'"]+)['"]/g);
  if (describeMatch) {
    for (const m of describeMatch) {
      const name = m.match(/it\(['"]([^'"]+)['"]/)?.[1];
      if (name) testNames.push(name.toLowerCase());
    }
  }

  // PADDING pattern: only has constructor and report tests
  const hasOnlyPadding =
    testNames.length > 0 &&
    testNames.length <= 3 &&
    testNames.every(n =>
      n.includes('constructor') ||
      n.includes('create') ||
      n.includes('factory') ||
      n.includes('instance') ||
      n.includes('generatereport') ||
      n.includes('get session') ||
      n.includes('session') && n.includes('return')
    );

  if (hasOnlyPadding) {
    addViolation(
      'error',
      'no-padding-tests',
      filePath,
      0,
      'Test file appears to be PADDING quality (only constructor/factory/report tests). ' +
      'Add behavioral tests: test actual outcomes, not just object creation.',
    );
  }
}

// ── Rule: toBe-defined-cap ────────────────────────────────────────────────
// Enforces that toBeDefined() is at most 5% of total assertions per file
// Target: 75% coverage requires high-quality assertions, not existence checks
function checkToBeDefinedCap(content, filePath) {
  const MAX_DEFINED_RATIO = 0.05; // 5% cap

  // Count all expect() assertions
  const assertionMatches = content.match(/expect\s*\(/g) || [];
  const totalAssertions = assertionMatches.length;

  if (totalAssertions < 10) return; // Skip small files

  // Count toBeDefined assertions
  const definedMatches = content.match(/\.toBeDefined\s*\(\)/g) || [];
  const definedCount = definedMatches.length;

  const ratio = definedCount / totalAssertions;
  if (ratio > MAX_DEFINED_RATIO) {
    const severity = CONFIG.toBeDefinedStrict ? 'error' : 'warning';
    addViolation(
      severity,
      'tobe-defined-cap',
      filePath,
      0,
      `toBeDefined() is ${(ratio * 100).toFixed(1)}% of assertions (${definedCount}/${totalAssertions}), ` +
      `exceeding the 5% cap. Replace with toBe(expectedValue) or toEqual(expectedShape). ` +
      `(Coverage target: 75% — existence-only assertions don't count toward it.)`,
    );
  }
}

// ── Rule: test-hermeticity ──────────────────────────────────────────────
// Block machine- and process-global coupling that makes otherwise valid tests
// order-dependent or owner-workstation-dependent. Per-key env mutation remains
// allowed when the test restores that key in afterEach/finally.
function checkTestHermeticity(content, filePath) {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/\bprocess\.env\s*=/.test(line)) {
      addViolation(
        'error',
        'test-hermeticity',
        filePath,
        i + 1,
        'Do not replace process.env. Mutate only the required keys and restore each key after the test.',
      );
    }

    const ownerPath = line.match(/\/(Users|home)\/([A-Za-z0-9._-]+)\/(?:workspaces|\.sinter)(?:\/|['"`])/);
    if (ownerPath && !['user', 'test', 'testuser', 'tmp'].includes(ownerPath[2])) {
      addViolation(
        'error',
        'test-hermeticity',
        filePath,
        i + 1,
        `Owner-specific workspace path '/${ownerPath[1]}/${ownerPath[2]}' is not hermetic. Use a generic fixture path or temporary directory.`,
      );
    }
  }
}

// ── Main execution ──────────────────────────────────────────────────────
function findTestFiles() {
  const exts = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
  const results = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some(ext => entry.name.endsWith(ext))) results.push(full);
    }
  }

  walk('test');
  return results.sort();
}

function checkFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');

  checkViHoisted(content, filePath);
  checkWeakAssertions(content, filePath);
  checkPaddingTests(content, filePath);
  checkToBeDefinedCap(content, filePath);
  checkTestHermeticity(content, filePath);
}

// Run
const testFiles = findTestFiles();
console.log(`\n🔍 Test Quality Check: scanning ${testFiles.length} test files...\n`);

for (const file of testFiles) {
  checkFile(file);
}

if (writeBaselinePath) {
  const baseline = [
    '# Test quality warning baseline.',
    '# Each line is: rule<TAB>file[:line]<TAB>message',
    '# Re-generate only after deliberately accepting new warning debt. After fixing a weak',
    '# assertion run `pnpm test:quality:prune`: it drops the spare line and never adds one.',
    ...violations.warnings.map(fingerprintViolation).sort(),
    '',
  ].join('\n');
  writeFileSync(writeBaselinePath, baseline);
  console.log(`\n🧾 Wrote test-quality warning baseline: ${writeBaselinePath}`);
}

if (pruneBaselinePath) {
  const removed = pruneBaseline(pruneBaselinePath);
  console.log(`\n🧹 Pruned ${removed} stale baseline ${removed === 1 ? 'entry' : 'entries'}: ${pruneBaselinePath}`);
}

const baseline = loadBaseline();
const activeWarnings = [];
const knownWarnings = [];

for (const warning of violations.warnings) {
  const fingerprint = stableFingerprintViolation(warning);
  const remaining = baseline.get(fingerprint) ?? 0;
  if (remaining > 0) {
    knownWarnings.push(warning);
    baseline.set(fingerprint, remaining - 1);
  } else activeWarnings.push(warning);
}

// A baseline line whose weak assertion is gone is a free pass for the next one
// written in that file. Count them so strict mode can refuse to carry them.
const staleBaseline = [...baseline.entries()].filter(([, remaining]) => remaining > 0);
const totalStale = staleBaseline.reduce((sum, [, remaining]) => sum + remaining, 0);

// Report
const totalErrors = violations.errors.length;
const totalWarnings = activeWarnings.length;

if (totalErrors > 0) {
  console.log(`\n❌ Errors: ${totalErrors}`);
  for (const v of violations.errors) {
    const loc = v.line ? `:${v.line}` : '';
    console.log(`  ${v.file}${loc}  [${v.rule}]  ${v.message}`);
  }
}

if (totalWarnings > 0) {
  console.log(`\n⚠️  Warnings: ${totalWarnings}`);
  for (const v of activeWarnings) {
    const loc = v.line ? `:${v.line}` : '';
    console.log(`  ${v.file}${loc}  [${v.rule}]  ${v.message}`);
  }
}

if (knownWarnings.length > 0) {
  console.log(`\n🧾 Known baseline warnings: ${knownWarnings.length}`);
}

if (totalStale > 0) {
  console.log(`\n🧹 Stale baseline entries: ${totalStale}`);
  for (const [fingerprint, remaining] of staleBaseline) {
    const [rule, file] = fingerprint.split('\t');
    console.log(`  ${file}  [${rule}]  ${remaining} baselined weak assertion(s) no longer exist`);
  }
  console.log('  Lock the improvement in: pnpm test:quality:prune');
}

const staleFails = totalStale > 0 && strictMode;

if (totalErrors === 0 && totalWarnings === 0 && !staleFails) {
  console.log('\n✅ All test quality checks passed!\n');
} else {
  console.log(`\n📊 Summary: ${totalErrors} errors, ${totalWarnings} new warnings, ${totalStale} stale baseline entries\n`);
}

// Exit code
if (totalErrors > 0) {
  process.exit(1);
}
if (totalWarnings > 0 && CONFIG.warningAsError) {
  console.log('(Warnings treated as errors in CI)\n');
  process.exit(1);
}
if (staleFails) {
  console.log('(Stale baseline entries fail strict mode: a spare line would let a new weak assertion through)\n');
  process.exit(1);
}

process.exit(0);
