import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const audioCoreSrc = fileURLToPath(new URL('./packages/audio-core/src', import.meta.url));

const SLOW_TEST_PATTERNS = [
  'test/organs/**/*.test.ts',
  'test/e2e/**/*.test.ts',
  'test/e2e/**/*.test.js',
  'test/e2e/**/*.e2e.test.ts',
  'test/e2e/**/*.e2e.test.js',
  'test/render/**/*.test.ts',
  'test/render/**/*.test.js',
  // CI's fast gate already runs `pnpm lint` as its own step; re-linting inside
  // the fast suite cost ~42s per attempt.
  'test/unit/lint.test.ts',
  'test/integration/dual-llm.test.ts',
  'test/integration/dream-pilot-fake-provider.test.ts',
  'test/integration/e2e-aesthetic-audio.test.ts',
  'test/integration/full-loop.test.js',
  'test/integration/generator-renderer.test.js',
  'test/integration/gui-security-regression.test.js',
  'test/integration/lir-e2e.test.ts',
  'test/integration/preview-server.test.js',
  'test/integration/renderer.test.js',
  'test/integration/run-merge-approve-api.test.js',
] as const;

const isFastCi = process.env.LIMINAL_CI_FAST === '1';
const isSlowCi = process.env.LIMINAL_CI_SLOW === '1';

// Coverage floors for the CI fast suite (`pnpm test:ci:fast:coverage`).
// The fast suite skips SLOW_TEST_PATTERNS, so it covers less than a local full
// run and cannot share the full-run ratchet below. These are the fast-suite
// numbers CI measured (84.74 / 76.77 / 88.92 / 86.52) minus a 0.5-point margin
// for run-to-run noise. They only go
// UP: when a CI run reports higher coverage, raise them; never lower them.
const FAST_CI_COVERAGE_FLOORS = {
  statements: 84.2,
  branches: 76.2,
  functions: 88.4,
  lines: 86.0,
};

const baseExclude = [
  'node_modules/**',
  'dist/**',
  'gui/node_modules/**',
  'artifacts/**',
  // Tests for unimplemented modules — move back when source is built
  '**/test/pending/**',
  // ━━━ Worktree decontamination ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // .claude/worktrees/ — agents' worktrees inside .claude
  '**/.claude/worktrees/**',
  // Root-level worktree (OMC naming convention)
  '**/worktree-polymorphic-growing-quiche/**',
  // Legacy .worktrees (pre-.claude convention)
  '**/.worktrees/**',
  // Coverage worktree (cov70 agent)
  '**/worktrees/cov70/**',
];

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@sinter\/audio-core\/dsp\/(.+)\.js$/, replacement: `${audioCoreSrc}/dsp/$1.ts` },
      { find: /^@sinter\/audio-core\/(.+)\.js$/, replacement: `${audioCoreSrc}/$1.ts` },
      { find: '@sinter/audio-core', replacement: `${audioCoreSrc}/index.ts` },
    ],
  },
  test: {
    globalSetup: ['test/global-setup-dist.ts'],
    // Spawned-CLI tests start node and import dist; the 5 s default fails them on a loaded host.
    // Tests that need less or more set their own cap.
    testTimeout: 30_000,
    setupFiles: ['test/setup.ts'],
    include: isSlowCi ? [...SLOW_TEST_PATTERNS] : ['**/test/**/*.test.(js|ts)', '**/test/**/*.e2e.test.(js|ts)'],
    exclude: isFastCi ? [...baseExclude, ...SLOW_TEST_PATTERNS] : baseExclude,
    coverage: {
      // Coverage is opt-in (--coverage flag / test:coverage script) so that
      // focused test runs don't fail from repo-wide thresholds applied to a
      // single file. Canonical enforcement: npm run test:coverage.
      enabled: false,
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/*.d.ts', '**/*.test.ts'],
      reportsDirectory: './coverage',
      // The per-file table is ~900 rows; CI only needs the totals.
      reporter: isFastCi ? ['text-summary'] : ['text', 'json', 'json-summary'],
      thresholds: {
        // ━━━ Global coverage ratchet ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // TARGET: 70% across all metrics (user-requested)
        //
        // Current → Target (as of 2026-06-11 fast suite):
        //   Statements: 82.3% → 70% (+12.3pp above target)
        //   Branches:   72.6% → 70% (+2.6pp above target)
        //   Functions:  85.3% → 70% (+15.3pp above target)
        //   Lines:      83.4% → 70% (+13.4pp above target)
        //
        // Ratchet is set to the current measured values (floor).
        // Coverage can only go UP, never DOWN, on local full-coverage runs.
        // The four numbers below are the full-run ratchet. The Forgejo fast
        // gate measures the fast suite and is held to FAST_CI_COVERAGE_FLOORS
        // (spread in at the end of this object) instead.
        // autoUpdate will raise these as coverage improves toward 70%.
        //
        // autoUpdate rounds DOWN to 0.1% to prevent false failures
        // from 0.01% run-to-run fluctuations.
        //
        // Per-file enforcement: scripts/ci/check-coverage-gaps.ts
        // Quality enforcement: scripts/testing/test-quality-check.mjs
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        statements: 85,
        branches: 76.3,
        functions: 88.7,
        lines: 86.7,
        // CI must never rewrite this config, so the ratchet only engages
        // on local full-coverage runs. Round DOWN to 0.1% so 0.01%
        // run-to-run fluctuations don't cause false failures.
        autoUpdate: isFastCi || isSlowCi
          ? undefined
          : (newThreshold: number) => Math.floor(newThreshold * 10) / 10,
        // Keep this spread last, and the four literals above as literals:
        // autoUpdate rewrites those literals in place.
        ...(isFastCi ? FAST_CI_COVERAGE_FLOORS : {}),
      },
    },
  },
});
