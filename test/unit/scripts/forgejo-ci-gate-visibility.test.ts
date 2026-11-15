import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Step = { name: string; if?: string; run: string; 'timeout-minutes'?: number };
// No YAML parser is a dependency, so read the workflow text step by step.
const text = readFileSync('.forgejo/workflows/ci.yml', 'utf8');
const jobText = text.slice(text.indexOf('\n  fast-gate:'));
const job = {
  name: /^    name: (.+)$/m.exec(jobText)?.[1],
  'timeout-minutes': Number(/^    timeout-minutes: (\d+)$/m.exec(jobText)?.[1]),
  steps: jobText
    .split('\n      - name: ')
    .slice(1)
    .map((chunk): Step => {
      const name = chunk.split('\n')[0];
      const num = /^        timeout-minutes: (\d+)$/m.exec(chunk)?.[1];
      const cond = /^        if: (.+)$/m.exec(chunk)?.[1];
      const run = chunk.split(/^        run: \|\n/m)[1] ?? '';
      const dedented = run
        .split('\n')
        .map((l) => l.replace(/^ {10}/, ''))
        .join('\n');
      return { name, if: cond, run: dedented, 'timeout-minutes': num ? Number(num) : undefined };
    }),
};
const evidence = job.steps.find((s) => s.name === 'Post failure evidence on PR') as Step;
const PRE_TEST = ['Checkout', 'Enable pnpm', 'Install dependencies', 'Build workspace packages', 'Build project'];

function runEvidence(opts: { cancelled: boolean; step?: string; testLog?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-evidence-'));
  if (opts.cancelled) writeFileSync(join(dir, 'cancelled'), 'x');
  if (opts.step) writeFileSync(join(dir, 'current-step'), opts.step + '\n');
  if (opts.testLog) writeFileSync(join(dir, '.ci-step-test-fast.log'), opts.testLog);
  // curl stub (a shell function, so a noexec tmpdir cannot bypass it): records the
  // -d payload and URL, answers 201.
  const curlStub =
    'curl() { while [ $# -gt 0 ]; do case "$1" in -d) echo "$2" >> "$CAPTURE";; -w) printf 201;; -o) : > "$2";; http*) echo "URL $1" >> "$CAPTURE";; esac; shift; done; }\n';
  const script = curlStub + (evidence.run as string).replaceAll('/tmp/ci-current-step', join(dir, 'current-step')).replaceAll('/tmp/ci-cancelled', join(dir, 'cancelled'));
  const res = spawnSync('bash', ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CAPTURE: join(dir, 'capture'),
      JOB_TOKEN: 't',
      SERVER_URL: 'https://forge.example',
      REPOSITORY: 'o/r',
      PR_NUMBER: '7',
      SHA: 'abc123',
      RUN_NUMBER: '99',
    },
  });
  if (!existsSync(join(dir, 'capture'))) throw new Error(res.stdout + res.stderr);
  const capture = readFileSync(join(dir, 'capture'), 'utf8').split('\n');
  const statusLine = capture.find((l) => l.includes('"liminal/ci-evidence"')) as string;
  return { res, status: JSON.parse(statusLine) as Record<string, string>, capture };
}

describe('forgejo fast-gate visibility', () => {
  it('keeps the required job name and the 40-minute job cap', () => {
    expect(job.name).toBe('fast-gate');
    expect(job['timeout-minutes']).toBe(40);
  });

  it('puts a step timeout and a step marker on every pre-test step', () => {
    for (const name of PRE_TEST) {
      const s = job.steps.find((x) => x.name === name) as Step;
      expect(s['timeout-minutes']).toBeGreaterThanOrEqual(2);
      expect(s['timeout-minutes']).toBeLessThanOrEqual(10);
      expect(s.run).toContain(`> /tmp/ci-current-step; echo "[$(date -u +%H:%M:%S)] ===== STEP: ${name}`);
    }
  });

  it('runs the evidence step on failure and on cancellation, never on success', () => {
    expect(evidence.if).toBe('failure() || cancelled()');
  });

  it('reports a cancelled run as failure naming the stalled step', () => {
    const { status } = runEvidence({ cancelled: true, step: 'Install dependencies' });
    expect(status.state).toBe('failure');
    expect(status.description).toBe(
      'CANCELLED/timed out during step: Install dependencies see https://forge.example/o/r/actions/runs/99',
    );
    expect(status.target_url).toBe('https://forge.example/o/r/actions/runs/99');
  });

  it('lists every failing file in the log and caps the description', () => {
    const files = Array.from({ length: 40 }, (_, i) => `test/unit/some/deeply/nested/path/case-${i}.test.ts`);
    const testLog = [
      'FAIL test/unit/early.test.ts > old failure fixed by the retry',
      '=== Rerunning failed files once: test/unit/early.test.ts ===',
      ...files.map((f) => `\u001b[31m FAIL \u001b[39m ${f} > case`),
    ].join('\n');
    const { res, status, capture } = runEvidence({ cancelled: false, step: 'Fast test suite', testLog });
    expect(status.state).toBe('failure');
    expect(status.description.length).toBeLessThanOrEqual(250);
    expect(status.description.startsWith('FAILED at step: Fast test suite; 40 failed: test/unit/some/deeply/nested/path/case-0.test.ts')).toBe(true);
    expect(status.description.endsWith('see https://forge.example/o/r/actions/runs/99')).toBe(true);
    expect(res.stdout).toContain('Failing test files (40):');
    for (const f of files) expect(res.stdout).toContain(f);
    expect(res.stdout).not.toContain('early.test.ts');
    // The full list reaches the PR comment too.
    const comment = capture.find((l) => l.includes('### Failing test files')) as string;
    expect(comment).toContain('case-39.test.ts');
  });

  it('falls back to an unknown step when no marker was written', () => {
    const { status } = runEvidence({ cancelled: false });
    expect(status.description).toBe(
      'FAILED at step: unknown (before the first step marker) see https://forge.example/o/r/actions/runs/99',
    );
  });
});
