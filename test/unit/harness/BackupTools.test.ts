import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateBackupTool, RestoreBackupTool } from '../../../src/harness/tools/BackupTools.js';

let dir: string;
let file: string;
const made: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-tools-'));
  mkdirSync(join(dir, 'src'));
  file = join(dir, 'src', 'doc.txt');
  writeFileSync(file, 'original');
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const p of made.splice(0)) rmSync(p, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('CreateBackupTool', () => {
  it('copies an allowed file into the backup dir and returns the backup path', async () => {
    const res = await new CreateBackupTool().execute({ path: file });
    expect(res.success).toBe(true);
    const data = res.data as { backupPath: string; originalPath: string };
    made.push(data.backupPath);
    expect(data.originalPath).toBe(file);
    expect(data.backupPath).toMatch(/doc\.txt\.\d+\.backup$/);
    expect(readFileSync(data.backupPath, 'utf8')).toBe('original');
    expect(typeof res.duration).toBe('number');
  });

  it('refuses paths outside the allowed project directories without touching disk', async () => {
    const outside = join(dir, 'secrets.txt');
    writeFileSync(outside, 'x');
    const res = await new CreateBackupTool().execute({ path: outside });
    expect(res.success).toBe(false);
    expect(res.error).toBe(`Path '${outside}' is outside allowed directories`);
  });

  it('reports a missing source file as a failure', async () => {
    const res = await new CreateBackupTool().execute({ path: join(dir, 'src', 'missing.txt') });
    expect(res.success).toBe(false);
    expect(res.error).toContain('missing.txt');
  });
});

describe('RestoreBackupTool', () => {
  it('restores a backup over the original path', async () => {
    const created = await new CreateBackupTool().execute({ path: file });
    const backupPath = (created.data as { backupPath: string }).backupPath;
    made.push(backupPath);
    writeFileSync(file, 'clobbered');
    const res = await new RestoreBackupTool().execute({ backupPath, originalPath: file });
    expect(res).toMatchObject({ success: true, data: { success: true } });
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('fails clearly when the backup does not exist and leaves the target alone', async () => {
    const res = await new RestoreBackupTool().execute({ backupPath: join(dir, 'ghost.1.backup'), originalPath: file });
    expect(res.success).toBe(false);
    expect(res.error).toContain('does not exist');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('original');
  });
});
