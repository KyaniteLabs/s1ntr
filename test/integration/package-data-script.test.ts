// @no-cli-spawn: only `npm pack --dry-run` runs here; bin/sinter is a file-list entry, never executed.
/** Sol F16: `sinter data` runs scripts/data/sinter_data.py, so the tarball must carry it. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 280_000 });

describe('packed install carries what bin/sinter shells out to', () => {
  it('npm pack lists the data script that `sinter data` runs', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files: string[] = JSON.parse(out.slice(out.indexOf('[\n')))[0].files.map((f: { path: string }) => f.path);
    expect(files).toContain('scripts/data/sinter_data.py');
    expect(files).toContain('bin/sinter');
  });
});
