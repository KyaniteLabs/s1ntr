/**
 * BoundedProcess - run a child under the shared RenderBudget (#1870): the budget rejects on expiry
 * whether or not the child settles, and the whole process group is killed.
 */
import { spawn } from 'node:child_process';
import { killProcessGroup, withRenderBudget } from './RenderBudget.js';

export interface BoundedResult { code: number | null; timedOut: boolean; stderr: string }

export async function runBounded(cmd: string, args: string[], timeoutMs: number, opts: { cwd?: string } = {}): Promise<BoundedResult> {
  if (timeoutMs <= 0) return { code: null, timedOut: true, stderr: '' };
  let pid: number | undefined;
  let stderr = '';
  try {
    return await withRenderBudget(`${cmd} child`, timeoutMs, () => new Promise<BoundedResult>((resolve) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      pid = child.pid;
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString(); });
      child.on('error', (error) => resolve({ code: null, timedOut: false, stderr: `${stderr}${error.message}` }));
      child.on('close', (code) => resolve({ code, timedOut: false, stderr }));
    }), () => { killProcessGroup(pid); });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'RENDER_TIMEOUT') return { code: null, timedOut: true, stderr };
    throw error;
  }
}
