/**
 * BlenderReadiness - can this host render a Blender piece at all?
 *
 * Checked BEFORE any model call. Without it a host with no Blender (or no OS
 * sandbox: macOS, Kaggle without bwrap) burns a full generation per prompt and
 * then reports a "degraded, no real score" row that looks like a model failure
 * (v16 batch 2026-11-16: 10 blender rows, all "Blender executable not found").
 */

import { BLENDER_BINARY_ENV, BLENDER_DEFAULT_BINARY, BLENDER_INSTALL_HINT } from './BlenderRenderer.js';
import { buildSandboxedCommand, hostSandboxDeps, type SandboxDeps } from './BlenderSandbox.js';

export interface BlenderReadiness {
  ready: boolean;
  /** One line per missing piece; empty when ready. */
  problems: string[];
}

export function checkBlenderReadiness(
  platform: NodeJS.Platform = process.platform,
  deps: SandboxDeps = hostSandboxDeps(),
): BlenderReadiness {
  const problems: string[] = [];
  const binary = deps.hostEnv[BLENDER_BINARY_ENV] || BLENDER_DEFAULT_BINARY;
  if (!deps.which(binary)) {
    problems.push(`Blender executable not found: "${binary}". ${BLENDER_INSTALL_HINT}, or set ${BLENDER_BINARY_ENV} to the full path.`);
  } else {
    // Same plan the renderer builds, with placeholder dirs: surfaces bwrap/macOS/home-dir refusals now.
    const plan = buildSandboxedCommand(platform, {
      command: binary, args: [], cwd: '/tmp',
      env: { SINTER_BLENDER_OUT: '/tmp', SINTER_BLENDER_SCRIPT: '/tmp/script.py' },
    }, deps);
    if (!plan.ok) problems.push(plan.message);
  }
  return { ready: problems.length === 0, problems };
}

/** Throws `BLENDER_LANE_NOT_READY` with every problem; call before spending tokens. */
export function assertBlenderReady(
  platform: NodeJS.Platform = process.platform,
  deps: SandboxDeps = hostSandboxDeps(),
): void {
  const { ready, problems } = checkBlenderReadiness(platform, deps);
  if (!ready) throw new Error(`BLENDER_LANE_NOT_READY: this host cannot render Blender, so no model call was made. ${problems.join(' ')}`);
}
