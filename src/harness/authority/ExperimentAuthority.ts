import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertMutationAuthority,
  parseRecursiveExperimentContract,
  type MutationPathClass,
  type RecursiveExperimentContract,
} from '../../runtime-core/RecursiveImprovementContract.js';

export const EXPERIMENT_AUTHORITY_SCHEMA_VERSION = 1 as const;

export type ExperimentCapabilityKind =
  | 'tool'
  | 'skill'
  | 'plugin'
  | 'filesystem'
  | 'package-script'
  | 'subprocess';

export interface ExperimentAuthorityPolicy {
  schemaVersion: typeof EXPERIMENT_AUTHORITY_SCHEMA_VERSION;
  projectRoot: string;
  contract: RecursiveExperimentContract;
  allowedTools: string[];
  allowedSkills: string[];
  allowedPlugins: string[];
  candidateFiles: string[];
  generatedOwnedFiles: string[];
  sealedEvaluatorFiles: string[];
}

export interface ExperimentAuthorityRequest {
  kind: ExperimentCapabilityKind;
  name: string;
  path?: string;
  content?: string;
}

export interface ExperimentAuthorityReceipt {
  schemaVersion: typeof EXPERIMENT_AUTHORITY_SCHEMA_VERSION;
  receiptId: string;
  experimentId: string;
  lineageId: string;
  timestamp: string;
  requested: Omit<ExperimentAuthorityRequest, 'content'> & {
    contentDigest?: string;
  };
  resolved: {
    kind: ExperimentCapabilityKind;
    name: string;
    path?: string;
    canonicalPath?: string;
    pathClass?: MutationPathClass | 'unknown';
  };
  decision: 'allow' | 'deny';
  reason: string;
  contractDigest: string;
  policyDigest: string;
  receiptDigest: string;
}

const READ_ONLY_TOOLS = Object.freeze([
  'readFile',
  'listDir',
  'search',
  'searchCode',
  'searchDocs',
  'listSkills',
  'gitStatus',
  'gitLog',
  'gitDiff',
  'typeCheck',
  'runBuild',
  'runTests',
  'runFocusedTests',
  'runLint',
  'lsp',
  'astValidate',
  'importGuard',
]);

const MUTATION_TOOLS = Object.freeze(['writeFile', 'applyEdit']);
const SAFE_READ_ROOTS = Object.freeze(['src', 'test', 'docs', 'scripts', 'harness-tasks']);
const PROTECTED_ROOTS = Object.freeze([
  '.git',
  '.forgejo',
  '.gitea',
  '.github',
  '.githooks',
  '.husky',
  '.claude',
  '.omx',
  '.quality',
  '.config',
  'artifacts',
  'config',
  'node_modules',
  'output',
  'gallery',
  'src/config',
  'tmp',
  '.cache',
  'coverage',
  'dist',
]);
const PROTECTED_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  '.env',
  '.npmrc',
  '.gitconfig',
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  '.gitkeep',
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isWithin(relativePath: string, root: string): boolean {
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function hasDirectEscape(content: string | undefined): boolean {
  if (!content) return false;
  return [
    /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"](?:node:)?fs(?:\/[^'"]*)?['"]/,
    /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"](?:node:)?child_process['"]/,
    /\b(?:exec|execFile|spawn|fork)\s*\(/,
    /\bprocess\.(?:binding|dlopen)\s*\(/,
    /\b(?:eval|Function)\s*\(/,
    /\bBun\.\$/,
    /\bDeno\.(?:run|Command)\b/,
  ].some((pattern) => pattern.test(content));
}

async function canonicalizeRequestedPath(
  projectRoot: string,
  requestedPath: string,
): Promise<{
  relativePath: string;
  canonicalPath: string;
  hardlink: boolean;
  symlinkAlias: boolean;
}> {
  if (
    !requestedPath
    || requestedPath.includes('\0')
    || requestedPath.includes('~')
    || requestedPath.split(/[\\/]/).includes('..')
    || path.isAbsolute(requestedPath)
  ) {
    throw new Error('PATH_SYNTAX_DENIED');
  }

  const canonicalRoot = await fs.realpath(projectRoot);
  const lexical = path.resolve(canonicalRoot, requestedPath);
  let canonicalPath: string;
  let hardlink = false;
  try {
    canonicalPath = await fs.realpath(lexical);
    const stat = await fs.stat(canonicalPath);
    hardlink = stat.isFile() && stat.nlink > 1;
  } catch {
    try {
      const parent = await fs.realpath(path.dirname(lexical));
      canonicalPath = path.join(parent, path.basename(lexical));
    } catch {
      throw new Error('PATH_RESOLUTION_DENIED');
    }
  }
  const symlinkAlias = path.normalize(lexical) !== path.normalize(canonicalPath);
  const relativePath = normalizeRelative(path.relative(canonicalRoot, canonicalPath));
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || path.isAbsolute(relativePath)
  ) {
    throw new Error('PATH_OUTSIDE_PROJECT');
  }
  return { relativePath, canonicalPath, hardlink, symlinkAlias };
}

function classifyPath(
  relativePath: string,
  policy: ExperimentAuthorityPolicy,
): MutationPathClass | 'unknown' {
  if (policy.sealedEvaluatorFiles.includes(relativePath)) {
    return 'sealed-evaluator-dependency';
  }
  if (
    PROTECTED_FILES.includes(relativePath)
    || PROTECTED_ROOTS.some((root) => isWithin(relativePath, root))
    || relativePath.startsWith('.env.')
    || relativePath.includes('/.env')
    || relativePath.includes('/config/secrets')
    || /(?:^|\/)[^/]*config\.(?:cjs|js|json|mjs|ts|yaml|yml|toml)$/.test(relativePath)
    || /(?:^|\/)\.(?:gitattributes|gitignore|gitkeep|gitmodules)$/.test(relativePath)
  ) {
    return 'secret-config-git';
  }
  if (
    isWithin(relativePath, 'docs/agents/waves/receipts')
    || relativePath.endsWith('.receipt.json')
    || relativePath.endsWith('-RECEIPT.md')
  ) {
    return 'evidence-state';
  }
  if (policy.generatedOwnedFiles.includes(relativePath)) return 'generated-owned';
  if (policy.candidateFiles.includes(relativePath)) return 'candidate-source';
  return 'unknown';
}

function unsignedPolicy(policy: ExperimentAuthorityPolicy): Omit<ExperimentAuthorityPolicy, 'projectRoot'> {
  const { projectRoot: _projectRoot, ...rest } = policy;
  return rest;
}

function finishReceipt(
  policy: ExperimentAuthorityPolicy,
  request: ExperimentAuthorityRequest,
  resolved: ExperimentAuthorityReceipt['resolved'],
  decision: ExperimentAuthorityReceipt['decision'],
  reason: string,
): ExperimentAuthorityReceipt {
  const { content, ...publicRequest } = request;
  const requested = {
    ...publicRequest,
    ...(content ? { contentDigest: digest(content) } : {}),
  };
  const unsigned = {
    schemaVersion: EXPERIMENT_AUTHORITY_SCHEMA_VERSION,
    receiptId: randomUUID(),
    experimentId: policy.contract.experimentId,
    lineageId: policy.contract.lineageId,
    timestamp: new Date().toISOString(),
    requested,
    resolved,
    decision,
    reason,
    contractDigest: digest(policy.contract),
    policyDigest: digest(unsignedPolicy(policy)),
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function createExperimentAuthorityPolicy(input: {
  contract: RecursiveExperimentContract;
  candidateFiles?: string[];
  generatedOwnedFiles?: string[];
  sealedEvaluatorFiles?: string[];
  allowedSkills?: string[];
  allowedPlugins?: string[];
  projectRoot?: string;
}): ExperimentAuthorityPolicy {
  const contract = parseRecursiveExperimentContract(input.contract);
  const mutationAllowed = contract.loop === 'autoresearch' && contract.sourceMutationRequested;
  return {
    schemaVersion: EXPERIMENT_AUTHORITY_SCHEMA_VERSION,
    projectRoot: input.projectRoot ?? process.cwd(),
    contract,
    allowedTools: [...READ_ONLY_TOOLS, ...(mutationAllowed ? MUTATION_TOOLS : [])],
    allowedSkills: [...new Set(input.allowedSkills ?? [])],
    allowedPlugins: [...new Set(input.allowedPlugins ?? [])],
    candidateFiles: [...new Set((input.candidateFiles ?? []).map(normalizeRelative))],
    generatedOwnedFiles: [...new Set((input.generatedOwnedFiles ?? []).map(normalizeRelative))],
    sealedEvaluatorFiles: [...new Set((input.sealedEvaluatorFiles ?? []).map(normalizeRelative))],
  };
}

export async function authorizeExperimentRequest(
  policyValue: ExperimentAuthorityPolicy,
  request: ExperimentAuthorityRequest,
): Promise<ExperimentAuthorityReceipt> {
  if (policyValue.schemaVersion !== EXPERIMENT_AUTHORITY_SCHEMA_VERSION) {
    throw new Error('UNKNOWN_EXPERIMENT_AUTHORITY_SCHEMA');
  }
  const policy = {
    ...policyValue,
    contract: parseRecursiveExperimentContract(policyValue.contract),
  };
  const baseResolved: ExperimentAuthorityReceipt['resolved'] = {
    kind: request.kind,
    name: request.name,
  };

  if (request.kind === 'filesystem') {
    return finishReceipt(policy, request, baseResolved, 'deny', 'DIRECT_FILESYSTEM_DENIED');
  }
  if (request.kind === 'subprocess') {
    return finishReceipt(policy, request, baseResolved, 'deny', 'SUBPROCESS_DENIED');
  }
  if (request.kind === 'package-script') {
    return finishReceipt(policy, request, baseResolved, 'deny', 'PACKAGE_SCRIPT_DENIED');
  }
  if (request.kind === 'plugin') {
    const allowed = policy.allowedPlugins.includes(request.name);
    return finishReceipt(
      policy,
      request,
      baseResolved,
      allowed ? 'allow' : 'deny',
      allowed ? 'PLUGIN_ALLOWLISTED' : 'PLUGIN_NOT_ALLOWLISTED',
    );
  }
  if (request.kind === 'skill') {
    const allowed = policy.allowedSkills.includes(request.name);
    return finishReceipt(
      policy,
      request,
      baseResolved,
      allowed ? 'allow' : 'deny',
      allowed ? 'SKILL_ALLOWLISTED' : 'SKILL_NOT_ALLOWLISTED',
    );
  }
  if (!policy.allowedTools.includes(request.name)) {
    return finishReceipt(policy, request, baseResolved, 'deny', 'TOOL_NOT_ALLOWLISTED');
  }
  if (hasDirectEscape(request.content)) {
    return finishReceipt(policy, request, baseResolved, 'deny', 'EMBEDDED_AUTHORITY_ESCAPE_DENIED');
  }
  if (!request.path) {
    return finishReceipt(policy, request, baseResolved, 'allow', 'TOOL_ALLOWLISTED');
  }

  let canonicalized: Awaited<ReturnType<typeof canonicalizeRequestedPath>>;
  try {
    canonicalized = await canonicalizeRequestedPath(policy.projectRoot, request.path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'PATH_RESOLUTION_DENIED';
    const receiptRequest = path.isAbsolute(request.path) || request.path.includes('~')
      ? { ...request, path: '[private-path-redacted]' }
      : request;
    return finishReceipt(policy, receiptRequest, baseResolved, 'deny', reason);
  }
  const pathClass = classifyPath(canonicalized.relativePath, policy);
  const resolved = {
    ...baseResolved,
    path: canonicalized.relativePath,
    canonicalPath: canonicalized.relativePath,
    pathClass,
  };
  if (canonicalized.symlinkAlias) {
    return finishReceipt(policy, request, resolved, 'deny', 'SYMLINK_ALIAS_DENIED');
  }
  if (canonicalized.hardlink) {
    return finishReceipt(policy, request, resolved, 'deny', 'HARDLINK_ALIAS_DENIED');
  }

  const mutating = MUTATION_TOOLS.includes(request.name);
  if (!mutating) {
    const readable = SAFE_READ_ROOTS.some((root) => isWithin(canonicalized.relativePath, root));
    return finishReceipt(
      policy,
      request,
      resolved,
      readable ? 'allow' : 'deny',
      readable ? 'READ_PATH_ALLOWLISTED' : 'READ_PATH_DENIED',
    );
  }

  try {
    assertMutationAuthority({
      contract: policy.contract,
      pathClass,
      activeExperiment: true,
      declaredGeneratedOwner:
        pathClass === 'generated-owned'
        && policy.generatedOwnedFiles.includes(canonicalized.relativePath),
    });
    return finishReceipt(policy, request, resolved, 'allow', 'MUTATION_AUTHORIZED');
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(':')[0] : 'MUTATION_DENIED';
    return finishReceipt(policy, request, resolved, 'deny', reason);
  }
}

export async function authorizeCandidateDiff(
  policy: ExperimentAuthorityPolicy,
  changedPaths: readonly string[],
): Promise<{
  allowed: boolean;
  receipts: ExperimentAuthorityReceipt[];
}> {
  const receipts: ExperimentAuthorityReceipt[] = [];
  for (const changedPath of [...new Set(changedPaths)]) {
    receipts.push(await authorizeExperimentRequest(policy, {
      kind: 'tool',
      name: 'applyEdit',
      path: changedPath,
    }));
  }
  return {
    allowed: receipts.length > 0 && receipts.every((receipt) => receipt.decision === 'allow'),
    receipts,
  };
}

export function parseExperimentAuthorityReceipt(value: unknown): ExperimentAuthorityReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_EXPERIMENT_AUTHORITY_RECEIPT');
  }
  const receipt = value as ExperimentAuthorityReceipt;
  if (
    receipt.schemaVersion !== EXPERIMENT_AUTHORITY_SCHEMA_VERSION
    || !receipt.receiptId
    || !receipt.experimentId
    || !receipt.lineageId
    || !['allow', 'deny'].includes(receipt.decision)
    || !receipt.requested
    || !receipt.resolved
  ) {
    throw new Error('INVALID_EXPERIMENT_AUTHORITY_RECEIPT');
  }
  const { receiptDigest, ...unsigned } = receipt;
  if (!receiptDigest || digest(unsigned) !== receiptDigest) {
    throw new Error('EXPERIMENT_AUTHORITY_RECEIPT_DIGEST_MISMATCH');
  }
  return receipt;
}

export function requestFromToolCall(
  tool: string,
  params: Record<string, unknown>,
): ExperimentAuthorityRequest {
  if (tool === 'executeSkill') {
    return { kind: 'skill', name: String(params.name ?? '') };
  }
  if (tool === 'npm') {
    return { kind: 'package-script', name: String(params.command ?? params.script ?? 'npm') };
  }
  if (['execute', 'bash', 'shell', 'runCommand', 'terminal'].includes(tool)) {
    return { kind: 'subprocess', name: tool };
  }
  const givenPath = [params.path, params.filePath, params.directory, params.root]
    .find((value): value is string => typeof value === 'string');
  // gitStatus's path picks the repository, not a file, and it reports repo metadata
  // only: the project root itself is its documented argument, not an escape.
  const repoRootStatus = tool === 'gitStatus' && givenPath !== undefined && ['.', './', ''].includes(givenPath);
  const requestedPath = repoRootStatus
    ? undefined
    : givenPath ?? (['search', 'listDir'].includes(tool) ? '.' : undefined);
  const content = [params.content, params.newString, params.replace, params.newText]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return {
    kind: 'tool',
    name: tool,
    ...(requestedPath ? { path: requestedPath } : {}),
    ...(content ? { content } : {}),
  };
}
