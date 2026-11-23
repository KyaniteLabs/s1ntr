import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDatamosh } from '../../../src/render/DatamoshRenderer.js';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const d = haveFfmpeg ? describe : describe.skip;
let root = '';
let out = '';

beforeAll(() => {
  if (!haveFfmpeg) return;
  root = mkdtempSync(path.join(os.tmpdir(), 'mosh-lib-'));
  out = mkdtempSync(path.join(os.tmpdir(), 'mosh-out-'));
  const file = path.join(root, 'bars.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  const buf = readFileSync(file);
  writeFileSync(path.join(root, 'bars.json'), JSON.stringify({
    id: 'bars', file: 'bars.mp4', kind: 'outside', source: 'wikimedia-commons', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bars.mp4',
    downloadUrl: 'https://example.invalid/bars.mp4', title: 'Bars', author: 'Test Author', licence: 'CC-BY-4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/', creditLine: 'Bars by Test Author, CC BY 4.0',
    sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, retrievedAt: '2026-11-19',
  }));
  const portrait = path.join(root, 'portrait.mp4');
  const encoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=180x320:rate=24:duration=4', '-c:v', 'libx264', '-threads', '1', portrait]);
  expect(encoded.status, String(encoded.stderr)).toBe(0);
  const portraitBytes = readFileSync(portrait);
  const source = JSON.parse(readFileSync(path.join(root, 'bars.json'), 'utf8'));
  writeFileSync(path.join(root, 'portrait.json'), JSON.stringify({ ...source, id: 'portrait', file: 'portrait.mp4',
    width: 180, height: 320, sha256: createHash('sha256').update(portraitBytes).digest('hex'), bytes: portraitBytes.length }));
});
afterAll(() => { for (const d of [root, out]) if (d) rmSync(d, { recursive: true, force: true }); });

const plan = (extra: Record<string, unknown> = {}) => JSON.stringify({
  segments: [{ clip: 'bars', start: 0, duration: 4 }], gop: 12, fps: 24, width: 320, strip: 'all', holds: [{ at: 30, repeat: 20 }], ...extra,
});

function lastFrameHash(video: string): string {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-sseof', '-0.1', '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'bmp', '-']);
  return createHash('sha256').update(r.stdout).digest('hex');
}

d('renderDatamosh (real ffmpeg)', () => {
  it('joins mixed-aspect footage on a common canvas', async () => {
    const result = await renderDatamosh(plan({ segments: [
      { clip: 'bars', start: 0, duration: 2 },
      { clip: 'portrait', start: 0, duration: 2 },
    ] }), { footageRoot: root, outputDir: path.join(out, 'mixed') });
    expect(result.success, result.error).toBe(true);
    expect(result.evidence?.clips).toEqual(['bars', 'portrait']);
  }, 60_000);
  it('strips I-frames and duplicates P-frames in the real bitstream, and writes video, contact sheet and credits', async () => {
    const r = await renderDatamosh(plan(), { footageRoot: root, outputDir: path.join(out, 'a') });
    expect(r.success).toBe(true);
    expect(existsSync(r.videoPath!)).toBe(true);
    expect(readFileSync(r.contactSheetPath!).subarray(1, 4).toString()).toBe('PNG');
    expect(r.evidence!.bitstream.iBefore).toBeGreaterThan(1);
    expect(r.evidence!.bitstream.iAfter).toBe(1);
    expect(r.evidence!.bitstream.stripped).toBe(r.evidence!.bitstream.iBefore - 1);
    expect(r.evidence!.bitstream.duplicated).toBe(20);
    expect(r.evidence!.credits).toEqual(['Bars by Test Author, CC BY 4.0']);
    expect(r.evidence!.frames).toBeGreaterThanOrEqual(96);
  }, 60_000);

  it('produces different pixels than the same clip encoded with no mosh', async () => {
    const mosh = await renderDatamosh(plan(), { footageRoot: root, outputDir: path.join(out, 'm') });
    const clean = await renderDatamosh(plan({ strip: [], holds: [] }), { footageRoot: root, outputDir: path.join(out, 'c') });
    expect(lastFrameHash(mosh.videoPath!)).not.toBe(lastFrameHash(clean.videoPath!));
  }, 90_000);

  it('is deterministic: the same plan gives the same edited bitstream', async () => {
    const a = await renderDatamosh(plan(), { footageRoot: root, outputDir: path.join(out, 'd1') });
    const b = await renderDatamosh(plan(), { footageRoot: root, outputDir: path.join(out, 'd2') });
    expect(a.evidence!.editedSha256).toBe(b.evidence!.editedSha256);
  }, 90_000);

  it('fails with kind "plan" for an unknown clip and never starts ffmpeg', async () => {
    const r = await renderDatamosh(plan({ segments: [{ clip: 'ghost', start: 0, duration: 2 }] }), { footageRoot: root, outputDir: path.join(out, 'g') });
    expect(r).toMatchObject({ success: false, failureKind: 'plan' });
    expect(r.error).toContain('ghost');
  });

  it('kills ffmpeg at the hard timeout and reports kind "timeout"', async () => {
    const t0 = Date.now();
    const r = await renderDatamosh(plan(), { footageRoot: root, outputDir: path.join(out, 't'), timeoutMs: 1 });
    expect(r).toMatchObject({ success: false, failureKind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('refuses a clip whose bytes no longer match the manifest sha256', async () => {
    writeFileSync(path.join(root, 'bars.mp4'), Buffer.concat([readFileSync(path.join(root, 'bars.mp4')), Buffer.from('x')]));
    const r = await renderDatamosh(plan(), { footageRoot: root, outputDir: path.join(out, 's') });
    expect(r).toMatchObject({ success: false, failureKind: 'footage' });
  });
});
