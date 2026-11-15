import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCb = (err: unknown, res?: { stdout: string; stderr: string }) => void;
type ExecCall = { cmd: string; args: string[]; opts: { timeout?: number; cwd?: string } };

const cp = vi.hoisted(() => ({
  calls: [] as unknown[],
  // Each entry is either a result or an error to reject with.
  next: { value: undefined as unknown },
  execFile: undefined as unknown as (...a: unknown[]) => void,
}));

vi.mock('node:child_process', () => {
  cp.execFile = (cmd: unknown, args: unknown, opts: unknown, cb: unknown) => {
    cp.calls.push({ cmd, args, opts });
    const outcome = cp.next.value as { error?: unknown; stdout?: string; stderr?: string };
    if (outcome.error) (cb as ExecCb)(outcome.error);
    else (cb as ExecCb)(null, { stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
  };
  return { execFile: cp.execFile, default: { execFile: cp.execFile } };
});

import { RunBuildTool } from '../../../src/harness/tools/RunBuildTool.js';
import { TypeCheckTool } from '../../../src/harness/tools/TypeCheckTool.js';
import { LSPTool } from '../../../src/harness/tools/LSPTool.js';

const lastCall = () => cp.calls[cp.calls.length - 1] as ExecCall;

beforeEach(() => {
  cp.calls.length = 0;
  cp.next.value = { stdout: '', stderr: '' };
});

describe('RunBuildTool', () => {
  it('runs `npm run build` with the default 60s timeout and reports success', async () => {
    cp.next.value = { stdout: 'built ok', stderr: 'warn' };
    const res = await new RunBuildTool().execute({});
    expect(lastCall().cmd).toBe('npm');
    expect(lastCall().args).toEqual(['run', 'build']);
    expect(lastCall().opts.timeout).toBe(60000);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ exitCode: 0, stdout: 'built ok', stderr: 'warn', success: true });
  });

  it('honours a caller timeout and keeps only the tail of long output', async () => {
    cp.next.value = { stdout: 'x'.repeat(5000) + 'END', stderr: 'y'.repeat(3000) + 'ERR' };
    const res = await new RunBuildTool().execute({ timeoutMs: 5 });
    expect(lastCall().opts.timeout).toBe(5);
    expect(res.data!.stdout).toHaveLength(2000);
    expect(res.data!.stdout.endsWith('END')).toBe(true);
    expect(res.data!.stderr).toHaveLength(1000);
    expect(res.data!.stderr.endsWith('ERR')).toBe(true);
  });

  it('reports a failed build with the process exit code and captured streams', async () => {
    cp.next.value = { error: Object.assign(new Error('boom'), { code: 2, stdout: 'out', stderr: 'tsc failed' }) };
    const res = await new RunBuildTool().execute({});
    expect(res.success).toBe(false);
    expect(res.error).toBe('Build failed with exit code 2');
    expect(res.data).toEqual({ exitCode: 2, stdout: 'out', stderr: 'tsc failed', success: false });
  });

  it('falls back to exit code 1 and the error message when no streams were captured', async () => {
    cp.next.value = { error: new Error('spawn npm ENOENT') };
    const res = await new RunBuildTool().execute({});
    expect(res.error).toBe('Build failed with exit code 1');
    expect(res.data).toEqual({ exitCode: 1, stdout: '', stderr: 'spawn npm ENOENT', success: false });
  });
});

describe('TypeCheckTool', () => {
  const tsErr = 'src/a.ts(3,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\n'
    + 'src/b.ts(10,1): error TS7006: Parameter \'x\' implicitly has an \'any\' type.\n';

  it('passes with zero errors and builds the base tsc command', async () => {
    const res = await new TypeCheckTool().execute({});
    expect(lastCall().cmd).toBe('npx');
    expect(lastCall().args).toEqual(['tsc', '--noEmit', '--pretty', 'false']);
    expect(res).toEqual({ success: true, data: { errors: [], totalErrors: 0, success: true } });
  });

  it('adds --strict and the path when asked', async () => {
    await new TypeCheckTool().execute({ strict: true, path: 'src/a.ts' });
    expect(lastCall().args).toEqual(['tsc', '--noEmit', '--pretty', 'false', '--strict', 'src/a.ts']);
  });

  it('parses tsc diagnostics out of a failing exit (node reports exit status as code)', async () => {
    cp.next.value = { error: Object.assign(new Error('failed'), { code: 2, stdout: tsErr, stderr: '' }) };
    const res = await new TypeCheckTool().execute({});
    expect(res.success).toBe(false);
    expect(res.data!.totalErrors).toBe(2);
    expect(res.data!.errors[0]).toEqual({
      file: 'src/a.ts', line: 3, column: 5, code: 'TS2322',
      message: 'Type \'string\' is not assignable to type \'number\'.',
    });
    expect(res.data!.errors[1].code).toBe('TS7006');
  });

  it('also accepts the exitCode spelling', async () => {
    cp.next.value = { error: Object.assign(new Error('failed'), { exitCode: 2, stdout: tsErr, stderr: '' }) };
    expect((await new TypeCheckTool().execute({})).data!.totalErrors).toBe(2);
  });

  it('returns only the first 20 errors but counts them all', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f.ts(${i + 1},1): error TS1000: bad ${i}`).join('\n');
    cp.next.value = { error: Object.assign(new Error('failed'), { code: 2, stdout: many, stderr: '' }) };
    const res = await new TypeCheckTool().execute({});
    expect(res.data!.errors).toHaveLength(20);
    expect(res.data!.totalErrors).toBe(25);
  });

  it('surfaces a non-type-error failure (e.g. tsc missing) as a tool error', async () => {
    cp.next.value = { error: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }) };
    const res = await new TypeCheckTool().execute({});
    expect(res.success).toBe(false);
    expect(res.error).toContain('spawn npx ENOENT');
  });
});

describe('LSPTool', () => {
  it('rejects unknown operations', async () => {
    expect(await new LSPTool().execute({ operation: 'rename' })).toEqual({
      success: false, error: 'Unknown LSP operation: rename',
    });
  });

  it('diagnostics parses errors and warnings and runs tsc against the given file', async () => {
    cp.next.value = {
      stdout: 'src/a.ts(1,2): error TS2304: Cannot find name \'foo\'.\n'
        + 'src/a.ts(4,9): warning TS6133: \'bar\' is declared but never used.\nnoise line\n',
    };
    const res = await new LSPTool().execute({ operation: 'diagnostics', path: 'src/a.ts' });
    expect(lastCall().args).toEqual(['tsc', '--noEmit', '--pretty', 'false', '--project', 'tsconfig.json', 'src/a.ts']);
    expect(res.success).toBe(false);
    expect(res.data).toEqual({
      errorCount: 1,
      warningCount: 1,
      diagnostics: [
        { file: 'src/a.ts', line: 1, character: 2, severity: 'error', code: 'TS2304', message: 'Cannot find name \'foo\'.', source: 'tsc' },
        { file: 'src/a.ts', line: 4, character: 9, severity: 'warning', code: 'TS6133', message: '\'bar\' is declared but never used.', source: 'tsc' },
      ],
    });
  });

  it('diagnostics succeeds on a clean file and uses stdout of a failing exit', async () => {
    expect((await new LSPTool().execute({ operation: 'diagnostics', path: 'x.ts' })).success).toBe(true);
    cp.next.value = { error: Object.assign(new Error('exit 2'), { stdout: 'x.ts(1,1): error TS1005: ; expected.' }) };
    const res = await new LSPTool().execute({ operation: 'diagnostics', path: 'x.ts' });
    expect(res.success).toBe(false);
    expect((res.data as { errorCount: number }).errorCount).toBe(1);
  });

  it('diagnostics caps the list at 10 entries but counts them all', async () => {
    cp.next.value = { stdout: Array.from({ length: 12 }, (_, i) => `a.ts(${i + 1},1): error TS1: e`).join('\n') };
    const res = await new LSPTool().execute({ operation: 'diagnostics', path: 'a.ts' });
    const data = res.data as { diagnostics: unknown[]; errorCount: number };
    expect(data.diagnostics).toHaveLength(10);
    expect(data.errorCount).toBe(12);
  });
});
