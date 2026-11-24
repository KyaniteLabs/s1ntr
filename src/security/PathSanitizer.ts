/**
 * Path sanitization utilities to prevent command injection
 */

import path from 'path';
import { logPathTraversalAttempt } from './SecurityLogger.js';

export class PathSanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSanitizationError';
  }
}

// Characters that could be used for shell injection
const DANGEROUS_CHARS = /[;|&$`\\<>{}[\]]/;

// Control characters (null bytes, control codes, DEL, high control codes)
// Security: These characters can be used for injection attacks and must be filtered
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/

/**
 * Sanitize a filename to prevent command injection
 * 
 * @param filename - The filename to sanitize
 * @returns Sanitized filename
 * @throws PathSanitizationError if filename contains dangerous characters
 */
export function sanitizeFilename(filename: string): string {
  if (DANGEROUS_CHARS.test(filename)) {
    logPathTraversalAttempt(filename, {
      details: { reason: 'dangerous_chars' }
    });
    throw new PathSanitizationError(
      `Filename contains dangerous characters: ${filename}`
    );
  }
  
  if (CONTROL_CHARS.test(filename)) {
    logPathTraversalAttempt(filename, {
      details: { reason: 'control_chars' }
    });
    throw new PathSanitizationError(
      `Filename contains control characters: ${filename}`
    );
  }
  
  // Normalize to remove path traversal attempts
  const normalized = path.normalize(filename);
  
  // Ensure filename doesn't traverse upward or resolve as an absolute path
  if (
    normalized === '..'
    || normalized.startsWith('..' + path.sep)
    || normalized.startsWith('../')
    || path.isAbsolute(normalized)
  ) {
    logPathTraversalAttempt(filename, {
      details: { reason: 'path_traversal' }
    });
    throw new PathSanitizationError(
      `Filename must be a relative path without traversal: ${filename}`
    );
  }
  
  return normalized;
}

/**
 * Validate and sanitize a file path
 * 
 * @param filepath - Full file path
 * @param allowedBaseDir - Base directory that must contain the path
 * @returns Sanitized absolute path
 * @throws PathSanitizationError if path is invalid or outside base directory
 */
export function validateFilePath(
  filepath: string, 
  allowedBaseDir: string
): string {
  // Resolve to absolute path and verify containment first
  const resolved = path.resolve(filepath);
  const baseResolved = path.resolve(allowedBaseDir);
  
  // Ensure resolved path is within allowed base
  const relative = path.relative(baseResolved, resolved);
  
  if (
    relative === '..'
    || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative)
  ) {
    logPathTraversalAttempt(filepath, {
      details: { reason: 'escapes_allowed_directory', baseDir: allowedBaseDir }
    });
    throw new PathSanitizationError(
      `Path escapes allowed directory: ${filepath}`
    );
  }

  // Sanitize every relative segment (not just basename) so parent segments cannot smuggle
  // shell metacharacters or control bytes.
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [path.basename(filepath)];
  for (const segment of segments) {
    sanitizeFilename(segment);
  }
  
  return resolved;
}

/**
 * Sanitize FFmpeg argument string
 * 
 * @param arg - Argument to sanitize
 * @returns Sanitized argument
 */
export function sanitizeFFmpegArg(arg: string): string {
  // FFmpeg args should not contain shell metacharacters or control characters
  if (DANGEROUS_CHARS.test(arg) || CONTROL_CHARS.test(arg)) {
    logPathTraversalAttempt(arg, {
      details: { reason: 'dangerous_chars_in_ffmpeg_arg' }
    });
    throw new PathSanitizationError(
      `FFmpeg argument contains dangerous characters: ${arg}`
    );
  }
  return arg;
}
