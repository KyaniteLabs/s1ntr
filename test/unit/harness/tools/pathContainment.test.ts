import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tool, type ToolResult } from '../../../../src/harness/tools/types.js';
import {
  ValidationGuard,
  canonicalPath,
  isContained,
} from '../../../../src/harness/tools/ValidationGuard.js';
import { PathTraversalError } from '../../../../src/harness/errors.js';

class ProbeTool extends Tool {
  readonly name = 'probe';
  readonly description = 'exposes validatePath';
  async execute(): Promise<ToolResult> {
    return { success: true };
  }
  allowed(p: string): boolean {
    return this.validatePath(p);
  }
}

let root: string;
let outside: string;
let tool: ProbeTool;

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'containment-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export {}');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  tool = new ProbeTool();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('Tool.validatePath containment', () => {
  it('allows a normal new file inside an allowed root', () => {
    expect(tool.allowed(path.join(root, 'output', 'new.txt'))).toBe(true);
  });

  it('refuses reading through a symlinked directory that points outside', () => {
    fs.symlinkSync(outside, path.join(root, 'output', 'link'));
    expect(tool.allowed(path.join(root, 'output', 'link', 'secret.txt'))).toBe(false);
  });

  it('refuses a new file under a symlinked parent that points outside', () => {
    fs.symlinkSync(outside, path.join(root, 'output', 'link'));
    expect(tool.allowed(path.join(root, 'output', 'link', 'deep', 'new.txt'))).toBe(false);
  });

  it('refuses a dangling symlink leaf, which a write would follow', () => {
    fs.symlinkSync(path.join(outside, 'planted.txt'), path.join(root, 'output', 'trap.txt'));
    expect(tool.allowed(path.join(root, 'output', 'trap.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
  });

  it('refuses a symlink into a forbidden root like .git', () => {
    fs.symlinkSync(path.join(root, '.git'), path.join(root, 'output', 'g'));
    expect(tool.allowed(path.join(root, 'output', 'g', 'config'))).toBe(false);
  });

  it('allows a symlink that stays inside another allowed root', () => {
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'output', 'srclink'));
    expect(tool.allowed(path.join(root, 'output', 'srclink', 'a.ts'))).toBe(true);
  });

  it('refuses a sibling directory that only shares a prefix', () => {
    fs.mkdirSync(path.join(root, 'output-evil'));
    expect(tool.allowed(path.join(root, 'output-evil', 'x.txt'))).toBe(false);
  });
});

describe('ValidationGuard containment', () => {
  it('throws for a path that escapes through a symlink', async () => {
    fs.symlinkSync(outside, path.join(root, 'output', 'link'));
    const guard = new ValidationGuard();
    await expect(
      guard.validatePath(path.join(root, 'output', 'link', 'secret.txt'), {
        allowedPrefixes: [path.join(root, 'output')],
        allowAbsolute: true,
      }),
    ).rejects.toThrow(PathTraversalError);
  });

  it('reports the escape in the sync check too', () => {
    fs.symlinkSync(outside, path.join(root, 'output', 'link'));
    const result = new ValidationGuard().validatePathSync(
      path.join(root, 'output', 'link', 'secret.txt'),
      { allowedPrefixes: [path.join(root, 'output')], allowAbsolute: true },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('outside allowed directories');
  });
});

describe('canonicalPath', () => {
  it('appends missing segments to the resolved existing ancestor', () => {
    fs.symlinkSync(outside, path.join(root, 'output', 'link'));
    expect(canonicalPath(path.join(root, 'output', 'link', 'a', 'b.txt'))).toBe(
      path.join(outside, 'a', 'b.txt'),
    );
  });

  it('returns null for a dangling symlink', () => {
    fs.symlinkSync(path.join(outside, 'gone'), path.join(root, 'output', 'dangling'));
    expect(canonicalPath(path.join(root, 'output', 'dangling'))).toBeNull();
  });

  it('isContained is false for an empty root list', () => {
    expect(isContained(path.join(root, 'src', 'a.ts'), [])).toBe(false);
  });
});
