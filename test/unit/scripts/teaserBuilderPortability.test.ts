import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('teaser builder input selection', () => {
  for (const script of ['build.mjs', 'build-v2.mjs']) {
    it(`${script} accepts a configured local artifact root`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-teaser-build-'));
      try {
        const teaser = join(root, 'teaser');
        const artifacts = join(root, 'artifacts');
        mkdirSync(teaser); mkdirSync(artifacts);
        copyFileSync(resolve('teaser', script), join(teaser, script));
        copyFileSync(resolve('teaser/vendor-paths.mjs'), join(teaser, 'vendor-paths.mjs'));
        for (const entry of ['ab', 'fonts', 'og']) symlinkSync(resolve('teaser', entry), join(teaser, entry));
        symlinkSync(resolve('vendor'), join(root, 'vendor'));
        const artifact = join(artifacts, 'work.html');
        writeFileSync(artifact, '<html><body><svg></svg></body></html>');
        const ledger = join(root, 'fixture.jsonl');
        writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg',
          artifact, axes: 'D=8 A=8 R=8 N=8', ts: '2026-01-01T00:00:00Z' }) + '\n');
        const result = spawnSync(process.execPath, [script, '--ledger', ledger, '--out', 'fixture-output'], {
          cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(teaser, 'fixture-output', 'index.html'), 'utf8')).toContain('<!DOCTYPE html>');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it(`${script} refuses artifacts linked outside the configured root`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-teaser-escape-'));
      try {
        const teaser = join(root, 'teaser'); const artifacts = join(root, 'artifacts');
        mkdirSync(teaser); mkdirSync(artifacts);
        copyFileSync(resolve('teaser', script), join(teaser, script));
        copyFileSync(resolve('teaser/vendor-paths.mjs'), join(teaser, 'vendor-paths.mjs'));
        symlinkSync(resolve('teaser/ab'), join(teaser, 'ab'));
        const outside = join(root, 'outside.html'); writeFileSync(outside, '<html>outside</html>');
        const artifact = join(artifacts, 'work.html'); symlinkSync(outside, artifact);
        const ledger = join(root, 'fixture.jsonl');
        writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg',
          artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
        const result = spawnSync(process.execPath, [script, '--ledger', ledger], {
          cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('no locally-present scored artifacts found');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it(`${script} refuses vendor references that escape the vendor root`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-teaser-vendor-'));
      try {
        const teaser = join(root, 'teaser'); const artifacts = join(root, 'artifacts');
        mkdirSync(teaser); mkdirSync(artifacts); mkdirSync(join(root, 'vendor'));
        copyFileSync(resolve('teaser', script), join(teaser, script));
        copyFileSync(resolve('teaser/vendor-paths.mjs'), join(teaser, 'vendor-paths.mjs'));
        for (const entry of ['ab', 'fonts', 'og']) symlinkSync(resolve('teaser', entry), join(teaser, entry));
        writeFileSync(join(root, 'secret.txt'), 'fixture-private-data');
        const artifact = join(artifacts, 'work.html');
        writeFileSync(artifact, '<html><body><svg></svg><script src="/vendor/../secret.txt"></script></body></html>');
        const ledger = join(root, 'fixture.jsonl');
        writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg',
          artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
        const result = spawnSync(process.execPath, [script, '--ledger', ledger, '--out', 'fixture-output'], {
          cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
        });
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stderr).toContain('unsafe vendor path');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it(`${script} refuses vendor files linked outside the vendor root`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-vendor-link-'));
      try {
        const teaser = join(root, 'teaser'); const artifacts = join(root, 'artifacts'); const vendor = join(root, 'vendor');
        mkdirSync(teaser); mkdirSync(artifacts); mkdirSync(vendor);
        copyFileSync(resolve('teaser', script), join(teaser, script));
        copyFileSync(resolve('teaser/vendor-paths.mjs'), join(teaser, 'vendor-paths.mjs'));
        for (const entry of ['ab', 'fonts', 'og']) symlinkSync(resolve('teaser', entry), join(teaser, entry));
        const outside = join(root, 'secret.txt'); writeFileSync(outside, 'fixture-private-data');
        symlinkSync(outside, join(vendor, 'linked.js'));
        const artifact = join(artifacts, 'work.html');
        writeFileSync(artifact, '<html><body><svg></svg><script src="/vendor/linked.js"></script></body></html>');
        const ledger = join(root, 'fixture.jsonl');
        writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg',
          artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
        const result = spawnSync(process.execPath, [script, '--ledger', ledger, '--out', 'fixture-output'], {
          cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('unsafe vendor path');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it(`${script} never writes through an output vendor link`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-vendor-output-'));
      try {
        const teaser = join(root, 'teaser'); const artifacts = join(root, 'artifacts');
        const vendor = join(root, 'vendor'); const outside = join(root, 'outside');
        for (const dir of [teaser, artifacts, vendor, outside, join(teaser, 'fixture-output')]) mkdirSync(dir);
        copyFileSync(resolve('teaser', script), join(teaser, script));
        copyFileSync(resolve('teaser/vendor-paths.mjs'), join(teaser, 'vendor-paths.mjs'));
        for (const entry of ['ab', 'fonts', 'og']) symlinkSync(resolve('teaser', entry), join(teaser, entry));
        symlinkSync(outside, join(teaser, 'fixture-output', 'vendor'));
        writeFileSync(join(vendor, 'asset.js'), 'fixture');
        const artifact = join(artifacts, 'work.html');
        writeFileSync(artifact, '<html><body><svg></svg><script src="/vendor/asset.js"></script></body></html>');
        const ledger = join(root, 'fixture.jsonl');
        writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg',
          artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
        const result = spawnSync(process.execPath, [script, '--ledger', ledger, '--out', 'fixture-output'], {
          cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
        });
        if (result.status !== 0) expect(result.stderr).toContain('unsafe vendor path');
        expect(existsSync(join(outside, 'asset.js'))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it(`${script} fails when an artifact requires a missing vendor asset`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-vendor-missing-'));
      try {
        const teaser = join(root, 'teaser'); const artifacts = join(root, 'artifacts');
        mkdirSync(teaser); mkdirSync(artifacts); mkdirSync(join(root, 'vendor'));
        copyFileSync(resolve('teaser', script), join(teaser, script));
        copyFileSync(resolve('teaser/vendor-paths.mjs'), join(teaser, 'vendor-paths.mjs'));
        for (const entry of ['ab', 'fonts', 'og']) symlinkSync(resolve('teaser', entry), join(teaser, entry));
        const artifact = join(artifacts, 'work.html');
        writeFileSync(artifact, '<html><body><svg></svg><script src="/vendor/missing.js"></script></body></html>');
        const ledger = join(root, 'fixture.jsonl');
        writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg',
          artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
        const result = spawnSync(process.execPath, [script, '--ledger', ledger, '--out', 'fixture-output'], {
          cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('vendor dependency missing');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    for (const attribute of ["src='/vendor/missing.js'", 'src=/vendor/missing.js']) {
    it(`${script} detects a missing vendor asset in ${attribute}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-vendor-quote-'));
      try {
        const teaser = join(root, 'teaser'); const artifacts = join(root, 'artifacts');
        mkdirSync(teaser); mkdirSync(artifacts); mkdirSync(join(root, 'vendor'));
        copyFileSync(resolve('teaser', script), join(teaser, script));
        copyFileSync(resolve('teaser/vendor-paths.mjs'), join(teaser, 'vendor-paths.mjs'));
        for (const entry of ['ab', 'fonts', 'og']) symlinkSync(resolve('teaser', entry), join(teaser, entry));
        const artifact = join(artifacts, 'work.html');
        writeFileSync(artifact, `<html><body><svg></svg><script ${attribute}></script></body></html>`);
        const ledger = join(root, 'fixture.jsonl');
        writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg',
          artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
        const result = spawnSync(process.execPath, [script, '--ledger', ledger, '--out', 'fixture-output'], {
          cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('vendor dependency missing');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    }
  }

  for (const [script, option] of [
    ['build.mjs', '--ledger'], ['build.mjs', '--out'],
    ['build-v2.mjs', '--ledger'], ['build-v2.mjs', '--out'],
    ['build-v2.mjs', '--name'], ['build-v2.mjs', '--domain'],
  ]) {
    it(`${script} rejects a missing ${option} value`, () => {
      const result = spawnSync(process.execPath, [script, option], {
        cwd: resolve('teaser'), env: { PATH: process.env.PATH }, encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Missing value for ${option}`);
    });
  }

  it('requires an explicit ledger for the legacy builder too', () => {
    const result = spawnSync(process.execPath, ['build.mjs'], {
      cwd: resolve('teaser'), env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Specify a ledger');
  });

  it('asks for an explicit ledger when none is configured', () => {
    const result = spawnSync(process.execPath, ['build-v2.mjs', '--check'], {
      cwd: resolve('teaser'), env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Specify a ledger');
  });

  it('checks an explicitly configured ledger without building', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-teaser-ledger-'));
    try {
      const ledger = join(root, 'fixture.jsonl');
      writeFileSync(ledger, '{}\n');
      const result = spawnSync(process.execPath, ['build-v2.mjs', '--check', '--out', join(root, 'fixture-output')], {
        cwd: resolve('teaser'), env: { PATH: process.env.PATH, SINTER_TEASER_LEDGER: ledger }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(11);
      const receipt = JSON.parse(result.stdout);
      expect(receipt.check).toBe(true);
      expect(receipt.input_paths.some((path: string) => path.endsWith('/fixture.jsonl'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates the build check when vendor safety code changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-vendor-hash-'));
    try {
      copyFileSync(resolve('teaser/build-v2.mjs'), join(root, 'build-v2.mjs'));
      copyFileSync(resolve('teaser/vendor-paths.mjs'), join(root, 'vendor-paths.mjs'));
      symlinkSync(resolve('teaser/ab'), join(root, 'ab'));
      mkdirSync(join(root, 'artifacts'));
      const artifact = join(root, 'artifacts', 'work.html');
      writeFileSync(artifact, '<html><body><svg></svg></body></html>');
      writeFileSync(join(root, 'fixture.jsonl'), JSON.stringify({ event_type: 'artifact_scored', domain: 'svg', artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
      const env = { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: join(root, 'artifacts') };
      const run = () => spawnSync(process.execPath, ['build-v2.mjs', '--ledger', 'fixture.jsonl', '--out', 'dist-v2', '--check'], {
        cwd: root, env, encoding: 'utf8',
      });
      const initial = run();
      expect(initial.status, initial.stderr).toBe(11);
      expect(spawnSync(process.execPath, ['build-v2.mjs', '--ledger', 'fixture.jsonl', '--out', 'dist-v2'], { cwd: root, env }).status).toBe(0);
      appendFileSync(join(root, 'vendor-paths.mjs'), '\n// fixture mutation\n');
      expect(run().status).toBe(10);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('verifies contract changes with disposable fixture inputs', () => {
    const result = spawnSync(process.execPath, ['verify-contract-integrity.mjs', '--fixture-only'], {
      cwd: resolve('teaser'), env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CONTRACT INTEGRITY 5/5');
    expect(result.stdout).toContain('fixture');
  });

  it('does not report actual build parity without configured inputs', () => {
    const result = spawnSync(process.execPath, ['verify-contract-integrity.mjs'], {
      cwd: resolve('teaser'), env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('actual build parity');
  });

  it('runs the fixture verifier from the repository root', () => {
    const result = spawnSync(process.execPath, ['teaser/verify-contract-integrity.mjs', '--fixture-only'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CONTRACT INTEGRITY 5/5');
  });
});
