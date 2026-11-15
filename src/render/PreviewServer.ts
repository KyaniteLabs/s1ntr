/**
 * PreviewServer — thin compatibility adapter.
 *
 * Per brief #298, preview HTTP behavior now lives in `TuiBridgeServer` (the
 * raw-HTTP bridge), implemented as a regex-dispatched `PreviewEndpoints`
 * class shared with the TUI bridge. This class exists only so existing
 * callers (`new PreviewServer(galleryDir)`, `.start(port)`, `.getPort()`,
 * `.stop()`, `.serveSketch()`, `.setVersionCode()`, `.setAllVersions()`) keep
 * working without a route implementation of their own.
 *
 * All route handling is delegated to `PreviewEndpoints`. The adapter only
 * owns the http.Server lifecycle so the legacy test surface (which expects
 * `start`/`stop`/`getPort`) keeps working unchanged.
 *
 * Out of scope: Puppeteer migration. The browser screenshot path is owned by
 * `PreviewService` (Playwright-only) and is not invoked by the HTTP server.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'node:net';
import { PreviewEndpoints } from '../tui-bridge/TuiBridgeServer.js';
import { SERVICE_DEFAULTS } from '../constants/index.js';
import { ServerError } from '../errors/ServerError.js';

interface PreviewServerOptions {
  galleryDir?: string;
}

interface VersionedIteration {
  version: number;
  code: string;
  timestamp?: string;
}

export class PreviewServer {
  private readonly endpoints: PreviewEndpoints;
  private server: Server | null = null;
  private readonly defaultPort: number;

  constructor(options: PreviewServerOptions | string | null = null) {
    const opts = typeof options === 'string' ? { galleryDir: options } : (options || {});
    this.defaultPort = SERVICE_DEFAULTS.PREVIEW_PORT;
    this.endpoints = new PreviewEndpoints({ galleryDir: opts.galleryDir ?? null });
  }

  async start(port: number = this.defaultPort): Promise<boolean> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new ServerError(`Invalid port number: ${port}`, { port });
    }
    if (this.server) {
      throw new ServerError('Server is already running');
    }

    this.server = createServer((req, res) => { void this.handleRequest(req, res); });

    await new Promise<void>((resolve, reject) => {
      this.server!
        .on('error', (error: Error & { code?: string }) => {
          this.server = null;
          if (error.code === 'EADDRINUSE') {
            reject(new ServerError(`Port ${port} is already in use`, { port, cause: error }));
          } else {
            reject(new ServerError(`Server error: ${error.message}`, { port, cause: error }));
          }
        })
        .on('listening', () => {
          resolve();
        });
      // Loopback only: the preview serves local gallery files and must not be
      // reachable from other machines on the network.
      this.server!.listen(port, '127.0.0.1');
    });

    return true;
  }

  getPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object'
      ? (address as AddressInfo).port
      : null;
  }

  async stop(): Promise<boolean> {
    if (!this.server) {
      // Never started (or already stopped): still release the constructor-time
      // resources held by the endpoints (EventBus subscription, lazy SinterFS
      // handle) instead of leaking them on the early return.
      this.shutdownEndpoints();
      return false;
    }

    await new Promise<void>((resolve) => {
      this.server!.close(() => {
        resolve();
      });
    });

    this.server = null;
    this.shutdownEndpoints();
    return true;
  }

  private endpointsShutdown = false;

  private shutdownEndpoints(): void {
    if (this.endpointsShutdown) return;
    this.endpointsShutdown = true;
    this.endpoints.shutdown();
  }

  serveSketch(code: string | null): void {
    this.endpoints.serveSketch(code);
  }

  /**
   * Set code for a specific version (used by GUI for /preview?version=N).
   */
  setVersionCode(version: number, code: string): void {
    this.endpoints.setVersionCode(version, code);
  }

  /**
   * Set all versions at once from iterations (version, code, timestamp).
   */
  setAllVersions(iterations: VersionedIteration[]): void {
    this.endpoints.setAllVersions(iterations);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    try {
      const handled = await this.endpoints.handle(req, res, url.pathname, url);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const explicitStatus = (err as { statusCode?: number }).statusCode;
      const status = explicitStatus
        ?? (message.includes('not found') || message.includes('Unknown') ? 404 : 500);
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    }
  }
}
