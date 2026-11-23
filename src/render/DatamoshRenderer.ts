/**
 * DatamoshRenderer - real codec-level datamosh from a JSON plan.
 *
 * ffmpeg encodes the chosen footage to an MPEG-4 part 2 elementary stream (no B-frames, fixed GOP),
 * Mpeg4Mosh strips I-VOPs and repeats P-VOPs in the bitstream, and ffmpeg decodes the damaged stream
 * (ignoring errors) to H.264 for the wall. Child processes share a deadline and host stages check it.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FootageError, FootageLibrary, creditLines, type FootageManifest } from '../footage/FootageLibrary.js';
import { parseMoshPlan, PlanError, type MoshPlan } from './DatamoshPlan.js';
import { moshMpeg4, splitMpeg4, type MoshStats } from './Mpeg4Mosh.js';
import { runBounded } from './BoundedProcess.js';
import { writeWallCard } from './NextDomainCard.js';
import { FSIZE_BYTES, buildSandboxedCommand, hostSandboxDeps } from './BlenderSandbox.js';

export const DATAMOSH_DEFAULT_TIMEOUT_MS = 120_000;
export type DatamoshFailureKind = 'plan' | 'footage' | 'timeout' | 'render';

export interface DatamoshEvidence {
  bitstream: MoshStats;
  frames: number;
  credits: string[];
  clips: string[];
  editedSha256: string;
  videoSha256: string;
  plan: MoshPlan;
}
export interface DatamoshResult {
  success: boolean;
  failureKind?: DatamoshFailureKind;
  error?: string;
  videoPath?: string;
  contactSheetPath?: string;
  cardPath?: string;
  evidence?: DatamoshEvidence;
}
export interface DatamoshOptions {
  footageRoot?: string;
  outputDir: string;
  timeoutMs?: number;
  isolated?: boolean;
}

class Fail extends Error { constructor(readonly kind: DatamoshFailureKind, message: string) { super(message); } }

export async function renderDatamosh(planText: string, options: DatamoshOptions): Promise<DatamoshResult> {
  const outputDir = path.resolve(options.outputDir);
  const deadline = Date.now() + (options.timeoutMs ?? DATAMOSH_DEFAULT_TIMEOUT_MS);
  const left = () => deadline - Date.now();
  const checkBudget = () => {
    if (left() <= 0) throw new Fail('timeout', 'Datamosh exceeded the render deadline');
  };
  const ff = async (args: string[], what: string, readOnlyFiles: readonly string[] = []) => {
    const argv = ['-v', 'error', '-nostdin', '-y', ...args];
    const command = options.isolated
      ? buildSandboxedCommand(process.platform, {
        command: 'ffmpeg', args: argv, cwd: outputDir, env: {}, readOnlyFiles,
      }, hostSandboxDeps())
      : { ok: true as const, command: 'ffmpeg', args: argv };
    if (!command.ok) throw new Fail('render', `codec isolation unavailable: ${command.message}`);
    const r = await runBounded(command.command, command.args, left());
    if (r.timedOut) throw new Fail('timeout', `${what} exceeded the render deadline`);
    if (r.code !== 0) throw new Fail('render', `${what} failed: ${r.stderr.slice(0, 300)}`);
  };
  try {
    checkBudget();
    let plan: MoshPlan;
    try { plan = parseMoshPlan(planText).plan; } catch (e) { throw new Fail('plan', e instanceof PlanError ? e.message : String(e)); }
    const lib = new FootageLibrary(options.footageRoot);
    const known = new Set(lib.list().map((m) => m.id));
    for (const s of plan.segments) if (!known.has(s.clip)) throw new Fail('plan', `plan names footage "${s.clip}" which is not in the library`);
    const clips: Array<{ manifest: FootageManifest; path: string }> = [];
    for (const s of plan.segments) {
      try {
        const clip = lib.get(s.clip, checkBudget);
        clips.push({ ...clip, path: realpathSync(clip.path) });
      } catch (e) {
        if (e instanceof Fail) throw e;
        throw new Fail('footage', e instanceof FootageError ? e.message : String(e));
      }
    }
    mkdirSync(outputDir, { recursive: true });
    const raw = path.join(outputDir, 'source.m4v');
    const moshed = path.join(outputDir, 'mosh.m4v');
    const video = path.join(outputDir, 'mosh.mp4');
    const sheet = path.join(outputDir, 'contact.png');

    const inputs = plan.segments.flatMap((s, i) => ['-ss', String(s.start), '-t', String(s.duration), '-i', clips[i].path]);
    const first = clips[0].manifest;
    const aspect = first.width && first.height ? first.height / first.width : 9 / 16;
    const height = Math.round(plan.width * Math.min(2, Math.max(0.5, aspect)) / 2) * 2;
    const geometry = clips.length === 1 ? `scale=${plan.width}:-2`
      : `scale=${plan.width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${plan.width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    const chains = plan.segments.map((_s, i) => `[${i}:v]${geometry},fps=${plan.fps},setsar=1[v${i}]`);
    const joined = plan.segments.length > 1 ? `${plan.segments.map((_s, i) => `[v${i}]`).join('')}concat=n=${plan.segments.length}:v=1:a=0[v]` : '[v0]null[v]';
    await ff([...inputs, '-filter_complex', `${chains.join(';')};${joined}`, '-map', '[v]', '-an', '-c:v', 'mpeg4', '-bf', '0', '-g', String(plan.gop), '-qscale:v', '4', '-threads', '1', '-f', 'm4v', raw], 'encode', clips.map((clip) => clip.path));

    let edited: Buffer; let stats: MoshStats;
    try {
      ({ out: edited, stats } = moshMpeg4(readFileSync(raw), { strip: plan.strip, holds: plan.holds }, FSIZE_BYTES));
    } catch (e) { throw new Fail('plan', `bitstream edit: ${e instanceof Error ? e.message : String(e)}`); }
    checkBudget();
    writeFileSync(moshed, edited);
    const frames = splitMpeg4(edited).vops.length;
    const eq = `eq=saturation=${plan.post.saturation}:contrast=${plan.post.contrast},hue=h=${plan.post.hue}`;
    await ff(['-err_detect', 'ignore_err', '-framerate', String(plan.fps), '-f', 'm4v', '-i', moshed, '-vf', `${eq},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '1', '-movflags', '+faststart', video], 'decode');
    const every = Math.max(1, Math.floor(frames / 8));
    await ff(['-i', video, '-vf', `select='not(mod(n\\,${every}))',scale=240:-2,tile=4x2`, '-frames:v', '1', '-fps_mode', 'vfr', sheet], 'contact sheet');
    copyFileSync(sheet, path.join(outputDir, 'early-frame.png'));

    const manifests = clips.map((c) => c.manifest);
    const credits = creditLines(manifests);
    const card = writeWallCard(outputDir, {
      domain: 'datamosh', title: `Datamosh of ${manifests.map((m) => m.title).join(' + ')}`.slice(0, 120), credits,
      video: 'mosh.mp4', still: 'contact.png',
      note: `Real bitstream edit: ${stats.stripped} I-frames stripped, ${stats.duplicated} P-frames repeated, ${frames} frames.`,
      requireCredits: manifests.some((m) => m.kind !== 'own'),
    });
    const videoSha256 = createHash('sha256').update(readFileSync(video)).digest('hex');
    checkBudget();
    return {
      success: true, videoPath: video, contactSheetPath: sheet, cardPath: card.htmlPath,
      evidence: { bitstream: stats, frames, credits, clips: manifests.map((m) => m.id),
        editedSha256: createHash('sha256').update(edited).digest('hex'),
        videoSha256, plan },
    };
  } catch (e) {
    if (e instanceof Fail) return { success: false, failureKind: e.kind, error: e.message };
    return { success: false, failureKind: 'render', error: e instanceof Error ? e.message : String(e) };
  }
}
