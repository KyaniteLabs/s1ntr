/**
 * Sol audit F02/F03/F16: a safety flag the global parser consumes must still reach the leaf command that
 * owns it. `--dry-run` used to be eaten by bin/sinter's global parser, so `ledger run X --dry-run` executed
 * the task and `rotation --live --dry-run` handed the battery a live plan. These run the real binary.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 }); // each case spawns the real CLI

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let home: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'sinter-dry-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function sinter(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/sinter'), ...args], {
    cwd: home, env: { ...process.env, HOME: home, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function loadTask(id: string) {
  const file = path.join(home, 'tasks.json');
  writeFileSync(file, JSON.stringify([{
    id, title: `Task ${id}`, description: 'dry-run probe', taskClass: 'leaf',
    files: { allowlist: ['src/**'], denylist: [] }, verifyCommand: 'true',
    scoringCriteria: ['technical'], lane: 1, maxAttempts: 2,
  }]));
  const r = sinter(['ledger', 'load', file]);
  expect(r.status, r.out).toBe(0);
}

describe('ledger --dry-run reaches the ledger leaf', () => {
  it('ledger run <id> --dry-run prints the plan and never runs the task', () => {
    loadTask('DRY-1');
    const r = sinter(['ledger', 'run', 'DRY-1', '--dry-run']);
    expect(r.out).toContain('Dry run for task DRY-1');
    expect(r.out).not.toContain('Running task');
    expect(r.status, r.out).toBe(0);
    const shown = sinter(['ledger', 'show', 'DRY-1']);
    expect(shown.out).toMatch(/Attempts?:\s+0\b/);
  });

  it('flag order does not matter', () => {
    loadTask('DRY-2');
    const r = sinter(['--dry-run', 'ledger', 'run', 'DRY-2']);
    expect(r.out).toContain('Dry run for task DRY-2');
    expect(r.out).not.toContain('Running task');
  });

  it('ledger batch --dry-run lists and does not process', () => {
    loadTask('DRY-3');
    const r = sinter(['ledger', 'batch', '--max-tasks', '1', '--dry-run']);
    expect(r.out).toContain('[DRY RUN]');
    expect(r.out).toContain('DRY-3');
    expect(r.out).not.toMatch(/Conveyor (Dashboard|Report)/i);
    expect(r.status, r.out).toBe(0);
  });

  it('ledger list --lane filters (lane flag crosses the global parser)', () => {
    loadTask('DRY-4');
    const none = sinter(['ledger', 'list', '--lane', '2']);
    expect(none.out).not.toContain('DRY-4');
    const some = sinter(['ledger', 'list', '--lane', '1']);
    expect(some.out).toContain('DRY-4');
  });

  it('ledger status --verbose is honored', () => {
    loadTask('DRY-5');
    const plain = sinter(['ledger', 'status']);
    const verbose = sinter(['ledger', 'status', '--verbose']);
    expect(verbose.out.length).toBeGreaterThan(plain.out.length);
  });
});

describe('rotation --dry-run is the no-spend mode', () => {
  it('--live --dry-run runs the mock battery, never a live plan', () => {
    const r = sinter(['rotation', 'generator', '--live', '--dry-run', '--max-tasks', '1']);
    expect(r.out).toContain('dryRun=true');
    expect(r.out).toContain('live=false');
    expect(r.out).not.toMatch(/mode=live/);
  });

  it('flag before the command still counts', () => {
    const r = sinter(['--dry-run', 'rotation', 'generator', '--max-tasks', '1']);
    expect(r.out).toContain('dryRun=true');
  });

  it('rotation report accepts its own --a/--b flags (they used to die as Unknown option)', () => {
    const r = sinter(['rotation', 'report', 'generator', '--a', path.join(home, 'nope-a'), '--b', path.join(home, 'nope-b')]);
    expect(r.out).not.toContain('Unknown option');
  });
});

describe('leaf-only flags cross the global parser', () => {
  it('taxonomy --no-write writes nothing; gbg --index and phases --window are not rejected', () => {
    mkdirSync(path.join(home, '.sinter'), { recursive: true });
    const t = sinter(['taxonomy', '--no-write', '--json']);
    expect(t.out).not.toContain('Unknown option');
    expect(t.out).not.toContain('[taxonomy] wrote');
    for (const argv of [['gbg', '--index'], ['phases', '--window', '4'], ['phases', '--domain', 'p5']]) {
      const r = sinter(argv);
      expect(r.out, argv.join(' ')).not.toContain('Unknown option');
    }
  });

  it('phases --domain reaches the leaf filter', () => {
    const r = sinter(['phases', '--domain', 'p5']);
    // either no substrate yet, or the filtered banner; never an unfiltered one
    if (!r.out.includes('no trend substrate')) expect(r.out).toContain('domain=p5');
  });

  it('mece manifest --check is forwarded to the script', () => {
    const r = sinter(['mece', 'manifest', '--check']);
    expect(r.out).not.toContain('Unknown option');
  });
});

describe('advertised actions are wired to the real path (never stubbed)', () => {
  it('archive branch records a lineage entry that archive lineage then shows', () => {
    const b = sinter(['archive', 'branch', 'parent-artifact-1']);
    expect(b.status).toBe(0);
    const id = /-> (\S+) \(recorded/.exec(b.out)?.[1];
    expect(id).toMatch(/^\S+$/);
    const l = sinter(['archive', 'lineage', id as string]);
    expect(l.status).toBe(0);
    expect(l.out).toContain('[branch]');
    expect(l.out).toContain('parent-artifact-1');
  });

  it.each([{ args: [] }, { args: ['unsupported-subcommand'] }])('directs retired chat invocations to Studio ($args)', ({ args }) => {
    const c = sinter(['chat', ...args]);
    expect(c.status).toBe(2);
    expect(c.out).toContain('sinter studio');
  });
});

describe('leaf flags reach their leaf', () => {
  it('image validate --studio and compost branch --description are not rejected by the global parser', () => {
    const i = sinter(['image', 'validate', path.join(home, 'missing.png'), '--studio']);
    expect(i.out).not.toContain('Unknown option');
    const c = sinter(['compost', 'branch', 'create', 'b1', '--description', 'probe']);
    expect(c.out).not.toContain('Unknown option');
  });
});

describe('generate parses its prompt', () => {
  it('reaches the governed runtime instead of dying on an undeclared prompt variable', () => {
    for (const argv of [['generate', 'a quiet orbit'], ['generate', '--prompt', 'a quiet orbit']]) {
      const r = sinter(argv);
      expect(r.out, argv.join(' ')).not.toContain('is not defined');
      expect(r.out, argv.join(' ')).not.toContain('--prompt is required');
    }
  });
});

describe('generate --parent', () => {
  it('is accepted by the parser and refuses an artifact the lineage store does not know, before any provider call', () => {
    const r = sinter(['generate', 'a quiet orbit', '--parent', 'no-such-artifact']);
    expect(r.out).not.toContain('Unknown option');
    expect(r.status).toBe(1);
    expect(r.out).toContain('--parent no-such-artifact is not in the lineage store');
  });

  it('accepts a parent that archive branch recorded (gets past the parent check)', () => {
    const b = sinter(['archive', 'branch', 'seed-artifact']);
    const id = /-> (\S+) \(recorded/.exec(b.out)?.[1] as string;
    const r = sinter(['generate', 'a quiet orbit', '--parent', id]);
    expect(r.out).not.toContain('is not in the lineage store');
    expect(r.out).not.toContain('Unknown option');
  });
});
