/**
 * GitReadOnlyTools - gitLog and gitDiff.
 *
 * Read-only git history/diff inspection. These close the specific capability
 * gap the harness hits when it needs to reason about what changed and why,
 * WITHOUT opening a generic shell: both tools execute `git` via execFile with
 * a fixed argument vector, validate every ref against a strict character
 * allowlist (no option injection), and cap output size. No mutation verbs
 * exist here by construction.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  Tool,
  type CommandRunner,
  type ToolResult,
  type GitLogParams,
  type GitLogResult,
  type GitDiffParams,
  type GitDiffResult,
} from './types.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COUNT = 10;
const MAX_MAX_COUNT = 50;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_MAX_CHARS = 100_000;

/**
 * Safe git ref characters: branch/tag names, SHAs, HEAD, relative specs
 * (HEAD~2, main^), and range dots (main..HEAD). Critically excludes '-' as
 * the first character and shell/option metacharacters, so a ref can never be
 * interpreted as a git option (e.g. --output=...).
 */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/~^]{0,199}$/;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

abstract class GitReadOnlyTool extends Tool {
  constructor(
    private readonly runner: CommandRunner = (command, args, options) =>
      execFileAsync(command, args, options),
  ) {
    super();
  }

  protected async runGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await this.runner('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout;
  }

  protected resolveRepoPath(params: { path?: string }): { repoPath?: string; error?: string } {
    const repoPath = params.path ?? process.cwd();
    if (!this.validatePath(repoPath)) {
      return { error: 'Path not allowed' };
    }
    return { repoPath };
  }

  protected validateRef(ref: string): string | null {
    if (!SAFE_REF.test(ref)) {
      return `Ref not allowed: ${ref}`;
    }
    return null;
  }

  protected resolveFileArg(repoPath: string, file: string): string | null {
    // The file is a repo-relative pathspec; resolve it against the repo path
    // and re-check the project confinement guard before passing it through.
    const resolved = path.resolve(repoPath, file);
    if (!this.validatePath(resolved)) {
      return `File path not allowed: ${file}`;
    }
    return null;
  }
}

export class GitLogTool extends GitReadOnlyTool {
  readonly name = 'gitLog';
  readonly description = 'Read-only git commit history (log) for the repo or a file';

  async execute(params: unknown): Promise<ToolResult<GitLogResult>> {
    const startTime = Date.now();
    const raw = (params || {}) as GitLogParams;

    try {
      const { repoPath, error: pathError } = this.resolveRepoPath(raw);
      if (pathError) return { success: false, error: pathError, duration: Date.now() - startTime };

      const ref = raw.ref ?? 'HEAD';
      const refError = this.validateRef(ref);
      if (refError) return { success: false, error: refError, duration: Date.now() - startTime };

      const args = [
        'log',
        `--max-count=${clampInt(raw.maxCount, 1, MAX_MAX_COUNT, DEFAULT_MAX_COUNT)}`,
        '--pretty=format:%h %ad %an %s',
        '--date=short',
        ref,
      ];
      if (raw.file) {
        const fileError = this.resolveFileArg(repoPath!, raw.file);
        if (fileError) return { success: false, error: fileError, duration: Date.now() - startTime };
        args.push('--', raw.file);
      }

      const stdout = await this.runGit(repoPath!, args);
      const commits = stdout.trim();
      const count = commits.length === 0 ? 0 : commits.split('\n').length;

      return {
        success: true,
        data: { commits, count, ref },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error), duration: Date.now() - startTime };
    }
  }
}

export class GitDiffTool extends GitReadOnlyTool {
  readonly name = 'gitDiff';
  readonly description = 'Read-only git diff for a ref range or working tree';

  async execute(params: unknown): Promise<ToolResult<GitDiffResult>> {
    const startTime = Date.now();
    const raw = (params || {}) as GitDiffParams;

    try {
      const { repoPath, error: pathError } = this.resolveRepoPath(raw);
      if (pathError) return { success: false, error: pathError, duration: Date.now() - startTime };

      const rangeResult = this.resolveRange(raw);
      if (rangeResult.error) return { success: false, error: rangeResult.error, duration: Date.now() - startTime };

      const maxChars = clampInt(raw.maxChars, 1_000, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);

      const args = ['diff'];
      if (raw.stat === true) args.push('--stat');
      if (rangeResult.range) args.push(rangeResult.range);
      if (raw.file) {
        const fileError = this.resolveFileArg(repoPath!, raw.file);
        if (fileError) return { success: false, error: fileError, duration: Date.now() - startTime };
        args.push('--', raw.file);
      }

      const stdout = await this.runGit(repoPath!, args);
      const truncated = stdout.length > maxChars;
      const diff = truncated
        ? `${stdout.slice(0, maxChars)}\n... [truncated: ${stdout.length - maxChars} chars omitted; narrow with params.file or params.stat]`
        : stdout;

      return {
        success: true,
        data: { diff, truncated, range: rangeResult.range ?? '(working tree)' },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error), duration: Date.now() - startTime };
    }
  }

  private resolveRange(raw: GitDiffParams): { range?: string; error?: string } {
    if (raw.base !== undefined || raw.head !== undefined) {
      if (!raw.base || !raw.head) {
        return { error: 'gitDiff requires both params.base and params.head for a range diff' };
      }
      const baseError = this.validateRef(raw.base);
      if (baseError) return { error: baseError };
      const headError = this.validateRef(raw.head);
      if (headError) return { error: headError };
      return { range: `${raw.base}..${raw.head}` };
    }
    if (raw.ref) {
      // A range expression (a..b) is two safe refs joined by dots; validate each side.
      if (raw.ref.includes('..')) {
        const [left, right] = raw.ref.split('..', 2);
        if (!left || !right || this.validateRef(left) || this.validateRef(right)) {
          return { error: `Ref not allowed: ${raw.ref}` };
        }
        return { range: raw.ref };
      }
      const refError = this.validateRef(raw.ref);
      if (refError) return { error: refError };
      return { range: raw.ref };
    }
    return {};
  }
}

export const gitLogTool = new GitLogTool();
export const gitDiffTool = new GitDiffTool();
