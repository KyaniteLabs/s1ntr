import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeArtifactDigests } from '../../../src/runtime-core/ProofReceiptValidator.js';
import { buildMarketReadinessStatus, collectRepositoryMarketReadinessStatus, formatMarketReadinessStatus } from '../../../src/market/MarketReadinessStatus.js';

describe('MarketReadinessStatus', () => {
  it('answers whether execution-verified checks pass and lists blocking gaps', () => {
    const status = buildMarketReadinessStatus({
      checks: [
        { id: 'natural-cli', label: 'Natural CLI front door', status: 'pass', evidence: 'PR #366' },
        { id: 'studio-cognition', label: 'Studio learning receipts', status: 'pass', evidence: 'PR #367' },
        { id: 'live-smoke', label: 'Live end-to-end smoke', status: 'fail', evidence: 'No current live provider smoke attached' },
      ],
    });

    expect(status.ready).toBe(false);
    expect(status.verdict).toBe('not-ready');
    expect(status.blockers).toEqual(['Live end-to-end smoke: No current live provider smoke attached']);
  });

  it('formats failing smoke checks for humans', () => {
    const status = buildMarketReadinessStatus({
      checks: [
        { id: 'a', label: 'A', status: 'pass', evidence: 'ok' },
        { id: 'b', label: 'B', status: 'unknown', evidence: 'not checked' },
      ],
    });

    expect(formatMarketReadinessStatus(status).split('\n')[0]).toBe('Smoke checks: FAIL');
    expect(formatMarketReadinessStatus(status)).toContain('B: unknown — not checked');
  });

  it('does not let source-presence (advisory) checks produce a passing smoke verdict', () => {
    // All advisory "pass" signals — grep hits only, no execution-verified check.
    const status = buildMarketReadinessStatus({
      checks: [
        { id: 'natural-cli', label: 'Natural CLI front door', status: 'advisory', evidence: 'source-presence (not execution-verified): found x' },
        { id: 'creative-wrappers', label: 'Creative wrappers', status: 'advisory', evidence: 'source-presence (not execution-verified): found y' },
      ],
    });

    expect(status.ready).toBe(false);
    expect(status.verdict).toBe('not-ready');
    expect(status.blockers).toEqual([]);
    expect(formatMarketReadinessStatus(status).split('\n')[0]).toBe('Smoke checks: FAIL');
  });

  it('marks the smoke verdict solely on execution-verified receipt checks', () => {
    const status = buildMarketReadinessStatus({
      checks: [
        // Advisory source checks are present but must not count toward the verdict.
        { id: 'natural-cli', label: 'Natural CLI front door', status: 'advisory', evidence: 'source-presence (not execution-verified): missing z' },
        { id: 'studio-smoke', label: 'Studio smoke', status: 'pass', evidence: 'Found passing receipt' },
        { id: 'live-provider-smoke', label: 'Live provider smoke', status: 'pass', evidence: 'Found passing receipt' },
      ],
    });

    expect(status.ready).toBe(true);
    expect(status.verdict).toBe('ready');
    expect(status.blockers).toEqual([]);
    expect(formatMarketReadinessStatus(status).split('\n')[0]).toBe('Smoke checks: PASS');
  });

  it('separates execution-verified checks from advisory source-presence checks in the output', () => {
    const status = buildMarketReadinessStatus({
      checks: [
        { id: 'natural-cli', label: 'Natural CLI front door', status: 'advisory', evidence: 'source-presence (not execution-verified): found x' },
        { id: 'live-provider-smoke', label: 'Live provider smoke', status: 'fail', evidence: 'No current live provider smoke receipt found' },
      ],
    });

    const formatted = formatMarketReadinessStatus(status);
    expect(formatted).toContain('Execution-verified checks (gate the verdict):');
    expect(formatted).toContain('Source-presence checks (advisory — do NOT gate the verdict):');
    expect(formatted).toContain('Natural CLI front door: advisory — source-presence (not execution-verified): found x');
    expect(formatted).toContain('Live provider smoke: fail — No current live provider smoke receipt found');
  });
});

describe('collectRepositoryMarketReadinessStatus', () => {
  function writeFakeGitHead(repoRoot: string, commit = 'a'.repeat(40)): string {
    const refsDir = path.join(repoRoot, '.git', 'refs', 'heads');
    fs.mkdirSync(refsDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(refsDir, 'main'), `${commit}\n`);
    return commit;
  }

  function writeSourcePresenceFixture(repoRoot: string): void {
    const files: Record<string, string> = {
      'bin/sinter': [
        'inferNaturalLanguagePrompt',
        'sinter "natural language prompt"',
        'writeCliCognitiveReceipt',
        'What Sinter learned',
        'release gate',
        'runLevel6ReleaseGate',
      ].join('\n'),
      'src/core/wrappers/GenericWrapper.ts': 'strudel-editor\nwrapRevideo\nHydra\nTone\n',
      'gui/src/gui/workbenchTelemetry.ts': 'latestCognitiveReceipt\nsinter-cognitive-receipt\n',
      'gui/src/App.tsx': 'What Sinter learned\n',
      'src/cli/CognitiveReceiptReporter.ts': 'writeCliCognitiveReceipt\nCognitive write-back\n',
      'src/runtime-core/Level6ReleaseGate.ts': 'self-improvement-gauntlet\ncreative-domain-gauntlet\n',
    };

    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(repoRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    }
  }

  it('checks the real repository surfaces without running slow provider calls', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-surfaces-'));
    writeFakeGitHead(repoRoot);
    writeSourcePresenceFixture(repoRoot);

    const status = collectRepositoryMarketReadinessStatus(repoRoot);

    expect(status.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'natural-cli',
      'creative-wrappers',
      'studio-cognition',
      'cli-cognition',
      'studio-smoke',
      'live-provider-smoke',
    ]));
    expect(status.checks.find((check) => check.id === 'live-provider-smoke')).toMatchObject({ id: 'live-provider-smoke' });
  });

  it('keeps the source-presence checks advisory so grep hits cannot fabricate READY', () => {
    // This fixture contains every literal the source-presence checks look for,
    // but ships no proof receipts. The verdict must come ONLY from the receipts,
    // not from whatever release proofs a developer has generated in process.cwd().
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-source-only-'));
    writeFakeGitHead(repoRoot);
    writeSourcePresenceFixture(repoRoot);

    const status = collectRepositoryMarketReadinessStatus(repoRoot);

    const sourceCheckIds = ['natural-cli', 'creative-wrappers', 'studio-cognition', 'cli-cognition', 'level6-gate'];
    for (const id of sourceCheckIds) {
      const check = status.checks.find((c) => c.id === id);
      expect(check?.status).toBe('advisory');
      // An advisory check never appears as a blocker, even when its literals are present.
      expect(status.blockers).not.toContain(`${check?.label}: ${check?.evidence}`);
    }

    // No fresh receipts in this worktree → not ready, blocked only by the receipt checks.
    expect(status.ready).toBe(false);
    expect(status.blockers.some((b) => b.startsWith('Live provider smoke'))).toBe(true);
    expect(status.blockers.some((b) => b.startsWith('Studio smoke'))).toBe(true);
  });

  it('does not report source-only capabilities as missing from a packaged install', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-packaged-'));
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'sinter', version: '2.1.0' }));
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'sinter'), 'inferNaturalLanguagePrompt\nsinter "natural language prompt"\n');
    fs.mkdirSync(path.join(repoRoot, 'dist', 'core', 'wrappers'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'dist', 'core', 'wrappers', 'GenericWrapper.js'), 'strudel-editor\nwrapRevideo\nHydra\nTone\n');

    const status = collectRepositoryMarketReadinessStatus(repoRoot);
    const creativeWrappers = status.checks.find((check) => check.id === 'creative-wrappers');
    const studioCognition = status.checks.find((check) => check.id === 'studio-cognition');

    expect(creativeWrappers?.evidence).toContain('not checkable in packaged install');
    expect(creativeWrappers?.evidence).not.toContain('missing strudel-editor');
    expect(studioCognition?.evidence).toContain('not checkable in packaged install');
    expect(studioCognition?.evidence).not.toContain('missing latestCognitiveReceipt');
  });

  it('reaches READY only when both receipt-backed checks pass, regardless of source presence', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-'));
    const gitCommit = writeFakeGitHead(repoRoot);
    const proofDir = path.join(repoRoot, '.omx', 'proof');
    fs.mkdirSync(proofDir, { recursive: true });

    // Live provider smoke receipt bound to the commit with a real artifact.
    const artifactPath = path.join(proofDir, 'live-provider-smoke', 'p5.js');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'function setup() { createCanvas(100, 100); }\n');
    fs.writeFileSync(path.join(proofDir, 'live-provider-smoke.json'), JSON.stringify({
      status: 'pass',
      generatedAt: new Date().toISOString(),
      gitCommit,
      provider: 'glm',
      model: 'glm-5v-turbo',
      artifactPath: '.omx/proof/live-provider-smoke/p5.js',
      artifactDigests: computeArtifactDigests(repoRoot, ['.omx/proof/live-provider-smoke/p5.js']),
    }));

    // Studio smoke receipt bound to the commit.
    fs.writeFileSync(path.join(proofDir, 'studio-smoke.json'), JSON.stringify({
      status: 'pass',
      generatedAt: new Date().toISOString(),
      gitCommit,
      checks: { backendHealth: true, noConsoleErrors: true, studioHeading: true, stageNav: true },
      blockers: [],
    }));

    const status = collectRepositoryMarketReadinessStatus(repoRoot);

    // This temp repo has NO source literals at all → the advisory checks "miss" them,
    // yet the verdict is READY because both receipt-backed checks pass.
    expect(status.checks.find((c) => c.id === 'natural-cli')?.status).toBe('advisory');
    expect(status.checks.find((c) => c.id === 'live-provider-smoke')?.status).toBe('pass');
    expect(status.checks.find((c) => c.id === 'studio-smoke')?.status).toBe('pass');
    expect(status.ready).toBe(true);
    expect(status.blockers).toEqual([]);
  });

  it('does not accept a stale or failed live-provider receipt as market-ready', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-'));
    const proofDir = path.join(repoRoot, '.omx', 'proof');
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(proofDir, 'live-provider-smoke.json'), JSON.stringify({ status: 'fail', blockers: ['bad output'] }));

    const status = collectRepositoryMarketReadinessStatus(repoRoot);
    const liveSmoke = status.checks.find((check) => check.id === 'live-provider-smoke');

    expect(liveSmoke?.status).toBe('fail');
    expect(liveSmoke?.evidence).toContain('Live provider smoke receipt status fail');
  });

  it('rejects passing live-provider receipts without commit and artifact proof', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-'));
    writeFakeGitHead(repoRoot);
    const proofDir = path.join(repoRoot, '.omx', 'proof');
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(proofDir, 'live-provider-smoke.json'), JSON.stringify({
      status: 'pass',
      generatedAt: new Date().toISOString(),
      provider: 'glm',
      model: 'glm-5v-turbo',
      artifactPath: '.omx/proof/live-provider-smoke/p5.js',
    }));

    const status = collectRepositoryMarketReadinessStatus(repoRoot);
    const liveSmoke = status.checks.find((check) => check.id === 'live-provider-smoke');

    expect(liveSmoke?.status).toBe('fail');
    expect(liveSmoke?.evidence).toContain('missing gitCommit');
  });

  it('accepts a fresh live-provider receipt bound to the current commit and artifact', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-'));
    const gitCommit = writeFakeGitHead(repoRoot);
    const proofDir = path.join(repoRoot, '.omx', 'proof');
    const artifactPath = path.join(proofDir, 'live-provider-smoke', 'p5.js');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'function setup() { createCanvas(100, 100); }\n');
    fs.writeFileSync(path.join(proofDir, 'live-provider-smoke.json'), JSON.stringify({
      status: 'pass',
      generatedAt: new Date().toISOString(),
      gitCommit,
      provider: 'glm',
      model: 'glm-5v-turbo',
      artifactPath: '.omx/proof/live-provider-smoke/p5.js',
      artifactDigests: computeArtifactDigests(repoRoot, ['.omx/proof/live-provider-smoke/p5.js']),
    }));

    const status = collectRepositoryMarketReadinessStatus(repoRoot);
    const liveSmoke = status.checks.find((check) => check.id === 'live-provider-smoke');

    expect(liveSmoke?.status).toBe('pass');
    expect(liveSmoke?.evidence).toContain('glm/glm-5v-turbo');
  });

  it('rejects a live-provider receipt whose artifact bytes changed or carry no digest (#1324)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-'));
    const gitCommit = writeFakeGitHead(repoRoot);
    const proofDir = path.join(repoRoot, '.omx', 'proof');
    const rel = '.omx/proof/live-provider-smoke/p5.js';
    const artifactPath = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, 'function setup() { createCanvas(100, 100); }\n');
    const base = { status: 'pass', generatedAt: new Date().toISOString(), gitCommit, provider: 'glm', model: 'glm-5v-turbo', artifactPath: rel };
    fs.writeFileSync(path.join(proofDir, 'live-provider-smoke.json'), JSON.stringify({
      ...base, artifactDigests: computeArtifactDigests(repoRoot, [rel]),
    }));
    fs.writeFileSync(artifactPath, '// swapped after the run\n');

    let liveSmoke = collectRepositoryMarketReadinessStatus(repoRoot).checks.find((check) => check.id === 'live-provider-smoke');
    expect(liveSmoke?.status).toBe('fail');
    expect(liveSmoke?.evidence).toContain(`artifact digest mismatch: ${rel}`);

    fs.writeFileSync(path.join(proofDir, 'live-provider-smoke.json'), JSON.stringify(base));
    liveSmoke = collectRepositoryMarketReadinessStatus(repoRoot).checks.find((check) => check.id === 'live-provider-smoke');
    expect(liveSmoke?.status).toBe('fail');
    expect(liveSmoke?.evidence).toContain(`missing artifactDigest: ${rel}`);
  });

  it('does not accept a missing or failed studio-smoke receipt as market-ready', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-'));

    // No receipt at all → the gate can no longer pass on the script merely existing.
    let status = collectRepositoryMarketReadinessStatus(repoRoot);
    let studio = status.checks.find((check) => check.id === 'studio-smoke');
    expect(studio?.status).toBe('fail');
    expect(studio?.evidence).toContain('No studio smoke receipt found');

    // A failed run is honestly reported as failing.
    const proofDir = path.join(repoRoot, '.omx', 'proof');
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(proofDir, 'studio-smoke.json'), JSON.stringify({ status: 'fail', blockers: ['noConsoleErrors'] }));
    status = collectRepositoryMarketReadinessStatus(repoRoot);
    studio = status.checks.find((check) => check.id === 'studio-smoke');
    expect(studio?.status).toBe('fail');
    expect(studio?.evidence).toContain('Studio smoke receipt status fail');
  });

  it('accepts a fresh studio-smoke receipt bound to the current commit', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-market-'));
    const gitCommit = writeFakeGitHead(repoRoot);
    const proofDir = path.join(repoRoot, '.omx', 'proof');
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(proofDir, 'studio-smoke.json'), JSON.stringify({
      status: 'pass',
      generatedAt: new Date().toISOString(),
      gitCommit,
      checks: { backendHealth: true, noConsoleErrors: true, studioHeading: true, stageNav: true },
      blockers: [],
    }));

    const status = collectRepositoryMarketReadinessStatus(repoRoot);
    const studio = status.checks.find((check) => check.id === 'studio-smoke');
    expect(studio?.status).toBe('pass');
    expect(studio?.evidence).toContain('studio-smoke.json');
  });
});
