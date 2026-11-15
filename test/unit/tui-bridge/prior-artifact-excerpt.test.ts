/**
 * W1 #322 — bridge-owned prior-artifact excerpt for revisions.
 *
 * - promptForCreativeDomain renders the excerpt block exactly once when given
 * - resolvePriorArtifactExcerpt reads/truncates safely (never throws) and
 *   confines paths to the repo root (cwd); accepts absolute in-repo paths
 * - revise-mode generation injects the excerpt into the generation prompt once
 *   on both draft and prove paths
 * - GUI no longer inlines "Current artifact code excerpt"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { Domain } from '../../../src/types/domains.js';
import { promptForCreativeDomain } from '../../../src/tui-bridge/CreativeIntentHelpers.js';

const EXCERPT_MARKER = 'Current artifact code (revise it, do not start over):';
const TRUNCATION_MARKER = '\n// …(truncated)';
const PRIOR_ARTIFACT_EXCERPT_MAX_CHARS = 5000;

// ── Integration mocks (same pattern as tui-bridge-no-chat-lane) ─────────────

const { draftGenerate } = vi.hoisted(() => ({
  draftGenerate: vi.fn(async () => ({
    needsClarification: false,
    code: 'function setup() { createCanvas(120, 120); background(12); }',
    thinking: 'Drafted a fast p5 preview.',
    model: 'test-model',
  })),
}));

const { mockEmitPreviewArtifacts } = vi.hoisted(() => ({
  mockEmitPreviewArtifacts: vi.fn(async (ctx: { emit: (sessionId: string, event: Record<string, unknown>) => void }, sessionId: string, _code: string, domain: string) => {
    ctx.emit(sessionId, { type: 'artifact.found', sessionId, artifactLabel: `${domain} HTML preview`, artifactPath: `.omx/proof/live-previews/${sessionId}.html` });
    ctx.emit(sessionId, { type: 'preview.completed', sessionId, previewType: 'html', content: '<html></html>', artifactPath: `.omx/proof/live-previews/${sessionId}.html` });
    ctx.emit(sessionId, { type: 'preview.verified', sessionId, previewType: 'html', artifactPath: `.omx/proof/live-previews/${sessionId}.html`, checks: ['mock preview rendered'] });
    ctx.emit(sessionId, { type: 'generation.domain_truth', sessionId, requestedDomain: domain, selectedDomain: domain, domains: [domain], promptDomainLocked: true, source: 'prompt', generatedDomain: domain, previewDomain: domain, artifactPath: `.omx/proof/live-previews/${sessionId}.html` });
  }),
}));

vi.mock('../../../src/tui-bridge/PreviewService.js', () => ({
  emitPreviewArtifacts: mockEmitPreviewArtifacts,
}));

const { TuiBridgeService, installRetiredDraftTestAdapter } =
  await import('../../../src/tui-bridge/TuiBridgeService.js');
installRetiredDraftTestAdapter({ create: () => ({ generate: draftGenerate }), score: () => 0 });

function fakeLlm() {
  return {
    getConfig: () => ({ baseUrl: 'https://api.openai.com/v1', model: 'test-model' }),
    generate: vi.fn().mockResolvedValue({ code: 'ok', explanation: '', success: true }),
  };
}

function governedProduct(prompts: string[]) {
  const command = { idempotencyKey: 'prior-excerpt-proof' };
  return { productCreateCommand: vi.fn(async (input: { prompt: string }) => {
    prompts.push(input.prompt); return command;
  }), productCommands: {
    submitCreate: vi.fn(async () => ({ kind: 'create', status: 'completed', result: {
      lineageId: 'prior-lineage', roles: { generator: 'verified/generator' },
      evaluation: { score: 0.82, confidence: 1, failureClass: 'none',
        admissionEligible: true, degraded: false, identityValid: true,
        evaluatorIdentity: 'verified/evaluator', evidenceDigest: 'evidence',
        rejectionReasons: [] },
    } })),
    verifiedArtifact: vi.fn(async () => ({
      source: 'function setup() { createCanvas(100, 100); }' })),
  } };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 800; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for event');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

type ResolveExcerpt = (receipt: unknown, maxChars?: number) => Promise<string | undefined>;

function resolveExcerpt(service: InstanceType<typeof TuiBridgeService>): ResolveExcerpt {
  return (service as unknown as { resolvePriorArtifactExcerpt: ResolveExcerpt }).resolvePriorArtifactExcerpt.bind(service);
}

// ── Unit: promptForCreativeDomain ───────────────────────────────────────────

describe('promptForCreativeDomain priorArtifactExcerpt', () => {
  it('includes the excerpt block exactly once when priorArtifactExcerpt is provided', () => {
    const excerpt = 'function setup() {\n  createCanvas(200, 200);\n  background(20, 40, 180);\n}';
    const prompt = promptForCreativeDomain(
      'make it bluer',
      Domain.P5,
      false,
      undefined,
      { priorArtifactExcerpt: excerpt },
    );

    expect(countOccurrences(prompt, EXCERPT_MARKER)).toBe(1);
    expect(prompt).toContain(excerpt);
    expect(prompt).toContain('```\n' + excerpt + '\n```');
    expect(prompt).toContain('make it bluer');
  });

  it('is unchanged (no excerpt block) when priorArtifactExcerpt is omitted', () => {
    const withExcerpt = promptForCreativeDomain(
      'make it bluer',
      Domain.P5,
      false,
      undefined,
      { priorArtifactExcerpt: 'const x = 1;' },
    );
    const without = promptForCreativeDomain('make it bluer', Domain.P5, false);

    expect(without).not.toContain(EXCERPT_MARKER);
    expect(without).not.toContain('const x = 1;');
    expect(withExcerpt).toContain(EXCERPT_MARKER);

    // Without excerpt, the rest of the prompt contract is preserved.
    expect(without).toContain('make it bluer');
    expect(without).toContain('Target creative domain: p5.');
    expect(without).toContain('Return raw p5.js sketch code only');
  });

  it('uses an unbreakable fence when the excerpt contains ```', () => {
    const excerpt = [
      'function setup() {',
      '  // example fence inside artifact:',
      '  const md = "```";',
      '  const triple = ```',
      '  background(0);',
      '}',
    ].join('\n');
    const runs = excerpt.match(/`+/g) ?? [];
    const longest = Math.max(0, ...runs.map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));

    const prompt = promptForCreativeDomain(
      'make it bluer',
      Domain.P5,
      false,
      undefined,
      { priorArtifactExcerpt: excerpt },
    );

    expect(countOccurrences(prompt, EXCERPT_MARKER)).toBe(1);
    expect(prompt).toContain(`${fence}\n${excerpt}\n${fence}`);
    // Surrounding prompt prose still lands after the closed fence.
    expect(prompt).toContain('Target creative domain: p5.');
    expect(prompt.indexOf(EXCERPT_MARKER)).toBeLessThan(prompt.indexOf('Target creative domain: p5.'));
    expect(prompt.indexOf(`${fence}\n${excerpt}\n${fence}`)).toBeLessThan(
      prompt.indexOf('Target creative domain: p5.'),
    );
  });
});

// ── Unit: resolvePriorArtifactExcerpt ───────────────────────────────────────

describe('resolvePriorArtifactExcerpt', () => {
  let tmpDir: string;
  let prevCwd: string;
  let service: InstanceType<typeof TuiBridgeService>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prior-artifact-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    service = new TuiBridgeService();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns file contents for a repo-relative artifact path', async () => {
    const relPath = path.join('.omx', 'proof', 'live-previews', 'sketch.js');
    const body = 'function draw() { ellipse(50, 50, 20, 20); }';
    await fs.mkdir(path.dirname(relPath), { recursive: true });
    await fs.writeFile(relPath, body, 'utf8');

    const excerpt = await resolveExcerpt(service)({
      artifact: { path: relPath, label: 'p5 sketch' },
    });

    expect(excerpt).toBe(body);
  });

  it('accepts absolute in-repo paths under .omx/proof/live-previews (production case)', async () => {
    // PreviewService emits path.join(process.cwd(), '.omx', 'proof', 'live-previews', ...)
    const absPath = path.join(tmpDir, '.omx', 'proof', 'live-previews', 'prod-preview.html');
    const body = '<!doctype html><html><body>preview</body></html>';
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, body, 'utf8');

    const excerpt = await resolveExcerpt(service)({
      artifact: { path: absPath, label: 'p5 HTML preview' },
    });

    expect(excerpt).toBe(body);
  });

  it('returns undefined without throwing when the file is missing', async () => {
    await fs.mkdir(path.join('.omx', 'proof', 'live-previews'), { recursive: true });
    await expect(
      resolveExcerpt(service)({
        artifact: { path: path.join('.omx', 'proof', 'live-previews', 'does-not-exist.js') },
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined without throwing when path is missing', async () => {
    await expect(
      resolveExcerpt(service)({ artifact: {} }),
    ).resolves.toBeUndefined();

    await expect(
      resolveExcerpt(service)(null),
    ).resolves.toBeUndefined();
  });

  it('appends the truncation marker when content exceeds 5000 chars', async () => {
    const relPath = path.join('.omx', 'proof', 'live-previews', 'big.js');
    const body = 'A'.repeat(PRIOR_ARTIFACT_EXCERPT_MAX_CHARS + 250);
    await fs.mkdir(path.dirname(relPath), { recursive: true });
    await fs.writeFile(relPath, body, 'utf8');

    const excerpt = await resolveExcerpt(service)({
      artifact: { path: relPath },
    });

    expect(excerpt!.endsWith(TRUNCATION_MARKER.trimStart()) || excerpt!.includes(TRUNCATION_MARKER)).toBe(true);
    expect(excerpt).toContain('// …(truncated)');
    expect(excerpt!.slice(0, PRIOR_ARTIFACT_EXCERPT_MAX_CHARS)).toBe('A'.repeat(PRIOR_ARTIFACT_EXCERPT_MAX_CHARS));
    expect(excerpt!.length).toBe(PRIOR_ARTIFACT_EXCERPT_MAX_CHARS + TRUNCATION_MARKER.length);
  });

  it('rejects absolute paths outside the repo', async () => {
    await expect(
      resolveExcerpt(service)({
        artifact: { path: '/etc/hostname' },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects in-repo paths outside .omx/proof', async () => {
    // Ensure the confinement root exists so rejection is path-relative
    // confinement, not ENOENT from realpathSync('.omx/proof').
    await fs.mkdir(path.join('.omx', 'proof'), { recursive: true });
    const relPath = 'src/secret-source.ts';
    await fs.mkdir('src', { recursive: true });
    await fs.writeFile(relPath, 'export const secret = 1;', 'utf8');

    await expect(
      resolveExcerpt(service)({
        artifact: { path: relPath },
      }),
    ).resolves.toBeUndefined();

    // Absolute in-repo path outside .omx/proof is also rejected.
    await expect(
      resolveExcerpt(service)({
        artifact: { path: path.join(tmpDir, relPath) },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects paths with .. segments', async () => {
    // path.join collapses `..`; use raw strings that still contain the segments.
    await fs.mkdir(path.join('.omx', 'proof'), { recursive: true });

    await expect(
      resolveExcerpt(service)({
        artifact: { path: '.omx/proof/../../outside-secret.js' },
      }),
    ).resolves.toBeUndefined();

    await expect(
      resolveExcerpt(service)({
        artifact: { path: '../outside-secret.js' },
      }),
    ).resolves.toBeUndefined();

    // Absolute path whose raw string still contains `..` segments.
    await expect(
      resolveExcerpt(service)({
        artifact: { path: `${tmpDir}/.omx/proof/../../../etc/hostname` },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects symlinks that escape the repo root', async () => {
    // Target lives outside the temp repo (sibling of tmpDir), so realpath escapes.
    const outside = path.join(path.dirname(tmpDir), `prior-artifact-escaped-${Date.now()}.js`);
    writeFileSync(outside, 'SECRET_PAYLOAD', 'utf8');
    try {
      const root = path.join(tmpDir, '.omx', 'proof', 'live-previews');
      mkdirSync(root, { recursive: true });
      const linkPath = path.join(root, 'escape-link.js');
      symlinkSync(outside, linkPath);

      await expect(
        resolveExcerpt(service)({
          artifact: { path: path.join('.omx', 'proof', 'live-previews', 'escape-link.js') },
        }),
      ).resolves.toBeUndefined();

      // Absolute path to the same escaping symlink is also rejected.
      await expect(
        resolveExcerpt(service)({
          artifact: { path: linkPath },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

// ── Integration: revise-mode generation prompt carries excerpt once ─────────

describe('revise-mode generation injects prior artifact excerpt', () => {
  let artifactRel: string;

  beforeEach(async () => {
    draftGenerate.mockClear();
    mockEmitPreviewArtifacts.mockClear();
    // Write under cwd so a repo-relative path works like production artifacts.
    artifactRel = path.join('.omx', 'proof', 'live-previews', `w1-prior-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    const abs = path.join(process.cwd(), artifactRel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'function setup() {\n  background(0, 0, 200);\n}\n', 'utf8');
  });

  afterEach(async () => {
    const abs = path.join(process.cwd(), artifactRel);
    await fs.rm(abs, { force: true });
  });

  it('puts the excerpt into the generation prompt exactly once (draft revise)', async () => {
    const service = new TuiBridgeService();
    const session = service.createSession();
    const uniqueSnippet = 'background(0, 0, 200)';

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'make it bluer',
        clientIntent: 'creative',
        executionMode: 'draft',
        maxIterations: 1,
        candidateCount: 1,
        timeoutMinutes: 1,
        creativePreferences: {
          revisionKind: 'revise',
          priorRunReceipt: {
            phase: 'complete',
            creativeDomain: 'p5',
            artifact: {
              label: 'p5 HTML preview',
              path: artifactRel,
            },
            preview: { type: 'html' },
          },
        },
      },
      fakeLlm() as never,
    );

    await waitFor(() => service.getEvents(session.sessionId).find(event => event.type === 'preview.completed'));

    expect(draftGenerate).toHaveBeenCalled();
    const generationPrompt = String(draftGenerate.mock.calls[0]?.[0] ?? '');
    expect(countOccurrences(generationPrompt, EXCERPT_MARKER)).toBe(1);
    expect(generationPrompt).toContain(uniqueSnippet);
    expect(generationPrompt).toContain('make it bluer');
  });

  it('puts the excerpt into the generation prompt exactly once (prove revise)', async () => {
    const prompts: string[] = [];
    const service = new TuiBridgeService(governedProduct(prompts) as never);
    const session = service.createSession();
    const uniqueSnippet = 'background(0, 0, 200)';

    await service.submitInput(
      session.sessionId,
      {
        mode: 'chat',
        text: 'make it bluer',
        clientIntent: 'creative',
        executionMode: 'prove',
        maxIterations: 1,
        candidateCount: 1,
        timeoutMinutes: 1,
        creativePreferences: {
          revisionKind: 'revise',
          priorRunReceipt: {
            phase: 'complete',
            creativeDomain: 'p5',
            artifact: {
              label: 'p5 HTML preview',
              path: artifactRel,
            },
            preview: { type: 'html' },
          },
        },
      },
      fakeLlm() as never,
    );

    await waitFor(() => service.getEvents(session.sessionId).find(event => event.type === 'preview.completed'));

    expect(prompts).toHaveLength(1);
    expect(draftGenerate).not.toHaveBeenCalled();
    const generationPrompt = prompts[0]!;
    expect(countOccurrences(generationPrompt, EXCERPT_MARKER)).toBe(1);
    expect(generationPrompt).toContain(uniqueSnippet);
    expect(generationPrompt).toContain('make it bluer');
  });
});

// ── GUI grep assertion ──────────────────────────────────────────────────────

describe('GUI no longer inlines artifact code into follow-up prompts', () => {
  it('does not contain the retired "Current artifact code excerpt" string', () => {
    const appSource = readFileSync(path.join(process.cwd(), 'gui/src/App.tsx'), 'utf8');
    expect(appSource).not.toContain('Current artifact code excerpt');
  });
});
