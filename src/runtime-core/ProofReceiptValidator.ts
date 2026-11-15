import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const DEFAULT_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Paths in DEFAULT_SOURCE_FINGERPRINT_EXCLUDES are excluded from the fingerprint
// because they are verified NON-runtime — changing them cannot affect what the
// product generates or validates.
//
// RUNTIME paths that are NOT excluded (changing them MUST invalidate a receipt):
//   - SOUL.md              (PromptBuilder reads at runtime to build LLM persona)
//   - PROJECT_RULES.md     (PromptBuilder reads at runtime for generation rules)
//   - docs/domains/*.md    (PromptBuilder reads domain-specific prompt context)
//   - .skills/*/SKILL.md   (SkillLoader reads at runtime to load skill content)
//   - src/, bin/, scripts/, package.json, pnpm-lock.yaml, tsconfig*, etc.
//
// When in doubt about a path, leave it IN (over-invalidating is safe; missing a
// real runtime change is not).
const DEFAULT_SOURCE_FINGERPRINT_EXCLUDES = [
  // Emitted proof artifacts — never affect runtime behaviour.
  '.omx/proof/',
  // Non-runtime documentation directories inside docs/ (verified by grep src/).
  // docs/domains/ is intentionally NOT listed here — PromptBuilder reads it.
  'docs/adr/',
  'docs/agent-law/',
  'docs/launch/',
  'docs/notes/',
  'docs/validation/',
  'docs/plans/',
  'docs/archive/',
  'docs/marketing/',
  'docs/research/',
  'docs/fable-handoffs/',
  'docs/factory/',
  'docs/audits/',
  'docs/ci-investigations/',
  'docs/codex-budget/',
  'docs/contracts/',
  'docs/features/',
  'docs/integrations/',
  'docs/styles/',
  'docs/superpowers/',
  'docs/textgen/',
  'docs/tutorials/',
];

// Top-level Markdown files that are verified non-runtime (project metadata /
// housekeeping). Any .md file NOT in this list and NOT under an excluded prefix
// remains IN the fingerprint (safe default).
const NON_RUNTIME_ROOT_MD_FILES = new Set([
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'HANDOFF.md',
]);

export interface ProofReceiptValidationOptions {
  requiredMode?: string;
  requireProviderModel?: boolean;
  requireArtifactPaths?: boolean;
  /** Every artifact path must carry a matching sha256 in `artifactDigests`. */
  requireArtifactDigests?: boolean;
  requireCaseCoverage?: boolean;
  maxAgeMs?: number;
}

export interface ProofReceiptValidationResult {
  ok: boolean;
  failures: string[];
  gitCommit: string | null;
  sourceFingerprint: string | null;
}

interface ReceiptLike {
  status?: unknown;
  ready?: unknown;
  mode?: unknown;
  generatedAt?: unknown;
  gitCommit?: unknown;
  sourceFingerprint?: unknown;
  provider?: unknown;
  model?: unknown;
  artifactPath?: unknown;
  artifactPaths?: unknown;
  artifactDigests?: unknown;
  domains?: unknown;
  results?: unknown;
  caseCoverage?: unknown;
}

export function readCurrentGitCommit(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return null;

  const headPath = path.join(gitDir, 'HEAD');
  const head = readText(headPath)?.trim();
  if (!head) return null;
  if (/^[0-9a-f]{40}$/i.test(head)) return head;

  const refPrefix = 'ref: ';
  if (!head.startsWith(refPrefix)) return null;
  const refName = head.slice(refPrefix.length).trim();
  const directRef = readText(path.join(gitDir, refName))?.trim();
  if (directRef && /^[0-9a-f]{40}$/i.test(directRef)) return directRef;

  const commonDir = resolveCommonGitDir(gitDir);
  const commonRef = commonDir ? readText(path.join(commonDir, refName))?.trim() : null;
  if (commonRef && /^[0-9a-f]{40}$/i.test(commonRef)) return commonRef;

  const packedRefs = commonDir ? readText(path.join(commonDir, 'packed-refs')) : readText(path.join(gitDir, 'packed-refs'));
  const packed = packedRefs
    ?.split('\n')
    .map(line => line.trim())
    .find(line => line.endsWith(` ${refName}`))
    ?.split(' ')[0];
  return packed && /^[0-9a-f]{40}$/i.test(packed) ? packed : null;
}

/** Resolve one exact git ref for release/admission binding. */
export function readGitRef(repoRoot: string, ref: string): string | null {
  if (!/^refs\/(heads|remotes)\/[A-Za-z0-9._/-]+$/.test(ref)) return null;
  const value = gitOutput(repoRoot, ['rev-parse', '--verify', ref])?.trim();
  return value && /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

export function computeProofSourceFingerprint(
  repoRoot: string,
  excludedPathPrefixes: string[] = DEFAULT_SOURCE_FINGERPRINT_EXCLUDES,
): string | null {
  const files = listGitSourceFiles(repoRoot)
    ?.map(normalizeRepoPath)
    .filter(file => file.length > 0 && !isExcludedProofPath(file, excludedPathPrefixes))
    .sort();
  if (!files) return null;

  const hash = createHash('sha256');
  for (const file of files) {
    const fullPath = path.join(repoRoot, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    hash.update('path\0');
    hash.update(file);
    hash.update('\0content\0');
    hash.update(fs.readFileSync(fullPath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function readProofSubjectGitCommit(
  repoRoot: string,
  excludedPathPrefixes: string[] = DEFAULT_SOURCE_FINGERPRINT_EXCLUDES,
): string | null {
  const head = readCurrentGitCommit(repoRoot);
  if (!head) return null;

  let commit = head;
  for (let depth = 0; depth < 200; depth += 1) {
    const parents = gitOutput(repoRoot, ['show', '-s', '--format=%P', commit])?.trim().split(/\s+/).filter(Boolean) ?? [];
    const firstParent = parents[0];
    if (!firstParent) return commit;

    const changedPaths = gitOutput(repoRoot, ['diff', '--name-only', firstParent, commit])
      ?.split('\n')
      .map(normalizeRepoPath)
      .filter(Boolean);
    if (!changedPaths) return head;
    if (changedPaths.some(file => !isExcludedProofPath(file, excludedPathPrefixes))) return commit;
    commit = firstParent;
  }

  return head;
}

export function validateProofReceipt(
  repoRoot: string,
  receipt: ReceiptLike,
  options: ProofReceiptValidationOptions = {},
): ProofReceiptValidationResult {
  const failures: string[] = [];
  const gitCommit = readCurrentGitCommit(repoRoot);
  const proofSubjectCommit = readProofSubjectGitCommit(repoRoot);
  const sourceFingerprint = computeProofSourceFingerprint(repoRoot);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_RECEIPT_MAX_AGE_MS;

  if (!(receipt.status === 'pass' || receipt.ready === true)) {
    failures.push(`receipt status ${String(receipt.status ?? receipt.ready ?? 'unknown')} is not pass`);
  }

  if (options.requiredMode && receipt.mode !== options.requiredMode) {
    failures.push(`mode ${String(receipt.mode ?? 'missing')} does not match ${options.requiredMode}`);
  }

  if (typeof receipt.generatedAt !== 'string') {
    failures.push('missing generatedAt');
  } else {
    const generatedAt = Date.parse(receipt.generatedAt);
    if (Number.isNaN(generatedAt)) {
      failures.push('generatedAt is unreadable');
    } else if (Date.now() - generatedAt > maxAgeMs) {
      failures.push(`receipt is stale (${receipt.generatedAt})`);
    } else if (generatedAt - Date.now() > 5 * 60 * 1000) {
      failures.push(`receipt generatedAt is in the future (${receipt.generatedAt})`);
    }
  }

  if (typeof receipt.sourceFingerprint === 'string' && receipt.sourceFingerprint.length > 0) {
    if (!sourceFingerprint) {
      failures.push('current source fingerprint unavailable');
    } else if (receipt.sourceFingerprint !== sourceFingerprint) {
      failures.push(`sourceFingerprint ${receipt.sourceFingerprint} does not match current ${sourceFingerprint}`);
    }
  } else if (!proofSubjectCommit) {
    failures.push('current proof subject git commit unavailable');
  } else if (typeof receipt.gitCommit !== 'string' || receipt.gitCommit.length === 0) {
    failures.push('missing gitCommit');
  } else if (receipt.gitCommit !== proofSubjectCommit) {
    failures.push(`gitCommit ${receipt.gitCommit} does not match current proof subject ${proofSubjectCommit}`);
  }

  if (options.requireProviderModel) {
    if (typeof receipt.provider !== 'string' || receipt.provider.trim().length === 0) failures.push('missing provider');
    if (typeof receipt.model !== 'string' || receipt.model.trim().length === 0) failures.push('missing model');
  }

  const artifactPaths = collectArtifactPaths(receipt);
  if (options.requireArtifactPaths || options.requireArtifactDigests) {
    if (artifactPaths.length === 0) {
      failures.push('missing artifactPath');
    }
    for (const artifactPath of artifactPaths) {
      const resolved = resolveArtifactPath(repoRoot, artifactPath);
      if (!resolved) {
        failures.push(`artifact outside repository: ${artifactPath}`);
      } else if (!isRegularFile(resolved)) {
        failures.push(`artifact missing: ${artifactPath}`);
      }
    }
  }

  // Recorded digests are always verified: existence alone is not integrity.
  const digests = readArtifactDigests(receipt.artifactDigests);
  if (digests === 'invalid') {
    failures.push('artifactDigests must map paths to sha256:<64 hex> strings');
  } else {
    for (const [artifactPath, expected] of Object.entries(digests)) {
      const actual = computeArtifactDigest(repoRoot, artifactPath);
      if (actual === null) {
        failures.push(`artifact digest unverifiable (missing or outside repository): ${artifactPath}`);
      } else if (actual !== expected) {
        failures.push(`artifact digest mismatch: ${artifactPath} is ${actual}, receipt recorded ${expected}`);
      }
    }
    if (options.requireArtifactDigests) {
      for (const artifactPath of artifactPaths) {
        if (!digests[artifactPath]) failures.push(`missing artifactDigest: ${artifactPath}`);
      }
    }
  }

  if (options.requireCaseCoverage) {
    const coverage = receipt.caseCoverage;
    if (!coverage || typeof coverage !== 'object') {
      failures.push('missing caseCoverage');
    } else {
      const fields = coverage as { complete?: unknown; assignmentCount?: unknown; fallbackProvenanceCount?: unknown };
      if (fields.complete !== true) failures.push('caseCoverage.complete is not true');
      if (typeof fields.assignmentCount !== 'number' || fields.assignmentCount <= 0) failures.push('caseCoverage.assignmentCount missing');
      if (typeof fields.fallbackProvenanceCount !== 'number' || fields.fallbackProvenanceCount <= 0) failures.push('caseCoverage.fallbackProvenanceCount missing');
    }
  }

  return { ok: failures.length === 0, failures, gitCommit, sourceFingerprint };
}

/**
 * sha256 of an artifact's bytes as `sha256:<hex>`, or null when the path
 * escapes the repository or is not a readable regular file.
 */
export function computeArtifactDigest(repoRoot: string, artifactPath: string): string | null {
  const resolved = resolveArtifactPath(repoRoot, artifactPath);
  if (!resolved || !isRegularFile(resolved)) return null;
  try {
    return `sha256:${createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Digest map for a receipt's `artifactDigests` field; unreadable paths are omitted. */
export function computeArtifactDigests(repoRoot: string, artifactPaths: readonly string[]): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const artifactPath of artifactPaths) {
    const digest = computeArtifactDigest(repoRoot, artifactPath);
    if (digest) digests[artifactPath] = digest;
  }
  return digests;
}

function resolveArtifactPath(repoRoot: string, artifactPath: string): string | null {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, artifactPath);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readArtifactDigests(value: unknown): Record<string, string> | 'invalid' {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, digest]) => typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest))) return 'invalid';
  return Object.fromEntries(entries) as Record<string, string>;
}

function listGitSourceFiles(repoRoot: string): string[] | null {
  return gitOutput(repoRoot, ['ls-files', '--cached'])
    ?.split('\n')
    .filter(Boolean) ?? null;
}

function gitOutput(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function normalizeRepoPath(filePath: string): string {
  return filePath.trim().replaceAll(path.sep, '/');
}

function isExcludedProofPath(filePath: string, excludedPathPrefixes: string[]): boolean {
  // Top-level non-runtime housekeeping Markdown files (e.g. README.md) are
  // excluded. All other paths fall through to the prefix check below — in
  // particular, runtime inputs like SOUL.md, PROJECT_RULES.md, docs/domains/**,
  // and .skills/*/SKILL.md are NOT excluded even though they are Markdown files.
  if (!filePath.includes('/') && filePath.endsWith('.md') && NON_RUNTIME_ROOT_MD_FILES.has(filePath)) return true;
  return excludedPathPrefixes.some(prefix => filePath === prefix.replace(/\/$/, '') || filePath.startsWith(prefix));
}

function collectArtifactPaths(receipt: ReceiptLike): string[] {
  const paths: string[] = [];
  if (typeof receipt.artifactPath === 'string') paths.push(receipt.artifactPath);
  if (Array.isArray(receipt.artifactPaths)) {
    for (const item of receipt.artifactPaths) {
      if (typeof item === 'string') paths.push(item);
    }
  }
  for (const collection of [receipt.domains, receipt.results]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (item && typeof item === 'object' && typeof (item as { artifactPath?: unknown }).artifactPath === 'string') {
        paths.push((item as { artifactPath: string }).artifactPath);
      }
    }
  }
  return [...new Set(paths)];
}

function resolveGitDir(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, '.git');
  if (!fs.existsSync(dotGit)) return null;
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  const content = readText(dotGit)?.trim();
  const prefix = 'gitdir: ';
  if (!content?.startsWith(prefix)) return null;
  const gitDir = content.slice(prefix.length).trim();
  return path.resolve(repoRoot, gitDir);
}

function resolveCommonGitDir(gitDir: string): string | null {
  const commonDir = readText(path.join(gitDir, 'commondir'))?.trim();
  return commonDir ? path.resolve(gitDir, commonDir) : gitDir;
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
