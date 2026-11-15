/**
 * Tool Types for Meta-Harness Agent
 * 
 * Each tool follows the JSON-RPC style interface:
 * - name: Tool identifier
 * - params: Input parameters
 * - result: Output result
 */

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  duration?: number;
}

export interface ReadFileParams {
  path: string;
  maxLines?: number;
  offset?: number;
  /** 1-based line number alias for offset; useful for models reading startLine/endLine metadata. */
  startLine?: number;
  limit?: number;
  /** Return a targeted excerpt around the first matching line containing this text. */
  pattern?: string;
  /** Alias for pattern when the caller knows the symbol name to inspect. */
  symbol?: string;
  /** Number of lines to include before a pattern/symbol match. */
  before?: number;
  /** Number of lines to include after a pattern/symbol match. */
  after?: number;
}

export interface ReadFileResult {
  content: string;
  exists: boolean;
  lineCount: number;
  truncated?: boolean;
  startLine?: number;
  endLine?: number;
  matchLine?: number;
  additionalMatchesExist?: boolean;
}

export interface WriteFileParams {
  path: string;
  content: string;
  mode?: 'overwrite' | 'append';
  createBackup?: boolean;
}

export interface WriteFileResult {
  bytesWritten: number;
  backupPath?: string;
}

export interface ApplyEditParams {
  path: string;
  oldString?: string;
  newString?: string;
  /** Alias commonly emitted by model planners. */
  search?: string;
  /** Alias commonly emitted by model planners. */
  replace?: string;
  /** Alias commonly emitted by model planners. */
  oldText?: string;
  /** Alias commonly emitted by model planners. */
  newText?: string;
  createBackup?: boolean;
}

export interface ApplyEditResult {
  replacements: number;
  backupPath?: string;
  /** Hint for which verification tool to use based on file extension */
  verificationHint?: string;
}

export interface RunBuildParams {
  timeoutMs?: number;
}

export interface RunBuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export interface RunTestsParams {
  pattern?: string;
  timeoutMs?: number;
}

export interface RunTestsResult {
  exitCode: number;
  passed: number;
  failed: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export interface GitStatusParams {
  path?: string;
}

export interface GitLogParams {
  path?: string;
  /** Single ref to start the log from (validated against git-ref characters). */
  ref?: string;
  /** Max commits to return (default 10, capped at 50). */
  maxCount?: number;
  /** Optional repo-relative file pathspec to limit history to. */
  file?: string;
}

export interface GitLogResult {
  commits: string;
  count: number;
  ref: string;
}

export interface GitDiffParams {
  path?: string;
  /** Base ref for a range diff (requires head). */
  base?: string;
  /** Head ref for a range diff (requires base). */
  head?: string;
  /** Single ref/range expression (e.g. 'HEAD~1..HEAD') when base/head are not used. */
  ref?: string;
  /** Optional repo-relative file pathspec to limit the diff to. */
  file?: string;
  /** Return --stat summary instead of the full patch. */
  stat?: boolean;
  /** Max characters of diff output before truncation (default 20000). */
  maxChars?: number;
}

export interface GitDiffResult {
  diff: string;
  truncated: boolean;
  range: string;
}

export interface RenderArtifactParams {
  /** Inline artifact source code (p5/three/hydra/html/svg/...). */
  code?: string;
  /** Repo-relative path to a file containing the artifact source. */
  path?: string;
  /** Domain hint; auto-detected from code when omitted. */
  domain?: string;
  width?: number;
  height?: number;
  timeout?: number;
}

export interface RenderArtifactScreenshot {
  mimeType: string;
  dataBase64: string;
  width?: number;
  height?: number;
}

export interface RenderArtifactResult {
  domain: string;
  timingMs: number;
  infraUnavailable: boolean;
  candidateFailure: boolean;
  screenshot?: RenderArtifactScreenshot;
  lateScreenshot?: RenderArtifactScreenshot;
  logs: string[];
  errors: string[];
}

export interface GitStatusResult {
  branch: string;
  commitSha: string;
  shortSha: string;
  hasHeadCommit: boolean;
  short: string;
  clean: boolean;
  root: string;
}

export interface LocalCheckpointParams {
  /** Short description of what was accomplished */
  message: string;
  /** Task ID for traceability */
  taskId?: string;
  /** Whether to run build verification before committing (default: true) */
  verifyBuild?: boolean;
}

export interface LocalCheckpointResult {
  /** The commit hash of the checkpoint */
  commitHash: string;
  /** Short commit hash */
  shortHash: string;
  /** Branch the checkpoint was created on */
  branch: string;
  /** Number of files changed */
  filesChanged: number;
  /** Whether build verification was run and passed */
  buildVerified: boolean;
}

export interface CreateBackupParams {
  path: string;
}

export interface CreateBackupResult {
  backupPath: string;
  originalPath: string;
  success: boolean;
}

export interface RestoreBackupParams {
  backupPath: string;
  originalPath?: string;
}

export interface RestoreBackupResult {
  success: boolean;
}

export interface ToolCall {
  id: string;
  tool: string;
  params: unknown;
}

export interface ToolResponse {
  id: string;
  result: ToolResult;
}

export interface CommandRunnerResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<CommandRunnerResult>;

import path from 'node:path';
import { canonicalPath, isContained } from './ValidationGuard.js';

/** Roots no harness tool may touch (SSOT shared with DiagnosePathAllowlist). */
const FORBIDDEN_ROOTS = ['.quality', 'node_modules', '.git'];

export abstract class Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  
  abstract execute(params: unknown): Promise<ToolResult>;
  
  protected validatePath(filePath: string): boolean {
    // Security: Only allow paths within project
    const resolved = path.resolve(filePath);
    const cwd = process.cwd();
    const rel = path.relative(cwd, resolved).replace(/\\/g, '/');
    // W9-L4-01: never allow diagnose-forbidden roots (SSOT shared with DiagnosePathAllowlist)
    if (FORBIDDEN_ROOTS.some(root => rel === root || rel.startsWith(`${root}/`))) {
      return false;
    }

    // Allow project implementation and verification surfaces.
    const allowedPrefixes = [
      path.join(cwd, 'src'),
      path.join(cwd, 'test'),
      path.join(cwd, 'docs'),
      path.join(cwd, 'scripts'),
      path.join(cwd, 'harness-tasks'),
      path.join(cwd, '.omx'),
      path.join(cwd, 'output'),
      path.join(cwd, 'gallery'),
      path.join(cwd, 'tmp'),
    ];
    const allowedFiles = [
      path.join(cwd, 'package.json'),
      path.join(cwd, 'package-lock.json'),
      path.join(cwd, 'pnpm-lock.yaml'),
    ];

    // Require exact prefix or a path-separator boundary so sibling dirs
    // like "output-evil" do not match allowed prefix "output".
    if (resolved === cwd) return true;
    // Check the path as written and where it really lands, so a symlink
    // inside an allowed root (output/link -> /etc) cannot reach outside it.
    const real = canonicalPath(resolved);
    if (real === null) return false;
    const realCwd = canonicalPath(cwd) ?? cwd;
    const realRel = path.relative(realCwd, real).replace(/\\/g, '/');
    if (FORBIDDEN_ROOTS.some(root => realRel === root || realRel.startsWith(`${root}/`))) {
      return false;
    }
    if (allowedFiles.includes(resolved)) {
      return allowedFiles.some(file => real === (canonicalPath(file) ?? file));
    }
    return isContained(resolved, allowedPrefixes);
  }
  
  protected formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
