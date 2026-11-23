/** Sol F16: leaf flags must cross the global parser AND do what they advertise (behavioural, not "no crash"). */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
let cwd = '';
beforeAll(() => { cwd = mkdtempSync(path.join(tmpdir(), 'sinter-leaf-')); });
afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

const bin = path.resolve('bin/sinter');
const sinter = (args: string[], dir = cwd) => new Promise<{ out: string; status: number }>((resolve) => {
  execFile(process.execPath, [bin, ...args], { cwd: dir, timeout: 100_000,
    env: { PATH: process.env.PATH, HOME: dir, SINTER_STATE_ROOT: path.join(dir, 's') } },
  (e, so, se) => resolve({ out: so + se, status: e ? Number((e as { code?: number }).code ?? 1) : 0 }));
});

describe('leaf flags behave', () => {
  it('taxonomy --no-write leaves no file; plain taxonomy writes one; --json prints parseable JSON', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sinter-tax-'));
    const file = path.join(dir, '.omx', 'atelier', 'game', 'taxonomy.json');
    const dry = await sinter(['taxonomy', '--no-write'], dir);
    expect(dry.out).not.toMatch(/Unknown option/);
    expect(existsSync(file)).toBe(false);
    const json = await sinter(['taxonomy', '--json', '--no-write'], dir);
    const parsed = JSON.parse(json.out.slice(json.out.indexOf('{')));
    expect(parsed.totals.domains).toBe(0);
    await sinter(['taxonomy'], dir);
    expect(existsSync(file)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('compost branch create records a branch with its description and list shows it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sinter-branch-'));
    const made = await sinter(['compost', 'branch', 'create', 'foo', '--description', 'try a quieter palette'], dir);
    expect(made.out).toContain('Created branch "foo"');
    const list = await sinter(['compost', 'branch', 'list'], dir);
    expect(list.out).toMatch(/foo .*try a quieter palette/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('gbg --index, phases --window/--domain, image validate --studio and mece manifest --check reach their leaves', async () => {
    const gbg = await sinter(['gbg', '--index']);
    expect(gbg.out).toContain('[gbg] beads');
    const phases = await sinter(['phases', '--window', '4', '--domain', 'svg']);
    expect(phases.out).toContain('[phases]');
    expect(phases.out).not.toMatch(/Unknown option/);
    const img = await sinter(['image', 'validate', path.join(cwd, 'missing.png'), '--studio']);
    expect(img.out).toContain('image validate: ENOENT'); // reached the leaf; the file is what is missing
    const mece = await sinter(['mece', 'manifest', '--check']);
    expect(JSON.parse(mece.out.slice(mece.out.indexOf('{'))).ok).toBe(true);
  });
});
