import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runProductionCliGenerate } from '../../src/cli/LiminalProductionGenerate.js';
import { createProductionLiminalRuntime } from '../../src/runtime-core/ProductionLiminalRuntime.js';
import { createTestReceiptAuthority } from '../../src/runtime-core/LiminalCommandService.js';
import { createTestLiminalOwnerReviewAuthority } from '../../src/runtime-core/LiminalOwnerReviewAuthority.js';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';
import { buildSandboxedCommand, hostSandboxDeps } from '../../src/render/BlenderSandbox.js';
import { renderDatamosh } from '../../src/render/DatamoshRenderer.js';

// End to end through the real governed entrypoint: runProductionCliGenerate -> real runtime ->
// generate -> real validation -> real HeadlessRenderer (real ffmpeg bitstream edit) -> real judge path.
// Stubbed only at the LLM boundary: the generator and evaluator clients.
const haveCodec = ['ffmpeg', 'ffprobe', 'bwrap'].every((tool) => spawnSync(tool, ['--version']).status === 0
  || spawnSync(tool, ['-version']).status === 0);
const requireIsolation = process.env.SINTER_REQUIRE_CODEC_ISOLATION_TEST === '1';
const d = haveCodec || process.env.GITHUB_ACTIONS === 'true' || requireIsolation ? describe : describe.skip;
function probeCodecIsolation() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'e2e-codec-probe-'));
  try {
    const plan = buildSandboxedCommand(process.platform, {
      command: 'ffmpeg', args: ['-version'], cwd, env: {}, readOnlyFiles: [],
    }, hostSandboxDeps());
    if (!plan.ok) throw new Error(plan.message);
    return spawnSync(plan.command, plan.args, { timeout: 5_000 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const probeSandbox = haveCodec ? probeCodecIsolation() : undefined;
const canIsolate = probeSandbox?.status === 0;
const dirs: string[] = [];
const tmp = (p: string) => { const dir = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(dir); return dir; };
let footage = '';

beforeAll(() => {
  if (!haveCodec) throw new Error('governed Datamosh requires ffmpeg, ffprobe and bubblewrap');
  if (requireIsolation && !canIsolate) {
    throw new Error(`required Bubblewrap namespace probe failed: ${probeSandbox?.stderr.toString()}`);
  }
  footage = tmp('e2e-footage-');
  const file = path.join(footage, 'bars.mp4');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  const buf = readFileSync(file);
  writeFileSync(path.join(footage, 'bars.json'), JSON.stringify({
    id: 'bars', file: 'bars.mp4', kind: 'outside', source: 'wikimedia-commons', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Bars.mp4',
    title: 'Bars', author: 'Test Author', licence: 'CC-BY-4.0', creditLine: 'Bars by Test Author, CC BY 4.0',
    sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, retrievedAt: '2026-11-19',
  }));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const PLAN = JSON.stringify({ segments: [{ clip: 'bars', start: 0, duration: 4 }], gop: 12, fps: 24, width: 320, strip: 'all', holds: [{ at: 30, repeat: 18 }], post: { saturation: 2.5 } });

d('datamosh through the governed production entrypoint', () => {
  it.skipIf(!canIsolate)('makes, renders, judges and cards a datamosh piece with the flag on', async () => {
    vi.stubEnv('SINTER_NEXT_DOMAINS', '1');
    vi.stubEnv('SINTER_FOOTAGE_ROOT', footage);
    vi.stubEnv('SINTER_LIMINAL_RUNTIME_ROOT', tmp('e2e-shared-'));
    const out = tmp('e2e-out-');
    const generate = vi.fn(async () => ({ success: true, code: PLAN }));
    const judge = vi.fn(async () => ({ success: true, code: JSON.stringify({ score: 0.81, confidence: 0.9, reasoning: 'hard saturated smear', failureClass: 'none' }) }));
    const client = (model: string, fn: unknown) => ({ getConfig: () => ({ provider: 'fake', model }), generate: fn }) as never;
    const factory = (o: { root: string; artifactRoot: string }) => createProductionLiminalRuntime({
      ...o, generator: client('generator', generate), evaluator: client('evaluator', judge), renderer: HeadlessRenderer.getInstance(),
      sourceRefs: { sourceHeadSha: '1'.repeat(40), canonicalMainSha: '2'.repeat(40) },
      harnessIdentity: 'fake/harness', studioIdentity: 'fake/studio',
      receiptAuthority: createTestReceiptAuthority('e2e-secret'), ownerReviewAuthority: createTestLiminalOwnerReviewAuthority('e2e-owner'),
      knowledgeSigningKey: 'e2e-knowledge',
    });
    const generated = await runProductionCliGenerate({ prompt: 'melt the bars', domain: 'datamosh', outputRoot: out }, factory);

    // generation: the model was asked with the datamosh rules and the footage list
    const asked = JSON.stringify(generate.mock.calls[0]);
    expect(asked).toContain('Footage available');
    expect(asked).toContain('bars: Bars');
    expect(readFileSync(generated.sourcePath, 'utf8')).toContain('"clip":"bars"');
    // judging: the judge ran once, on the real contact sheet
    expect(judge, JSON.stringify({
      evaluation: generated.result.evaluation, renderErrors: generated.result.evidence.runtimeErrors,
    })).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(judge.mock.calls[0])).toContain('datamosh');
    const dir = path.dirname(generated.sourcePath);
    expect(readFileSync(path.join(dir, 'early-frame.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(JSON.stringify(generated.result)).toContain('0.81');
    // wall card: real video plus the credit line from the manifest
    expect(generated.previewPath).toBe(path.join(dir, 'preview.html'));
    expect(readFileSync(generated.previewPath!, 'utf8')).toContain('Bars by Test Author, CC BY 4.0');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,nb_read_frames', '-count_frames', '-of', 'csv=p=0', path.join(dir, 'mosh.mp4')]);
    expect(String(probe.stdout).trim()).toMatch(/^h264,\d+$/);
    expect(existsSync(path.join(dir, 'card.json'))).toBe(true);
    expect(readdirSync(dir)).toContain('mosh.mp4');
    const videoDigest = createHash('sha256').update(readFileSync(path.join(dir, 'mosh.mp4'))).digest('hex');
    expect(generated.result.evidence.containment?.assetDigests).toContain(videoDigest);

    const replay = await runProductionCliGenerate({
      prompt: 'melt the bars', domain: 'datamosh', outputRoot: tmp('e2e-replay-'),
    }, factory);
    expect(replay.artifactsPresent).toBe(false);
    expect(replay.originalArtifactDirectory).toBe(dir);
    expect(replay.result.operationId).toBe(generated.result.operationId);
    expect(judge).toHaveBeenCalledTimes(1);
  }, 180_000);

  it.skipIf(canIsolate)('fails closed when the container denies the required namespaces', async () => {
    expect(probeSandbox?.stderr.toString()).toMatch(/(?:namespace|permission|operation not permitted)/i);
    const outputDir = tmp('e2e-isolation-unavailable-');
    const result = await renderDatamosh(PLAN, { outputDir, footageRoot: footage, isolated: true });
    expect(result).toMatchObject({ success: false, failureKind: 'render', error: expect.stringMatching(/bwrap:/) });
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it('with the flag off, refuses before any runtime or provider call', async () => {
    vi.stubEnv('SINTER_NEXT_DOMAINS', '');
    const factory = vi.fn();
    await expect(runProductionCliGenerate({ prompt: 'x', domain: 'datamosh', outputRoot: tmp('e2e-off-') }, factory as never))
      .rejects.toThrow(/NEXT_DOMAIN_DISABLED:datamosh.*SINTER_NEXT_DOMAINS/);
    expect(factory).not.toHaveBeenCalled();
  });
});
