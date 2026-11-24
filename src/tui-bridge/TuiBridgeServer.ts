import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'http';
import fs from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { randomBytes, createHmac } from 'node:crypto';
import { TuiBridgeService } from './TuiBridgeService.js';
import type { LLMClient } from '../llm/LLMClient.js';
import type { TuiInputRequest } from './types.js';
import { loadConfig, type UserConfig } from '../config/ConfigLoader.js';
import { LLMClient as RuntimeLLMClient } from '../llm/LLMClient.js';
import { formatHarnessExecutorProjection, type HarnessTransportAuthority } from '../identity/harnessTransportGuard.js';
import { resolveRuntimeExecutorAuthority } from '../identity/executorAuthorityBootstrap.js';
import { summarizeBridgeRuntime } from './BridgeLauncherConfig.js';
import {
  PROVIDER_DEFAULTS,
  detectProviderLabel,
  resolveProviderRuntime,
  type RuntimeProviderKey,
} from '../config/ProviderRuntime.js';
import {
  MODEL_CHOICES,
  findModelChoice,
  resolveChoiceByAlias,
  resolveOpenRouterChoice,
  resolveProviderToken,
  type ModelChoice,
} from './ModelPickerCatalog.js';
import { TuiControlEndpoints } from './endpoints/TuiControlEndpoints.js';
import { TuiMicPreviewEndpoints } from './endpoints/TuiMicPreviewEndpoints.js';
import { Gallery, parseVersionContent, type GalleryIteration } from '../gallery/Gallery.js';
import { SinterFS } from '../fs/SinterFS.js';
import { resolveSinterProjectRoot } from '../fs/projectRoot.js';
import { Exporter } from '../export/Exporter.js';
import { normalizePath, assertSafeSegment } from '../utils/normalizePath.js';
import { HTMLWrapper } from '../utils/htmlWrapper.js';
import { Logger } from '../utils/Logger.js';
import { IpRateLimiter, rateLimitEnvMinutes, rateLimitEnvMax } from '../security/RateLimiter.js';
import { validateCode } from '../utils/validation.js';
import { isVendorAssetPath, readVendorAsset } from '../utils/vendorAssets.js';
import { eventBus } from '../core/EventBus.js';
import { ProjectStore } from '../compost/ProjectStore.js';
import type { BusEvent } from '../core/EventBus.js';
import { allowedHostsFor, rejectForeignRequest } from '../security/LocalRequestGuard.js';

const ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://localhost:4200',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4200',
  'http://127.0.0.1:5173',
];

function bearerCredential(req: IncomingMessage, header = 'authorization'): string | undefined {
  const value = req.headers[header];
  const raw = Array.isArray(value) ? value[0] : value;
  const match = /^Bearer\s+([^\s]+)$/i.exec(raw ?? '');
  return match?.[1];
}

interface BridgeServerOptions {
  port?: number;
  host?: string;
  llm?: LLMClient;
  harnessTransportAuthority?: HarnessTransportAuthority;
}

interface VersionedIteration {
  version: number;
  code: string;
  timestamp?: string;
}

const SSE_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Write an SSE frame. Returns false only when the client is gone or has
 * buffered past the cap; backpressure (res.write() === false) is normal and
 * must NOT abort the replay, or a large replay silently truncates and the
 * client is never subscribed.
 */
export function writeSse(res: ServerResponse, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  if (res.writableLength > SSE_MAX_BUFFER_BYTES) {
    res.destroy();
    return false;
  }
  res.write(chunk);
  return true;
}

/**
 * Options for PreviewEndpoints — constructs the shared state used by every
 * preview surface route. `TuiBridgeServer` instantiates one of these and
 * `PreviewServer` (the thin compatibility adapter) does the same so both
 * surfaces share an identical route implementation.
 */
export interface PreviewEndpointsOptions {
  /** Gallery directory for `/api/gallery` and the file-backed gallery routes. */
  galleryDir?: string | null;
  /** Directory of `generate` output (`<64 hex>/playable.html`) that `/api/gallery` also lists. */
  artifactsDir?: string | null;
}

/**
 * Where `sinter serve` looks for saved works (#1711). `generate` writes
 * `~/.sinter/output/artifacts/<sha>/playable.html`; the `./gallery` project dirs are the
 * compose/GUI store. An explicit `--gallery <dir>` means "that dir only".
 */
export function resolveServeGalleryDirs(
  galleryFlag: string | undefined,
  home: string = process.env.HOME || '/tmp',
): { galleryDir: string; artifactsDir: string | null } {
  if (galleryFlag) return { galleryDir: path.resolve(galleryFlag), artifactsDir: null };
  return {
    galleryDir: path.resolve('gallery'),
    artifactsDir: path.join(home, '.sinter', 'output', 'artifacts'),
  };
}

export class TuiBridgeServer {
  private readonly bridge: TuiBridgeService;
  private readonly server: Server;
  private loopbackSecondary?: Server;
  private readonly port: number;
  /** Host names this bridge answers to (DNS-rebinding guard); null when bound to every interface. */
  private readonly allowedHosts: ReadonlySet<string> | null;
  private readonly host: string;
  private readonly controls: TuiControlEndpoints;
  private readonly micPreview: TuiMicPreviewEndpoints;
  private readonly preview: PreviewEndpoints;
  private llm?: LLMClient;
  /** `/model` picks bind to the requesting session only; other sessions keep the server's launch client. */
  private readonly sessionLlm = new Map<string, LLMClient>();
  private readonly harnessTransportAuthority?: HarnessTransportAuthority;

  constructor(bridge: TuiBridgeService, options: BridgeServerOptions = {}) {
    this.llm = options.llm;
    this.harnessTransportAuthority = resolveRuntimeExecutorAuthority(options.harnessTransportAuthority);
    this.bridge = bridge;
    this.port = options.port ?? 3000;
    this.host = options.host ?? 'localhost';
    this.allowedHosts = allowedHostsFor(this.host);
    this.controls = new TuiControlEndpoints(this.bridge, () => this.llm);
    this.micPreview = new TuiMicPreviewEndpoints(this.bridge, () => this.address);
    this.preview = new PreviewEndpoints();
    this.server = createServer((req, res) => { void this.handleRequest(req, res); });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 'localhost' does not resolve to a single stable family: dns.lookup
      // prefers ::1 on macOS and in Linux containers, while HTTP clients
      // (undici) may try 127.0.0.1. A single-family bind therefore leaves one
      // side unreachable (ECONNREFUSED) in one environment or another. For the
      // default host, bind BOTH loopback families explicitly — primary on
      // 127.0.0.1, a secondary socket on ::1 sharing the same handler — so
      // clients reach the bridge on either, and a port held on either family
      // still fails with EADDRINUSE. An explicit non-default host binds
      // exactly that interface.
      if (this.host === 'localhost') {
        // Primary first so that port 0 yields a single ephemeral port; the
        // secondary then binds the SAME actual port on the other family.
        const secondary = createServer((req, res) => { void this.handleRequest(req, res); });
        this.server.once('error', (err: Error) => reject(err));
        this.server.once('listening', () => {
          const actual = this.server.address();
          const actualPort = actual && typeof actual === 'object' ? actual.port : this.port;
          secondary.once('error', (err: Error) => {
            this.server.close();
            reject(err);
          });
          secondary.once('listening', () => {
            this.loopbackSecondary = secondary;
            resolve();
          });
          secondary.listen(actualPort, '::1');
        });
        this.server.listen(this.port, '127.0.0.1');
        return;
      }
      const onError = (err: Error) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host, () => {
        // The explicit listening listener above resolves the promise. Keep this
        // callback empty so older Node versions still use the same listen path.
      });
    });
  }

  async stop(): Promise<void> {
    this.server.closeIdleConnections?.();
    this.server.closeAllConnections?.();
    const secondary = this.loopbackSecondary;
    this.loopbackSecondary = undefined;
    secondary?.closeIdleConnections?.();
    secondary?.closeAllConnections?.();
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        this.bridge.destroy();
        // Detach the preview EventBus listener and close the lazy SinterFS
        // handle, mirroring the thin PreviewServer adapter's stop().
        this.preview.shutdown();
        if (!secondary) {
          if (err) reject(err);
          else resolve();
          return;
        }
        secondary.close((secondaryErr) => {
          if (err) reject(err);
          else if (secondaryErr) reject(secondaryErr);
          else resolve();
        });
      });
    });
  }

  get address(): string {
    const actual = this.server.address();
    const port = actual && typeof actual === 'object' ? actual.port : this.port;
    return `http://${this.host}:${port}`;
  }

  /**
   * Expose the shared preview endpoints so the `PreviewServer` thin adapter
   * can mutate `currentSketch` / versioned sketches / gallery dir the same
   * way the bridge-backed surface does. Without this, the legacy
   * `new PreviewServer()` flow couldn't set up state for `/preview`.
   */
  get previewEndpoints(): PreviewEndpoints {
    return this.preview;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (rejectForeignRequest(req, res, this.allowedHosts)) return;

    // CORS headers - restrict to localhost origins only
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Sinter-Issuer-Authorization',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      this.json(res, 400, { error: 'Invalid request URL' });
      return;
    }
    const path = url.pathname;

    try {
      // POST /api/tui/session — create a new session
      if (req.method === 'POST' && path === '/api/tui/session') {
        const rawBody = await this.readBody(req);
        let body: { artistReviewGrant?: unknown };
        try {
          body = rawBody.trim() ? JSON.parse(rawBody) as typeof body : {};
        } catch {
          this.json(res, 400, { error: 'Session request must be valid JSON.' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some((key) => key !== 'artistReviewGrant')
          || (body.artistReviewGrant !== undefined
            && (typeof body.artistReviewGrant !== 'string' || !body.artistReviewGrant.trim()))) {
          this.json(res, 400, { error: 'Only a server-issued artist review grant is accepted.' });
          return;
        }
        const cfg = this.llm?.getConfig();
        const runtime = summarizeBridgeRuntime();
        const status = this.bridge.createSession({
          provider: cfg ? this.providerLabel(cfg.baseUrl) : undefined,
          model: cfg?.model,
          roles: runtime.roles,
          evaluation: runtime.evaluation,
        }, body.artistReviewGrant as string | undefined);
        this.json(res, 201, status);
        return;
      }

      // GET /api/tui/session/:id/status
      const statusMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/status$/);
      if (req.method === 'GET' && statusMatch) {
        const sessionId = statusMatch[1];
        const status = this.bridge.getStatus(sessionId);
        this.json(res, 200, status);
        return;
      }

      const artistReviewMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/artist-review$/);
      if (req.method === 'GET' && artistReviewMatch) {
        this.json(res, 200, this.bridge.getArtistReviewState(artistReviewMatch[1]));
        return;
      }
      if (req.method === 'POST' && artistReviewMatch) {
        const body = JSON.parse(await this.readBody(req)) as { token?: unknown };
        if (typeof body.token !== 'string' || !body.token.trim()) {
          this.json(res, 400, { error: 'An owner action token is required.' });
          return;
        }
        try {
          const result = this.bridge.executeArtistReviewAction(
            artistReviewMatch[1], body.token, bearerCredential(req),
          );
          if (!result.accepted) {
            this.json(res, 403, { error: 'Artist review action could not be verified.' });
            return;
          }
          this.json(res, 200, result);
        } catch {
          this.json(res, 403, { error: 'Artist review action could not be verified.' });
        }
        return;
      }

      const artistCheckpointMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/artist-review\/checkpoints$/,
      );
      if (req.method === 'POST' && artistCheckpointMatch) {
        const ownerCredential = bearerCredential(req);
        if (!ownerCredential) {
          this.json(res, 401, { error: 'Authenticated owner session required.' });
          return;
        }
        const body = JSON.parse(await this.readBody(req)) as { action?: unknown };
        if (!body.action || typeof body.action !== 'object' || Array.isArray(body.action)
          || Object.keys(body).some((key) => key !== 'action')) {
          this.json(res, 400, { error: 'A scoped artist-review action is required.' });
          return;
        }
        try {
          this.json(res, 201, this.bridge.issueArtistReviewActionCheckpoint(
            artistCheckpointMatch[1], ownerCredential,
            body.action as import('../creative-run/ArtistReviewExperience.js').ArtistReviewAction,
            bearerCredential(req, 'x-sinter-issuer-authorization'),
          ));
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      const artistReleaseCheckpointMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/artist-review\/release-checkpoints$/,
      );
      if (req.method === 'POST' && artistReleaseCheckpointMatch) {
        const ownerCredential = bearerCredential(req);
        if (!ownerCredential) {
          this.json(res, 401, { error: 'Authenticated owner session required.' });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await this.readBody(req));
        } catch {
          this.json(res, 400, { error: 'Release verdict request must be valid JSON.' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1
          || ((body as Record<string, unknown>).decision !== 'release-worthy'
            && (body as Record<string, unknown>).decision !== 'not-release-worthy')) {
          this.json(res, 400, { error: 'One release-worthy or not-release-worthy verdict is required.' });
          return;
        }
        try {
          this.json(res, 201, this.bridge.issueArtistReviewReleaseCheckpoint(
            artistReleaseCheckpointMatch[1]!, ownerCredential,
            (body as { readonly decision: 'release-worthy' | 'not-release-worthy' }).decision,
          ));
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      const governedDecisionStartMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/governed-campaign\/([^/]+)\/owner-decisions\/([^/]+)\/comparison$/,
      );
      if (req.method === 'POST' && governedDecisionStartMatch) {
        const ownerCredential = bearerCredential(req);
        if (!ownerCredential) {
          this.json(res, 401, { error: 'Authenticated owner session required.' });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await this.readBody(req));
        } catch {
          this.json(res, 400, { error: 'Revision comparison request must be valid JSON.' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1
          || typeof (body as Record<string, unknown>).revisionEvidenceId !== 'string'
          || !(body as Record<string, string>).revisionEvidenceId.trim()) {
          this.json(res, 400, { error: 'One host-sealed revision evidence ID is required.' });
          return;
        }
        try {
          this.json(res, 201, await this.bridge.startGovernedCampaignOwnerDecisionComparison(
            governedDecisionStartMatch[1]!, ownerCredential, {
              campaignRunId: governedDecisionStartMatch[2]!, briefId: governedDecisionStartMatch[3]!,
              revisionEvidenceId: (body as Record<string, string>).revisionEvidenceId,
            },
          ));
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      const governedContinuationMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/governed-campaign\/([^/]+)\/continuation$/,
      );
      if (req.method === 'POST' && governedContinuationMatch) {
        const ownerCredential = bearerCredential(req);
        if (!ownerCredential) {
          this.json(res, 401, { error: 'Authenticated owner session required.' });
          return;
        }
        let body: unknown;
        try {
          const raw = await this.readBody(req);
          body = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          this.json(res, 400, { error: 'Campaign continuation request must be valid JSON.' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 0) {
          this.json(res, 400, { error: 'Campaign continuation accepts no caller evidence.' });
          return;
        }
        try {
          const result = await this.bridge.continueGovernedCampaign(
            governedContinuationMatch[1]!, ownerCredential, governedContinuationMatch[2]!,
          );
          this.json(res, 200, result);
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      const governedDecisionMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/governed-campaign\/([^/]+)\/owner-decisions\/([^/]+)$/,
      );
      if (req.method === 'POST' && governedDecisionMatch) {
        const ownerCredential = bearerCredential(req);
        if (!ownerCredential) {
          this.json(res, 401, { error: 'Authenticated owner session required.' });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await this.readBody(req));
        } catch {
          this.json(res, 400, { error: 'Owner decision request must be valid JSON.' });
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 0) {
          this.json(res, 400, { error: 'The server-owned comparison binding accepts no client evidence IDs.' });
          return;
        }
        try {
          const result = await this.bridge.finalizeGovernedCampaignOwnerDecision(
            governedDecisionMatch[1]!, ownerCredential, {
              campaignRunId: governedDecisionMatch[2]!, briefId: governedDecisionMatch[3]!,
            },
          );
          this.json(res, 200, result);
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      const transferOpenMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/transfer-promotion\/open$/,
      );
      if (req.method === 'POST' && transferOpenMatch) {
        const raw = await this.readBody(req);
        const body = raw.trim() ? JSON.parse(raw) as unknown : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 0) {
          this.json(res, 400, { error: 'Transfer promotion opens only from server-owned review state.' });
          return;
        }
        const credential = bearerCredential(req);
        if (!credential) {
          this.json(res, 401, { error: 'Authenticated owner session required.' });
          return;
        }
        try {
          this.json(res, 200, await this.bridge.startTransferPromotion(
            transferOpenMatch[1], credential,
          ));
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      const transferMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/transfer-promotion$/,
      );
      if (req.method === 'GET' && transferMatch) {
        this.json(res, 200, this.bridge.getTransferPromotionState(transferMatch[1]));
        return;
      }
      if (req.method === 'POST' && transferMatch) {
        const body = JSON.parse(await this.readBody(req)) as Record<string, unknown>;
        const allowed = new Set(['token', 'preferredBlindId', 'preferredArtifact', 'claim']);
        if (typeof body.token !== 'string' || !body.token.trim()
          || Object.keys(body).some((key) => !allowed.has(key))) {
          this.json(res, 400, { error: 'A server-issued promotion checkpoint is required.' });
          return;
        }
        const credential = bearerCredential(req);
        if (!credential) {
          this.json(res, 401, { error: 'Authenticated promotion actor required.' });
          return;
        }
        try {
          this.json(res, 200, this.bridge.executeTransferPromotionCheckpoint(
            transferMatch[1], {
            token: body.token,
            ...(typeof body.preferredBlindId === 'string'
              ? { preferredBlindId: body.preferredBlindId } : {}),
            ...(body.preferredArtifact === 'treatment' || body.preferredArtifact === 'control'
              ? { preferredArtifact: body.preferredArtifact } : {}),
            ...(typeof body.claim === 'string' ? { claim: body.claim } : {}),
            }, credential,
          ));
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      const transferCheckpointMatch = path.match(
        /^\/api\/tui\/session\/([^/]+)\/transfer-promotion\/checkpoints$/,
      );
      if (req.method === 'POST' && transferCheckpointMatch) {
        const credential = bearerCredential(req);
        if (!credential) {
          this.json(res, 401, { error: 'Authenticated promotion actor required.' });
          return;
        }
        const body = JSON.parse(await this.readBody(req)) as { kind?: unknown };
        if ((body.kind !== 'reviewer' && body.kind !== 'owner' && body.kind !== 'promote')
          || Object.keys(body).some((key) => key !== 'kind')) {
          this.json(res, 400, { error: 'A scoped promotion checkpoint kind is required.' });
          return;
        }
        try {
          this.json(res, 201, this.bridge.issueTransferPromotionCheckpointForHost(
            transferCheckpointMatch[1], body.kind, credential,
          ));
        } catch (error) {
          this.json(res, 403, { error: (error as Error).message });
        }
        return;
      }

      // GET /api/tui/session/:id/events — SSE stream
      const eventsMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/events$/);
      if (req.method === 'GET' && eventsMatch) {
        const sessionId = eventsMatch[1];
        // Validate session exists
        this.bridge.getStatus(sessionId);
        this.handleSSE(req, res, sessionId);
        return;
      }

      // POST /api/tui/session/:id/input
      const inputMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/input$/);
      if (req.method === 'POST' && inputMatch) {
        const sessionId = inputMatch[1];
        const body = await this.readBody(req);
        const input: TuiInputRequest = JSON.parse(body);
        if (this.micPreview.handleCommand(sessionId, input)) {
          this.json(res, 200, { reviewRequired: false });
          return;
        }
        if (await this.handleModelPicker(sessionId, input)) {
          this.json(res, 200, { reviewRequired: false });
          return;
        }
        // Pass the full LLMClient (not just stream function)
        const sessionClient = this.llmFor(sessionId);
        const result = await this.bridge.submitInput(sessionId, input, sessionClient);
        if (sessionClient) {
          this.bridge.updateStatus(sessionId, { executor: sessionClient.getHarnessExecutorProjection() });
        }
        this.json(res, 200, result);
        return;
      }

      // POST /api/tui/session/:id/actions/:actionId/confirm
      const confirmMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/actions\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmMatch) {
        const sessionId = confirmMatch[1];
        const actionId = confirmMatch[2];
        this.json(res, 200, await this.controls.confirmAction(sessionId, actionId));
        return;
      }

      // POST /api/tui/session/:id/actions/:actionId/cancel
      const cancelMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/actions\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const sessionId = cancelMatch[1];
        const actionId = cancelMatch[2];
        this.json(res, 200, this.controls.cancelAction(sessionId, actionId));
        return;
      }

      // POST /api/tui/session/:id/cancel
      const runCancelMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && runCancelMatch) {
        const sessionId = runCancelMatch[1];
        this.json(res, 200, this.controls.cancelRun(sessionId));
        return;
      }

      const micPageMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/mic-preview$/);
      if (req.method === 'GET' && micPageMatch) {
        const page = this.micPreview.renderPage(micPageMatch[1]);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }

      const micUpdateMatch = path.match(/^\/api\/tui\/session\/([^/]+)\/mic-preview\/update$/);
      if (req.method === 'POST' && micUpdateMatch) {
        const sessionId = micUpdateMatch[1];
        const body = await this.readBody(req);
        this.micPreview.applyUpdate(sessionId, JSON.parse(body));
        this.json(res, 200, { ok: true });
        return;
      }

      // Health check
      if (path === '/health') {
        this.json(res, 200, { status: 'ok', bridge: 'sinter-tui' });
        return;
      }

      // ── Preview surface (raw-HTTP handlers, no Express) ──
      if (await this.preview.handle(req, res, path, url)) {
        return;
      }

      this.json(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const explicitStatus = (err as { statusCode?: number }).statusCode;
      const status = explicitStatus
        ?? (message === 'ARTIST_REVIEW_BOOTSTRAP_GRANT_INVALID' ? 403
          : message.includes('not found') || message.includes('Unknown') ? 404 : 500);
      this.json(res, status, { error: message });
    }
  }

  private handleSSE(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const lastEventId = Number(req.headers['last-event-id'] || 0) || 0;

    // Send any existing events first
    const replay = this.bridge.getEventReplay();
    const existing = replay.replayAfter(sessionId, lastEventId);
    for (const stored of existing) {
      if (!writeSse(res, `id: ${stored.id}\n`)) return;
      if (!writeSse(res, `data: ${JSON.stringify(stored.event)}\n\n`)) return;
    }

    // Subscribe to new events
    const unsubscribe = replay.subscribeStored(sessionId, (stored) => {
      const payload = `id: ${stored.id}
data: ${JSON.stringify(stored.event)}

`;
      writeSse(res, payload);
    });

    const heartbeat = setInterval(() => {
      writeSse(res, ': ping\n\n');
    }, 15000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  private providerLabel(baseUrl: string, model = ''): string {
    return detectProviderLabel(baseUrl, model);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private llmFor(sessionId: string): LLMClient | undefined {
    return this.sessionLlm.get(sessionId) ?? this.llm;
  }

  private async handleModelPicker(sessionId: string, input: TuiInputRequest): Promise<boolean> {
    const text = input.text.trim();
    if (!text.startsWith('/model') && !text.startsWith('/provider')) return false;

    const words = text.split(/\s+/);
    const isProviderCommand = words[0] === '/provider';
    const parts = words.slice(1);
    if (isProviderCommand && parts[0] === 'openrouter') {
      parts.shift();
    }
    if (parts.length === 0) {
      this.bridge.emitCommandResponse(sessionId, await this.renderModelPicker(sessionId));
      return true;
    }

    const resolved = await this.resolveModelSelection(parts);
    if (!resolved) {
      this.bridge.emitCommandResponse(sessionId, `Unknown model selection: ${parts.join(' ')}\n\n${await this.renderModelPicker(sessionId)}`);
      return true;
    }

    const loaded = await loadConfig();
    const config = loaded.isErr()
      ? ({ defaultProvider: resolved.provider, providers: {} } as UserConfig)
      : (loaded.value as UserConfig);
    const providerConfig = this.providerConfigForSelection(config, resolved.provider);
    const currentConfig = this.llmFor(sessionId)?.getConfig();
    const runtime = resolveProviderRuntime({
      provider: resolved.provider,
      model: resolved.model,
      configuredBaseUrl: providerConfig.baseUrl,
      configuredApiKey: providerConfig.apiKey,
      current: currentConfig ? {
        provider: this.providerLabel(currentConfig.baseUrl, currentConfig.model),
        baseUrl: currentConfig.baseUrl,
        apiKey: currentConfig.apiKey,
      } : undefined,
      env: process.env,
    });

    if (runtime.requiresKey && !runtime.apiKey) {
      this.bridge.emitCommandResponse(sessionId, `${runtime.label} API key not found. Set providers.${resolved.provider}.apiKey in ~/.sinter/config.json before switching.`);
      return true;
    }

    const picked = new RuntimeLLMClient({
      role: 'studio',
      baseUrl: runtime.baseUrl,
      model: runtime.model,
      apiKey: runtime.apiKey ?? '',
      temperature: 0.5,
      maxTokens: 4096,
      harnessTransportAuthority: this.harnessTransportAuthority,
    });
    this.sessionLlm.set(sessionId, picked);

    this.bridge.updateStatus(sessionId, {
      provider: runtime.statusProvider,
      model: runtime.model,
      activeTask: `Studio dialogue model switched to ${resolved.label}`,
      executor: picked.getHarnessExecutorProjection(),
    });
    this.bridge.emitCommandResponse(sessionId, `Switched Studio dialogue model to ${resolved.label} (${runtime.model}) via ${runtime.label}\nScope: this session's Studio dialogue only (other sessions keep their model). Governed Create keeps using the configured generator seat (roles.generator).\nExecutor truth: ${formatHarnessExecutorProjection(picked.getHarnessExecutorProjection())}`);
    return true;
  }

  private providerConfigForSelection(
    config: UserConfig,
    provider: RuntimeProviderKey,
  ): { baseUrl?: string; model?: string; apiKey?: string } {
    const providerConfig = config.providers?.[provider];
    if (providerConfig) return providerConfig;

    // Backward compatibility: older configs stored OpenAI-compatible GPT
    // selections under `custom`. Read that key when switching to the new
    // first-class `openai` provider, but save future selections as `openai`.
    const legacyCustom = config.providers?.custom;
    if (provider === 'openai' && legacyCustom) {
      const legacyProvider = detectProviderLabel(
        legacyCustom.baseUrl ?? PROVIDER_DEFAULTS.openai.baseUrl,
        legacyCustom.model,
      );
      if (legacyProvider === 'openai') return legacyCustom;
    }

    return {};
  }

  private async renderModelPicker(sessionId: string): Promise<string> {
    const loaded = await loadConfig();
    const config = loaded.isErr() ? undefined : (loaded.value as UserConfig);
    const currentConfig = this.llmFor(sessionId)?.getConfig();
    const currentModel = currentConfig?.model;
    const currentProvider = currentConfig?.baseUrl ? this.providerLabel(currentConfig.baseUrl, currentConfig.model) : config?.defaultProvider;
    const lines = [
      'Model picker:',
      `Current: ${currentProvider || 'unknown'}/${currentModel || 'unknown'}`,
      '',
      'Type /model NUMBER, /model PROVIDER, or /model PROVIDER MODEL',
      '',
    ];
    MODEL_CHOICES.forEach((choice, index) => {
      const marker = choice.model === currentModel ? ' (current)' : '';
      lines.push(`${String(index + 1).padStart(2, ' ')}. ${PROVIDER_DEFAULTS[choice.provider].label.padEnd(10)} ${choice.label.padEnd(18)} ${choice.model}${marker}`);
    });
    lines.push('');
    lines.push('Examples: /model 1, /model glm 5v, /model openai gpt-5.4-mini, /model lmstudio, /model ollama llama3.2, /model minimax m3');
    return lines.join('\n');
  }

  private async resolveModelSelection(parts: string[]): Promise<ModelChoice | null> {
    const first = parts[0]?.toLowerCase();
    const numericChoice = Number(first);
    if (Number.isInteger(numericChoice) && numericChoice >= 1 && numericChoice <= MODEL_CHOICES.length) {
      return MODEL_CHOICES[numericChoice - 1];
    }

    const provider = resolveProviderToken(first);
    if (!provider) {
      return resolveChoiceByAlias(parts.join(' '));
    }

    const selection = parts.slice(1).join(' ').trim();
    if (!selection) {
      const loaded = await loadConfig();
      const config = loaded.isErr() ? undefined : (loaded.value as UserConfig);
      const configuredModel = config?.providers?.[provider]?.model;
      return {
        provider,
        label: configuredModel || PROVIDER_DEFAULTS[provider].model,
        model: configuredModel || PROVIDER_DEFAULTS[provider].model,
        aliases: [],
      };
    }

    if (provider === 'openrouter') {
      const openRouterChoice = resolveOpenRouterChoice(selection);
      if (openRouterChoice) return openRouterChoice;
    }

    const providerChoice = findModelChoice(provider, selection);
    return providerChoice ?? {
      provider,
      label: selection,
      model: selection,
      aliases: [],
    };
  }

  private readBody(req: IncomingMessage): Promise<string> {
    // Bounded: the unbounded accumulator was an O(n^2) string concat and an
    // unauthenticated memory sink. Oversize rejects with statusCode 413,
    // which handleRequest maps to the response.
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > 1024 * 1024) {
          req.removeAllListeners('data');
          req.resume();
          const err = new Error('Request body too large') as Error & { statusCode?: number };
          err.statusCode = 413;
          reject(err);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PreviewEndpoints — single source of truth for the preview HTTP surface.
//
// Lives in TuiBridgeServer.ts per the brief: "Re-implement PreviewServer
// behavior as raw-HTTP handlers in TuiBridgeServer's existing regex-dispatch
// style; do not introduce an Express router into the bridge or duplicate
// business logic outside PreviewService." All preview routes — `/`, `/preview`,
// `/api/csp-report`, `/api/csrf-token`, `/api/gallery`, `/api/gallery/:project`,
// `/api/sinter/gallery/:project`, `/api/sinter/gallery/:project/:version`,
// `/api/preview/versions`, `/api/sandbox/run`, `/gui`, `/gui/*`, `/api/events`,
// `/api/status`, `/api/compost/seeds`, `/api/export` — are implemented here.
//
// Both TuiBridgeServer and the thin PreviewServer adapter route through this
// class, so there is exactly one implementation of each handler.
// ─────────────────────────────────────────────────────────────────────────────

export class PreviewEndpoints {
  private currentSketch = '';
  /** When the current sketch was last set; a newer saved artifact outranks an older sketch at `/` (Sol F14). */
  private currentSketchAt = 0;
  private versionedSketches: Map<number, string> = new Map();
  private galleryDir: string | null;
  private artifactsDir: string | null;
  private sseClients: Set<ServerResponse> = new Set();
  private sinterFsInstance: SinterFS | null = null;
  private readonly standardLimiter: IpRateLimiter;
  private readonly exportLimiter: IpRateLimiter;
  private readonly sandboxLimiter: IpRateLimiter;
  /** CSRF secret — per-process HMAC key for the double-submit cookie pattern. */
  private readonly csrfSecret: string;
  private readonly isTestEnv: boolean;
  private readonly isProduction: boolean;
  /** Used to detach EventBus listeners when this instance shuts down. */
  private readonly unsubscribeEventBus: () => void;

  constructor(options: PreviewEndpointsOptions = {}) {
    this.galleryDir = options.galleryDir ?? null;
    this.artifactsDir = options.artifactsDir ?? null;
    this.isTestEnv = process.env.NODE_ENV === 'test';
    this.isProduction = process.env.NODE_ENV === 'production';
    this.standardLimiter = new IpRateLimiter('standard', {
      windowMs: rateLimitEnvMinutes('LIMINAL_RATE_LIMIT_WINDOW_MINUTES', 15) * 60_000,
      max: rateLimitEnvMax('LIMINAL_RATE_LIMIT_GENERAL', 100),
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
    });
    this.exportLimiter = new IpRateLimiter('Export', {
      windowMs: rateLimitEnvMinutes('LIMINAL_RATE_LIMIT_EXPORT_WINDOW_MINUTES', 60) * 60_000,
      max: rateLimitEnvMax('LIMINAL_RATE_LIMIT_EXPORT', 10),
      error: 'Export rate limit exceeded',
      message: 'Export operations are limited to prevent resource exhaustion. Please try again later.',
    });
    this.sandboxLimiter = new IpRateLimiter('Sandbox', {
      windowMs: rateLimitEnvMinutes('LIMINAL_RATE_LIMIT_SANDBOX_WINDOW_MINUTES', 15) * 60_000,
      max: rateLimitEnvMax('LIMINAL_RATE_LIMIT_SANDBOX', 30),
      error: 'Sandbox rate limit exceeded',
      message: 'Sandbox operations are rate limited. Please try again later.',
    });
    this.csrfSecret = this.resolveCsrfSecret();
    this.unsubscribeEventBus = this.subscribeEventBus();
  }

  setGalleryDir(dir: string | null): void {
    this.galleryDir = dir;
  }

  setArtifactsDir(dir: string | null): void {
    this.artifactsDir = dir;
  }

  /** Saved `generate` output: one folder per artwork holding playable.html (+ optional provenance.txt). */
  private async listSavedArtifacts(): Promise<Array<{ id: string; domain: string; playable: string; mtimeMs: number }>> {
    if (!this.artifactsDir) return [];
    let names: string[];
    try {
      names = await readdir(this.artifactsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: Array<{ id: string; domain: string; playable: string; mtimeMs: number }> = [];
    for (const id of names) {
      const playable = path.join(this.artifactsDir, id, 'playable.html');
      let mtimeMs: number;
      try { mtimeMs = (await stat(playable)).mtimeMs; } catch { continue; }
      let domain = '';
      try {
        const provenance = JSON.parse(await readFile(path.join(this.artifactsDir, id, 'provenance.txt'), 'utf8')) as { domain?: unknown };
        if (typeof provenance.domain === 'string') domain = provenance.domain;
      } catch { /* provenance is optional */ }
      out.push({ id, domain, playable, mtimeMs });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  serveSketch(code: string | null, atMs: number = Date.now()): void {
    this.currentSketch = code || '';
    this.currentSketchAt = atMs;
  }

  setVersionCode(version: number, code: string): void {
    if (version > 0 && Number.isInteger(version)) {
      this.versionedSketches.set(version, code ?? '');
    }
  }

  setAllVersions(iterations: VersionedIteration[]): void {
    this.versionedSketches.clear();
    for (const it of iterations || []) {
      if (it.version > 0 && Number.isInteger(it.version)) {
        this.versionedSketches.set(it.version, it.code ?? '');
      }
    }
  }

  /** Read-only access to the current sketch (used by the thin adapter). */
  getCurrentSketch(): string {
    return this.currentSketch;
  }

  /**
   * Detach the EventBus listener and close any open SinterFS handle. Called
   * from the thin `PreviewServer.stop()` so test teardown matches the
   * original lifecycle (and from the bridge's process-exit path).
   */
  shutdown(): void {
    this.unsubscribeEventBus();
    this.closeSinterFS();
  }

  /**
   * Regex-dispatch entry point used by TuiBridgeServer. Returns true if a
   * preview route matched (and the response was already written). Returns
   * false otherwise so the caller can fall through to a 404.
   */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    // Helmet-equivalent security headers — every preview response gets them,
    // matching the original Express middleware behavior. Body-content paths
    // skip frameguard/COEP/COOP, which the Express config disabled globally.
    this.applySecurityHeaders(res);

    // State-changing preview POSTs require a valid CSRF token (mirrors the
    // double-submit pattern used in the original implementation): the
    // `x-csrf-token` header must match the signed `x-csrf-token` cookie.
    // GET/HEAD are exempt. The token is delivered by /api/csrf-token below.
    if (this.requiresCsrf(req.method ?? 'GET', pathname)) {
      if (!this.verifyCsrf(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid csrf token' }));
        return true;
      }
    }

    // Standard limiter applies to every /api/* route, mirroring the original
    // `app.use('/api/', standardLimiter)`. The stricter export/sandbox limiters
    // stack on top of it at their routes below, as they did under Express.
    // `/api/status` stays unthrottled in development, matching the original
    // limiter's skip rule.
    if (pathname.startsWith('/api/')) {
      const skipStatusInDev = process.env.NODE_ENV === 'development' && pathname === '/api/status';
      if (!skipStatusInDev && !this.standardLimiter.consume(req, res)) return true;
    }

    // Static `/gui` and `/gui/*` — serve files from cwd/gui with path-traversal
    // rejection. Matches the original `express.static(guiDir, { index: 'index.html' })`
    // behavior. We let `GET /gui` fall through to the index handler below.
    if (req.method === 'GET' && pathname.startsWith('/gui/')) {
      await this.serveGuiStatic(req, res, pathname);
      return true;
    }

    // Vendored libraries. Playables load p5/Strudel/Hydra from root-absolute
    // /vendor/... URLs, so `sinter serve` must answer them or the stage stays
    // blank. Only registered files are served; anything else is a 404.
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/vendor/')) {
      if (!isVendorAssetPath(pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return true;
      }
      try {
        const body = await readVendorAsset(pathname);
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
      return true;
    }

    // Root: serve the current sketch as a wrapped HTML page.
    if (req.method === 'GET' && pathname === '/') {
      // Same selection as /api/gallery: the newest saved artifact's playable page wins over an older (or absent)
      // sketch; with nothing to show the page says so instead of rendering an empty canvas.
      let html: string;
      const latest = (await this.listSavedArtifacts())[0];
      if (latest && (!this.currentSketch || latest.mtimeMs >= this.currentSketchAt)) {
        html = await readFile(latest.playable, 'utf8');
      } else if (this.currentSketch) {
        html = HTMLWrapper.wrap(this.currentSketch);
      } else {
        html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nothing to preview yet</title></head>'
          + '<body style="font-family:sans-serif;background:#0b0d12;color:#e8ecf4;padding:2rem"><h1>Nothing to preview yet</h1>'
          + '<p>No saved artwork was found. Run <code>sinter generate --prompt "your idea"</code>, then reload.</p></body></html>';
      }
      this.sandboxGeneratedPage(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return true;
    }

    // /preview?version=N — same wrapping, but reads from versioned sketches
    // when an integer > 0 is supplied.
    if (req.method === 'GET' && pathname === '/preview') {
      const versionParam = url.searchParams.get('version');
      const version = versionParam != null ? Number(versionParam) : NaN;
      const code = Number.isInteger(version) && version > 0
        ? (this.versionedSketches.get(version) ?? '')
        : this.currentSketch;
      this.sandboxGeneratedPage(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTMLWrapper.wrap(code || ''));
      return true;
    }

    if (req.method === 'GET' && pathname === '/gui') {
      await this.serveGuiIndex(res);
      return true;
    }

    // CSP report endpoint — accepts the browser's JSON-CSP-report payload and
    // logs only the non-sensitive fields, identical to the original. Body cap
    // stays at the original express.json default (100kb), not the 10mb used
    // by the sketch/export routes.
    if (req.method === 'POST' && pathname === '/api/csp-report') {
      const raw = await this.readBodyWithLimit(req, 100 * 1024);
      try {
        const report = raw ? JSON.parse(raw) : {};
        const csp = report['csp-report'];
        if (csp) {
          Logger.warn('PreviewServer', '[CSP Violation]', {
            'document-uri': csp['document-uri'],
            'violated-directive': csp['violated-directive'],
            'blocked-uri': csp['blocked-uri'],
          });
        }
      } catch {
        // Bad JSON — still return 204 like the original; don't leak parser errors.
      }
      res.writeHead(204);
      res.end();
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/csrf-token') {
      this.issueCsrfToken(res);
      return true;
    }

    // /api/gallery — list of project directories under galleryDir.
    if (req.method === 'GET' && pathname === '/api/gallery') {
      try {
        const projects = this.galleryDir ? await new Gallery(this.galleryDir).listProjectDirs() : [];
        this.jsonOk(res, { projects, artifacts: await this.listSavedArtifacts() });
      } catch (err) {
        Logger.error('PreviewServer', 'Failed to list gallery:', err);
        this.jsonErr(res, 500, 'Failed to list gallery');
      }
      return true;
    }

    // /api/gallery/:project — load full history for one project.
    const galleryMatch = pathname.match(/^\/api\/gallery\/([^/]+)$/);
    if (req.method === 'GET' && galleryMatch) {
      if (!this.galleryDir) {
        this.jsonOk(res, { iterations: [] });
        return true;
      }
      try {
        const projectDirName = decodeURIComponent(galleryMatch[1]);
        const gallery = new Gallery(this.galleryDir);
        const iterations = await gallery.loadHistoryFromDir(projectDirName);
        this.jsonOk(res, { iterations });
      } catch (err) {
        Logger.error('PreviewServer', 'Failed to load project:', err);
        this.jsonErr(res, 500, 'Failed to load project');
      }
      return true;
    }

    // /api/sinter/gallery/:project — SinterFS-backed gallery list.
    const sinterGalleryMatch = pathname.match(/^\/api\/sinter\/gallery\/([^/]+)$/);
    if (req.method === 'GET' && sinterGalleryMatch) {
      const project = decodeURIComponent(sinterGalleryMatch[1]);
      try {
        assertSafeSegment(project, 'Project name');
      } catch {
        this.jsonErr(res, 400, 'Invalid project name');
        return true;
      }
      try {
        const sinterFs = this.getSinterFS();
        const refsDir = path.join(sinterFs.getProjectRoot(), '.sinter', 'refs', 'gallery', project);
        if (!existsSync(refsDir)) {
          this.jsonOk(res, { iterations: [] });
          return true;
        }
        const files = await readdir(refsDir);
        const versionFiles = files.filter((f) => /^v(\d+)\.json$/.test(f));
        const iterations: GalleryIteration[] = [];
        await Promise.all(versionFiles.map(async (file) => {
          const match = file.match(/^v(\d+)\.json$/);
          if (!match) return;
          const version = parseInt(match[1], 10);
          const ref = sinterFs.readRef(`gallery/${project}/v${version}`);
          if (!ref) return;
          const content = sinterFs.readArtifact(ref);
          if (!content) return;
          const raw = content.toString('utf-8');
          const fileStat = await stat(path.join(refsDir, file));
          const timestamp = fileStat.mtime?.toISOString() ?? new Date().toISOString();
          const parsed = parseVersionContent(raw, version, timestamp);
          if (parsed) iterations.push(parsed);
        }));
        iterations.sort((a, b) => a.version - b.version);
        this.jsonOk(res, { iterations });
      } catch (err) {
        Logger.error('PreviewServer', 'Failed to load SinterFS gallery:', err);
        this.jsonErr(res, 500, 'Failed to load gallery');
      }
      return true;
    }

    // /api/sinter/gallery/:project/:version — SinterFS-backed single version.
    const sinterVersionMatch = pathname.match(/^\/api\/sinter\/gallery\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && sinterVersionMatch) {
      const project = decodeURIComponent(sinterVersionMatch[1]);
      const versionParam = sinterVersionMatch[2];
      if (!/^\d+$/.test(versionParam)) {
        this.jsonErr(res, 400, 'Invalid version');
        return true;
      }
      const version = parseInt(versionParam, 10);
      if (version <= 0) {
        this.jsonErr(res, 400, 'Invalid version');
        return true;
      }
      try {
        assertSafeSegment(project, 'Project name');
      } catch {
        this.jsonErr(res, 400, 'Invalid project name');
        return true;
      }
      try {
        const sinterFs = this.getSinterFS();
        const ref = sinterFs.readRef(`gallery/${project}/v${version}`);
        if (!ref) {
          this.jsonErr(res, 404, 'Version not found');
          return true;
        }
        const content = sinterFs.readArtifact(ref);
        if (!content) {
          this.jsonErr(res, 404, 'Artifact not found');
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(content.toString('utf-8'));
      } catch (err) {
        Logger.error('PreviewServer', 'Failed to load SinterFS version:', err);
        this.jsonErr(res, 500, 'Failed to load version');
      }
      return true;
    }

    // /api/preview/versions — bulk-set the version→code map.
    if (req.method === 'POST' && pathname === '/api/preview/versions') {
      const raw = await this.readBodyWithLimit(req, 10 * 1024 * 1024);
      let body: { iterations?: Array<{ version?: number; code?: string; timestamp?: string }> } = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const iterations = Array.isArray(body?.iterations) ? body.iterations : [];
      this.setAllVersions(iterations.map((it) => ({
        version: typeof it.version === 'number' ? it.version : parseInt(String(it.version), 10) || 1,
        code: typeof it.code === 'string' ? it.code : '',
        timestamp: typeof it.timestamp === 'string' ? it.timestamp : undefined,
      })));
      this.jsonOk(res, { ok: true });
      return true;
    }

    // /api/sandbox/run — store a version and return the preview URL.
    if (req.method === 'POST' && pathname === '/api/sandbox/run') {
      if (!this.sandboxLimiter.consume(req, res)) return true;
      const raw = await this.readBodyWithLimit(req, 10 * 1024 * 1024);
      let body: { code?: string; version?: number } = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const code = typeof body?.code === 'string' ? body.code : '';
      const version = Number.isInteger(body?.version) && (body?.version as number) > 0
        ? (body.version as number)
        : 1;
      this.setVersionCode(version, code);
      this.serveSketch(code);
      this.jsonOk(res, { url: `/preview?version=${version}` });
      return true;
    }

    // /api/events — SSE stream of EventBus activity, replay-on-attach included.
    if (req.method === 'GET' && pathname === '/api/events') {
      this.startEventsSSE(req, res);
      return true;
    }

    // /api/status — mill/loop snapshot.
    if (req.method === 'GET' && pathname === '/api/status') {
      await this.handleStatus(res);
      return true;
    }

    // /api/compost/seeds — first 50 seeds.
    if (req.method === 'GET' && pathname === '/api/compost/seeds') {
      await this.handleSeeds(res);
      return true;
    }

    // /api/export — html/js/zip.
    if (req.method === 'POST' && pathname === '/api/export') {
      if (!this.exportLimiter.consume(req, res)) return true;
      await this.handleExport(req, res);
      return true;
    }

    return false;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private resolveCsrfSecret(): string {
    if (process.env.CSRF_SECRET) return process.env.CSRF_SECRET;
    if (this.isTestEnv) return 'test-secret';
    if (this.isProduction) {
      throw new Error('CSRF_SECRET environment variable is required');
    }
    // eslint-disable-next-line no-console -- intentional dev-time security notice
    console.warn('[PreviewServer] CSRF_SECRET not set — using an ephemeral dev secret. Set CSRF_SECRET for production.');
    return randomBytes(32).toString('hex');
  }

  private csrfSignature(token: string): string {
    return createHmac('sha256', this.csrfSecret).update(token).digest('hex');
  }

  /**
   * Issue a fresh CSRF token and set the signed double-submit cookie, matching
   * the original `doubleCsrf` behavior: the client must echo the token in the
   * `x-csrf-token` header AND present the cookie on state-changing requests.
   * In the test environment the protection middleware was a no-op, so we keep
   * returning the dummy `test-token` without a cookie.
   */
  private issueCsrfToken(res: ServerResponse): void {
    if (this.isTestEnv) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ csrfToken: 'test-token' }));
      return;
    }
    const token = randomBytes(32).toString('hex');
    const cookie = `x-csrf-token=${token}.${this.csrfSignature(token)}; HttpOnly; SameSite=Strict; Path=/${this.isProduction ? '; Secure' : ''}`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    });
    res.end(JSON.stringify({ csrfToken: token }));
  }

  private verifyCsrf(req: IncomingMessage): boolean {
    if (this.isTestEnv) return true;
    const supplied = (req.headers['x-csrf-token'] as string | undefined) ?? '';
    const cookieHeader = req.headers.cookie ?? '';
    const cookiePair = cookieHeader.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('x-csrf-token='));
    const cookieValue = cookiePair ? cookiePair.slice('x-csrf-token='.length) : '';
    if (!supplied || !cookieValue) return false;
    const dot = cookieValue.lastIndexOf('.');
    if (dot <= 0) return false;
    const cookieToken = cookieValue.slice(0, dot);
    const signature = cookieValue.slice(dot + 1);
    if (cookieToken !== supplied) return false;
    const expected = this.csrfSignature(cookieToken);
    if (signature.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < signature.length; i++) {
      diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }

  private requiresCsrf(method: string, pathname: string): boolean {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    return pathname === '/api/preview/versions'
      || pathname === '/api/sandbox/run'
      || pathname === '/api/export';
  }

  /**
   * Generated code runs in an opaque origin, as Studio's stage does: it keeps
   * its scripts but cannot read cookies or call this server's API as the user.
   */
  private sandboxGeneratedPage(res: ServerResponse): void {
    const csp = String(res.getHeader('Content-Security-Policy') ?? '');
    res.setHeader('Content-Security-Policy', csp ? `${csp}; sandbox allow-scripts` : 'sandbox allow-scripts');
  }

  private applySecurityHeaders(res: ServerResponse): void {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      // Vendor-local (#924): libraries load from /vendor on this origin.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "media-src 'self'",
      "frame-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "script-src-attr 'none'",
      "upgrade-insecure-requests",
    ].join('; '));
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  }

  private jsonOk(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private jsonErr(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  }

  private readBodyWithLimit(req: IncomingMessage, limitBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > limitBytes) {
          // Stop accumulating and drain the rest so the socket stays usable;
          // the caller's catch maps statusCode 413 to the HTTP response,
          // matching the original body-parser behavior.
          req.removeAllListeners('data');
          req.resume();
          const err = new Error('Request body too large') as Error & { statusCode?: number };
          err.statusCode = 413;
          reject(err);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private readJsonBody<T>(req: IncomingMessage, limitBytes: number): Promise<T> {
    return this.readBodyWithLimit(req, limitBytes).then((raw) => {
      if (!raw) return {} as T;
      try { return JSON.parse(raw) as T; } catch { return {} as T; }
    });
  }

  private getSinterFS(): SinterFS {
    if (!this.sinterFsInstance) this.sinterFsInstance = SinterFS.open(resolveSinterProjectRoot());
    return this.sinterFsInstance;
  }

  /**
   * Release the lazily-opened SinterFS handle. Called from the thin
   * PreviewServer.stop() so test teardown matches the original lifecycle.
   */
  closeSinterFS(): void {
    if (this.sinterFsInstance) {
      this.sinterFsInstance.close();
      this.sinterFsInstance = null;
    }
  }

  private subscribeEventBus(): () => void {
    const listener = (event: BusEvent) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of this.sseClients) {
        try {
          client.write(data);
        } catch (err) {
          Logger.warn('PreviewServer', 'Failed to write to SSE client, removing:', err);
          this.sseClients.delete(client);
        }
      }
    };
    eventBus.onEvent(listener);
    return () => eventBus.offEvent(listener);
  }

  private startEventsSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    writeSse(res, ': connected\n\n');

    const recent = eventBus.getRecentEvents();
    for (const event of recent) {
      if (!writeSse(res, `data: ${JSON.stringify(event)}\n\n`)) return;
    }

    this.sseClients.add(res);
    const close = () => {
      this.sseClients.delete(res);
    };
    req.on('close', close);
  }

  private async handleStatus(res: ServerResponse): Promise<void> {
    const projectStore = new ProjectStore({ projectRoot: resolveSinterProjectRoot() });
    projectStore.init();
    try {
      const { openCompostMill } = await import('../compost/openCompostMill.js');
      const LLMClient = (await import('../llm/LLMClient.js')).LLMClient;
      const llm = new LLMClient({ role: 'generator' });
      const mill = openCompostMill({ llm, projectStore });
      const millStatus = await mill.statusAsync();
      const loopProgress = await import('../core/RalphLoop.js').then((m) => m.RalphLoop.getProgress());
      this.jsonOk(res, {
        heapSize: millStatus.heapSize,
        heapFileCount: millStatus.heapFileCount,
        seedCount: millStatus.seedCount,
        soupRunning: millStatus.soupRunning,
        loopProgress,
        recentEvents: eventBus.getRecentEvents().slice(-20),
      });
    } catch (err) {
      Logger.error('PreviewServer', 'Status endpoint error:', err);
      this.jsonErr(res, 500, 'Status unavailable');
    } finally {
      projectStore.close();
    }
  }

  private async handleSeeds(res: ServerResponse): Promise<void> {
    const projectStore = new ProjectStore({ projectRoot: resolveSinterProjectRoot() });
    projectStore.init();
    try {
      const { openCompostMill } = await import('../compost/openCompostMill.js');
      const LLMClient = (await import('../llm/LLMClient.js')).LLMClient;
      const llm = new LLMClient({ role: 'generator' });
      const mill = openCompostMill({ llm, projectStore });
      const seeds = await mill.listSeeds();
      this.jsonOk(res, { seeds: seeds.slice(0, 50), total: seeds.length });
    } catch (err) {
      Logger.error('PreviewServer', 'Seed query failed:', err);
      this.jsonErr(res, 500, 'Seed query failed');
    } finally {
      projectStore.close();
    }
  }

  private async handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<{
      code?: string; format?: string; outputPath?: string;
      projectName?: string; iterations?: Array<{ version?: number; code?: string; timestamp?: string }>;
    }>(req, 10 * 1024 * 1024);
    const { code, format, outputPath: reqPath, projectName, iterations: reqIterations } = body || {};
    const fmt = (format || 'html').toLowerCase();
    if (!['html', 'js', 'zip'].includes(fmt)) {
      this.jsonErr(res, 400, 'format must be html, js, or zip');
      return;
    }
    const exporter = new Exporter();
    const cwd = process.cwd();
    const baseDir = path.join(cwd, 'output');
    const defaultName = projectName || 'export';
    const requestedPath = reqPath || path.join(baseDir, `${defaultName}.${fmt === 'zip' ? 'zip' : fmt === 'html' ? 'html' : 'js'}`);
    try {
      const resolvedPath = normalizePath(cwd, requestedPath);
      if (fmt === 'zip') {
        const project = {
          name: projectName || 'project',
          iterations: Array.isArray(reqIterations)
            ? reqIterations.map((it) => ({
                version: typeof it.version === 'number' ? it.version : parseInt(String(it.version), 10) || 1,
                code: typeof it.code === 'string' ? it.code : '',
                timestamp: typeof it.timestamp === 'string' ? it.timestamp : new Date().toISOString(),
              }))
            : [],
        };
        if (project.iterations.length === 0 && code) {
          project.iterations = [{ version: 1, code, timestamp: new Date().toISOString() }];
        }
        await exporter.exportZIP(project, resolvedPath);
      } else if (fmt === 'html') {
        try { validateCode(code); } catch { this.jsonErr(res, 400, 'code is required for html export'); return; }
        await exporter.exportHTML(code!, resolvedPath);
      } else {
        try { validateCode(code); } catch { this.jsonErr(res, 400, 'code is required for js export'); return; }
        await exporter.exportJS(code!, resolvedPath);
      }
      this.jsonOk(res, { path: resolvedPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Export failed';
      if (msg.includes('Path traversal') || msg.includes('path separators')) {
        this.jsonErr(res, 400, msg);
        return;
      }
      Logger.error('PreviewServer', 'Export failed:', err);
      this.jsonErr(res, 500, 'Export failed');
    }
  }

  // ── /gui static serving ───────────────────────────────────────────────────

  private guiDir(): string {
    return path.join(process.cwd(), 'gui');
  }

  private async serveGuiIndex(res: ServerResponse): Promise<void> {
    const indexPath = path.join(this.guiDir(), 'index.html');
    try {
      const data = await fs.promises.readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch {
      this.jsonErr(res, 404, 'Not found');
    }
  }

  private async serveGuiStatic(_req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    // Strip `/gui/` prefix; reject any traversal.
    const rel = pathname.slice('/gui/'.length);
    if (!rel || rel.includes('..')) {
      this.jsonErr(res, 400, 'Invalid path');
      return;
    }
    const base = path.resolve(this.guiDir());
    const target = path.resolve(base, rel);
    const relPath = path.relative(base, target);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      this.jsonErr(res, 400, 'Invalid path');
      return;
    }
    try {
      const data = await fs.promises.readFile(target);
      const type = this.guessContentType(target);
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    } catch {
      this.jsonErr(res, 404, 'Not found');
    }
  }

  private guessContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.html': return 'text/html; charset=utf-8';
      case '.js':   return 'application/javascript; charset=utf-8';
      case '.mjs':  return 'application/javascript; charset=utf-8';
      case '.css':  return 'text/css; charset=utf-8';
      case '.json': return 'application/json; charset=utf-8';
      case '.svg':  return 'image/svg+xml';
      case '.png':  return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.gif':  return 'image/gif';
      case '.webp': return 'image/webp';
      case '.ico':  return 'image/x-icon';
      case '.woff': return 'font/woff';
      case '.woff2': return 'font/woff2';
      case '.ttf':  return 'font/ttf';
      case '.map':  return 'application/json; charset=utf-8';
      case '.txt':  return 'text/plain; charset=utf-8';
      default:      return 'application/octet-stream';
    }
  }
}
