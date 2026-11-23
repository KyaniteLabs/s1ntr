/** Sol F18: `garden stop` is a real control operation and `garden tend` honours the shared queue path. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = path.resolve(__dirname, '../../bin/sinter');
const waitFor = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 200)); } return cond(); };

describe('sinter garden control', { timeout: 240000 }, () => {
  it('stop from another shell terminates a running garden and removes its pid file', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'garden-'));
    const env = { ...process.env, HOME: home };
    const child = spawn('node', [bin, 'garden', 'start'], { cwd: home, env, stdio: 'ignore' });
    let exited = false; child.on('exit', () => { exited = true; });
    try {
      const pidFile = path.join(home, '.sinter', 'garden.pid');
      expect(await waitFor(() => existsSync(pidFile), 120000)).toBe(true);
      // Async, so this process can reap the stopped child (a zombie would still answer kill(pid, 0)).
      const stop = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const p = spawn('node', [bin, 'garden', 'stop'], { cwd: home, env }); let stdout = ''; let stderr = '';
        p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; });
        p.on('close', status => resolve({ status, stdout, stderr }));
      });
      expect(stop.stderr).toBe('');
      expect(stop.status).toBe(0);
      expect(stop.stdout).toMatch(/Garden pid \d+ stopped/);
      expect(await waitFor(() => exited, 10000)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    } finally { if (!exited && child.pid) process.kill(child.pid, 'SIGKILL'); rmSync(home, { recursive: true, force: true }); }
  });

  it('stop with nothing running says so and exits 0', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'garden-'));
    try {
      const stop = spawnSync('node', [bin, 'garden', 'stop'], { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120000 });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toContain('No garden is running');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('tend writes to SINTER_DREAM_QUEUE_PATH, the same path the consumer resolves', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'garden-'));
    const queue = path.join(home, 'custom', 'q.json');
    try {
      const tend = spawnSync('node', [bin, 'garden', 'tend'], { cwd: home, encoding: 'utf8', timeout: 200000,
        env: { ...process.env, HOME: home, SINTER_DREAM_QUEUE_PATH: queue } });
      expect(tend.stdout).toContain(queue);
      expect(existsSync(queue)).toBe(true);
      expect(existsSync(path.join(home, '.sinter', 'dreams', 'queue.json'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
