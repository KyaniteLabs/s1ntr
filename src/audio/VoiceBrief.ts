/**
 * Voice brief: turns a recording (a voice, a hum, any sound) into a short block of plain numbers
 * (colours, motion, shape, energy) that is appended to the generation brief, so the piece is
 * shaped by what the recording sounds like. `describeVisualMapping` is the one formatter shared
 * with ContextBuilder (the legacy loop); `analyzeVoiceFile` decodes with ffmpeg and runs AudioAnalyzer.
 */
import { spawn } from 'node:child_process';
import { AudioAnalyzer } from './AudioAnalyzer.js';
import type { VisualMappingParams } from './types.js';

type LooseMapping = Partial<Record<keyof VisualMappingParams, unknown>> & Record<string, unknown>;

/** Header + one line per group, exactly the text ContextBuilder always produced. */
export function describeVisualMapping(mapping: object): string {
  const vp = mapping as { [K in keyof VisualMappingParams]?: any } & LooseMapping;
  let out = '';
  if (vp.palette) {
    out += '  Palette: hues=' + JSON.stringify(vp.palette.hues) + ', saturations=' + JSON.stringify(vp.palette.saturations)
      + ', lightness=' + JSON.stringify(vp.palette.lightness) + '\n';
  }
  if (vp.motion) out += '  Motion: speed=' + vp.motion.speed + ', turbulence=' + vp.motion.turbulence + ', rhythm=' + vp.motion.rhythm + '\n';
  if (vp.form) out += '  Form: complexity=' + vp.form.complexity + ', sharpness=' + vp.form.sharpness + ', scale=' + vp.form.scale + '\n';
  if (vp.dynamics) out += '  Dynamics: energy=' + vp.dynamics.energy + '\n';
  if (vp.composition) out += '  Composition: focalWeight=' + vp.composition.focalWeight + ', balance=' + vp.composition.balance + '\n';
  return out;
}

export const VOICE_BRIEF_HEADER = '\n\nAudio-derived visual parameters:\n';

/** The block appended to a brief; empty string when the mapping carries nothing. */
export function buildVoiceBrief(mapping: object): string {
  const body = describeVisualMapping(mapping);
  return body ? VOICE_BRIEF_HEADER + body : '';
}

export function applyVoiceBrief(prompt: string, mapping: object): string {
  return prompt + buildVoiceBrief(mapping);
}

const SAMPLE_RATE = 44100;
/** Only the first seconds are analysed: enough to read pitch, tone and energy, bounded in cost. */
const MAX_ANALYSIS_SECONDS = 10;
const FFMPEG_TIMEOUT_MS = 30_000;

/** Decodes any audio file to mono float samples at 44.1 kHz through ffmpeg. */
export function decodeAudioFile(file: string, ffmpegBin = 'ffmpeg'): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ['-v', 'quiet', '-t', String(MAX_ANALYSIS_SECONDS), '-i', file, '-f', 's16le', '-ac', '1',
      '-ar', String(SAMPLE_RATE), 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`VOICE_FILE_DECODE_FAILED: could not run ${ffmpegBin} (${e.message})`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      if (code !== 0 || pcm.length < 4096) {
        reject(new Error(`VOICE_FILE_DECODE_FAILED: ${file} is not readable audio (ffmpeg exit ${code}, ${pcm.length} bytes)`));
        return;
      }
      const samples = new Float32Array(Math.floor(pcm.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      resolve(samples);
    });
  });
}

/** Recording -> visual mapping (palette, motion, form, dynamics, composition). */
export async function analyzeVoiceFile(file: string, ffmpegBin?: string): Promise<VisualMappingParams> {
  const samples = await decodeAudioFile(file, ffmpegBin);
  const analyzer = new AudioAnalyzer();
  return analyzer.getVisualMapping(analyzer.analyze(samples, SAMPLE_RATE));
}
