import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  BLENDER_UNSANDBOXED_ENV,
  ADDRESS_SPACE_BYTES,
  BWRAP_STATUS_FD,
  FSIZE_BYTES,
  TMPFS_BYTES,
  buildSandboxedCommand,
  hostSandboxDeps,
  type SandboxDeps,
  type SandboxSpec,
} from '../../../src/render/BlenderSandbox.js';
import { readRegularFile, renderBlender, spawnBlender, type BlenderRunner } from '../../../src/render/BlenderRenderer.js';

const SPEC: SandboxSpec = {
  command: 'blender',
  args: ['-b', '--factory-startup', '-P', '/tmp/sinter-in/driver.py'],
  cwd: '/tmp/sinter-out',
  env: { PATH: '/usr/bin', HOME: '/tmp/sinter-out', SINTER_BLENDER_OUT: '/tmp/sinter-out', SINTER_BLENDER_SCRIPT: '/tmp/sinter-in/script.py' },
};

function fakeDeps(present: Record<string, string>, hostEnv: Record<string, string | undefined> = {}): SandboxDeps {
  return { which: (c) => present[c] ?? null, realpath: (p) => p, hostEnv };
}

describe('buildSandboxedCommand (pure argv)', () => {
  it('linux: bwrap with no network, die-with-parent, new session, output dir the only writable bind', () => {
    const plan = buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', prlimit: '/usr/bin/prlimit', blender: '/opt/blender/blender' }, { HOME: '/home/u' }));
    if (!plan.ok) throw new Error(plan.message);

    expect(plan.sandbox).toBe('bwrap');
    expect(plan.command).toBe('/usr/bin/bwrap');
    expect(plan.args).toEqual([
      '--unshare-all', '--die-with-parent', '--new-session', '--json-status-fd', '3',
      '--size', String(TMPFS_BYTES), '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
      '--ro-bind-try', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib32', '/lib32',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/sbin', '/sbin',
      '--ro-bind-try', '/etc/fonts', '/etc/fonts',
      '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
      '--ro-bind-try', '/etc/localtime', '/etc/localtime',
      '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
      '--ro-bind', '/opt/blender', '/opt/blender',
      '--ro-bind', '/tmp/sinter-in', '/tmp/sinter-in',
      '--bind', '/tmp/sinter-out', '/tmp/sinter-out',
      '--chdir', '/tmp/sinter-out', '--clearenv',
      '--setenv', 'PATH', '/usr/bin',
      '--setenv', 'HOME', '/tmp/sinter-out',
      '--setenv', 'SINTER_BLENDER_OUT', '/tmp/sinter-out',
      '--setenv', 'SINTER_BLENDER_SCRIPT', '/tmp/sinter-in/script.py',
      '--', '/usr/bin/prlimit', `--fsize=${FSIZE_BYTES}`, `--as=${ADDRESS_SPACE_BYTES}`, '--',
      '/opt/blender/blender', '-b', '--factory-startup', '-P', '/tmp/sinter-in/driver.py',
    ]);
    // Exactly one writable bind, and it is the output dir; /tmp is a fresh tmpfs mounted before any bind.
    const writable = plan.args.flatMap((a, i) => (a === '--bind' ? [plan.args[i + 1]] : []));
    expect(writable).toEqual(['/tmp/sinter-out']);
    expect(plan.args.indexOf('--tmpfs')).toBeLessThan(plan.args.indexOf('--bind'));
    expect(plan.args).toContain('--unshare-all');
  });

  it('linux: a blender under /usr needs no extra bind', () => {
    const plan = buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', blender: '/usr/bin/blender' }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.args.filter((a) => a === '--ro-bind')).toHaveLength(1); // only the input dir
  });

  it('linux without bwrap fails closed and names the escape hatch', () => {
    const plan = buildSandboxedCommand('linux', SPEC, fakeDeps({ blender: '/usr/bin/blender' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain('Blender sandbox unavailable');
    expect(plan.message).toContain('bwrap');
    expect(plan.message).toContain(BLENDER_UNSANDBOXED_ENV);
  });

  it('macOS fails closed: sandbox-exec cannot confine exec or mach services', () => {
    const plan = buildSandboxedCommand('darwin', SPEC, fakeDeps({ 'sandbox-exec': '/usr/bin/sandbox-exec', blender: '/Applications/Blender.app/Contents/MacOS/Blender' }, { HOME: '/Users/u' }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain('macOS is not sandboxed yet');
    expect(plan.message).toContain(BLENDER_UNSANDBOXED_ENV);
  });

  it('caps the tmpfs, file size and address space; --size comes right before --tmpfs', () => {
    const plan = buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', prlimit: '/usr/bin/prlimit', blender: '/usr/bin/blender' }, { HOME: '/home/u' }));
    if (!plan.ok) throw new Error(plan.message);
    const i = plan.args.indexOf('--tmpfs');
    expect(plan.args.slice(i - 2, i + 2)).toEqual(['--size', '268435456', '--tmpfs', '/tmp']);
    expect(plan.args).toContain('--fsize=134217728');
    expect(plan.args).toContain('--as=17179869184');
    expect(plan.args.indexOf('--json-status-fd') + 1).toBe(plan.args.indexOf(String(BWRAP_STATUS_FD)));
  });

  it('without prlimit under /usr the limits come from ulimit in /bin/sh', () => {
    const plan = buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', blender: '/usr/bin/blender' }, { HOME: '/home/u' }));
    if (!plan.ok) throw new Error(plan.message);
    const sep = plan.args.indexOf('--', plan.args.indexOf('--clearenv'));
    expect(plan.args.slice(sep + 1, sep + 3)).toEqual(['/bin/sh', '-c']);
    expect(plan.args[sep + 3]).toBe('ulimit -f 65536; ulimit -v 16777216; exec "$@"');
    expect(plan.args.slice(sep + 4, sep + 6)).toEqual(['sh', '/usr/bin/blender']);
  });

  it('refuses a binary directory that is / , is the home, or contains the home (would expose ~/.ssh)', () => {
    for (const binary of ['/blender', '/home/u/blender.sh', '/home/blender']) {
      const plan = buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', blender: binary }, { HOME: '/home/u' }));
      expect(plan.ok, binary).toBe(false);
      if (!plan.ok) expect(plan.message).toContain('would expose the home');
    }
    // Another user's home, /root and /run (agent sockets) are refused too, even with HOME unset.
    for (const binary of ['/home/other/blender', '/root/blender', '/run/blender', '/home/blender']) {
      const plan = buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', blender: binary }, {}));
      expect(plan.ok, `${binary} with HOME unset`).toBe(false);
    }
    // A Blender unpacked inside the home, or /opt, binds only its own directory: fine.
    expect(buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', blender: '/home/u/blender-4.2/blender' }, { HOME: '/home/u' })).ok).toBe(true);
    // The host HOME is what counts, not spec.env.HOME (which is the output dir).
    expect(buildSandboxedCommand('linux', SPEC, fakeDeps({ bwrap: '/usr/bin/bwrap', blender: '/tmp/sinter-out/blender' }, { HOME: '/home/u' })).ok).toBe(true);
  });

  it('runs the resolved binary, not a symlink whose own directory is not bound', () => {
    const deps: SandboxDeps = {
      which: (c) => ({ bwrap: '/usr/bin/bwrap', blender: '/home/u/.local/bin/blender' } as Record<string, string>)[c] ?? null,
      realpath: (p) => (p === '/home/u/.local/bin/blender' ? '/opt/blender/blender' : p),
      hostEnv: { HOME: '/home/u' },
    };
    const plan = buildSandboxedCommand('linux', SPEC, deps);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const sep = plan.args.indexOf('--');
    expect(plan.args.slice(sep).includes('/opt/blender/blender')).toBe(true);
    expect(plan.args.includes('/home/u/.local/bin/blender')).toBe(false);
  });

  it('win32 and other platforms fail closed', () => {
    for (const platform of ['win32', 'freebsd'] as const) {
      const plan = buildSandboxedCommand(platform, SPEC, fakeDeps({ blender: 'blender.exe' }));
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.message).toContain(`platform ${platform}`);
    }
  });

  it('SINTER_BLENDER_UNSANDBOXED=1 is the only escape hatch: plain argv plus a loud warning', () => {
    const plan = buildSandboxedCommand('win32', SPEC, fakeDeps({}, { [BLENDER_UNSANDBOXED_ENV]: '1' }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.sandbox).toBe('none');
    expect(plan.command).toBe('blender');
    expect(plan.args).toEqual(SPEC.args);
    expect(plan.warning).toContain('WITHOUT an OS sandbox');

    for (const off of ['0', 'true', '', undefined]) {
      expect(buildSandboxedCommand('win32', SPEC, fakeDeps({}, { [BLENDER_UNSANDBOXED_ENV]: off })).ok).toBe(false);
    }
  });
});

describe('renderBlender fails closed when the sandbox is unavailable', () => {
  it('maps a sandbox error from the runner to failureKind sandbox-unavailable without a PNG', async () => {
    const runner: BlenderRunner = async () => ({
      exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false,
      sandboxError: 'Blender sandbox unavailable: bwrap (bubblewrap) executable not found',
    });
    const result = await renderBlender('import bpy\nbpy.ops.mesh.primitive_cube_add()\n', { runner });
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('sandbox-unavailable');
    expect(result.png).toBeUndefined();
    expect(result.error).toContain('Blender sandbox unavailable');
  });

  it('puts the unsandboxed warning at the top of the render logs', async () => {
    const runner: BlenderRunner = async (spec) => {
      writeFileSync(path.join(spec.env.SINTER_BLENDER_OUT, 'render.png'), Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(25),
      ]));
      return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, warning: 'running WITHOUT an OS sandbox' };
    };
    const result = await renderBlender('import bpy\nbpy.ops.mesh.primitive_cube_add()\n', { runner });
    expect(result.logs).toEqual(['WARNING: running WITHOUT an OS sandbox', 'ok']);
  });

  it('the real spawn path refuses to run the script on a host with no sandbox wrapper', async () => {
    const saved = { PATH: process.env.PATH, flag: process.env[BLENDER_UNSANDBOXED_ENV] };
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sinter-nosandbox-'));
    const fake = path.join(dir, 'fake-blender');
    const marker = path.join(dir, 'ran');
    writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    delete process.env[BLENDER_UNSANDBOXED_ENV];
    process.env.PATH = '/nonexistent-bin'; // no bwrap / sandbox-exec reachable
    try {
      const result = await renderBlender('import bpy\nbpy.ops.mesh.primitive_cube_add()\n', { binary: fake });
      expect(result.failureKind).toBe('sandbox-unavailable');
      expect(existsSync(marker)).toBe(false); // the script never ran
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.flag !== undefined) process.env[BLENDER_UNSANDBOXED_ENV] = saved.flag;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('output file handling (real files)', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'sinter-readfile-')); made.push(d); return d; };

  it('reads a regular file', () => {
    const f = path.join(tmp(), 'render.png');
    writeFileSync(f, Buffer.from('abc'));
    expect(readRegularFile(f, 1024).toString()).toBe('abc');
  });

  it('rejects a symlink even when it points at a readable host file', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'secret'), 'host secret');
    symlinkSync(path.join(d, 'secret'), path.join(d, 'render.png'));
    expect(() => readRegularFile(path.join(d, 'render.png'), 1024)).toThrow('not a regular file');
  });

  it('rejects an oversized file and an empty file', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'big'), Buffer.alloc(2048));
    writeFileSync(path.join(d, 'empty'), '');
    expect(() => readRegularFile(path.join(d, 'big'), 1024)).toThrow('larger than 1024 bytes');
    expect(() => readRegularFile(path.join(d, 'empty'), 1024)).toThrow('empty');
  });

  it('renderBlender reports a symlinked render.png as no-output and never returns the target bytes', async () => {
    const d = tmp();
    const target = path.join(d, 'target.png');
    writeFileSync(target, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(25)]));
    const runner: BlenderRunner = async (spec) => {
      symlinkSync(target, path.join(spec.env.SINTER_BLENDER_OUT, 'render.png'));
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
    };
    const result = await renderBlender('import bpy\nbpy.ops.mesh.primitive_cube_add()\n', { runner });
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('no-output');
    expect(result.png).toBeUndefined();
  });

  it('passes a fixed PATH into the sandboxed env, not the host PATH', async () => {
    let seen: Record<string, string> = {};
    const runner: BlenderRunner = async (spec) => {
      seen = spec.env;
      return { exitCode: 1, signal: null, stdout: '', stderr: 'x', timedOut: false };
    };
    const saved = process.env.PATH;
    process.env.PATH = '/home/u/secret-bin:/usr/bin';
    try {
      await renderBlender('import bpy\nbpy.ops.mesh.primitive_cube_add()\n', { runner });
    } finally {
      process.env.PATH = saved;
    }
    expect(seen.PATH).toBe('/usr/bin:/bin');
  });
});

// Real isolation proof. Needs a Linux host with bwrap (no Blender needed): python3 stands in for blender
// inside the exact argv shape renderBlender uses.
const REAL = hostSandboxDeps();
// Installed is not enough: hosts that restrict unprivileged user namespaces (Ubuntu 24.04 AppArmor
// default) ship bwrap but cannot start a sandbox, so probe one real start, as the isolation tests need.
const bwrapPath = process.platform === 'linux' ? REAL.which('bwrap') : null;
const canBwrap = bwrapPath !== null && REAL.which('python3') !== null
  && spawnSync(bwrapPath, ['--ro-bind', '/', '/', '--unshare-net', '--die-with-parent', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;

const PROBE = `
import json, os, socket, sys
ro_dir, out_dir, outside, port, limits = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5] == '1'
res = {}
def attempt(name, fn):
    try:
        fn()
        res[name] = 'ok'
    except Exception as e:
        res[name] = 'blocked:' + type(e).__name__
attempt('write_ro_input_dir', lambda: open(os.path.join(ro_dir, 'pwn1.txt'), 'w').write('x'))
attempt('os_open_wronly_outside', lambda: os.close(os.open(os.path.join(outside, 'pwn2.txt'), os.O_WRONLY | os.O_CREAT)))
def via_getattr():
    status = getattr(__import__('os'), 'sys' + 'tem')('echo x > ' + os.path.join(outside, 'pwn3.txt'))
    if status != 0: raise OSError('shell write failed')
attempt('getattr_os_system_outside', via_getattr)
def via_alias():
    import os as o
    status = o.system('echo x > ' + os.path.join(ro_dir, 'pwn4.txt'))
    if status != 0: raise OSError('shell write failed')
attempt('aliased_os_system_ro', via_alias)
attempt('builtins_open_outside', lambda: __builtins__.__dict__['open'](os.path.join(outside, 'pwn5.txt'), 'w').write('x'))
def connect():
    s = socket.socket(); s.settimeout(2); s.connect(('127.0.0.1', port)); s.close()
attempt('socket_connect_loopback', connect)
attempt('write_output_dir', lambda: open(os.path.join(out_dir, 'ok.txt'), 'w').write('fine'))
if limits:
    def big_file():
        with open(os.path.join(out_dir, 'big.bin'), 'wb') as f:
            f.write(b'x' * (200 * 1024 * 1024))
    attempt('file_over_fsize_cap', big_file)
    attempt('address_space_over_cap', lambda: bytearray(20 * 1024 * 1024 * 1024))
attempt('symlink_render_png', lambda: os.symlink(os.path.join(outside, 'secret.txt'), os.path.join(out_dir, 'render.png')))
print(json.dumps(res))
`;

describe.skipIf(!canBwrap)('real bwrap isolation (python3 as the stand-in process)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function runProbe(hostEnv: Record<string, string | undefined>) {
    const inDir = mkdtempSync(path.join(os.tmpdir(), 'sinter-probe-in-'));
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'sinter-probe-out-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'sinter-probe-outside-'));
    dirs.push(inDir, outDir, outside);
    const probe = path.join(inDir, 'probe.py');
    writeFileSync(probe, PROBE);

    writeFileSync(path.join(outside, 'secret.txt'), 'host secret');
    const server = net.createServer((c) => c.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const spec: SandboxSpec = {
        command: 'python3',
        args: [probe, inDir, outDir, outside, String(port), hostEnv[BLENDER_UNSANDBOXED_ENV] === '1' ? '0' : '1'],
        cwd: outDir,
        env: { PATH: '/usr/bin:/bin', HOME: outDir, SINTER_BLENDER_OUT: outDir, SINTER_BLENDER_SCRIPT: probe },
      };
      const plan = buildSandboxedCommand('linux', spec, { ...REAL, hostEnv });
      if (!plan.ok) throw new Error(plan.message);
      const run = spawnSync(plan.command, plan.args, { encoding: 'utf-8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      if (run.status !== 0) throw new Error(`probe failed to run (${plan.sandbox}): ${run.stderr}`);
      return {
        results: JSON.parse(run.stdout.trim()) as Record<string, string>,
        wrote: (dir: string, name: string) => existsSync(path.join(dir, name)),
        inDir, outDir, outside,
      };
    } finally {
      server.close();
    }
  }

  it('control (red): without the sandbox every bypass string succeeds on the host', async () => {
    const r = await runProbe({ [BLENDER_UNSANDBOXED_ENV]: '1' });
    expect(r.results).toEqual({
      write_ro_input_dir: 'ok',
      os_open_wronly_outside: 'ok',
      getattr_os_system_outside: 'ok',
      aliased_os_system_ro: 'ok',
      builtins_open_outside: 'ok',
      socket_connect_loopback: 'ok',
      write_output_dir: 'ok',
      symlink_render_png: 'ok',
    });
    expect(r.wrote(r.outside, 'pwn2.txt')).toBe(true);
    expect(r.wrote(r.outside, 'pwn3.txt')).toBe(true);
  });

  it('green: under bwrap writes outside the output dir and network connects fail, the output dir works', async () => {
    const r = await runProbe({});
    expect(r.results.write_ro_input_dir).toMatch(/^blocked:/);
    expect(r.results.os_open_wronly_outside).toMatch(/^blocked:/);
    expect(r.results.getattr_os_system_outside).toMatch(/^blocked:/);
    expect(r.results.aliased_os_system_ro).toMatch(/^blocked:/);
    expect(r.results.builtins_open_outside).toMatch(/^blocked:/);
    expect(r.results.socket_connect_loopback).toMatch(/^blocked:/);
    expect(r.results.write_output_dir).toBe('ok');
    // prlimit caps: a 200 MB file and a 20 GiB allocation are refused.
    expect(r.results.file_over_fsize_cap).toMatch(/^blocked:/);
    expect(r.results.address_space_over_cap).toMatch(/^blocked:/);
    expect(r.wrote(r.outDir, 'big.bin') ? statSync(path.join(r.outDir, 'big.bin')).size : 0).toBeLessThanOrEqual(FSIZE_BYTES);
    // The script may plant a symlink at render.png; Sinter must refuse to read through it.
    expect(r.results.symlink_render_png).toBe('ok');
    expect(() => readRegularFile(path.join(r.outDir, 'render.png'), 32 * 1024 * 1024)).toThrow('not a regular file');
    // The host filesystem is untouched; only the output dir received a file.
    for (const name of ['pwn2.txt', 'pwn3.txt', 'pwn5.txt']) expect(r.wrote(r.outside, name)).toBe(false);
    for (const name of ['pwn1.txt', 'pwn4.txt']) expect(r.wrote(r.inDir, name)).toBe(false);
    expect(r.wrote(r.outDir, 'ok.txt')).toBe(true);
  });
  it('classifies by bwrap status, not stderr: a script printing "bwrap: x" and exiting 1 is a script failure', async () => {
    const inDir = mkdtempSync(path.join(os.tmpdir(), 'sinter-cls-in-'));
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'sinter-cls-out-'));
    dirs.push(inDir, outDir);
    const script = path.join(inDir, 'spoof.py');
    writeFileSync(script, "import sys\nsys.stderr.write('bwrap: spoofed setup failure\\n')\nsys.exit(1)\n");
    const run = await spawnBlender({
      command: 'python3', args: [script], cwd: outDir, timeoutMs: 10_000,
      env: { PATH: '/usr/bin:/bin', HOME: outDir, SINTER_BLENDER_OUT: outDir, SINTER_BLENDER_SCRIPT: script },
    });
    expect(run.sandboxError).toBeUndefined();
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('bwrap: spoofed setup failure');
  });

  it('a genuine bwrap setup failure (unmountable output dir) is sandbox-unavailable and the script never ran', async () => {
    const inDir = mkdtempSync(path.join(os.tmpdir(), 'sinter-cls2-in-'));
    dirs.push(inDir);
    const script = path.join(inDir, 'ran.py');
    const marker = path.join(inDir, 'ran');
    writeFileSync(script, `open(${JSON.stringify(marker)}, 'w')\n`);
    const missingOut = path.join(inDir, 'no-such-out-dir');
    const run = await spawnBlender({
      command: 'python3', args: [script], cwd: inDir, timeoutMs: 10_000,
      env: { PATH: '/usr/bin:/bin', HOME: missingOut, SINTER_BLENDER_OUT: missingOut, SINTER_BLENDER_SCRIPT: script },
    });
    expect(run.sandboxError).toContain('bwrap failed to start');
    expect(existsSync(marker)).toBe(false);
  });
});
