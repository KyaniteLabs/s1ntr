// Sol L3-11: a shared absolute deadline, a hung encoder is killed (and proven gone), and returned media is measured.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VideoExporter } from '../../../src/export/VideoExporter.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('VideoExporter deadline and probe (Sol L3-11)', () => {
  it('kills a hung encoder at the shared deadline and says so truthfully', async () => {
    // Under cwd: validateFilePath only accepts paths inside it. The hung "ffmpeg" ignores SIGTERM.
    const dir = mkdtempSync(path.join(process.cwd(), 'tmp-vidx-'));
    try {
      const pidFile = path.join(dir, 'pid');
      const fake = path.join(dir, 'ffmpeg');
      writeFileSync(fake, `#!/bin/bash\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile true; do sleep 0.2; done\n`);
      chmodSync(fake, 0o755);
      const exporter = new VideoExporter({ ffmpegPath: fake, deadlineAt: Date.now() + 1500 });
      const started = Date.now();
      await expect(exporter.convert(path.join(dir, 'in.mov'), path.join(dir, 'out.mp4'), 'mp4'))
        .rejects.toThrow(/killed \(SIGKILL\) after exceeding its \d+ ms budget/);
      expect(Date.now() - started).toBeLessThan(5000);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      await new Promise(r => setTimeout(r, 300));
      expect(alive(pid)).toBe(false); // child teardown confirmed, not assumed
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not start the encoder once the shared deadline is already spent', async () => {
    const exporter = new VideoExporter({ ffmpegPath: '/nonexistent/ffmpeg', deadlineAt: Date.now() - 1 });
    await expect(exporter.convert('a.mov', 'b.mp4', 'mp4')).rejects.toThrow(/deadline was already spent/);
  });

  it('probes the real size and duration of a produced file, not the requested ones', async () => {
    const dir = mkdtempSync(path.join(process.cwd(), 'tmp-vidx-'));
    try {
      const out = path.join(dir, 'real.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1:r=10', '-pix_fmt', 'yuv420p', '-y', out]);
      const m = await new VideoExporter().probe(out);
      expect(m.width).toBe(64); expect(m.height).toBe(48);
      expect(m.durationSec).toBeGreaterThan(0.8); expect(m.durationSec).toBeLessThan(1.3);
      writeFileSync(path.join(dir, 'bad.mp4'), 'not a video');
      await expect(new VideoExporter().probe(path.join(dir, 'bad.mp4'))).rejects.toThrow(/ffprobe/);
      expect(existsSync(out)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
