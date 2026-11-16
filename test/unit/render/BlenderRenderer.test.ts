import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BLENDER_INSTALL_HINT,
  BLENDER_MAX_RESOLUTION,
  BLENDER_MAX_SAMPLES,
  renderBlender,
  type BlenderRunSpec,
  type BlenderRunner,
  type BlenderRunResult,
} from '../../../src/render/BlenderRenderer.js';

/** Smallest PNG-shaped buffer: signature + IHDR carrying the width and height. */
function fakePng(width = 64, height = 32): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const SCRIPT = 'import bpy\nbpy.ops.mesh.primitive_cube_add()\n';

function ok(overrides: Partial<BlenderRunResult> = {}): BlenderRunResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

/** A runner that behaves like a successful Blender: it writes render.png into the output dir. */
function rendering(seen: { spec?: BlenderRunSpec }, png: Buffer = fakePng()): BlenderRunner {
  return async (spec) => {
    seen.spec = spec;
    writeFileSync(path.join(spec.env.SINTER_BLENDER_OUT, 'render.png'), png);
    return ok();
  };
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('renderBlender', () => {
  it('happy path: runs blender headless, returns the PNG bytes, size and a path for the judge', async () => {
    const seen: { spec?: BlenderRunSpec } = {};
    const keep = mkdtempSync(path.join(os.tmpdir(), 'blender-keep-'));
    cleanup.push(keep);

    const result = await renderBlender(SCRIPT, {
      runner: async (spec) => {
        const r = await rendering(seen, fakePng(64, 32))(spec);
        return { ...r, stdout: 'Blender 4.2 render done' };
      },
      outputDir: keep,
    });

    expect(result.success).toBe(true);
    expect(result.width).toBe(64);
    expect(result.height).toBe(32);
    expect(result.png?.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(result.pngPath).toBe(path.join(keep, 'render.png'));
    expect(existsSync(result.pngPath as string)).toBe(true);
    expect(result.logs).toEqual(['Blender 4.2 render done']);

    // Headless, factory settings, script autoexec off, never the system python env.
    expect(seen.spec?.command).toBe('blender');
    expect(seen.spec?.args.slice(0, 3)).toEqual(['-b', '--factory-startup', '--disable-autoexec']);
    expect(seen.spec?.args).toContain('-P');
    expect(seen.spec?.args).not.toContain('--python-use-system-env');
    expect(seen.spec?.cwd).toBe(keep);
  });

  it('reports which sandbox ran the script (#1628)', async () => {
    const seen: { spec?: BlenderRunSpec } = {};
    const result = await renderBlender(SCRIPT, {
      runner: async (spec) => ({ ...(await rendering(seen)(spec)), sandbox: 'bwrap' as const }),
    });
    expect(result.success).toBe(true);
    expect(result.sandbox).toBe('bwrap');
  });

  it('strips the environment: no proxies, no tokens, HOME and TMPDIR pinned to the output dir', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.invalid:3128';
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    process.env.PYTHONPATH = '/evil';
    const seen: { spec?: BlenderRunSpec } = {};
    try {
      await renderBlender(SCRIPT, { runner: rendering(seen) });
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.PYTHONPATH;
    }
    const env = seen.spec?.env ?? {};
    expect(Object.keys(env).sort()).toEqual([
      'HOME', 'LANG', 'PATH', 'SINTER_BLENDER_MAX_RES', 'SINTER_BLENDER_MAX_SAMPLES',
      'SINTER_BLENDER_OUT', 'SINTER_BLENDER_SCRIPT', 'TMPDIR',
    ]);
    expect(env.HOME).toBe(env.SINTER_BLENDER_OUT);
    expect(env.TMPDIR).toBe(env.SINTER_BLENDER_OUT);
  });

  it('caps requested resolution and samples to the hard limits', async () => {
    const seen: { spec?: BlenderRunSpec } = {};
    await renderBlender(SCRIPT, { runner: rendering(seen), maxResolution: 99999, maxSamples: 99999 });
    expect(seen.spec?.env.SINTER_BLENDER_MAX_RES).toBe(String(BLENDER_MAX_RESOLUTION));
    expect(seen.spec?.env.SINTER_BLENDER_MAX_SAMPLES).toBe(String(BLENDER_MAX_SAMPLES));

    await renderBlender(SCRIPT, { runner: rendering(seen), maxResolution: 320, maxSamples: 4 });
    expect(seen.spec?.env.SINTER_BLENDER_MAX_RES).toBe('320');
    expect(seen.spec?.env.SINTER_BLENDER_MAX_SAMPLES).toBe('4');
  });

  it('bad script: non-zero exit surfaces stderr and is not a PNG success', async () => {
    const runner: BlenderRunner = async () =>
      ok({ exitCode: 1, stderr: 'Traceback (most recent call last):\n  File "script.py", line 2\nNameError: name \'cube\' is not defined' });

    const result = await renderBlender(SCRIPT, { runner });

    expect(result.success).toBe(false);
    expect(result.png).toBeUndefined();
    expect(result.failureKind).toBe('script');
    expect(result.error).toContain('exited with code 1');
    expect(result.error).toContain("NameError: name 'cube' is not defined");
  });

  it('timeout: reports the limit, keeps partial stderr, and never claims success', async () => {
    const runner: BlenderRunner = async () =>
      ok({ exitCode: null, signal: 'SIGKILL', timedOut: true, stderr: 'rendering sample 3/32' });

    const result = await renderBlender(SCRIPT, { runner, timeoutMs: 1500 });

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('timeout');
    expect(result.error).toContain('timed out after 1500ms');
    expect(result.error).toContain('rendering sample 3/32');
  });

  it('empty output: exit 0 but no PNG is a failure, not a blank judge input', async () => {
    const runner: BlenderRunner = async () => ok({ stdout: 'Blender quit' });

    const result = await renderBlender(SCRIPT, { runner });

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('no-output');
    expect(result.error).toContain('produced no usable PNG at render.png (ENOENT');
  });

  it('empty output: a file that is not a PNG is rejected', async () => {
    const seen: { spec?: BlenderRunSpec } = {};
    const result = await renderBlender(SCRIPT, { runner: rendering(seen, Buffer.from('not a png at all, just text')) });
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('no-output');
    expect(result.error).toContain('not a valid PNG');
  });

  it('binary missing: names the binary and how to install it, without hanging', async () => {
    const runner: BlenderRunner = async () =>
      ok({ exitCode: null, spawnError: { code: 'ENOENT', message: 'spawn blender ENOENT' } });

    const result = await renderBlender(SCRIPT, { runner, binary: 'blender' });

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('binary-missing');
    expect(result.error).toContain('Blender executable not found: "blender"');
    expect(result.error).toContain(BLENDER_INSTALL_HINT);
    expect(result.error).toContain('SINTER_BLENDER_BIN');
  });

  it('the real subprocess runner turns a missing binary into the same clear error', async () => {
    const result = await renderBlender(SCRIPT, { binary: '/nonexistent/sinter-no-blender-here', timeoutMs: 5000 });
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('binary-missing');
    expect(result.error).toContain('/nonexistent/sinter-no-blender-here');
  });

  it('the real subprocess runner kills a hung process and its children on timeout', async () => {
    // `sh -c "sleep 30 & wait"` leaves a child; a tree kill must end both well before 30s.
    const shim = mkdtempSync(path.join(os.tmpdir(), 'blender-shim-'));
    cleanup.push(shim);
    const fake = path.join(shim, 'fake-blender');
    writeFileSync(fake, '#!/bin/sh\nsleep 30 &\nwait\n', { mode: 0o755 });
    const started = Date.now();
    // Tree-kill behaviour is independent of the sandbox; opt out so this runs on hosts without bwrap.
    process.env.SINTER_BLENDER_UNSANDBOXED = '1';
    let result;
    try {
      result = await renderBlender(SCRIPT, { binary: fake, timeoutMs: 400 });
    } finally {
      delete process.env.SINTER_BLENDER_UNSANDBOXED;
    }

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('honours SINTER_BLENDER_BIN for the binary path', async () => {
    process.env.SINTER_BLENDER_BIN = '/opt/blender/blender';
    const seen: { spec?: BlenderRunSpec } = {};
    try {
      await renderBlender(SCRIPT, { runner: rendering(seen) });
    } finally {
      delete process.env.SINTER_BLENDER_BIN;
    }
    expect(seen.spec?.command).toBe('/opt/blender/blender');
  });

  it('rejects an empty script before spawning anything', async () => {
    const runner = vi.fn<BlenderRunner>();
    const result = await renderBlender('   ', { runner });
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('script');
    expect(runner).not.toHaveBeenCalled();
  });

  it('statically refuses scripts that reach for network, processes or the shell', async () => {
    const runner = vi.fn<BlenderRunner>();
    for (const bad of [
      'import bpy\nimport socket\n',
      'import bpy\nimport subprocess\nsubprocess.run(["ls"])\n',
      'import bpy\nimport os\nos.system("id")\n',
      'import bpy\nfrom urllib.request import urlopen\n',
      'import bpy\nexec(open("/etc/passwd").read())\n',
    ]) {
      const result = await renderBlender(bad, { runner });
      expect(result.success).toBe(false);
      expect(result.failureKind).toBe('script');
      expect(result.error).toContain('not allowed');
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('removes its temp directories after a run that did not ask to keep output', async () => {
    const seen: { spec?: BlenderRunSpec } = {};
    const result = await renderBlender(SCRIPT, { runner: rendering(seen) });
    expect(result.success).toBe(true);
    expect(result.pngPath).toBeUndefined();
    expect(existsSync(seen.spec?.cwd as string)).toBe(false);
    expect(existsSync(path.dirname(seen.spec?.env.SINTER_BLENDER_SCRIPT as string))).toBe(false);
  });

  it('hands the user script over verbatim and installs the write jail, network block and render caps in the driver', async () => {
    let driver = '';
    let script = '';
    const runner: BlenderRunner = async (spec) => {
      driver = readFileSync(spec.args[spec.args.indexOf('-P') + 1], 'utf-8');
      script = readFileSync(spec.env.SINTER_BLENDER_SCRIPT, 'utf-8');
      writeFileSync(path.join(spec.env.SINTER_BLENDER_OUT, 'render.png'), fakePng());
      return ok();
    };
    await renderBlender(SCRIPT, { runner });
    expect(script).toBe(SCRIPT);
    expect(driver).toContain('builtins.open = _guarded_open');
    expect(driver).toContain('socket.socket.connect = _no_network');
    expect(driver).toContain("SINTER_BLENDER_MAX_SAMPLES");
    expect(driver).toContain('write_still=True');
  });
});
