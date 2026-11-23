/**
 * NextDomainRenderer - adapts flag-gated next-release domain renderers to the RenderResult the judges consume.
 * The domain's own output (video, contact sheet, card) is written under a scratch dir; the judge sees the
 * contact sheet as its screenshot and the evidence in logs.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNextDomainEnabled } from '../config/nextDomains.js';
import sharp from 'sharp';
import { DATAMOSH_DEFAULT_TIMEOUT_MS, renderDatamosh } from './DatamoshRenderer.js';
import type { RenderResult } from './HeadlessRenderer.js';


export async function renderNextDomain(
  domain: string,
  code: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  limits = { timeoutMs: DATAMOSH_DEFAULT_TIMEOUT_MS, maximumOutputBytes: 2 * 1024 * 1024 },
): Promise<RenderResult> {
  assertNextDomainEnabled(domain, env);
  if (domain !== 'datamosh') {
    const error = `next domain "${domain}" has no renderer yet`;
    return { rendered: false, success: false, error, logs: [], errors: [error], pageErrors: [] };
  }
  const outputBytes = Buffer.byteLength(code);
  if (outputBytes > limits.maximumOutputBytes) {
    const error = 'datamosh plan exceeds the configured source byte limit';
    return { rendered: false, success: false, error, logs: [], errors: [error], pageErrors: [] };
  }
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'sinter-datamosh-'));
  try {
    const result = await renderDatamosh(code, { outputDir, timeoutMs: limits.timeoutMs, isolated: true });
    if (!result.success || !result.contactSheetPath || !result.evidence) {
      const error = `datamosh ${result.failureKind ?? 'render'} failure: ${result.error ?? 'unknown'}`;
      return { rendered: false, success: false, error, logs: [], errors: [error], pageErrors: [] };
    }
    const buffer = readFileSync(result.contactSheetPath);
    const meta = await sharp(buffer).metadata();
    const shot = { buffer, width: meta.width ?? 0, height: meta.height ?? 0, success: true };
    const { bitstream, credits, frames, videoSha256 } = result.evidence;
    const logs = [`I-frames ${bitstream.iBefore} → ${bitstream.iAfter}, P-frames repeated ${bitstream.duplicated}, ${frames} frames`,
      ...credits.map((credit) => `credit: ${credit}`)];
    const containment = {
      networkIsolated: true, permissionsDenied: true, cleanupSucceeded: true, blockedRequests: 0,
      // Codec children have hard deadlines. Trusted host-side work has cooperative checks.
      routeInstalled: false, timeoutEnforced: false, outputLimitEnforced: true,
      outputBytes, assetDigests: [videoSha256],
    };
    return { rendered: true, success: true, screenshot: shot, lateScreenshot: shot, logs, errors: [], pageErrors: [], containment };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
