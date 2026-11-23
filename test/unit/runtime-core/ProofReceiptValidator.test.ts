import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));
import {
  computeArtifactDigest,
  computeArtifactDigests,
  computeProofSourceFingerprint,
  readGitRef,
  readProofSubjectGitCommit,
  validateProofReceipt,
} from '../../../src/runtime-core/ProofReceiptValidator.js';

interface FakeCommit {
  parent: string | null;
  files: Map<string, string>;
}

interface FakeRepo {
  tracked: Set<string>;
  commits: Map<string, FakeCommit>;
  head: string | null;
}

const fakeRepos = new Map<string, FakeRepo>();
let nextCommit = 1;

function fakeGit(_file: string, args: string[], options: { cwd: string }): string {
  const repoRoot = options.cwd;
  const commandIndex = args.findIndex(arg => ['init', 'config', 'add', 'commit', 'rev-parse', 'show', 'diff', 'ls-files'].includes(arg));
  const command = args[commandIndex];
  if (command === 'init') {
    mkdirSync(join(repoRoot, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fakeRepos.set(repoRoot, { tracked: new Set(), commits: new Map(), head: null });
    return '';
  }

  const repo = fakeRepos.get(repoRoot);
  if (!repo) throw new Error(`not a fake repository: ${repoRoot}`);

  if (command === 'config') return '';
  if (command === 'add') {
    for (const file of args.slice(commandIndex + 1).filter(arg => !arg.startsWith('-'))) {
      repo.tracked.add(file);
    }
    return '';
  }
  if (command === 'commit') {
    const commitId = nextCommit.toString(16).padStart(40, '0');
    nextCommit += 1;
    const files = new Map<string, string>();
    for (const file of repo.tracked) {
      files.set(file, readFileSync(join(repoRoot, file), 'utf8'));
    }
    repo.commits.set(commitId, { parent: repo.head, files });
    repo.head = commitId;
    writeFileSync(join(repoRoot, '.git', 'refs', 'heads', 'main'), `${commitId}\n`);
    return '';
  }
  if (command === 'rev-parse') return `${repo.head ?? ''}\n`;
  if (command === 'ls-files') return `${[...repo.tracked].sort().join('\n')}\n`;
  if (command === 'show') {
    const commit = repo.commits.get(args.at(-1) ?? '');
    if (!commit) throw new Error('unknown commit');
    return commit.parent ? `${commit.parent}\n` : '\n';
  }
  if (command === 'diff') {
    const before = repo.commits.get(args.at(-2) ?? '');
    const after = repo.commits.get(args.at(-1) ?? '');
    if (!before || !after) throw new Error('unknown commit');
    const paths = new Set([...before.files.keys(), ...after.files.keys()]);
    return `${[...paths].filter(file => before.files.get(file) !== after.files.get(file)).sort().join('\n')}\n`;
  }

  throw new Error(`unsupported fake git command: ${args.join(' ')}`);
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function commit(repoRoot: string, message: string): string {
  git(repoRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', message, '--no-gpg-sign']);
  return git(repoRoot, ['rev-parse', 'HEAD']);
}

function createRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'sinter-proof-receipt-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.name', 'Sinter Test']);
  git(repoRoot, ['config', 'user.email', 'liminal@example.test']);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n');
  git(repoRoot, ['add', 'src/app.ts']);
  commit(repoRoot, 'source');
  return repoRoot;
}

beforeEach(() => {
  fakeRepos.clear();
  nextCommit = 1;
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(fakeGit);
});

describe('ProofReceiptValidator', () => {
  it('binds committed proof receipts to the last non-proof source commit', () => {
    const repoRoot = createRepo();
    try {
      const sourceCommit = git(repoRoot, ['rev-parse', 'HEAD']);
      mkdirSync(join(repoRoot, '.omx', 'proof'), { recursive: true });
      writeFileSync(join(repoRoot, '.omx', 'proof', 'domain-gauntlet-live.json'), JSON.stringify({
        status: 'pass',
        mode: 'live-execution',
        generatedAt: new Date().toISOString(),
        gitCommit: sourceCommit,
      }));
      git(repoRoot, ['add', '-f', '.omx/proof/domain-gauntlet-live.json']);
      commit(repoRoot, 'proof only');

      const receipt = JSON.parse(readFileSync(join(repoRoot, '.omx/proof/domain-gauntlet-live.json'), 'utf8')) as Record<string, unknown>;

      expect(readProofSubjectGitCommit(repoRoot)).toBe(sourceCommit);
      expect(validateProofReceipt(repoRoot, receipt, { requiredMode: 'live-execution' }).ok).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('keeps source fingerprints stable across proof-only artifact changes', () => {
    const repoRoot = createRepo();
    try {
      const beforeProof = computeProofSourceFingerprint(repoRoot);
      mkdirSync(join(repoRoot, '.omx', 'proof'), { recursive: true });
      writeFileSync(join(repoRoot, '.omx', 'proof', 'artifact.txt'), 'proof output\n');
      git(repoRoot, ['add', '-f', '.omx/proof/artifact.txt']);
      commit(repoRoot, 'add proof artifact');

      expect(computeProofSourceFingerprint(repoRoot)).toBe(beforeProof);

      writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n');

      expect(computeProofSourceFingerprint(repoRoot)).not.toBe(beforeProof);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not absorb untracked local scratch files into committed receipt fingerprints', () => {
    const repoRoot = createRepo();
    try {
      const cleanFingerprint = computeProofSourceFingerprint(repoRoot);

      writeFileSync(join(repoRoot, 'scratch-never-committed.txt'), 'local operator note\n');

      expect(computeProofSourceFingerprint(repoRoot)).toBe(cleanFingerprint);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('SOUL.md changes the fingerprint (runtime prompt input — must gate)', () => {
    // SOUL.md is read by PromptBuilder at runtime to build the LLM persona.
    // A change there must invalidate a stale smoke receipt.
    const repoRoot = createRepo();
    try {
      const baseline = computeProofSourceFingerprint(repoRoot);
      writeFileSync(join(repoRoot, 'SOUL.md'), '# Updated soul\n');
      git(repoRoot, ['add', 'SOUL.md']);
      commit(repoRoot, 'update soul');
      expect(computeProofSourceFingerprint(repoRoot)).not.toBe(baseline);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('docs/domains/*.md changes the fingerprint (PromptBuilder reads at runtime)', () => {
    // PromptBuilder reads docs/domains/<domain>.md to build domain-specific prompts.
    const repoRoot = createRepo();
    try {
      const baseline = computeProofSourceFingerprint(repoRoot);
      mkdirSync(join(repoRoot, 'docs', 'domains'), { recursive: true });
      writeFileSync(join(repoRoot, 'docs', 'domains', 'p5.md'), '# p5 domain\n');
      git(repoRoot, ['add', 'docs/domains/p5.md']);
      commit(repoRoot, 'add p5 domain doc');
      expect(computeProofSourceFingerprint(repoRoot)).not.toBe(baseline);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('README.md and HANDOFF.md do not change the fingerprint (verified non-runtime docs)', () => {
    const repoRoot = createRepo();
    try {
      const baseline = computeProofSourceFingerprint(repoRoot);
      writeFileSync(join(repoRoot, 'README.md'), '# Updated readme\n');
      writeFileSync(join(repoRoot, 'HANDOFF.md'), '# Session handoff note\n');
      git(repoRoot, ['add', 'README.md', 'HANDOFF.md']);
      commit(repoRoot, 'readme and handoff update');
      expect(computeProofSourceFingerprint(repoRoot)).toBe(baseline);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('docs/validation/*.md does not change the fingerprint (excluded non-runtime docs dir)', () => {
    const repoRoot = createRepo();
    try {
      const baseline = computeProofSourceFingerprint(repoRoot);
      mkdirSync(join(repoRoot, 'docs', 'validation'), { recursive: true });
      writeFileSync(join(repoRoot, 'docs', 'validation', 'report.md'), '# Validation report\n');
      git(repoRoot, ['add', 'docs/validation/report.md']);
      commit(repoRoot, 'add validation doc');
      expect(computeProofSourceFingerprint(repoRoot)).toBe(baseline);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('package.json change moves the fingerprint (dependency-change guarantee)', () => {
    const repoRoot = createRepo();
    try {
      const baseline = computeProofSourceFingerprint(repoRoot);
      writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'test', version: '2.0.0' }));
      git(repoRoot, ['add', 'package.json']);
      commit(repoRoot, 'bump version');
      expect(computeProofSourceFingerprint(repoRoot)).not.toBe(baseline);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('passes a receipt whose sourceFingerprint matches even when gitCommit differs from HEAD', () => {
    const repoRoot = createRepo();
    try {
      const sourceFingerprint = computeProofSourceFingerprint(repoRoot);

      // A non-runtime docs commit advances HEAD but must not change the
      // fingerprint, so a receipt pinned to a stale gitCommit still validates.
      writeFileSync(join(repoRoot, 'HANDOFF.md'), '# Session handoff\n');
      git(repoRoot, ['add', 'HANDOFF.md']);
      const docsCommit = commit(repoRoot, 'handoff doc only');

      const receipt = {
        status: 'pass',
        generatedAt: new Date().toISOString(),
        gitCommit: 'stale0000000000000000000000000000000000000',
        sourceFingerprint,
      };

      expect(receipt.gitCommit).not.toBe(docsCommit);
      expect(validateProofReceipt(repoRoot, receipt).ok).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('fails a receipt whose sourceFingerprint does not match the current tree', () => {
    const repoRoot = createRepo();
    try {
      const receipt = {
        status: 'pass',
        generatedAt: new Date().toISOString(),
        gitCommit: git(repoRoot, ['rev-parse', 'HEAD']),
        sourceFingerprint: 'sha256:deadbeef',
      };

      const result = validateProofReceipt(repoRoot, receipt);
      expect(result.ok).toBe(false);
      expect(result.failures.some(failure => failure.includes('sourceFingerprint'))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('invalidates a receipt when a src change moves the fingerprint after the receipt was sealed', () => {
    const repoRoot = createRepo();
    try {
      // Receipt sealed against the current tree.
      const sealedFingerprint = computeProofSourceFingerprint(repoRoot);
      const receipt = {
        status: 'pass',
        generatedAt: new Date().toISOString(),
        gitCommit: git(repoRoot, ['rev-parse', 'HEAD']),
        sourceFingerprint: sealedFingerprint,
      };
      expect(validateProofReceipt(repoRoot, receipt).ok).toBe(true);

      // A product source change MUST invalidate the sealed receipt.
      writeFileSync(join(repoRoot, 'src', 'app.ts'), 'export const value = 99;\n');
      git(repoRoot, ['add', 'src/app.ts']);
      commit(repoRoot, 'breaking source change');

      const result = validateProofReceipt(repoRoot, receipt);
      expect(result.ok).toBe(false);
      expect(result.failures.some(failure => failure.includes('sourceFingerprint'))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  describe('artifact byte integrity (#1324)', () => {
    const rel = '.omx/proof/run/p5.js';
    const freshReceipt = (repoRoot: string, extra: Record<string, unknown> = {}) => ({
      status: 'pass',
      generatedAt: new Date().toISOString(),
      sourceFingerprint: computeProofSourceFingerprint(repoRoot),
      artifactPath: rel,
      ...extra,
    });
    const withArtifact = (body: string): string => {
      const repoRoot = createRepo();
      mkdirSync(join(repoRoot, '.omx', 'proof', 'run'), { recursive: true });
      writeFileSync(join(repoRoot, rel), body);
      return repoRoot;
    };

    it('passes when recorded digests match the retained bytes', () => {
      const repoRoot = withArtifact('function setup() {}\n');
      try {
        const digests = computeArtifactDigests(repoRoot, [rel]);
        expect(digests[rel]).toMatch(/^sha256:[0-9a-f]{64}$/);
        const result = validateProofReceipt(repoRoot, freshReceipt(repoRoot, { artifactDigests: digests }), {
          requireArtifactPaths: true, requireArtifactDigests: true,
        });
        expect(result.failures).toEqual([]);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('fails when the artifact bytes changed after the receipt, even without any require option', () => {
      const repoRoot = withArtifact('original\n');
      try {
        const digests = computeArtifactDigests(repoRoot, [rel]);
        writeFileSync(join(repoRoot, rel), 'swapped\n');
        const result = validateProofReceipt(repoRoot, freshReceipt(repoRoot, { artifactDigests: digests }));
        expect(result.ok).toBe(false);
        expect(result.failures).toEqual([
          `artifact digest mismatch: ${rel} is ${computeArtifactDigest(repoRoot, rel)}, receipt recorded ${digests[rel]}`,
        ]);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('requireArtifactDigests rejects an artifact with no recorded digest', () => {
      const repoRoot = withArtifact('x\n');
      try {
        const result = validateProofReceipt(repoRoot, freshReceipt(repoRoot), { requireArtifactDigests: true });
        expect(result.failures).toEqual([`missing artifactDigest: ${rel}`]);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('rejects artifact paths that escape the repository or name a directory', () => {
      const repoRoot = withArtifact('x\n');
      try {
        const escaping = validateProofReceipt(repoRoot, freshReceipt(repoRoot, { artifactPath: '../../etc/hostname' }), { requireArtifactPaths: true });
        expect(escaping.failures).toEqual(['artifact outside repository: ../../etc/hostname']);
        expect(computeArtifactDigest(repoRoot, '../../etc/hostname')).toBeNull();

        const dir = validateProofReceipt(repoRoot, freshReceipt(repoRoot, { artifactPath: '.omx/proof/run' }), { requireArtifactPaths: true });
        expect(dir.failures).toEqual(['artifact missing: .omx/proof/run']);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('rejects malformed digest maps and digests for missing files', () => {
      const repoRoot = withArtifact('x\n');
      try {
        for (const artifactDigests of [[], 'sha256:abc', { [rel]: 'md5:00' }, { [rel]: 42 }]) {
          expect(validateProofReceipt(repoRoot, freshReceipt(repoRoot, { artifactDigests })).failures)
            .toEqual(['artifactDigests must map paths to sha256:<64 hex> strings']);
        }
        const ghost = { 'gone.js': `sha256:${'0'.repeat(64)}` };
        expect(validateProofReceipt(repoRoot, freshReceipt(repoRoot, { artifactDigests: ghost })).failures)
          .toEqual(['artifact digest unverifiable (missing or outside repository): gone.js']);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('readGitRef without the git CLI', () => {
  const sha = 'a'.repeat(40);
  const packedSha = 'b'.repeat(40);
  let root: string;
  beforeEach(() => {
    execFileSyncMock.mockReset();
    // The CLI refuses checkouts owned by another uid; the reader must not depend on it.
    execFileSyncMock.mockImplementation(() => { throw new Error('fatal: detected dubious ownership'); });
    root = mkdtempSync(join(tmpdir(), 'gitref-'));
    mkdirSync(join(root, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  });

  it('reads a loose remote ref', () => {
    writeFileSync(join(root, '.git', 'refs', 'remotes', 'origin', 'main'), `${sha}\n`);
    expect(readGitRef(root, 'refs/remotes/origin/main')).toBe(sha);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a packed remote ref', () => {
    writeFileSync(join(root, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${packedSha} refs/remotes/origin/main\n`);
    expect(readGitRef(root, 'refs/remotes/origin/main')).toBe(packedSha);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null for a missing ref', () => {
    expect(readGitRef(root, 'refs/remotes/origin/main')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});
