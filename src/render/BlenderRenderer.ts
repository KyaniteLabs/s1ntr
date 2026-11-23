/**
 * BlenderRenderer - render a model-written bpy script to a PNG, headless.
 *
 * `blender -b --factory-startup -P driver.py` runs a small Sinter driver that
 * installs guards, execs the model's script, forces cheap render settings and
 * writes one still. The PNG is what the judge scores, exactly like the browser
 * screenshot of the other visual domains.
 *
 * The boundary is the OS (see BlenderSandbox): on Linux the process runs under
 * `bwrap --unshare-all` (no network, read-only system view, the output dir is
 * the only writable path, fresh /tmp, capped file size and address space). macOS
 * is not sandboxed yet. With no sandbox available the render fails closed (`sandbox-unavailable`) unless the operator sets
 * SINTER_BLENDER_UNSANDBOXED=1, which is host code execution. Details and the
 * operator contract: docs/domains/blender.md.
 *
 * Defense in depth, inside the sandbox:
 *  - own process group, killed as a tree on timeout;
 *  - minimal environment: no proxies, tokens, PYTHONPATH or DISPLAY; HOME and
 *    TMPDIR point at the output dir; `--python-use-system-env` is never passed;
 *  - `--factory-startup` + `--disable-autoexec`: no user prefs or add-ons;
 *  - the driver patches `open`/`io.open` and `socket`; a static denylist refuses
 *    obvious escapes before anything is spawned. Both are bypassable on their
 *    own and are NOT the security boundary;
 *  - resolution and Cycles samples are capped after the script runs.
 */

import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Logger } from '../utils/Logger.js';
import { BWRAP_STATUS_FD, buildSandboxedCommand, hostSandboxDeps, type SandboxKind } from './BlenderSandbox.js';

export const BLENDER_DEFAULT_BINARY = 'blender';
export const BLENDER_BINARY_ENV = 'SINTER_BLENDER_BIN';
export const BLENDER_MAX_RESOLUTION = 640;
export const BLENDER_MAX_SAMPLES = 32;
export const BLENDER_DEFAULT_TIMEOUT_MS = 240_000; // measured renders took 36, 71 and 91 s on 4 niced cores (90 s was too tight)
export const BLENDER_INSTALL_HINT =
  'Install Blender 4.x (Debian/Ubuntu: `sudo apt install blender`, macOS: `brew install --cask blender`, or https://www.blender.org/download/) and make sure `blender` is on PATH';

const OUTPUT_NAME = 'render.png';
const LOG_TAIL_BYTES = 16_000;
const KILL_GRACE_MS = 2_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type BlenderFailureKind = 'script' | 'timeout' | 'no-output' | 'binary-missing' | 'sandbox-unavailable';

export interface BlenderRunSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface BlenderRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: { code?: string; message: string };
  /** The OS sandbox could not be set up; the script was NOT run (fail closed). */
  sandboxError?: string;
  /** Loud operator warning, e.g. the unsandboxed escape hatch was used. */
  warning?: string;
  /** Which OS sandbox the script ran under; absent when it never ran. */
  sandbox?: SandboxKind;
}

/** The subprocess boundary. Tests inject a fake; production uses spawnBlender. */
export type BlenderRunner = (spec: BlenderRunSpec) => Promise<BlenderRunResult>;

export interface BlenderRenderOptions {
  runner?: BlenderRunner;
  binary?: string;
  timeoutMs?: number;
  maxResolution?: number;
  maxSamples?: number;
  /** Keep the render here (created if needed) and return `pngPath`. Otherwise a temp dir is used and removed. */
  outputDir?: string;
}

export interface BlenderRenderResult {
  success: boolean;
  png?: Buffer;
  pngPath?: string;
  width?: number;
  height?: number;
  error?: string;
  failureKind?: BlenderFailureKind;
  logs: string[];
  /** Which OS sandbox the script ran under. Only 'bwrap' is network-isolated. */
  sandbox?: SandboxKind;
}

const FORBIDDEN_SCRIPT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^\s*(?:import|from)\s+(socket|subprocess|ctypes|urllib\w*|http\w*|requests|ftplib|smtplib|telnetlib|multiprocessing|asyncio|importlib|pty|shutil)\b/m, label: '$1' },
  { pattern: /\bimport[ \t]+[\w.,\t ]*\b(socket|subprocess|ctypes|requests|importlib|shutil)\b/, label: '$1' },
  { pattern: /\bos\s*\.\s*(system|popen|exec\w*|spawn\w*|fork\w*|kill\w*|remove|unlink|rmdir|removedirs|rename|replace|chmod|chown|symlink|link)\b/, label: 'os.$1' },
  { pattern: /^\s*from\s+os\s+import\b/m, label: 'from os import' },
  { pattern: /(?<![\w.])(exec|eval|compile|__import__)\s*\(/, label: '$1()' },
];

/** Static pre-flight: returns the first forbidden construct, or null. */
export function findForbiddenBlenderConstruct(script: string): string | null {
  for (const { pattern, label } of FORBIDDEN_SCRIPT_PATTERNS) {
    const match = pattern.exec(script);
    if (match) return label.replace('$1', match[1] ?? '');
  }
  return null;
}

/** The Python driver Blender runs. Reads its limits from the environment. */
export const BLENDER_DRIVER = `# Sinter Blender driver. Generated; do not edit by hand.
import builtins, io, os, socket

_OUT = os.path.realpath(os.environ["SINTER_BLENDER_OUT"])
_SCRIPT = os.environ["SINTER_BLENDER_SCRIPT"]
_MAX_RES = int(os.environ["SINTER_BLENDER_MAX_RES"])
_MAX_SAMPLES = int(os.environ["SINTER_BLENDER_MAX_SAMPLES"])

_real_open = io.open

def _guarded_open(file, mode="r", *args, **kwargs):
    if isinstance(file, (str, bytes, os.PathLike)) and any(c in mode for c in "wax+"):
        target = os.path.realpath(os.fsdecode(file))
        if target != _OUT and not target.startswith(_OUT + os.sep):
            raise PermissionError("Sinter sandbox: writes are only allowed inside the output directory: " + target)
    return _real_open(file, mode, *args, **kwargs)

builtins.open = _guarded_open
io.open = _guarded_open

def _no_network(*args, **kwargs):
    raise PermissionError("Sinter sandbox: network access is disabled")

socket.socket.connect = _no_network
socket.socket.connect_ex = _no_network
socket.create_connection = _no_network
socket.getaddrinfo = _no_network

import bpy

with _real_open(_SCRIPT, "r", encoding="utf-8") as _fh:
    _source = _fh.read()
exec(compile(_source, _SCRIPT, "exec"), {"__name__": "__main__", "__file__": _SCRIPT})

scene = bpy.context.scene
scene.render.engine = "CYCLES"
try:
    scene.cycles.device = "CPU"
    scene.cycles.samples = min(int(scene.cycles.samples), _MAX_SAMPLES)
except Exception:
    pass
longest = max(scene.render.resolution_x, scene.render.resolution_y, 1)
factor = min(1.0, _MAX_RES / longest)
scene.render.resolution_x = max(16, int(scene.render.resolution_x * factor))
scene.render.resolution_y = max(16, int(scene.render.resolution_y * factor))
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.use_file_extension = False
scene.render.filepath = os.path.join(_OUT, "${OUTPUT_NAME}")
bpy.ops.render.render(write_still=True)
`;

function tail(text: string, max = LOG_TAIL_BYTES): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/** Production runner: own process group, bounded output, tree kill on timeout. */
export const spawnBlender: BlenderRunner = (spec) => new Promise((resolve) => {
  const deps = hostSandboxDeps();
  // A missing blender is an install problem, reported as such before any sandbox talk.
  if (!deps.which(spec.command)) {
    resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: { code: 'ENOENT', message: `spawn ${spec.command} ENOENT` } });
    return;
  }
  const plan = buildSandboxedCommand(process.platform, spec, deps);
  if (!plan.ok) {
    resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, sandboxError: plan.message });
    return;
  }
  if (plan.warning) Logger.warn('BlenderRenderer', plan.warning);

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  let forceTimer: NodeJS.Timeout | undefined;

  const child = spawn(plan.command, plan.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', ...(plan.sandbox === 'bwrap' ? ['pipe' as const] : [])],
  });
  // bwrap writes {"exit-code": N} to this fd only after the sandboxed command itself ran and
  // exited (child-pid is written earlier, before the mounts, so it proves nothing). Its absence
  // on a failing exit, not anything the script prints, proves the sandbox failed to start.
  let childRan = false;
  let statusBuf = '';
  const statusStream = child.stdio[BWRAP_STATUS_FD];
  if (plan.sandbox === 'bwrap' && statusStream && 'on' in statusStream) {
    (statusStream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
      statusBuf = (statusBuf + chunk.toString('utf-8')).slice(-4096);
      if (/"exit-code"\s*:\s*\d+/.test(statusBuf)) childRan = true;
    });
  }

  const finish = (result: BlenderRunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    // The wrapper itself failing (for example user namespaces disabled) means the script never
    // ran: bwrap reports exit-code on the status fd only once it did. A child that started and
    // then failed is always a script failure, whatever it printed to stderr.
    if (plan.sandbox === 'bwrap' && !childRan && !result.timedOut && result.exitCode !== null && result.exitCode !== 0) {
      resolve({ ...result, sandboxError: `Blender sandbox unavailable: bwrap failed to start: ${result.stderr.trim().slice(0, 500)}. The script was not run.` });
      return;
    }
    resolve({ ...result, sandbox: plan.sandbox, ...(plan.warning ? { warning: plan.warning } : {}) });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killTree(child.pid);
    // If a stubborn descendant keeps the pipes open, do not wait for 'close' forever.
    forceTimer = setTimeout(() => finish({ exitCode: null, signal: 'SIGKILL', stdout, stderr, timedOut }), KILL_GRACE_MS);
  }, spec.timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => { stdout = tail(stdout + chunk.toString('utf-8')); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = tail(stderr + chunk.toString('utf-8')); });
  child.on('error', (error: NodeJS.ErrnoException) => {
    finish({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: { code: error.code, message: error.message } });
  });
  child.on('close', (exitCode, signal) => {
    finish({ exitCode, signal, stdout, stderr, timedOut });
  });
});

const MAX_PNG_BYTES = 32 * 1024 * 1024;

/**
 * Read a file the sandboxed script produced. The script controls the output dir, so
 * refuse symlinks (it could point at any host file) and oversized files, and read
 * from an O_NOFOLLOW fd so a swap after the check cannot redirect the read.
 */
export function readRegularFile(file: string, maxBytes: number): Buffer {
  if (!lstatSync(file).isFile()) throw new Error('not a regular file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size === 0) throw new Error('empty');
    if (stat.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function fail(kind: BlenderFailureKind, error: string, logs: string[] = []): BlenderRenderResult {
  return { success: false, failureKind: kind, error, logs };
}

function clampPositive(value: number | undefined, fallback: number, hardCap: number): number {
  const wanted = Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
  return Math.min(wanted, hardCap);
}

/**
 * Render a bpy script to a PNG. Never throws: every failure comes back as
 * `{ success: false, failureKind, error }` with Blender's stderr surfaced.
 */
export async function renderBlender(script: string, options: BlenderRenderOptions = {}): Promise<BlenderRenderResult> {
  if (!script || !script.trim()) return fail('script', 'Blender script is empty');
  const forbidden = findForbiddenBlenderConstruct(script);
  if (forbidden) {
    return fail('script', `Blender script uses "${forbidden}", which is not allowed in the sandboxed render (no network, subprocess, shell or dynamic code)`);
  }

  const runner = options.runner ?? spawnBlender;
  const binary = options.binary ?? process.env[BLENDER_BINARY_ENV] ?? BLENDER_DEFAULT_BINARY;
  const timeoutMs = clampPositive(options.timeoutMs, BLENDER_DEFAULT_TIMEOUT_MS, 600_000);
  const maxResolution = clampPositive(options.maxResolution, BLENDER_MAX_RESOLUTION, BLENDER_MAX_RESOLUTION);
  const maxSamples = clampPositive(options.maxSamples, BLENDER_MAX_SAMPLES, BLENDER_MAX_SAMPLES);

  const keepOutput = Boolean(options.outputDir);
  const inputDir = mkdtempSync(path.join(os.tmpdir(), 'sinter-blender-in-'));
  const outDir = options.outputDir ?? mkdtempSync(path.join(os.tmpdir(), 'sinter-blender-out-'));
  try {
    mkdirSync(outDir, { recursive: true });
    const scriptPath = path.join(inputDir, 'script.py');
    const driverPath = path.join(inputDir, 'driver.py');
    writeFileSync(scriptPath, script, 'utf-8');
    writeFileSync(driverPath, BLENDER_DRIVER, 'utf-8');

    const spec: BlenderRunSpec = {
      command: binary,
      args: ['-b', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '-P', driverPath],
      cwd: outDir,
      timeoutMs,
      env: {
        PATH: '/usr/bin:/bin', // fixed: never leak the host PATH into the sandbox
        LANG: 'C.UTF-8',
        HOME: outDir,
        TMPDIR: outDir,
        SINTER_BLENDER_OUT: outDir,
        SINTER_BLENDER_SCRIPT: scriptPath,
        SINTER_BLENDER_MAX_RES: String(maxResolution),
        SINTER_BLENDER_MAX_SAMPLES: String(maxSamples),
      },
    };

    const run = await runner(spec);
    // stdout is the log; failures carry stderr inside the error text.
    const logs = run.stdout.trim() ? [run.stdout.trim()] : [];
    if (run.warning) logs.unshift(`WARNING: ${run.warning}`);

    if (run.sandboxError) return fail('sandbox-unavailable', run.sandboxError, logs);

    if (run.spawnError) {
      if (run.spawnError.code === 'ENOENT') {
        return fail(
          'binary-missing',
          `Blender executable not found: "${binary}". ${BLENDER_INSTALL_HINT}, or set ${BLENDER_BINARY_ENV} to the full path of the blender binary.`,
        );
      }
      return fail('binary-missing', `Could not start Blender executable "${binary}": ${run.spawnError.message}. ${BLENDER_INSTALL_HINT}.`);
    }
    if (run.timedOut) {
      return fail('timeout', `Blender render timed out after ${timeoutMs}ms and the process tree was killed${run.stderr.trim() ? `: ${tail(run.stderr.trim(), 2000)}` : ''}`);
    }
    if (run.exitCode !== 0) {
      const detail = tail((run.stderr || run.stdout).trim(), 4000);
      return fail('script', `Blender exited with code ${run.exitCode}${run.signal ? ` (signal ${run.signal})` : ''}${detail ? `:\n${detail}` : ''}`);
    }

    const pngPath = path.join(outDir, OUTPUT_NAME);
    let png: Buffer;
    try {
      png = readRegularFile(pngPath, MAX_PNG_BYTES);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail('no-output', `Blender exited cleanly but produced no usable PNG at ${OUTPUT_NAME} (${reason}). The script must build a scene (objects, a camera and a light); Sinter renders the still itself.`, logs);
    }
    const size = pngSize(png);
    if (!size) return fail('no-output', `Blender wrote ${OUTPUT_NAME} but it is not a valid PNG`, logs);

    return {
      success: true,
      png,
      ...(keepOutput ? { pngPath } : {}),
      width: size.width,
      height: size.height,
      logs,
      ...(run.sandbox ? { sandbox: run.sandbox } : {}),
    };
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    if (!keepOutput) rmSync(outDir, { recursive: true, force: true });
  }
}
