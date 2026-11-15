/**
 * Validation Guard for Meta-Harness
 * 
 * Safety checks before applying changes:
 * - Path validation (only active project implementation/test/doc surfaces)
 * - File size limits
 * - Change size limits
 * - Forbidden patterns
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { formatError } from '../../utils/errors.js';
import { PathTraversalError } from '../errors.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PathValidationOptions {
  allowedPrefixes?: string[];
  allowAbsolute?: boolean;
}

export interface ContentValidationOptions {
  maxLines?: number;
  maxLineLength?: number;
  forbiddenPatterns?: RegExp[];
}

/**
 * Resolve a path to where it really points on disk, including paths that do
 * not exist yet: the nearest existing ancestor is resolved through symlinks and
 * the missing remainder is appended. Returns null for a dangling symlink,
 * because writing through it would land wherever the link points.
 */
export function canonicalPath(target: string): string | null {
  let existing = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...missing);
    } catch {
      try {
        if (lstatSync(existing).isSymbolicLink()) return null;
      } catch {
        // Does not exist at all: keep walking up.
      }
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** True when target sits at or under root, on a path-separator boundary. */
export function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * True when an absolute path is under one of the roots both as written and
 * after symlinks resolve, so a link inside an allowed root cannot reach out.
 */
export function isContained(resolved: string, roots: string[]): boolean {
  const real = canonicalPath(resolved);
  if (real === null || !roots.some(root => isWithin(resolved, root))) return false;
  return roots.some(root => isWithin(real, canonicalPath(root) ?? root));
}

export class ValidationGuard {
  private allowedPrefixes: string[];

  constructor() {
    const cwd = process.cwd();
    this.allowedPrefixes = [
      path.join(cwd, 'src'),
      path.join(cwd, 'test'),
      path.join(cwd, 'docs'),
      path.join(cwd, 'scripts'),
      path.join(cwd, 'harness-tasks'),
      path.join(cwd, '.omx'),
      path.join(cwd, 'output'),
      path.join(cwd, 'gallery'),
      path.join(cwd, 'tmp'),
      path.join(cwd, 'package.json'),
      path.join(cwd, 'package-lock.json'),
      path.join(cwd, 'pnpm-lock.yaml'),
    ];
  }

  /**
   * Validate file path is within allowed directories
   * SECURITY: Checks traversal BEFORE resolve, uses realpath for canonicalization.
   * Stays async so callers keep a rejected promise rather than a sync throw.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- public async contract
  async validatePath(filePath: string, options?: PathValidationOptions): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // SECURITY: Check traversal BEFORE resolve to prevent bypasses
    if (filePath.includes('..')) {
      throw new PathTraversalError(`Path '${filePath}' contains '..' which is not allowed`);
    }
    
    if (filePath.includes('~')) {
      throw new PathTraversalError(`Path '${filePath}' contains '~' which is not allowed`);
    }

    // Check for absolute paths
    if (path.isAbsolute(filePath) && !options?.allowAbsolute) {
      warnings.push(`Path '${filePath}' is absolute - prefer relative paths`);
    }

    const resolved = path.resolve(filePath);
    
    // SECURITY: resolve symlinks, including on the parents of a file that does
    // not exist yet, and check both the written path and where it really lands.
    const prefixes = options?.allowedPrefixes || this.allowedPrefixes;
    const isAllowed = isContained(resolved, prefixes);
    
    if (!isAllowed) {
      throw new PathTraversalError(`Path '${filePath}' is outside allowed directories (${prefixes.join(', ')})`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Synchronous path validation (for backward compatibility)
   * SECURITY: Checks traversal BEFORE any path operations
   */
  validatePathSync(filePath: string, options?: PathValidationOptions): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // SECURITY: Check traversal BEFORE resolve to prevent bypasses
    if (filePath.includes('..')) {
      errors.push(`Path '${filePath}' contains '..' which is not allowed`);
      return { valid: false, errors, warnings };
    }
    
    if (filePath.includes('~')) {
      errors.push(`Path '${filePath}' contains '~' which is not allowed`);
      return { valid: false, errors, warnings };
    }

    // Check for absolute paths
    if (path.isAbsolute(filePath) && !options?.allowAbsolute) {
      warnings.push(`Path '${filePath}' is absolute - prefer relative paths`);
    }

    const resolved = path.resolve(filePath);
    const prefixes = options?.allowedPrefixes || this.allowedPrefixes;

    // Same check as validatePath: as written and after symlinks resolve.
    const isAllowed = isContained(resolved, prefixes);

    if (!isAllowed) {
      errors.push(`Path '${filePath}' is outside allowed directories (${prefixes.join(', ')})`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate file content meets constraints
   * SECURITY: Detects forbidden imports and requires
   */
  async validateContent(filePath: string, options?: ContentValidationOptions): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // SECURITY: Forbidden modules that could compromise security
    const FORBIDDEN_MODULES = ['fs', 'child_process', 'path', 'os', 'net', 'http', 'https', 'cluster', 'dgram', 'repl', 'vm'];
    const IMPORT_PATTERN = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    
    const opts = {
      maxLines: 1000,
      maxLineLength: 500,
      forbiddenPatterns: [
        /eval\s*\(/,  // No eval()
        /new\s+Function/,  // No new Function()
        /child_process/,  // No child_process
        /require\s*\(\s*['"]child_process/,  // No child_process require
      ],
      ...options,
    };

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Check line count
      if (lines.length > opts.maxLines!) {
        errors.push(`File has ${lines.length} lines, max allowed is ${opts.maxLines}`);
      }

      // Check line lengths
      lines.forEach((line, idx) => {
        if (line.length > opts.maxLineLength!) {
          warnings.push(`Line ${idx + 1} is ${line.length} chars, max recommended is ${opts.maxLineLength}`);
        }
      });

      // Check forbidden patterns
      opts.forbiddenPatterns!.forEach(pattern => {
        if (pattern.test(content)) {
          errors.push(`Forbidden pattern detected: ${pattern.source}`);
        }
      });

      // SECURITY: Check for forbidden imports/requires
      let importMatch;
      while ((importMatch = IMPORT_PATTERN.exec(content)) !== null) {
        const importedModule = importMatch[1];
        if (FORBIDDEN_MODULES.some(m => importedModule === m || importedModule.startsWith(`${m}/`))) {
          errors.push(`Security: Import of '${importedModule}' is not allowed`);
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (error) {
      return {
        valid: false,
        errors: [formatError('Failed to read file', error)],
        warnings,
      };
    }
  }

  /**
   * Validate a code change (diff)
   */
  validateChange(oldContent: string, newContent: string, maxLinesChanged: number = 50): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Check total size change
    const sizeDiff = Math.abs(newContent.length - oldContent.length);
    if (sizeDiff > 10000) {
      warnings.push(`Large size change: ${sizeDiff} bytes`);
    }

    // Check line count change
    const lineDiff = Math.abs(newLines.length - oldLines.length);
    if (lineDiff > maxLinesChanged) {
      errors.push(`Too many lines changed: ${lineDiff}, max allowed is ${maxLinesChanged}`);
    }

    // Check for suspicious patterns in new content
    const suspiciousPatterns = [
      { pattern: /DELETE\s+FROM|DROP\s+TABLE/i, message: 'Possible SQL injection' },
      { pattern: /rm\s+-rf/i, message: 'Dangerous shell command' },
      { pattern: /process\.exit\s*\(\s*0\s*\)/, message: 'Process termination' },
    ];

    suspiciousPatterns.forEach(({ pattern, message }) => {
      if (pattern.test(newContent)) {
        errors.push(`Suspicious pattern: ${message}`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Quick path validation (for frequent checks)
   */
  isPathAllowed(filePath: string): boolean {
    // SECURITY: Check for prototype pollution attempts
    if (filePath === '__proto__' || filePath === 'constructor') {
      return false;
    }
    return isContained(path.resolve(filePath), this.allowedPrefixes);
  }

  /**
   * Validate object keys to prevent prototype pollution
   * SECURITY: Blocks __proto__, constructor, and prototype keys
   */
  validateObjectKeys(obj: Record<string, unknown>, path = ''): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const key of Object.keys(obj)) {
      const fullPath = path ? `${path}.${key}` : key;
      
      // SECURITY: Block prototype pollution keys
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        errors.push(`Security: Prototype pollution attempt detected at '${fullPath}'`);
        continue;
      }

      const value = obj[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = this.validateObjectKeys(value as Record<string, unknown>, fullPath);
        errors.push(...nested.errors);
        warnings.push(...nested.warnings);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

// Singleton instance
export const validationGuard = new ValidationGuard();
