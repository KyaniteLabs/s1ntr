/**
 * BlenderSandbox - wrap the Blender spawn in a real OS sandbox, fail closed.
 *
 * Model-written Python runs inside Blender. In-process guards (the denylist and
 * the driver's monkeypatches) are bypassable, so the boundary is the OS:
 *
 *  - Linux: `bwrap --unshare-all` (new user/pid/ipc/uts/cgroup/NET namespaces),
 *    `--die-with-parent`, `--new-session`. The filesystem is a minimal read-only
 *    view (/usr, /lib*, /bin, /sbin, fonts, ld.so.cache, the blender binary's
 *    directory, the input dir). The output dir is the ONLY writable bind. /tmp
 *    is a fresh tmpfs. The environment is rebuilt with --clearenv/--setenv.
 *  - macOS: not sandboxed yet (sandbox-exec cannot stop exec/mach escapes): unavailable.
 *  - Anything else, or no wrapper installed: no sandbox plan (`ok: false`), and
 *    the render fails with failureKind 'sandbox-unavailable'. The only way past
 *    that is the explicit SINTER_BLENDER_UNSANDBOXED=1, which runs the script as
 *    host code execution and is logged loudly (docs/domains/blender.md).
 *
 * `buildSandboxedCommand` is pure: the host (which/realpath/env) is injected so
 * tests can assert the exact argv.
 */

import { accessSync, constants, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BLENDER_UNSANDBOXED_ENV = 'SINTER_BLENDER_UNSANDBOXED';

export interface SandboxSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Codec mode. Mount exactly these files and require isolation. */
  readOnlyFiles?: readonly string[];
}

export interface SandboxDeps {
  /** Resolve an executable name or path to an absolute path, or null when absent. */
  which(command: string): string | null;
  realpath(p: string): string;
  /** Host environment, only consulted for SINTER_BLENDER_UNSANDBOXED. */
  hostEnv: Record<string, string | undefined>;
}

export type SandboxKind = 'bwrap' | 'sandbox-exec' | 'none';

export type SandboxPlan =
  | { ok: true; sandbox: SandboxKind; command: string; args: string[]; warning?: string }
  | { ok: false; message: string };

/** Read-only host paths Blender needs. `-try` so a distro without /lib64 still works. */
const RO_SYSTEM_DIRS = ['/usr', '/lib', '/lib32', '/lib64', '/bin', '/sbin'];
/** fd number (in the child's stdio) where bwrap reports startup status as JSON. */
export const BWRAP_STATUS_FD = 3;
/** Cap on the sandbox /tmp tmpfs. */
export const TMPFS_BYTES = 256 * 1024 * 1024;
/** Per-file write cap and address-space cap for the Blender process. Enough for a 640px render. */
export const FSIZE_BYTES = 128 * 1024 * 1024;
export const ADDRESS_SPACE_BYTES = 16 * 1024 * 1024 * 1024;

/** Resource-limit prefix run inside the sandbox: prlimit when present under /usr, else ulimit via sh. */
function limitWrapper(deps: SandboxDeps): string[] {
  const prlimit = deps.which('prlimit');
  if (prlimit && RO_SYSTEM_DIRS.some((dir) => isUnder(deps.realpath(prlimit), dir))) {
    return [prlimit, `--fsize=${FSIZE_BYTES}`, `--as=${ADDRESS_SPACE_BYTES}`, '--'];
  }
  // sh ulimit -f is in 512/1024-byte blocks depending on the shell; the smaller reading is still above a PNG.
  return ['/bin/sh', '-c', `ulimit -f ${FSIZE_BYTES / 1024 / 2}; ulimit -v ${ADDRESS_SPACE_BYTES / 1024}; exec "$@"`, 'sh'];
}

const RO_SYSTEM_FILES = ['/etc/fonts', '/etc/ld.so.cache', '/etc/localtime', '/etc/alternatives'];

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** Every home-like root that must never be bound: the host user's home plus the shared roots. */
function hostHomes(deps: SandboxDeps): string[] {
  let home = deps.hostEnv.HOME ?? '';
  if (!home) {
    try { home = os.homedir(); } catch { home = ''; }
  }
  return [...(home ? [deps.realpath(home)] : []), '/home', '/root', '/run', '/var/home', '/Users'];
}

function unavailable(detail: string): SandboxPlan {
  return {
    ok: false,
    message:
      `Blender sandbox unavailable: ${detail}. Model-written Python will not run on the host without an OS sandbox. `
      + 'Install bubblewrap (Linux: `sudo apt install bubblewrap`) or use a Linux container (macOS is not sandboxed yet); '
      + `setting ${BLENDER_UNSANDBOXED_ENV}=1 runs the script unsandboxed as host code execution (not recommended).`,
  };
}

export function buildSandboxedCommand(platform: NodeJS.Platform, spec: SandboxSpec, deps: SandboxDeps): SandboxPlan {
  const codec = spec.readOnlyFiles !== undefined;
  if (!codec && deps.hostEnv[BLENDER_UNSANDBOXED_ENV] === '1') {
    // Resolve bare binary names against host PATH before spawn runs with stripped PATH.
    const resolvedCommand = deps.which(spec.command) ?? spec.command;
    return {
      ok: true,
      sandbox: 'none',
      command: resolvedCommand,
      args: spec.args,
      warning:
        `${BLENDER_UNSANDBOXED_ENV}=1: running the Blender script WITHOUT an OS sandbox. `
        + 'The model-written Python has the full privileges of this user (files, network, processes).',
    };
  }

  const outDir = deps.realpath(spec.env.SINTER_BLENDER_OUT ?? spec.cwd);

  if (platform === 'linux') {
    const bwrap = deps.which('bwrap');
    if (!bwrap) return unavailable('bwrap (bubblewrap) executable not found');
    const binary = deps.which(spec.command);
    if (!binary) return unavailable(`could not resolve the Blender binary "${spec.command}" for the sandbox`);
    // Run the resolved target: its directory is what gets bound, so a symlink elsewhere would not resolve inside.
    const realBinary = deps.realpath(binary);
    const binaryDir = path.dirname(realBinary);
    const inputDir = path.dirname(deps.realpath(spec.env.SINTER_BLENDER_SCRIPT ?? spec.cwd));
    // Binding a binary dir that is /, a home, or contains one (or /run's agent sockets) would expose
    // ~/.ssh and friends. HOME may be unset under a service, so fall back to os.homedir().
    if (binaryDir === '/' || path.dirname(binaryDir) === '/home'
      || hostHomes(deps).some((home) => isUnder(home, binaryDir))) {
      return unavailable(`the Blender binary directory "${binaryDir}" is / or contains the home directory, so binding it would expose the home; install Blender somewhere else (for example /opt/blender)`);
    }

    const argv: string[] = ['--unshare-all', '--die-with-parent', '--new-session'];
    if (!codec) argv.push('--json-status-fd', String(BWRAP_STATUS_FD));
    // tmpfs first: the binds below may live under /tmp and must be mounted on top of it.
    argv.push('--size', String(TMPFS_BYTES), '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev');
    for (const dir of RO_SYSTEM_DIRS) argv.push('--ro-bind-try', dir, dir);
    for (const file of RO_SYSTEM_FILES) argv.push('--ro-bind-try', file, file);
    if (!RO_SYSTEM_DIRS.some((dir) => isUnder(binaryDir, dir))) argv.push('--ro-bind', binaryDir, binaryDir);
    if (spec.readOnlyFiles) {
      for (const file of new Set(spec.readOnlyFiles.map(deps.realpath))) {
        argv.push('--ro-bind', file, file);
      }
    } else {
      argv.push('--ro-bind', inputDir, inputDir);
    }
    argv.push('--bind', outDir, outDir);
    argv.push('--chdir', outDir, '--clearenv');
    for (const [key, value] of Object.entries(spec.env)) argv.push('--setenv', key, value);
    argv.push('--', ...limitWrapper(deps), realBinary, ...spec.args);
    return { ok: true, sandbox: 'bwrap', command: bwrap, args: argv };
  }

  if (platform === 'darwin') {
    // sandbox-exec cannot confine exec/mach services (`open`, osascript, launchctl) and is untested here.
    return unavailable('macOS is not sandboxed yet (sandbox-exec cannot stop exec and mach-service escapes); use a Linux container');
  }

  return unavailable(`no OS sandbox is implemented for platform ${platform}`);
}

/** Real host lookups for production. */
export function hostSandboxDeps(): SandboxDeps {
  const which = (command: string): string | null => {
    const candidates = command.includes('/')
      ? [command]
      : (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean).map((dir) => path.join(dir, command));
    for (const candidate of candidates) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // try the next PATH entry
      }
    }
    return null;
  };
  const realpath = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return { which, realpath, hostEnv: process.env };
}
