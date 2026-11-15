import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stopChild } = require('../../electron/stopChild.cjs') as {
  stopChild: (child: ChildProcess | null, opts?: { graceMs?: number; platform?: string }) => void;
};

function spawnNode(source: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
  // Wait until the child prints, so its SIGTERM handler is installed.
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => resolve(child));
  });
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

describe.skipIf(process.platform === 'win32')('stopChild', () => {
  it('force-kills a child that ignores SIGTERM after the grace period', async () => {
    const child = await spawnNode(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);

    stopChild(child, { graceMs: 200 });
    const result = await exitOf(child);
    clearTimeout(timer);

    expect(result).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('lets a child that honours SIGTERM exit on SIGTERM', async () => {
    const child = await spawnNode("console.log('ready'); setInterval(() => {}, 1000);");

    stopChild(child, { graceMs: 200 });
    const result = await exitOf(child);

    expect(result).toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('does nothing for a missing or already-exited child', async () => {
    expect(() => stopChild(null)).not.toThrow();

    const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    const result = await exitOf(child);
    expect(result).toEqual({ code: 3, signal: null });
    expect(() => stopChild(child, { graceMs: 10 })).not.toThrow();
    expect(child.killed).toBe(false);
  });
});
