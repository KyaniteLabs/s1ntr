import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '../../..');
let proj: string;

function runBuild(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [path.join(proj, 'scripts/build-atomic.mjs')], { cwd: proj, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}
function runBuildAsync(): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(proj, 'scripts/build-atomic.mjs')], { cwd: proj, stdio: 'ignore', env: { ...process.env, BUILD_ATOMIC_NO_EXCHANGE: '1', BUILD_ATOMIC_TEST_SWAP_DELAY_MS: '400' } });
    c.on('close', resolve);
  });
}
const leftovers = () => readdirSync(proj).filter((n) => /^dist\.(build|prev|swap)/.test(n));

beforeEach(() => {
  // a throwaway project that uses the real script and the real compiler
  proj = mkdtempSync(path.join(tmpdir(), 'build-atomic-'));
  mkdirSync(path.join(proj, 'scripts')); mkdirSync(path.join(proj, 'src'));
  cpSync(path.join(repo, 'scripts/build-atomic.mjs'), path.join(proj, 'scripts/build-atomic.mjs'));
  symlinkSync(path.join(repo, 'node_modules'), path.join(proj, 'node_modules'));
  writeFileSync(path.join(proj, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ES2022', outDir: './dist', rootDir: './src', strict: true, skipLibCheck: true }, include: ['src/**/*'] }));
  writeFileSync(path.join(proj, 'src/a.ts'), 'export const answer: number = 41;\n');
});
afterEach(() => { rmSync(proj, { recursive: true, force: true }); });

describe('pnpm build is atomic', () => {
  it('a good build puts the compiled output in dist and leaves no scratch directories', () => {
    const r = runBuild();
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(proj, 'dist/a.js'), 'utf8')).toContain('41');
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('a failed compile exits non-zero and leaves the previous dist byte-for-byte intact', () => {
    expect(runBuild().status).toBe(0);
    writeFileSync(path.join(proj, 'dist/marker.txt'), 'old build');
    const before = readFileSync(path.join(proj, 'dist/a.js'), 'utf8');
    writeFileSync(path.join(proj, 'src/a.ts'), 'export const answer: number = "not a number";\n');
    const r = runBuild();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('error TS2322');
    expect(readFileSync(path.join(proj, 'dist/a.js'), 'utf8')).toBe(before);
    expect(readFileSync(path.join(proj, 'dist/marker.txt'), 'utf8')).toBe('old build');
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('five overlapping builds, each stalled mid-swap, all succeed and leave one complete dist', async () => {
    writeFileSync(path.join(proj, 'src/b.ts'), 'import { answer } from "./a.js";\nexport const twice = answer * 2;\n');
    expect(runBuild().status).toBe(0); // dist exists first, so every overlapping swap has something to move
    const codes = await Promise.all([1, 2, 3, 4, 5].map(() => runBuildAsync()));
    expect(codes).toEqual([0, 0, 0, 0, 0]);
    expect(readdirSync(path.join(proj, 'dist')).filter((n) => n.endsWith('.js')).sort()).toEqual(['a.js', 'b.js']);
    expect(readFileSync(path.join(proj, 'dist/b.js'), 'utf8')).toContain('answer * 2');
    expect(existsSync(path.join(proj, 'dist/a.js'))).toBe(true);
    expect(leftovers()).toEqual([]);
  }, 180_000);
  it('boots the real launcher when dist appears during a locked swap', async () => {
    mkdirSync(path.join(proj, 'dist.swap-lock'));
    cpSync(path.join(repo, 'bin'), path.join(proj, 'bin'), { recursive: true });
    writeFileSync(path.join(proj, 'package.json'), '{"type":"module"}');
    const cli = spawn(process.execPath, ['bin/sinter', '--version'], { cwd: proj, env: { ...process.env, HOME: proj } });
    const result = new Promise((resolve) => cli.once('close', resolve));
    let stderr = '';
    cli.stderr.on('data', (data) => { stderr += data; });
    mkdirSync(path.join(proj, 'incoming/config'), { recursive: true });
    writeFileSync(path.join(proj, 'incoming/config/loadProjectDotenv.js'),
      'export function loadProjectDotenv() { process.exit(42); }');
    await new Promise((resolve) => setTimeout(resolve, 400));
    renameSync(path.join(proj, 'incoming'), path.join(proj, 'dist'));
    rmSync(path.join(proj, 'dist.swap-lock'), { recursive: true });
    expect(await result, stderr).toBe(42);
  });
});
