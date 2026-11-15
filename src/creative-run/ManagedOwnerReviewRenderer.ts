import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OwnerReviewHandle, OwnerReviewPacketRenderer } from './OwnerQualityReview.js';

export interface ManagedRendererOptions {
  /** Override the command that launches the server child process (for testing). */
  readonly spawnFn?: typeof spawn;
  /** Override the temp directory root (for testing). */
  readonly tempRoot?: string;
  /** Maximum wait for child to report readiness (ms). */
  readonly readyTimeoutMs?: number;
}

interface RunningState {
  readonly child: ChildProcess;
  readonly tempDir: string;
  readonly port: number;
  readonly exited: Promise<void>;
}

/**
 * Concrete managed renderer shared by Studio and CLI.
 *
 * Spawns a child process running a minimal HTTP server that serves the
 * contact-sheet HTML — including temporal, interaction, runtime, and
 * accessibility evidence — then guarantees child-process and temp-file
 * cleanup on both success and failure paths.
 */
export class ManagedOwnerReviewRenderer implements OwnerReviewPacketRenderer {
  #state: RunningState | null = null;
  #closed = false;
  private readonly spawnFn: typeof spawn;
  private readonly tempRoot: string;
  private readonly readyTimeoutMs: number;

  constructor(options: ManagedRendererOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
  }

  get isRunning(): boolean {
    return this.#state !== null && !this.#closed;
  }

  get childPid(): number | null {
    return this.#state?.child.pid ?? null;
  }

  async render(html: string): Promise<OwnerReviewHandle> {
    if (this.#closed) throw new Error('MANAGED_RENDERER_CLOSED');
    if (this.#state) throw new Error('MANAGED_RENDERER_ALREADY_RENDERING');
    const tempDir = await mkdtemp(path.join(this.tempRoot, 'owner-review-'));
    const htmlPath = path.join(tempDir, 'contact-sheet.html');
    await writeFile(htmlPath, html, 'utf8');
    const script = `(async()=>{
      const http=require('http'),fs=require('fs');
      const htmlPath=${JSON.stringify(htmlPath)};
      const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(fs.readFileSync(htmlPath));});
      server.listen(0,'127.0.0.1',()=>{const addr=server.address();process.stdout.write(String(typeof addr==='object'&&addr?addr.port:addr));});
      process.on('SIGTERM',()=>{server.close(()=>process.exit(0));});
    })();`;
    const child = this.spawnFn('node', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await this.awaitReady(child);
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      this.#state = { child, tempDir, port, exited };
      return Object.freeze({
        url: `http://127.0.0.1:${port}/`,
        close: () => this.close(),
      });
    } catch (err) {
      // Ensure no orphan process: kill the child if readiness failed so the
      // caller's finally-driven close() does not miss it (#state was unset).
      if (!child.killed) child.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private awaitReady(child: ChildProcess): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => {
        reject(new Error('MANAGED_RENDERER_CHILD_START_TIMEOUT'));
      }, this.readyTimeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const parsed = parseInt(stdout.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (stdout.trim().length === 0) {
          reject(new Error(`MANAGED_RENDERER_CHILD_EXITED:${code ?? 'null'}`));
        }
      });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const state = this.#state;
    this.#state = null;
    if (!state) return;
    const { child, tempDir, exited } = state;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let forceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          forceTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            void exited.then(resolve);
          }, 2_000);
        }),
      ]);
      if (forceTimer) clearTimeout(forceTimer);
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  get port(): number | null {
    return this.#state?.port ?? null;
  }
}
